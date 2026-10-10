/**
 * dsh-workbuddy — WorkBuddy / CodeBuddy 网关在 DSH 中的宿主管家。
 *
 * 职责：
 *   1. 启动时探测本地 workbuddy2api 网关；未运行则按 launchScript 拉起（autoStart）。
 *   2. 通过 host-webserver 的 `webServer` 服务暴露 /api/workbuddy/* 状态与操作接口。
 *   3. 提供同源反向代理 /workbuddy-panel/*，让官方 Web 面板内嵌在 DSH 里，
 *      不受任何跨源 iframe 策略影响。
 *
 * 关键实现约束：`webServer` 是**后注入**服务 —— 插件 apply 时它通常尚未就绪
 * （DSH 启动诊断里会看到一批插件 "waiting for services (…) webServer"）。
 * 因此不能靠 `ctx.get('webServer')` 取用，也不能把 webServer 列进 `inject`
 * （那会让插件在 headless / Electron 组合里永不加载）。正确做法是用
 * `ctx.inject(['webServer'], cb)`：依赖就绪时执行回调，不就绪时插件照常加载，
 * 只是不注册 HTTP 路由。
 *
 * 网关来源有两种：
 *   - `vendored`（默认）：本插件自带 `vendor/wb-proxy/`，直接用 python3 跑
 *     `wb_proxy.py`，**生命周期跟随 DSH**——DSH 启动即拉起、DSH 退出即停止。
 *   - `external`：使用外部安装的网关（`gatewayDir` 或 `launchScript`）。
 * 两种模式都把运行时数据（accounts / usage）放在独立数据目录，所以换来源
 * 不会丢登录态（首次会自动从旧装迁移）。
 *
 * @module dsh-workbuddy
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  appendFileSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

export const name = 'workbuddy'

/** 不声明任何必需服务：见文件头注释（webServer 走 ctx.inject 动态注入）。 */
export const inject = []

/** 排查用文件日志：插件加载异常时 stdout 往往是空的，落盘最可靠。 */
function trace(msg) {
  try {
    appendFileSync('/tmp/dsh-workbuddy-plugin.log', `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* 日志失败不影响插件 */
  }
}

/**
 * 中性默认值。
 *
 * 注意这里**不预设任何本机路径与密码**：`launchScript` 留空时插件只探测、不自动
 * 拉起网关；`panelPassword` 留空时不做面板自动登录。两者都应由使用者在自己的
 * profile patch 里显式配置——预设成某台机器的路径或 'admin' 这类弱口令，会让
 * 别人装了之后「看起来能用」却在别处静默失效，或把面板口令写死在代码里。
 */
const DEFAULTS = {
  gatewayUrl: 'http://127.0.0.1:8788',
  gatewayPort: 8788,
  /**
   * 网关来源：
   *   'auto'     —— 有内嵌网关就用内嵌；否则看 gatewayDir / launchScript；都没有则只探测。
   *   'vendored' —— 强制用插件自带的 vendor/wb-proxy。
   *   'external' —— 强制用外部安装（gatewayDir 或 launchScript）。
   *   'off'      —— 只探测，从不启动。
   */
  mode: 'auto',
  /** DSH 启动时若网关未运行，是否自动拉起。 */
  autoStart: true,
  /** DSH 退出时，是否停止**由本插件启动/接管**的网关；外部进程不会被碰。 */
  stopOnExit: true,
  /** 内嵌网关目录；留空 = 插件自带的 vendor/wb-proxy。 */
  vendorDir: '',
  /** 外部网关目录（需含 wb_proxy.py）；mode=external 时优先用它。 */
  gatewayDir: '',
  /** 外部启动脚本（备选，与 gatewayDir 二选一）。留空则不使用。 */
  launchScript: '',
  /** python 解释器路径；留空 = 自动探测 3.9+。 */
  pythonPath: '',
  /** 运行时数据目录（accounts / usage / settings）；留空 = ~/.dsh/workbuddy-gateway。 */
  dataDir: '',
  /** 旧装位置，用于首次迁移账号；留空 = 自动探测 ~/workbuddy2api-hub/wb-proxy 等。 */
  legacyDataDir: '',
  /** 面板访问密码。留空 = 面板需手输一次，且 /workbuddy/realm 不可用。 */
  panelPassword: '',
  /** 配了 panelPassword 时，进入面板根路径自动带 ?pwd= 登录，省掉每次手输。 */
  panelAutoLogin: true,
  /** 后台健康检查间隔（毫秒）；0 = 关闭，仅在被请求时探测。 */
  healthIntervalMs: 15000,
  /**
   * 拉起后等待网关就绪的最长时间（毫秒）。
   * 首次启动要探测 python、加载模型目录，比固定等 3 秒慢得多——等太短会把
   * 「还在启动」误判成「启动失败」。
   */
  startTimeoutMs: 25000,
  /**
   * 网关 stdout/stderr 落盘位置；留空 = 数据目录下的 dsh-gateway.log。
   * 必须落盘：`stdio: 'ignore'` 会让启动失败的原因彻底丢失（这正是之前
   * 「启动失败但只显示 HTTP 200」无从排查的原因）。
   */
  logPath: '',
  /** 停止网关时先 SIGTERM，超过该毫秒数仍未退出再 SIGKILL。 */
  stopGraceMs: 5000,
}

/** 展开 config 里的 ~ 前缀。 */
function expandHome(p) {
  if (!p || typeof p !== 'string') return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** 去掉尾部斜杠与 /v1 后缀，得到面板根地址。 */
function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

export function apply(ctx, rawConfig) {
  trace(`apply() 被调用，rawConfig=${JSON.stringify(rawConfig ?? null)}`)
  const cfg = { ...DEFAULTS, ...(rawConfig || {}) }
  const base = normalizeBase(cfg.gatewayUrl)
  const script = expandHome(cfg.launchScript)
  const log = ctx.logger?.('workbuddy') ?? console

  /** 面板会话 token：切区域等上游出口操作必须用面板会话，API key 会被拒。 */
  let panelToken = null

  async function probe(timeoutMs = 3000) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return { up: false, httpStatus: res.status }
      return { up: true, health: await res.json() }
    } catch (err) {
      return { up: false, error: String(err?.message ?? err) }
    }
  }

  async function fetchModels(timeoutMs = 10000) {
    try {
      const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return { ok: false, httpStatus: res.status }
      const data = await res.json()
      return { ok: true, models: data.data ?? [] }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  }

  // ═══════════════════════════ 网关生命周期管理 ═══════════════════════════
  //
  // 代码目录与数据目录分离：
  //   - 代码来自 vendor/wb-proxy（内置）或外部安装；
  //   - 数据（accounts / usage / settings）固定在数据目录，用 --accounts-dir /
  //     --usage-dir 指过去，所以换代码来源不会丢登录态。
  //
  // 生命周期跟随 DSH：autoStart 拉起、stopOnExit 停止。只有本插件启动或显式
  // 接管的进程才会被停；外部自行运行的网关不会被碰。

  /** 本插件 spawn 出来的子进程。 */
  let gatewayChild = null
  /** 接管的外部进程 pid（上次遗留，无 child 句柄）。 */
  let adoptedPid = null
  /** 最近一次解析出的运行方案，供 /workbuddy/status 展示。 */
  let gatewayPlan = null

  const EXTRA_PATH = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':')

  const ownsGateway = () => Boolean(gatewayChild || adoptedPid)
  const ownedPid = () => gatewayChild?.pid ?? adoptedPid ?? null

  /** 子进程环境：补 PATH（GUI 启动的 DSH 未必继承登录 shell 的 PATH）。 */
  function childEnv() {
    return {
      ...process.env,
      PATH: `${EXTRA_PATH}:${process.env.PATH ?? ''}`,
      // 不缓冲 stdout，否则日志尾看不到实时内容
      PYTHONUNBUFFERED: '1',
    }
  }

  /** 插件自带的内嵌网关目录（lib/index.js → ../vendor/wb-proxy）。 */
  function resolveVendorDir() {
    const d = cfg.vendorDir
      ? expandHome(cfg.vendorDir)
      : join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'wb-proxy')
    return existsSync(join(d, 'wb_proxy.py')) ? d : null
  }

  /** 外部网关目录（需含 wb_proxy.py）。 */
  function resolveExternalDir() {
    if (cfg.gatewayDir) {
      const d = expandHome(cfg.gatewayDir)
      if (existsSync(join(d, 'wb_proxy.py'))) return d
    }
    if (script) {
      const d = dirname(script)
      if (existsSync(join(d, 'wb_proxy.py'))) return d
    }
    return null
  }

  /** 自动探测可用的 python 3.9+（复刻 start-wb-proxy.sh 的候选顺序）。 */
  function findPython() {
    if (cfg.pythonPath) {
      const p = expandHome(cfg.pythonPath)
      return existsSync(p) ? p : null
    }
    const cands = [
      'python3',
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/usr/bin/python3',
      'python3.13',
      'python3.12',
      'python3.11',
      'python3.10',
      'python3.9',
      'python',
    ]
    for (const c of cands) {
      try {
        const r = spawnSync(
          c,
          ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)'],
          { timeout: 5000 },
        )
        if (r.status === 0) return c
      } catch {
        /* 试下一个 */
      }
    }
    return null
  }

  /** 运行时数据目录（与代码目录分离）。 */
  function resolveDataDir() {
    return cfg.dataDir ? expandHome(cfg.dataDir) : join(homedir(), '.dsh', 'workbuddy-gateway')
  }

  /** 可能含账号数据的旧装目录。 */
  function findLegacyDirs() {
    const out = []
    if (cfg.legacyDataDir) out.push(expandHome(cfg.legacyDataDir))
    out.push(join(homedir(), 'workbuddy2api-hub', 'wb-proxy'))
    out.push(join(homedir(), 'wb-proxy'))
    return out.filter((d) => d && existsSync(join(d, 'accounts')))
  }

  /**
   * 首次运行时从旧装迁移账号与用量，避免用户重新登录。
   * 仅在目标数据目录还没有 accounts/ 时执行一次。
   */
  function migrateLegacyData(dataDir) {
    if (existsSync(join(dataDir, 'accounts'))) return null
    const from = findLegacyDirs()[0]
    if (!from) return null
    try {
      mkdirSync(dataDir, { recursive: true })
      for (const name of ['accounts', 'usage', 'settings.json']) {
        const src = join(from, name)
        if (existsSync(src)) cpSync(src, join(dataDir, name), { recursive: true })
      }
      const msg = `已迁移旧装数据：${from} → ${dataDir}`
      log.info?.(msg)
      trace(msg)
      return { from, to: dataDir }
    } catch (err) {
      trace(`迁移失败: ${err?.message ?? err}`)
      return null
    }
  }

  /** 算出这次该怎么跑（只解析，不产生副作用）。 */
  function resolveGatewayPlan() {
    const requested = cfg.mode || 'auto'
    const vendor = resolveVendorDir()
    const external = resolveExternalDir()

    let mode = requested
    if (requested === 'auto') mode = vendor ? 'vendored' : external ? 'external' : 'off'
    if (mode === 'off') return { ok: false, mode, error: 'mode=off：只探测，不启动网关' }

    const dir = mode === 'vendored' ? vendor : external
    if (!dir) {
      return {
        ok: false,
        mode,
        error:
          mode === 'vendored'
            ? '找不到内嵌网关（vendor/wb-proxy/wb_proxy.py）'
            : '找不到外部网关（gatewayDir 或 launchScript 下没有 wb_proxy.py）',
      }
    }

    const python = findPython()
    if (!python) {
      return { ok: false, mode, error: '找不到 Python 3.9+；可用 pythonPath 显式指定', dir }
    }

    const dataDir = resolveDataDir()
    return {
      ok: true,
      mode,
      dir,
      python,
      entry: join(dir, 'wb_proxy.py'),
      dataDir,
      accountsDir: join(dataDir, 'accounts'),
      usageDir: join(dataDir, 'usage'),
    }
  }

  /** 日志与 pidfile 都放数据目录，便于打包与清理。 */
  const gatewayLog = cfg.logPath
    ? expandHome(cfg.logPath)
    : join(resolveDataDir(), 'dsh-gateway.log')
  const pidfilePath = join(resolveDataDir(), 'dsh-gateway.pid')

  /** 读日志尾部若干行，用于把启动失败的真实原因带回前端。 */
  function readLogTail(lines = 12) {
    try {
      if (!gatewayLog || !existsSync(gatewayLog)) return null
      const all = readFileSync(gatewayLog, 'utf8').split('\n').filter((l) => l.trim())
      return all.slice(-lines).join('\n')
    } catch {
      return null
    }
  }

  function readPidfile() {
    try {
      const pid = Number(readFileSync(pidfilePath, 'utf8').trim())
      return Number.isInteger(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  function writePidfile(pid) {
    try {
      mkdirSync(dirname(pidfilePath), { recursive: true })
      writeFileSync(pidfilePath, String(pid))
    } catch {
      /* 非致命 */
    }
  }

  function clearPidfile() {
    try {
      rmSync(pidfilePath, { force: true })
    } catch {
      /* 非致命 */
    }
  }

  function isAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** 端口是否有人监听（TCP 连得上就算，不管它是否响应 HTTP）。 */
  function isPortListening(port, timeoutMs = 1200) {
    return new Promise((resolve) => {
      const sock = createConnection({ host: '127.0.0.1', port })
      const done = (v) => {
        try {
          sock.destroy()
        } catch {
          /* 忽略 */
        }
        resolve(v)
      }
      sock.setTimeout(timeoutMs)
      sock.once('connect', () => done(true))
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
    })
  }

  /**
   * 启动网关并等它就绪。区分三种既有状态：
   *   1. 端口已服务 + pidfile 指向存活进程 → 接管（DSH 退出时停止它）
   *   2. 端口已服务 + 不是我们的          → 外部网关，不接管、退出时也不碰
   *   3. 端口被占但不响应                → 僵尸（关终端后被 SIGTTOU 挂起），清掉重起
   */
  async function startGateway() {
    const plan = resolveGatewayPlan()
    gatewayPlan = {
      mode: plan.mode,
      ok: plan.ok,
      error: plan.error ?? null,
      dir: plan.dir ?? null,
      python: plan.python ?? null,
      dataDir: plan.dataDir ?? null,
    }
    if (!plan.ok) return { started: false, ok: false, mode: plan.mode, reason: plan.error }

    // 1) 已在服务
    const up0 = await probe(2500)
    if (up0.up) {
      const prev = readPidfile()
      if (prev && isAlive(prev)) {
        adoptedPid = prev
        const msg = `接管上次遗留的网关（pid ${prev}），DSH 退出时会停止它`
        log.info?.(msg)
        trace(msg)
        return { started: false, ok: true, adopted: true, mode: plan.mode, pid: prev, up: true, health: up0.health, reason: msg }
      }
      return {
        started: false,
        ok: true,
        external: true,
        mode: plan.mode,
        up: true,
        health: up0.health,
        reason: '网关已在运行，且不是本插件启动的——不接管其生命周期',
      }
    }

    // 2) 端口被占但不响应 = 僵尸，必须先清掉
    if (await isPortListening(cfg.gatewayPort)) {
      const stale = readPidfile()
      if (stale && isAlive(stale)) {
        try {
          process.kill(stale, 'SIGKILL')
        } catch {
          /* 忽略 */
        }
        clearPidfile()
        const msg = `清掉了上次遗留、占着端口但不响应的网关（pid ${stale}）`
        log.warn?.(msg)
        trace(msg)
        for (let i = 0; i < 12 && (await isPortListening(cfg.gatewayPort)); i++) {
          await new Promise((r) => setTimeout(r, 300))
        }
      }
      if (await isPortListening(cfg.gatewayPort)) {
        return {
          started: false,
          ok: false,
          mode: plan.mode,
          reason: `端口 ${cfg.gatewayPort} 被占用但服务无响应，且不是本插件启动的`,
          hint: `在终端运行 lsof -nP -iTCP:${cfg.gatewayPort} -sTCP:LISTEN 找到进程，确认后可 kill -9 <PID>`,
          logTail: readLogTail(),
        }
      }
    }

    // 3) 启动
    const migrated = migrateLegacyData(plan.dataDir)
    let fd
    try {
      mkdirSync(plan.dataDir, { recursive: true })
      fd = openSync(gatewayLog, 'a')
      const args = [
        plan.entry,
        '--host', '127.0.0.1',
        '--port', String(cfg.gatewayPort),
        '--accounts-dir', plan.accountsDir,
        '--usage-dir', plan.usageDir,
      ]
      if (cfg.panelPassword) args.push('--panel-password', cfg.panelPassword)

      const child = spawn(plan.python, args, {
        cwd: plan.dir,
        stdio: ['ignore', fd, fd],
        detached: false, // 跟着 DSH：退出时由 disposer 收掉
        env: childEnv(),
      })
      gatewayChild = child
      adoptedPid = null
      writePidfile(child.pid)

      child.on('exit', (code, signal) => {
        trace(`网关进程退出 code=${code} signal=${signal}`)
        if (gatewayChild === child) {
          gatewayChild = null
          clearPidfile()
        }
      })
      child.on('error', (err) => trace(`网关进程 error: ${err?.message ?? err}`))

      const startedMsg = `已启动网关（${plan.mode}）pid=${child.pid} python=${plan.python}`
      log.info?.(startedMsg)
      trace(`${startedMsg} entry=${plan.entry} dataDir=${plan.dataDir}`)

      const began = Date.now()
      const deadline = began + (Number(cfg.startTimeoutMs) || 25000)
      let last = { up: false }
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000))
        last = await probe(2500)
        if (last.up) break
        if (!gatewayChild) break // 进程已退出，再等没意义
      }

      const result = {
        started: true,
        ok: Boolean(last.up),
        mode: plan.mode,
        pid: child.pid,
        python: plan.python,
        entry: plan.entry,
        dir: plan.dir,
        dataDir: plan.dataDir,
        accountsDir: plan.accountsDir,
        usageDir: plan.usageDir,
        logPath: gatewayLog,
        up: Boolean(last.up),
        health: last.health,
        waitedMs: Date.now() - began,
      }
      if (migrated) result.migrated = migrated
      if (!last.up) {
        result.reason = gatewayChild ? '网关进程在跑，但未在超时内就绪' : '网关进程已退出'
        result.logTail = readLogTail()
        trace(`启动失败 waitedMs=${result.waitedMs} logTail=${String(result.logTail).slice(0, 400)}`)
      }
      return result
    } catch (err) {
      return { started: false, ok: false, mode: plan.mode, reason: String(err?.message ?? err), logPath: gatewayLog }
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  /** 停止由本插件启动/接管的网关；外部进程不碰。 */
  function stopGateway() {
    const pid = ownedPid()
    if (!pid) return { stopped: false, reason: '当前网关不由本插件托管，未动它' }

    const grace = Number(cfg.stopGraceMs) || 5000
    const child = gatewayChild
    try {
      if (child) child.kill('SIGTERM')
      else process.kill(pid, 'SIGTERM')
    } catch {
      /* 可能已退出 */
    }
    const t = setTimeout(() => {
      try {
        if (child) child.kill('SIGKILL')
        else process.kill(pid, 'SIGKILL')
      } catch {
        /* 忽略 */
      }
    }, grace)
    t.unref?.()

    gatewayChild = null
    adoptedPid = null
    clearPidfile()
    const msg = `已请求停止网关（pid ${pid}，${grace}ms 后强制）`
    log.info?.(msg)
    trace(msg)
    return { stopped: true, pid, graceMs: grace }
  }

  async function panelSession() {
    if (panelToken) return panelToken
    if (!cfg.panelPassword) return null
    try {
      const res = await fetch(`${base}/panel/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: cfg.panelPassword }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      const data = await res.json()
      panelToken = data?.token ?? null
      return panelToken
    } catch {
      return null
    }
  }

  const disposers = []

  /** 注册 HTTP 路由。只在 webServer 就绪后被调用。 */
  function registerRoutes(webServer) {
    const addRoute = (kind, path, handler) => {
      try {
        disposers.push(webServer.register({ kind, path, handler }))
        trace(`路由已注册 ${kind} ${path}`)
      } catch (err) {
        trace(`路由注册失败 ${path}: ${err?.message ?? err}`)
        log.warn?.(`路由注册失败 ${path}: ${err?.message ?? err}`)
      }
    }

    addRoute('exact', '/workbuddy/status', async (_req, res) => {
      const p = await probe()
      sendJson(res, 200, {
        gatewayUrl: base,
        panelUrl: `${base}/`,
        // 面板必须**直连**网关源站。
        // 它的内部 API 走绝对路径（/panel/status、/accounts/*），因此任何
        // 「路径前缀式」反向代理都会把这些请求留在 DSH 自己的源上，表现为
        // 「无法连接反代」+ 添加账号 405。网关源站无 X-Frame-Options / CSP，
        // 跨源 iframe 可直接嵌入（已实测通过）。
        panelIframeUrl:
          cfg.panelAutoLogin !== false && cfg.panelPassword
            ? `${base}/?pwd=${encodeURIComponent(cfg.panelPassword)}`
            : `${base}/`,
        // ── 网关来源与运行方案 ──
        mode: gatewayPlan?.mode ?? resolveGatewayPlan().mode,
        gatewayDir: gatewayPlan?.dir ?? null,
        python: gatewayPlan?.python ?? null,
        dataDir: gatewayPlan?.dataDir ?? resolveDataDir(),
        logPath: gatewayLog,
        // ── 生命周期 ──
        autoStart: Boolean(cfg.autoStart),
        stopOnExit: cfg.stopOnExit !== false,
        managed: ownsGateway(),
        managedPid: ownedPid(),
        // 兼容字段
        launchScript: script,
        launchScriptExists: Boolean(script) && existsSync(script),
        panelPasswordConfigured: Boolean(cfg.panelPassword),
        ...p,
      })
    })

    addRoute('exact', '/workbuddy/gateway/start', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      // 逻辑全在 startGateway：解析来源 → 处理三种既有状态 → spawn → 轮询等就绪
      const result = await startGateway()
      sendJson(res, 200, result)
    })

    addRoute('exact', '/workbuddy/gateway/stop', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      const r = stopGateway()
      // 等它真的退下去再复探，前端拿到的是停止后的状态
      await new Promise((x) => setTimeout(x, 1500))
      const after = await probe(1500)
      sendJson(res, 200, { ...r, up: after.up })
    })

    addRoute('exact', '/workbuddy/models', async (_req, res) => {
      const m = await fetchModels()
      if (m.ok) return sendJson(res, 200, { models: m.models })
      sendJson(res, 502, m)
    })

    addRoute('exact', '/workbuddy/realm', async (req, res) => {
      if (req.method === 'GET') {
        try {
          const r = await fetch(`${base}/realm`, { signal: AbortSignal.timeout(4000) })
          return sendJson(res, 200, await r.json())
        } catch (err) {
          return sendJson(res, 502, { error: String(err?.message ?? err) })
        }
      }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })

      const { realm } = await readJsonBody(req)
      if (realm !== 'intl' && realm !== 'cn') {
        return sendJson(res, 400, { error: "realm 必须是 'intl' 或 'cn'" })
      }
      const token = await panelSession()
      if (!token) {
        return sendJson(res, 401, {
          error: '无法取得面板会话：检查 panelPassword 是否与面板当前密码一致',
        })
      }
      try {
        const r = await fetch(`${base}/realm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Panel-Token': token },
          body: JSON.stringify({ realm }),
          signal: AbortSignal.timeout(5000),
        })
        sendJson(res, r.status, await r.json())
      } catch (err) {
        sendJson(res, 502, { error: String(err?.message ?? err) })
      }
    })

    // 注意：这里**不要**加路径前缀式的反向代理（曾实现为 /workbuddy-panel/*）。
    // 面板前端用绝对路径调自己的 API（/panel/status、/accounts/*、/realm…），
    // 前缀代理只能覆盖被改写过的相对路径，绝对路径请求仍会落到 DSH 源上并 404/405，
    // 面板就会报「无法连接反代」「添加账号 发起失败: 405」。
    // 正确做法是让 iframe 直连网关源站（见 status 的 panelIframeUrl）。
  }

  // webServer 后注入：等它就绪再注册路由；headless 组合下回调不会触发，
  // 插件仍然完成网关生命周期管理。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      const ws =
        scope?.webServer ??
        (typeof scope?.get === 'function' ? scope.get('webServer') : undefined)
      trace(`ctx.inject 回调触发，webServer=${ws ? '可用' : '不可用'}`)
      if (ws) registerRoutes(ws)
    })
  } else {
    trace('ctx.inject 不可用，跳过路由注册')
  }

  // ─────────────────────── 生命周期：DSH 退出即停网关 ───────────────────────
  // 插件的 disposer 在 DSH 退出（或插件热重载）时执行，这里停掉由本插件
  // 启动/接管的网关。外部门自己跑的网关不会被碰。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (cfg.stopOnExit !== false) {
        try {
          stopGateway()
        } catch (err) {
          trace(`停止网关失败: ${err?.message ?? err}`)
        }
      }
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已被热重载清理 */
        }
      }
    })
  }

  // 兜底：进程真正退出时，若我们 spawn 的网关还活着，同步补一刀 SIGKILL。
  // （disposer 是优雅路径；这里覆盖 DSH 异常退出的情况。只动我们自己 spawn
  //  的 pid，绝不碰外部网关。）
  const exitGuard = () => {
    const pid = gatewayChild?.pid
    if (!pid) return
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
  process.once('exit', exitGuard)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        process.removeListener('exit', exitGuard)
      } catch {
        /* 忽略 */
      }
    })
  }

  // ------------------------------------------------- 启动时自动探测 / 拉起
  void (async () => {
    const p = await probe()
    trace(`启动探测: ${JSON.stringify(p).slice(0, 240)}`)
    if (p.up) {
      // 已在服务：若 pidfile 指向存活的遗留进程，就接管它的生命周期
      const prev = readPidfile()
      if (prev && isAlive(prev)) {
        adoptedPid = prev
        trace(`接管遗留网关 pid=${prev}（DSH 退出时将停止它）`)
      }
      gatewayPlan = { ...(gatewayPlan ?? {}), mode: resolveGatewayPlan().mode }
      log.info?.(
        `网关已就绪 ${base}（realm=${p.health?.realm ?? '?'}, accounts=${p.health?.accounts ?? '?'}）`,
      )
      return
    }
    if (!cfg.autoStart) {
      log.info?.(`网关未运行，且 autoStart=false：${base}`)
      return
    }
    log.info?.('网关未运行，自动拉起…')
    const r = await startGateway()
    trace(`自动拉起结果: ${JSON.stringify(r).slice(0, 320)}`)
  })()

  // ------------------------------------------------------- 可选后台健康检查
  if (cfg.healthIntervalMs > 0) {
    const timer = setInterval(() => void probe().catch(() => {}), cfg.healthIntervalMs)
    timer.unref?.()
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(timer))
  }
}
