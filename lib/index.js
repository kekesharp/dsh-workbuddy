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
 * 网关本身不打包在本插件里：它由 workbuddy2api-hub 独立发布与安装。
 *
 * @module dsh-workbuddy
 */

import { spawn } from 'node:child_process'
import { existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

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
  autoStart: true,
  launchScript: '',
  gatewayPort: 8788,
  panelPassword: '',
  /** 配了 panelPassword 时，进入面板根路径自动带 ?pwd= 登录，省掉每次手输。 */
  panelAutoLogin: true,
  healthIntervalMs: 15000,
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

  function spawnGateway() {
    if (!script || !existsSync(script)) {
      return { started: false, reason: 'launchScript 不存在', launchScript: script }
    }
    try {
      const child = spawn('/bin/bash', [script, String(cfg.gatewayPort)], {
        detached: true,
        stdio: 'ignore',
        cwd: dirname(script),
      })
      child.unref()
      log.info?.(`已拉起网关 ${script} ${cfg.gatewayPort}（pid ${child.pid}）`)
      trace(`已拉起网关 pid=${child.pid}`)
      return { started: true, pid: child.pid, launchScript: script }
    } catch (err) {
      return { started: false, reason: String(err?.message ?? err), launchScript: script }
    }
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
        launchScript: script,
        launchScriptExists: Boolean(script) && existsSync(script),
        autoStart: Boolean(cfg.autoStart),
        panelPasswordConfigured: Boolean(cfg.panelPassword),
        ...p,
      })
    })

    addRoute('exact', '/workbuddy/gateway/start', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      const before = await probe(2000)
      if (before.up) {
        return sendJson(res, 200, { started: false, reason: '网关已在运行', up: true, health: before.health })
      }
      const started = spawnGateway()
      await new Promise((r) => setTimeout(r, 3000))
      const after = await probe(5000)
      sendJson(res, 200, { ...started, up: after.up, health: after.health })
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

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已被热重载清理 */
        }
      }
    })
  }

  // ------------------------------------------------- 启动时自动探测 / 拉起
  void (async () => {
    const p = await probe()
    trace(`启动探测: ${JSON.stringify(p).slice(0, 240)}`)
    if (p.up) {
      log.info?.(
        `网关已就绪 ${base}（realm=${p.health?.realm ?? '?'}, accounts=${p.health?.accounts ?? '?'}）`,
      )
      return
    }
    if (!cfg.autoStart) {
      log.info?.(`网关未运行，且 autoStart=false：${base}`)
      return
    }
    log.info?.('网关未运行，尝试自动拉起…')
    spawnGateway()
  })()

  // ------------------------------------------------------- 可选后台健康检查
  if (cfg.healthIntervalMs > 0) {
    const timer = setInterval(() => void probe().catch(() => {}), cfg.healthIntervalMs)
    timer.unref?.()
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(timer))
  }
}
