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
  readSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
  statSync,
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
   * 看门狗：后台健康检查发现网关**确实挂了**就自动重拉。
   *
   * 这是「用着用着模型突然不可用」最常见的成因——网关进程中途退出
   * （被误杀、端口冲突、上游断连后自退）。开着它能把中断窗口压到十几秒；
   * 关掉的话，用户只会看到模型的 TRANSPORT 报错，还得自己去翻日志。
   */
  watchdog: true,
  /** 两次自愈重启之间的最小间隔（毫秒），避免拉起风暴。 */
  watchdogCooldownMs: 30000,
  /**
   * 日志取证：/health 只能证明「HTTP 服务还活着」，证明不了「它还能出网」。
   *
   * 实测故障（2026-11-09，DSH 0.2.2-rc.1）：网关进程的 DNS 解析器卡死，
   * `/health`、`/v1/models`（本地缓存）全都 200，面板也照常打开，可每次上游
   * 请求都卡约 126 秒后抛 `socket.gaierror` → `URLError: [Errno 8] nodename
   * nor servname provided`，用户侧就是「模型全 503 + 两分钟转圈」。只看
   * /health 的看门狗永远判它健康，于是永远不自愈。
   *
   * 这里改成对网关日志取证：出现「本机没网」类证据就重启进程（重启即换掉
   * 那个卡死的解析器状态，实测 1.7s 恢复）。关掉则退回只看 /health 的老行为。
   */
  logWatch: true,
  /**
   * `logWatchWindowMs` 窗口内累计多少条出网故障证据才重启。
   *
   * 默认 2：一条可能只是网络抖动（合盖唤醒、切 WiFi 都会来一条），两条说明
   * 这个进程**反复**解析不了域名——那不是抖动，是它的解析器已经坏了。
   * 设 1 = 见到第一条就重启（最激进），设很大 = 只当记录不当触发。
   */
  logWatchStreak: 2,
  /** 故障证据的累计窗口（毫秒）：窗口外的旧证据清掉。 */
  logWatchWindowMs: 600000,
  /** 每次从日志尾部增量读取的字节上限。 */
  logWatchTailBytes: 262144,
  /** 自愈重启的冷却上限（毫秒）：同一故障反复修不好时退避到这里。 */
  watchdogCooldownMaxMs: 600000,
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

/**
 * 读取内嵌网关的上游版本元数据（vendor/wb-proxy/UPSTREAM.json）。
 * 外部安装通常没有这个文件，返回 null 即可，不影响任何功能。
 */
function readGatewayVersion(dir) {
  try {
    if (!dir) return null
    const p = join(dir, 'UPSTREAM.json')
    if (!existsSync(p)) return null
    const meta = JSON.parse(readFileSync(p, 'utf8'))
    if (!meta?.tag) return null
    return { tag: meta.tag, commit: meta.commit ?? null, syncedAt: meta.synced_at ?? null }
  } catch {
    return null
  }
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

  /** 自愈记账：次数、最近一次结果、以及故障修不好时的退避。 */
  let selfHealCount = 0
  let lastHeal = null
  let healBackoffMs = 0

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

  /**
   * 当前网关的版本元数据：优先运行方案里的目录，其次内置，最后外部安装。
   * 只读 UPSTREAM.json，不探测 python，可以每轮状态轮询调用。
   */
  function currentGatewayVersion() {
    return (
      readGatewayVersion(gatewayPlan?.dir) ??
      readGatewayVersion(resolveVendorDir()) ??
      readGatewayVersion(resolveExternalDir())
    )
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
    // 上游 1.7 起仓库是扁平布局（wb_proxy.py 在根目录），早期的克隆则是 wb-proxy/ 子目录
    out.push(join(homedir(), 'workbuddy2api-hub', 'wb-proxy'))
    out.push(join(homedir(), 'workbuddy2api-hub'))
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
      version: readGatewayVersion(dir),
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

  // ────────────── 出网故障取证（日志增量扫描） ──────────────
  //
  // 网关把「本机没网」与上游请求失败都落在 dsh-gateway.log 里。DNS 卡死时
  // 这些进程还活着、端口还服务，唯一的外部可观测证据就是这几行文本，所以
  // 看门狗必须读它，否则「活着但不可用」永远发现不了。
  //
  // 只认**明确的解析/本机网络失败**，不认普通 5xx、429、超时：那些是上游
  // 或账号侧的问题，重启本地进程什么也修不好，只会打断正在跑的请求。
  const LOCAL_NET_MARKERS = [
    'local network looks down',
    'nodename nor servname provided',
    'Temporary failure in name resolution',
    'Name or service not known',
    'getaddrinfo failed',
    'Name resolution is temporarily unavailable',
  ]

  /** 上次扫到的字节位置；null = 还没建立基线。 */
  let logCursor = null
  /** 最近一次扫描结果快照，供 /workbuddy/status 展示。 */
  let lastLogScan = null

  // 基线：只把**本次 apply 之后**新写进来的故障当成本次故障。上一轮崩溃留下的
  // Errno 8 还在日志尾部，若不建基线，DSH 一起动就会把健康的网关重启一遍。
  try {
    logCursor = existsSync(gatewayLog) ? statSync(gatewayLog).size : null
  } catch {
    logCursor = null
  }

  /**
   * 从 logCursor 起增量扫描网关日志。
   * 返回 { hits, evidence, size }：hits 为新出现的故障行数。
   */
  function scanGatewayLog() {
    if (!gatewayLog || !existsSync(gatewayLog)) return { hits: 0, evidence: null }
    let size
    try {
      size = statSync(gatewayLog).size
    } catch {
      return { hits: 0, evidence: null }
    }
    const cap = Math.max(4096, Number(cfg.logWatchTailBytes) || 262144)
    // 首次（或日志被轮转/截断）：只从尾部一个窗口开始，不把陈年故障算进来。
    if (logCursor === null || size < logCursor) logCursor = Math.max(0, size - cap)
    if (size <= logCursor) return { hits: 0, evidence: null, size }

    let buf
    try {
      const len = Math.min(size - logCursor, cap)
      buf = Buffer.allocUnsafe(len)
      const fd = openSync(gatewayLog, 'r')
      try {
        readSync(fd, buf, 0, len, logCursor)
      } finally {
        closeSync(fd)
      }
    } catch {
      return { hits: 0, evidence: null, size }
    }
    // 半行留到下次：只有确认读到换行才推进游标，否则下一次会重复同一行。
    const cut = buf.lastIndexOf(0x0a)
    if (cut < 0) return { hits: 0, evidence: null, size }
    const whole = buf.subarray(0, cut + 1).toString('utf8')
    logCursor += cut + 1

    const hits = []
    for (const line of whole.split('\n')) {
      const s = line.trim()
      if (!s) continue
      if (LOCAL_NET_MARKERS.some((m) => s.toLowerCase().includes(m.toLowerCase()))) {
        hits.push(s.slice(0, 300))
      }
    }
    if (hits.length) {
      lastLogScan = { at: Date.now(), hits: hits.length, evidence: hits[hits.length - 1] }
    }
    return { hits: hits.length, lines: hits, evidence: hits.length ? hits[hits.length - 1] : null, size }
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
  async function startGatewayInner() {
    const plan = resolveGatewayPlan()
    gatewayPlan = {
      mode: plan.mode,
      ok: plan.ok,
      error: plan.error ?? null,
      dir: plan.dir ?? null,
      version: plan.version ?? null,
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
    //
    // 但「刚 spawn、还在 bind」的自己人也表现为「端口被占、服务不响应」，绝不能
    // 当僵尸杀掉——那正是并发 start/stop 互相打的一枪。自己的子进程一律等它就绪。
    if (await isPortListening(cfg.gatewayPort)) {
      const stale = readPidfile()
      if (stale && gatewayChild?.pid === stale) {
        const msg = `端口已被自己刚拉起的网关占用（pid ${stale}），等它就绪而不是清掉它`
        trace(msg)
        return { started: false, ok: true, starting: true, mode: plan.mode, pid: stale, up: false, reason: msg }
      }
      if (stale && isAlive(stale)) {
        try {
          process.kill(stale, 'SIGKILL')
          trace(`僵尸清理：SIGKILL pid=${stale}（端口占着但不响应）`)
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
        env: {
          ...childEnv(),
          // 上游 1.7.x 会把最近一次成功拉到的 /v3/config 原始目录归档到这里；
          // 默认落在脚本同目录。指到数据目录：插件升级（整目录替换 vendor）时不丢，
          // 也不往代码目录里写运行时文件。
          WB_PROXY_CATALOG_DIR: join(plan.dataDir, 'catalog'),
        },
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
        gatewayVersion: plan.version?.tag ?? null,
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
  function stopGatewayInner() {
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
        trace(`停止网关：${grace}ms 宽限期到，SIGKILL pid=${pid}`)
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

  /**
   * 自愈重启：先停掉本插件托管的进程，等端口真的空出来，再拉一个新的。
   *
   * 顺序不能反：`startGateway()` 的第一步是「端口已在服务就接管」，SIGTERM
   * 的 grace 期里直接调它只会把那个正在死的进程重新接管回来，等于没重启。
   * 外部网关（不是本插件起的）一律不动——这是插件一贯的边界。
   */
  async function restartGatewayInner(reason) {
    const before = ownedPid()
    if (!before) {
      // 没托管有两种：① 外部网关在跑 → 一律不碰；② 已经什么都没在跑
      // （进程崩溃后被 exit 处理器清了状态）→ 这正是最该拉起的时候。
      const cur = await probe(2000).catch(() => ({ up: false }))
      if (cur.up) {
        const msg = `自愈跳过：网关由外部启动（pid ${readPidfile() ?? '?'}），不接管其生命周期`
        trace(msg)
        lastHeal = { at: Date.now(), reason, ok: false, fromPid: null, toPid: null, skipped: msg }
        return { ok: false, reason: msg, external: true }
      }
      const started0 = await startGatewayInner()
      selfHealCount += 1
      lastHeal = {
        at: Date.now(),
        reason,
        ok: Boolean(started0.ok),
        fromPid: null,
        toPid: started0.pid ?? null,
      }
      trace(`自愈拉起（此前无托管进程，${reason}）→ ${started0.ok ? `pid ${started0.pid ?? '-'}` : `失败：${started0.reason ?? 'unknown'}`}`)
      return started0
    }
    const stopped = stopGatewayInner()
    const deadline = Date.now() + (Number(cfg.stopGraceMs) || 5000) + 8000
    while (Date.now() < deadline) {
      const p = await probe(1200).catch(() => ({ up: false }))
      if (!p.up && !(await isPortListening(cfg.gatewayPort, 500))) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const started = await startGatewayInner()
    selfHealCount += 1
    lastHeal = {
      at: Date.now(),
      reason,
      ok: Boolean(started.ok),
      fromPid: before,
      toPid: started.pid ?? null,
      stoppedPid: stopped.pid ?? null,
    }
    const msg = `自愈重启（${reason}）：pid ${before} → ${started.ok ? `pid ${started.pid ?? '-'}` : `拉起失败：${started.reason ?? 'unknown'}`}`
    if (started.ok) log.warn?.(msg)
    else log.error?.(msg)
    trace(msg)
    return started
  }

  // ────────────── 生命周期串行化 ──────────────
  //
  // 看门狗、面板按钮、启动探测三条路径都可能同时进来。并发 start/stop 实测会
  // 互相伤害：A 刚 spawn 的进程还在 bind，B 看到的却是「端口占着不响应」，于是
  // 按僵尸处理 SIGKILL 掉——监控看起来「重启成功了」，实际上把新进程打死了。
  // 所有生命周期操作排成一条链，一次只跑一个。
  let lifecycleChain = Promise.resolve()

  function withLifecycle(fn) {
    const run = lifecycleChain.then(fn, fn)
    lifecycleChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const startGateway = () => withLifecycle(startGatewayInner)
  const stopGateway = () => withLifecycle(stopGatewayInner)
  const restartGateway = (reason) => withLifecycle(() => restartGatewayInner(reason))

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
      const gwVersion = currentGatewayVersion()
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
        gatewayVersion: gwVersion?.tag ?? null,
        gatewayVersionCommit: gwVersion?.commit ?? null,
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
        // ── 自愈 ──
        // gatewayPid 活着不等于能用：DNS 卡死时 /health 依然 200（见 DEFAULTS 里
        // logWatch 的注释）。把「日志取证看到了什么」和「重启过几次」一并暴露，
        // 出问题时这里能直接看出是插件没自愈，还是上游/账号真的挂了。
        selfHeal: {
          enabled: cfg.watchdog !== false && cfg.logWatch !== false,
          count: selfHealCount,
          backoffMs: healBackoffMs,
          last: lastHeal,
          logWatch: lastLogScan,
        },
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

    // 手动重启：给「模型能连上但一直在转圈」这种情况一个一键自救入口，
    // 不必等看门狗、也不必去面板里点停止再启动。外部网关照样不碰。
    addRoute('exact', '/workbuddy/gateway/restart', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      const result = await restartGateway('手动重启')
      sendJson(res, 200, result)
    })

    // 一键自检：把「为什么不可用」拆成可判定的检查项。
    // 面向的是刚装完插件、或者突然用不了的其他使用者——他们看不到我们的日志，
    // 这个接口把 vendor / python / 数据目录 / 端口 / 账号 / 日志 一次性列清楚。
    addRoute('exact', '/workbuddy/diagnose', async (req, res) => {
      const plan = resolveGatewayPlan()
      const p = await probe(3000)
      const portHeld = await isPortListening(cfg.gatewayPort)
      const dataDir = resolveDataDir()
      // ?deep=1 额外做一次「真的发一次 1 token 的对话」验证：/health 只能证明
      // HTTP 服务活着，证明不了这个进程还能解析域名、连得上上游。默认关着，
      // 因为这一项会真的消耗一次极小的额度。
      let deep = false
      try {
        deep = new URL(req?.url ?? '/', 'http://127.0.0.1').searchParams.get('deep') === '1'
      } catch {
        deep = false
      }

      let dataWritable = false
      try {
        mkdirSync(dataDir, { recursive: true })
        const probeFile = join(dataDir, '.write-test')
        writeFileSync(probeFile, 'ok')
        rmSync(probeFile, { force: true })
        dataWritable = true
      } catch {
        /* 不可写 */
      }

      const vendorDir = resolveVendorDir()
      const externalDir = resolveExternalDir()
      const accountsDir = join(dataDir, 'accounts')
      const hasAccounts = existsSync(accountsDir)

      // 注意：ok 只代表「这一项本身是否正常」，不适用于当前模式的项要标 applicable:false，
      // 否则新用户会看到一个无关的 ❌ 就以为装坏了（比如 vendored 模式下没有外部网关）。
      const checks = {
        mode: { ok: plan.mode !== 'off', value: plan.mode },
        vendorGateway: { ok: Boolean(vendorDir), path: vendorDir, used: plan.mode === 'vendored' },
        // 版本是信息项：外部安装没有 UPSTREAM.json 时显示未知，不算故障
        gatewayVersion: {
          ok: true,
          informative: true,
          tag: plan.version?.tag ?? null,
          commit: plan.version?.commit ?? null,
          syncedAt: plan.version?.syncedAt ?? null,
        },
        externalGateway: {
          ok: Boolean(externalDir) || plan.mode !== 'external',
          path: externalDir,
          used: plan.mode === 'external',
          applicable: plan.mode === 'external',
        },
        python: { ok: Boolean(plan.python), path: plan.python ?? null, configured: cfg.pythonPath || null },
        dataDir: { ok: dataWritable, path: dataDir, writable: dataWritable },
        accounts: { ok: hasAccounts, path: accountsDir },
        port: { ok: p.up, port: cfg.gatewayPort, listening: portHeld },
        // 日志是信息项，不作通过/失败判定
        log: { ok: true, informative: true, path: gatewayLog, exists: existsSync(gatewayLog) },
        managed: {
          ok: true,
          informative: true,
          managed: ownsGateway(),
          pid: ownedPid(),
          stopOnExit: cfg.stopOnExit !== false,
        },
        // 出网取证：日志里最近一次「本机没网」类证据，以及自愈记账。
        // 这一项默认是信息项——只有拿到具体证据才判失败，免得把「日志里没有
        // 相关行」误报成故障。
        selfHeal: {
          ok: !(lastLogScan && lastLogScan.hits > 0 && !p.up),
          informative: !lastLogScan || lastLogScan.hits === 0,
          count: selfHealCount,
          backoffMs: healBackoffMs,
          last: lastHeal,
          logWatch: lastLogScan,
        },
      }

      // 深度检查：走网关自己的上游链路发一次最小请求
      if (deep) {
        const t0 = Date.now()
        let model = 'deepseek-v4.1-flash'
        try {
          const m = await fetchModels(8000)
          model = m.models?.[0]?.id ?? model
        } catch {
          /* 用默认模型兜底 */
        }
        try {
          const r = await fetch(`${base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }],
            }),
            signal: AbortSignal.timeout(30000),
          })
          const body = await r.text()
          checks.outbound = {
            ok: r.ok,
            deep: true,
            model,
            httpStatus: r.status,
            ms: Date.now() - t0,
            sample: body.slice(0, 300),
          }
        } catch (err) {
          checks.outbound = {
            ok: false,
            deep: true,
            model,
            ms: Date.now() - t0,
            error: String(err?.message ?? err),
          }
        }
      } else {
        checks.outbound = { ok: true, informative: true, deep: false, skipped: '加 ?deep=1 做一次真实上游请求' }
      }

      const hints = []
      if (plan.error) hints.push(plan.error)
      if (!vendorDir && plan.mode !== 'external') {
        hints.push('找不到内嵌网关：确认安装时 package.json 的 files 含 vendor（npm 打包常见漏项）')
      }
      if (!plan.python) hints.push('找不到 Python 3.9+：安装 Python 或用 pythonPath 指定绝对路径')
      if (!dataWritable) hints.push(`数据目录不可写：${dataDir}`)
      if (!hasAccounts) hints.push('还没有账号：打开面板登录一次（数据目录里目前没有 accounts/）')
      if (portHeld && !p.up) {
        hints.push(`端口 ${cfg.gatewayPort} 被占但无响应：用 lsof -nP -iTCP:${cfg.gatewayPort} -sTCP:LISTEN 找出进程`)
      }
      if (!p.up && plan.ok) hints.push('网关未运行：点面板里的「启动网关」，或重启 DSH 触发 autoStart')
      if (checks.outbound && !checks.outbound.ok && p.up) {
        hints.push(
          '网关进程活着但连不上上游（DNS/出网卡死）：点「重启网关」或等看门狗自愈——' +
            '这类故障下 /health 仍是 200，所以只看端口是看不出来的',
        )
      }

      sendJson(res, 200, {
        ok: Boolean(p.up && plan.ok),
        checks,
        managed: ownsGateway(),
        health: p.health ?? null,
        logTail: readLogTail(20),
        hints,
      })
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
      trace(`进程退出兜底：SIGKILL pid=${pid}`)
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

  // ────────────── 后台健康检查 + 自愈看门狗 ──────────────
  //
  // 只探测不处理是不够的：网关中途挂掉时，用户侧只会看到模型报 TRANSPORT，
  // 完全不知道发生了什么。这里在确认它**确实**挂了之后自动拉回来。
  //
  // 判定用「连续两次不可达」而不是单次失败：单次探测失败可能只是上游一时
  // 卡顿或 DSH 自身忙，误判会导致无谓重启、反而把健康的网关打断。
  //
  // 2026-11-09 补第二类故障：**进程活着，但出网已死**。DSH 更新那一刻网关
  // 进程的 DNS 解析器卡死：`/health` 与 `/v1/models`（本地缓存）全都 200，
  // 面板也照常打开，可每次上游请求都卡约 126 秒后抛 socket.gaierror，用户侧
  // 就是「所有模型 503 + 两分钟转圈」。只看 /health 的看门狗永远判它健康，
  // 于是永远不会自愈。这里再加一条取证通道：增量读网关日志里的「本机没网」
  // 证据，连续 logWatchStreak 次检查都读到新证据就重启进程——重启换掉的正是
  // 那个卡死的解析器状态（实测重启后 1.7 秒恢复正常）。
  if (cfg.healthIntervalMs > 0) {
    let failStreak = 0 // /health 连续不可达次数
    /** 窗口内的出网故障证据时间戳（一条日志 = 一次失败的出网尝试）。 */
    let netHits = []
    let cleanTicks = 0 // 连续「没有新证据」的次数，用于解除退避
    let lastRestartAt = 0
    const baseCooldown = Math.max(5000, Number(cfg.watchdogCooldownMs) || 30000)
    const maxCooldown = Math.max(baseCooldown, Number(cfg.watchdogCooldownMaxMs) || 600000)
    const netThreshold = Math.max(1, Number(cfg.logWatchStreak) || 2)
    const netWindowMs = Math.max(5000, Number(cfg.logWatchWindowMs) || 600000)
    /** 当前冷却：基础值或退避值，封顶 maxCooldown。 */
    const cooldown = () => Math.min(maxCooldown, healBackoffMs || baseCooldown)
    /** 自愈没修好就翻倍退避：真没网时不该每 30 秒重启一遍。 */
    const bumpBackoff = () => {
      healBackoffMs = Math.min(maxCooldown, (healBackoffMs || baseCooldown) * 2)
    }
    const clearBackoff = () => {
      if (healBackoffMs) trace(`看门狗：出网已稳定，解除重启退避（此前 ${healBackoffMs}ms）`)
      healBackoffMs = 0
    }
    const healAllowed = () => cfg.watchdog !== false && cfg.autoStart !== false

    // 任何异常都不能冒泡：看门狗跑在 setInterval 里，一次未捕获的 rejection 就会
    // 打掉整个插件宿主进程（实测：一个残留变量名足以让 DSH 直接掉线）。
    const tick = async () => {
      try {
        await runTick()
      } catch (err) {
        trace(`看门狗异常（已忽略，下一轮继续）: ${err?.message ?? err}`)
      }
    }

    const runTick = async () => {
      const p = await probe().catch(() => ({ up: false }))

      // ① 进程还在服务吗
      if (!p.up) {
        netHits = []
        failStreak += 1
        if (failStreak === 1) trace('健康检查：网关不可达（第 1 次，先观察）')
        if (!healAllowed()) return
        if (failStreak < 2) return
        if (Date.now() - lastRestartAt < cooldown()) return
        lastRestartAt = Date.now()
        const msg = `看门狗：连续 ${failStreak} 次不可达，尝试自愈重拉`
        log.warn?.(msg)
        trace(msg)
        try {
          const r = await restartGateway('健康检查连续不可达')
          trace(`看门狗重拉结果: ${JSON.stringify(r).slice(0, 280)}`)
          if (r?.ok) failStreak = 0
          else bumpBackoff()
        } catch (err) {
          bumpBackoff()
          trace(`看门狗重拉异常: ${err?.message ?? err}`)
        }
        return
      }
      if (failStreak >= 2) trace(`看门狗：网关已恢复（此前连续 ${failStreak} 次不可达）`)
      failStreak = 0

      // ② 活着，但还出得了网吗：读日志取证
      if (!cfg.logWatch || !healAllowed()) return
      const scan = scanGatewayLog()
      const now = Date.now()
      if (scan.hits) {
        for (let i = 0; i < scan.hits; i++) netHits.push(now)
        trace(
          `看门狗：日志新增出网故障 ${scan.hits} 条（窗口内累计 ${netHits.length}/${netThreshold}）：` +
            String(scan.evidence ?? '').slice(0, 200),
        )
      }
      netHits = netHits.filter((t) => now - t <= netWindowMs)
      if (!netHits.length) {
        cleanTicks += 1
        if (cleanTicks >= 4) clearBackoff()
        return
      }
      cleanTicks = 0
      if (netHits.length < netThreshold) return
      if (now - lastRestartAt < cooldown()) return
      lastRestartAt = now
      const evidence = scan.evidence ?? lastLogScan?.evidence ?? ''
      netHits = []
      try {
        const r = await restartGateway('网关活着但出网已死（DNS/本机网络故障）')
        // 重启成功不等于修好：真断网时后面还会继续出现证据，靠退避把频率压下去。
        bumpBackoff()
        if (!r?.ok) trace(`看门狗：出网自愈的拉起没有成功，证据=${String(evidence).slice(0, 160)}`)
      } catch (err) {
        bumpBackoff()
        trace(`看门狗出网自愈异常: ${err?.message ?? err}`)
      }
    }

    const timer = setInterval(() => void tick(), cfg.healthIntervalMs)
    timer.unref?.()
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(timer))
  }
}
