/**
 * dsh-workbuddy — 浏览器端入口：右下角状态胶囊 + 内嵌网关面板抽屉。
 *
 * ⚠️ 必须是 DSH 前端的模块格式：`window.__ModuleLoader__.load({ id, factory })`，
 * 且 `factory` 必须**返回模块 exports 对象**。
 * 裸 IIFE（直接执行、无返回值）会被 renderer 判定为 `import failed`，表现为
 * 启动时 "web boot: 1 entry did not activate" 并弹出崩溃窗——desktop（Electron
 * renderer）下这是硬约束，不要改回裸 JS。
 *
 * 零外部依赖：不 require 任何 DSH 客户端包，也不声明 `dsh.client.inject`。
 * 面板通过同源反向代理 /workbuddy-panel/ 挂载，因此不受跨源 iframe 限制。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    /** 初始化本体（一次性守卫，HMR / 重复加载时只挂一份 UI）。 */
    function boot() {
      if (globalThis.__DSH_WORKBUDDY_CLIENT__) return
      globalThis.__DSH_WORKBUDDY_CLIENT__ = true

      /** WorkBuddy 官方图标（96x96 PNG，原图白底圆角已裁成透明），内联为 data URI。 */
      const ICON = 'data:image/png;base64,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'

      const API = '/workbuddy'
      const POLL_MS = 5000

      /**
       * 面板地址：直连网关源站。
       * 面板内部用绝对路径调自己的 API（/panel/status、/accounts/*），
       * 任何「路径前缀式」反代都会让这些请求落到 DSH 源上，表现为
       * 「无法连接反代」与「添加账号 发起失败: 405」。
       */
      const panelSrc = () =>
        status?.panelIframeUrl || status?.panelUrl || 'http://127.0.0.1:8788/'

      let status = null
      let drawerOpen = false
      let iframeLoaded = false
      let timer = null

      const css = `
      /* 右下角图标：32px 圆角正方形，直接使用 WorkBuddy 官方图标。
         默认只显示图标，状态用右下角小圆点，详细文字只在悬停 tooltip 里出现。 */
      #dsh-wb-pill{position:fixed;right:18px;bottom:18px;z-index:2147483000;
        width:32px;height:32px;border-radius:10px;box-sizing:border-box;
        display:grid;place-items:center;cursor:pointer;user-select:none;
        background-image:url(${ICON});
        background-size:100% 100%;background-repeat:no-repeat;
        box-shadow:0 2px 8px rgba(16,120,100,.30),0 1px 2px rgba(0,0,0,.18);
        transition:transform .14s ease,box-shadow .14s ease,opacity .14s ease}
      #dsh-wb-pill:hover{transform:translateY(-1px) scale(1.07);
        box-shadow:0 6px 16px rgba(16,120,100,.40),0 1px 2px rgba(0,0,0,.20)}
      #dsh-wb-pill:active{transform:scale(.97)}
      #dsh-wb-pill .dsh-wb-dot{position:absolute;right:-2px;bottom:-2px;
        width:10px;height:10px;border-radius:50%;background:#22c55e;
        box-shadow:0 0 0 2px #fff;transition:background .2s ease}
      #dsh-wb-pill[data-state="warn"] .dsh-wb-dot{background:#f59e0b}
      #dsh-wb-pill[data-state="down"] .dsh-wb-dot{background:#ef4444}
      @media (prefers-color-scheme:dark){
        #dsh-wb-pill .dsh-wb-dot{box-shadow:0 0 0 2px #151517}
      }
      #dsh-wb-pill .dsh-wb-tip{position:absolute;right:calc(100% + 12px);top:50%;
        transform:translateY(-50%);white-space:nowrap;pointer-events:none;
        background:rgba(20,20,24,.94);color:#e8e8ea;border:1px solid rgba(255,255,255,.12);
        font:500 12px/1.35 ui-sans-serif,system-ui,-apple-system,sans-serif;
        padding:7px 10px;border-radius:8px;opacity:0;
        box-shadow:0 6px 20px rgba(0,0,0,.3);transition:opacity .14s ease}
      #dsh-wb-pill:hover .dsh-wb-tip{opacity:1}
      #dsh-wb-pill .dsh-wb-tip b{font-weight:700}
      #dsh-wb-pill .dsh-wb-tip i{font-style:normal;opacity:.62}
      #dsh-wb-drawer{position:fixed;inset:0 0 0 auto;width:min(1180px,94vw);z-index:2147483001;
        background:#0f1013;border-left:1px solid rgba(255,255,255,.12);
        box-shadow:-12px 0 48px rgba(0,0,0,.5);display:none;flex-direction:column}
      #dsh-wb-drawer[data-open="1"]{display:flex}
      #dsh-wb-bar{display:flex;align-items:center;gap:10px;padding:10px 12px;
        border-bottom:1px solid rgba(255,255,255,.1);color:#e8e8ea;
        font:600 13px/1 ui-sans-serif,system-ui,-apple-system,sans-serif}
      #dsh-wb-bar .dsh-wb-grow{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #dsh-wb-bar button{font:500 12px/1 inherit;color:#e8e8ea;background:rgba(255,255,255,.08);
        border:1px solid rgba(255,255,255,.14);border-radius:7px;padding:6px 10px;cursor:pointer}
      #dsh-wb-bar button:hover{background:rgba(255,255,255,.16)}
      #dsh-wb-bar button[disabled]{opacity:.45;cursor:default}
      #dsh-wb-frame{flex:1 1 auto;width:100%;border:0;background:#fff}
      `

      const pill = document.createElement('div')
      pill.id = 'dsh-wb-pill'
      pill.dataset.state = 'down'
      pill.setAttribute('role', 'button')
      pill.setAttribute('aria-label', 'WorkBuddy 面板')
      // 默认只有一个图标 + 状态点；状态文字放进 hover tooltip，避免挡界面
      pill.innerHTML =
        '<span class="dsh-wb-dot"></span>' +
        '<span class="dsh-wb-tip">WorkBuddy <i>连接中…</i></span>'

      const drawer = document.createElement('div')
      drawer.id = 'dsh-wb-drawer'
      drawer.dataset.open = '0'
      drawer.innerHTML = `
        <div id="dsh-wb-bar">
          <span>WorkBuddy 面板</span>
          <span class="dsh-wb-grow" id="dsh-wb-bar-status"></span>
          <button id="dsh-wb-btn-start" type="button">启动网关</button>
          <button id="dsh-wb-btn-stop" type="button">停止网关</button>
          <button id="dsh-wb-btn-realm" type="button">切换区域</button>
          <button id="dsh-wb-btn-reload" type="button">刷新</button>
          <button id="dsh-wb-btn-ext" type="button">新窗口打开</button>
          <button id="dsh-wb-btn-close" type="button">关闭</button>
        </div>
        <iframe id="dsh-wb-frame" title="WorkBuddy 面板" referrerpolicy="no-referrer"></iframe>
      `

      const style = document.createElement('style')
      style.textContent = css

      const $ = (id) => document.getElementById(id)

      function render() {
        const h = status?.health
        const up = Boolean(status?.up)
        const accounts = Number(h?.accounts ?? 0)
        const ready = Number(h?.accounts_ready ?? 0)
        const realm = h?.realm ?? '—'

        let state = 'down'
        let sub = '网关未运行'
        if (status?.apiOk === false) {
          state = 'down'
          sub = '插件 API 未就绪'
        } else if (up && ready > 0) {
          state = 'ok'
          sub = `${realm} · ${ready}/${accounts} 账号`
        } else if (up) {
          state = 'warn'
          sub = `${realm} · 未登录`
        }

        pill.dataset.state = state
        const tip = pill.querySelector('.dsh-wb-tip')
        if (tip) tip.innerHTML = `WorkBuddy · <b>${sub}</b>`
        const bar = $('dsh-wb-bar-status')
        if (bar) {
          const modeTag = status?.mode ? `${status.mode}${status.managed ? '/托管' : ''}` : '?'
          bar.textContent = up
            ? `${status.gatewayUrl} · ${modeTag} · realm=${realm} · accounts=${accounts} · ready=${ready}`
            : `网关未运行（${status?.gatewayUrl ?? '?'}）· ${modeTag}`
          if (bar.title) bar.removeAttribute('title')
          bar.title = [
            status?.mode ? `来源：${status.mode}` : null,
            status?.gatewayVersion ? `网关：${status.gatewayVersion}` : null,
            status?.gatewayDir ? `代码：${status.gatewayDir}` : null,
            status?.python ? `python：${status.python}` : null,
            status?.dataDir ? `数据：${status.dataDir}` : null,
            status?.managedPid ? `pid：${status.managedPid}` : null,
            status?.stopOnExit === false ? '退出不停网关' : '退出即停网关',
          ]
            .filter(Boolean)
            .join('\n')
        }
        const realmBtn = $('dsh-wb-btn-realm')
        if (realmBtn) realmBtn.disabled = !up
        const startBtn = $('dsh-wb-btn-start')
        if (startBtn) startBtn.disabled = up || status?.apiOk === false
        // 只有「由本插件托管」的网关才给停止按钮——避免误杀别人起的实例
        const stopBtn = $('dsh-wb-btn-stop')
        if (stopBtn) stopBtn.disabled = !status?.managed || status?.apiOk === false
      }

      async function poll() {
        try {
          const r = await fetch(API + '/status', {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
          })
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          status = { ...(await r.json()), apiOk: true }
        } catch (err) {
          // 区分「插件 API 不可达」与「网关未运行」——否则 404 会被误报成网关挂了
          status = { up: false, apiOk: false, error: String(err?.message ?? err) }
        }
        render()
      }

      function startTimer() {
        if (timer) return
        timer = setInterval(poll, POLL_MS)
      }

      function stopTimer() {
        if (!timer) return
        clearInterval(timer)
        timer = null
      }

      async function openDrawer() {
        drawerOpen = true
        drawer.dataset.open = '1'
        if (!iframeLoaded) {
          // 先取一次状态：status.panelIframeUrl 已带面板密码，免手输直接进面板
          await poll()
          $('dsh-wb-frame').src = panelSrc()
          iframeLoaded = true
        }
        pill.style.opacity = '0'
        pill.style.pointerEvents = 'none'
        await poll()
      }

      function closeDrawer() {
        drawerOpen = false
        drawer.dataset.open = '0'
        pill.style.opacity = '1'
        pill.style.pointerEvents = 'auto'
      }

      function wire() {
        pill.addEventListener('click', () => (drawerOpen ? closeDrawer() : void openDrawer()))
        $('dsh-wb-btn-close').addEventListener('click', closeDrawer)

        $('dsh-wb-btn-start').addEventListener('click', async () => {
          const btn = $('dsh-wb-btn-start')
          btn.disabled = true
          btn.textContent = '启动中…'
          try {
            // 后端会轮询等就绪（默认最长 25s），这里要等得住
            const r = await fetch(API + '/gateway/start', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
            })
            const d = await r.json().catch(() => ({}))
            if (!d?.up) {
              const parts = []
              parts.push(d?.reason ?? d?.error ?? `HTTP ${r.status}`)
              if (d?.waitedMs) parts.push(`已等待 ${Math.round(d.waitedMs / 1000)}s`)
              if (d?.logTail) parts.push('\n\n── 网关日志（末几行）──\n' + d.logTail)
              else if (d?.logPath) parts.push('\n\n日志文件：' + d.logPath)
              window.alert('网关启动失败：' + parts.join('\n'))
            }
          } catch (err) {
            window.alert('网关启动失败：' + String(err?.message ?? err))
          } finally {
            btn.textContent = '启动网关'
            await poll()
          }
        })

        $('dsh-wb-btn-stop').addEventListener('click', async () => {
          const btn = $('dsh-wb-btn-stop')
          btn.disabled = true
          btn.textContent = '停止中…'
          try {
            const r = await fetch(API + '/gateway/stop', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
            })
            const d = await r.json().catch(() => ({}))
            if (d?.up) {
              window.alert('网关未能停止：' + (d?.reason ?? '仍在响应'))
            }
          } catch (err) {
            window.alert('网关停止失败：' + String(err?.message ?? err))
          } finally {
            btn.textContent = '停止网关'
            await poll()
          }
        })

        $('dsh-wb-btn-reload').addEventListener('click', () => {
          const frame = $('dsh-wb-frame')
          if (frame) {
            const src = panelSrc()
            frame.src = src + (src.includes('?') ? '&' : '?') + '_=' + Date.now()
          }
          void poll()
        })

        $('dsh-wb-btn-ext').addEventListener('click', () => {
          window.open(status?.panelUrl || 'http://127.0.0.1:8788/', '_blank', 'noopener')
        })

        $('dsh-wb-btn-realm').addEventListener('click', async () => {
          if (!status?.up) return
          const next = status.health?.realm === 'cn' ? 'intl' : 'cn'
          const btn = $('dsh-wb-btn-realm')
          btn.disabled = true
          btn.textContent = '切换中…'
          try {
            const r = await fetch(API + '/realm', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ realm: next }),
            })
            const d = await r.json().catch(() => ({}))
            if (!r.ok || d?.error) {
              window.alert('切换区域失败：' + (d?.error ?? r.status))
            } else {
              const frame = $('dsh-wb-frame')
              if (frame) {
                const src = panelSrc()
                frame.src = src + (src.includes('?') ? '&' : '?') + '_=' + Date.now()
              }
            }
          } catch (err) {
            window.alert('切换区域失败：' + String(err?.message ?? err))
          } finally {
            btn.textContent = '切换区域'
            await poll()
          }
        })

        document.addEventListener('visibilitychange', () => {
          if (document.hidden) stopTimer()
          else startTimer()
        })
      }

      function mount() {
        document.head.appendChild(style)
        document.body.appendChild(pill)
        document.body.appendChild(drawer)
        wire()
        void poll()
        startTimer()
      }

      if (document.body) mount()
      else document.addEventListener('DOMContentLoaded', mount, { once: true })
    }

    const name = 'workbuddy'
    /** 不依赖任何客户端服务：UI 直接挂 DOM，不注册 slot，也不 require 外部包。 */
    const inject = []

    /**
     * cordis 客户端插件入口。缺少 `apply` 会让宿主报
     * `invalid plugin, expect function or object with an "apply" method`。
     * apply 可能因 HMR 被多次调用，boot() 内有一次性守卫。
     */
    function apply(ctx) {
      try {
        boot()
      } catch (err) {
        // 绝不能把异常抛出去：entry 抛错会让整个 web boot 失败并弹崩溃窗
        console.error('[dsh-workbuddy] 客户端初始化失败:', err)
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply

    return module.exports
  },
})
