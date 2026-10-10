# dsh-workbuddy

把 **WorkBuddy / CodeBuddy（腾讯代码助手）** 的订阅额度接进 DeepSeek Harness：
DSH 启动时自动探测并拉起本地 `workbuddy2api` 网关，在 DSH 页面右下角提供状态胶囊，
展开即内嵌官方 Web 面板（账号 / 积分 / 用量 / 任务管理）。

网关本身**不打包在本插件里**——它由
[workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) 独立发布，
本插件只做「生命周期管理 + 面板内嵌 + 状态 API」。

---

## 它解决什么

| 问题 | 本插件的做法 |
|---|---|
| 网关要手动跑、还得占一个终端窗口 | **插件自带网关**（`vendor/wb-proxy`）：DSH 启动即自动拉起，进程挂在 DSH 下、不占终端 |
| 关掉终端窗口后网关变成「僵尸」 | 不再依赖终端：网关由 DSH 直接 spawn，`stdio` 指向日志文件（从不碰 tty），不可能被 SIGTTOU 挂起 |
| DSH 关了网关还在后台占端口 | `stopOnExit`：DSH 退出时停掉由本插件启动/接管的网关（外部自行运行的不会被碰） |
| 官方面板在 8788，DSH 里看不到 | 右下角 **32px 圆角方形图标**（WorkBuddy 官方图标内联为 data URI；右下角状态点绿/黄/红）+ 抽屉内嵌面板，零跳转；状态文字只在悬停 tooltip 中出现，不占界面 |
| 想看账号/积分/区域状态要开浏览器 | `GET /workbuddy/status`；悬停图标即显示 `realm · ready/total 账号`，点开抽屉看完整数据 |
| 切区域必须手动登面板（API key 会被拒） | 插件代持面板会话（`panelPassword`），一键 `POST /workbuddy/realm` |
| 跨源 iframe 被策略挡住 | 无需处理：网关源站**没有** X-Frame-Options / CSP，iframe 直连即可（见「实现约束 1」） |

---

## 安装

```bash
# 本地源码目录（link 模式，改代码即生效）
dsh plugin --profile desktop add /path/to/dsh-workbuddy
dsh plugin --profile web     add /path/to/dsh-workbuddy
```

装完**重启 DSH**（bundle 层是启动时加载的）。

**前提**：本机有 Python 3.9+（macOS 自带 `/usr/bin/python3` 即可）。插件会自动探测，
也可用 `pythonPath` 指定。

**不需要**另外安装 workbuddy2api —— 网关已内置在 `vendor/wb-proxy/`。

---

## 网关：内置、随 DSH 启停

### 两种来源

| `mode` | 行为 |
|---|---|
| `auto`（默认） | 有内置网关就用内置，否则回退到 `gatewayDir` / `launchScript`，都没有则只探测 |
| `vendored` | 强制用插件自带的 `vendor/wb-proxy` |
| `external` | 强制用外部安装的网关 |
| `off` | 只探测，从不启动 |

内置模式下插件直接用 `python3 vendor/wb-proxy/wb_proxy.py` 启动，参数包括
`--port`、`--accounts-dir`、`--usage-dir`（以及配了 `panelPassword` 时的
`--panel-password`）——**不经过任何 shell 启动脚本**，所以也不会有 CRLF、
PATH、终端之类的问题。

### 生命周期

- **随 DSH 启动**：`autoStart: true` 时，DSH 一起来就探测；没跑就拉起，并**轮询等到就绪**。
- **随 DSH 停止**：`stopOnExit: true` 时，DSH 退出会停掉由本插件启动/接管的网关
  （先 SIGTERM，`stopGraceMs` 后 SIGKILL）。
- **不碰别人的进程**：如果 8788 上跑的是你自己起的网关，插件只探测、不接管，
  退出时也不会去停它。只有「本插件启动的」或「pidfile 指向的遗留进程」才归它管。
- **中途挂了会自愈**：`watchdog: true`（默认）时，后台健康检查发现网关
  **连续两次**不可达就自动重拉，中断窗口约 30 秒。用连续两次而不是单次判定，
  是为了避免上游一时卡顿就误重启、反而打断健康的网关。两次重启之间有
  `watchdogCooldownMs`（默认 30 秒）冷却，防止拉起风暴。

> 为什么这条重要：网关中途退出时，DSH 侧只会显示模型的 `TRANSPORT` 错误，
> 使用者根本不知道是网关挂了。有看门狗后，同一个请求重试一下往往就恢复了。

### 装完不对劲？先跑自检

```bash
curl -s http://127.0.0.1:19387/workbuddy/diagnose | python3 -m json.tool
```

它会逐项告诉你哪一环断了（vendor 在不在、python 找没找到、数据目录能不能写、
账号有没有、端口是被占还是没起来），并在 `hints` 里给出下一步。
输出约定：`✅` 通过、`❌` 真有问题、`—` 当前模式不适用、`ℹ️` 纯信息项。

> 面板条右侧的 `vendored/托管` 标记就是这个状态；鼠标悬停可看到来源目录、
> python、数据目录、pid。「停止网关」按钮只在**托管**状态下可用。

### 数据目录与迁移

代码目录和数据目录是分开的：

```
代码：<插件>/vendor/wb-proxy/            （或外部安装目录）
数据：~/.dsh/workbuddy-gateway/          （accounts / usage / settings / 日志 / pidfile）
```

所以**换代码来源不会丢登录态**。首次启动时，如果数据目录还没有 `accounts/`，
插件会**自动从旧装迁移**（默认探测 `~/workbuddy2api-hub/wb-proxy`、
`~/wb-proxy`，也可用 `legacyDataDir` 指定），不需要重新登录。

### 僵尸网关的自愈

如果 8788 被占用、但服务不响应（典型是之前在终端里跑过、关终端后被挂起成
`STAT=T` 的进程），插件会：

1. 若 pidfile 指向的进程还活着 → 先 `SIGKILL` 清掉，再重新启动；
2. 若不是本插件启动的 → 明确报错并给出 `lsof` 命令，**不会**盲杀别人的进程。

---

## 配置

`cordis.patch.yml` 的 `config`，或 profile 的用户覆盖层：

```yaml
mode: auto                          # auto | vendored | external | off
autoStart: true                     # DSH 启动时未运行则拉起
stopOnExit: true                    # DSH 退出时停止（仅限本插件托管的）
gatewayUrl: http://127.0.0.1:8788   # 面板 iframe 与 /health 探测都用它
gatewayPort: 8788                   # 必须与 gatewayUrl 端口一致
dataDir: ''                         # 留空 = ~/.dsh/workbuddy-gateway
pythonPath: ''                      # 留空 = 自动探测 python 3.9+
panelPassword: ''                   # 面板密码；留空则面板需手输、且不能切区域
healthIntervalMs: 15000             # 后台健康检查间隔；0 = 关闭
startTimeoutMs: 25000               # 拉起后等就绪的上限
```

> `panelPassword` 只在内存里用于换取面板会话 token，不会写入日志。
> 若你在面板里改过密码，这里要同步改，否则 `/workbuddy/realm` 返回 401。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workbuddy/status` | 网关可达性 + `/health`，另含 `mode` / `gatewayDir` / `python` / `dataDir` / `managed` / `managedPid` / `stopOnExit` |
| POST | `/workbuddy/gateway/start` | 拉起网关并**轮询等到就绪**；已运行则识别为「接管」或「外部实例」。失败时返回 `logTail` |
| POST | `/workbuddy/gateway/stop` | 停止**由本插件托管**的网关（外部实例会拒绝，返回 `stopped:false`） |
| GET | `/workbuddy/diagnose` | **一键自检**：逐项报告 vendor / python / 数据目录可写性 / 账号 / 端口 / 托管状态，并给出 `hints` |
| GET | `/workbuddy/models` | 代理网关 `/v1/models` |
| GET | `/workbuddy/realm` | 当前上游出口与可选值 |
| POST | `/workbuddy/realm` | 切换出口，body `{"realm":"cn"\|"intl"}` |

> `status` 额外返回 `panelIframeUrl`：面板的**直连**地址（含 `?pwd=`），前端直接拿它当
> iframe `src`。

---

## 实现约束（很重要，改代码前先读）

### 1. 面板必须**直连**网关源站，不要做反向代理

面板前端的 API 调用全是**绝对路径**（`/panel/status`、`/accounts/*`、`/v1/…`）。
一旦用「路径前缀」反代（例如把面板挂在 `/workbuddy-panel/*`），只有页面本身走代理，
而绝对路径请求会落到 **DSH 自己的源**上，于是表现为：

- 面板右上角提示「**无法连接反代**」
- 点「添加账号」报「**发起失败: 405**」，无法生成授权链接

正确做法：iframe `src` 直接用 `http://127.0.0.1:8788/?pwd=<panelPassword>`。
网关源站不带 `X-Frame-Options`、也没有 CSP 限制，跨源 iframe 可以正常嵌入（已实测）。

### 2. `webServer` 是后注入服务

DSH 启动时它的诊断会显示一批插件
`waiting for services (…) webServer`——意味着插件 `apply()` 执行时
`webServer` 通常**还没就绪**。

因此以下两种写法都是错的：

```js
// ❌ 拿不到：apply 时服务尚未注入
const ws = ctx.get('webServer')

// ❌ 会在 headless / Electron 组合里永不加载（webServer 永远不就绪）
export const inject = ['webServer']
```

正确写法：

```js
export const inject = []                                   // 插件始终加载
ctx.inject(['webServer'], (scope) => {                     // 服务就绪时回调
  const ws = scope.webServer ?? scope.get('webServer')
  if (ws) ws.register({ kind: 'exact', path: '/api/...', handler })
})
```

这样 headless 组合下插件照常加载（只做网关管理、不注册路由），Web 组合下
路由在服务就绪后自动挂上。

排查加载问题：插件会把关键步骤写到 `/tmp/dsh-workbuddy-plugin.log`
（`apply()` 调用、`ctx.inject` 回调、每条路由注册结果、启动探测结果）。
stdout 在插件加载失败时往往是空的，落盘最可靠。

### 3. 浏览器端入口必须是 DSH 的模块格式（不是裸 IIFE）

`client.js` 由 DSH 前端的 `window.__ModuleLoader__` 加载，必须是：

```js
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    function apply(ctx) { /* 挂 UI */ }
    exports.name = 'workbuddy'
    exports.inject = []
    exports.apply = apply
    return module.exports        // ← 必须返回 exports 对象
  },
})
```

两条硬性要求，违反任一条都会让**整个 web boot 失败**（desktop 下弹崩溃窗
`web boot: 1 entry did not activate` / `dsh-workbuddy: import failed`）：

1. `factory` 必须**返回** exports 对象——返回 `undefined` 即判定 import failed
2. exports 必须带 `apply` 方法，否则报
   `invalid plugin, expect function or object with an "apply" method`

另外 `apply` 内部要把异常吞掉后再 `console.error`：entry 抛错同样会拖垮 boot。

---

## 与 LLM provider 的关系

本插件**不管** `llm-pi-ai` 的 `workbuddy` provider 路由——那是 profile patch 的事：

```yaml
- id: llm-pi-ai
  config:
    providers:
      workbuddy:
        displayName: WorkBuddy
        api: openai-completions
        apiKeyEnv: WORKBUDDY_API_KEY     # 必需，见下
        baseURL: http://127.0.0.1:8788/v1
        models: [...]
```

`apiKeyEnv` **必须**声明，否则请求会以
`No API key for provider: workbuddy` 失败：Harness 的 llm seam 要求每个路由都有凭据。
网关 `api_key` 为 off 时不校验该值，所以在 `~/.dsh/.credentials.yaml` 的 `refs` 里
存任意占位值即可（注意该文件是 flow-style JSON mapping，`refs` 条目要以逗号分隔）。

---

## ⚠️ 不要再手动在终端里跑网关

插件已经内置并托管网关，手动再起一个只会打架。尤其**不要在终端前台启动后关掉终端窗口**：

```
$ ps -o pid,ppid,stat,command -p <pid>
  PID  PPID STAT  COMMAND
15380  1069  T    /bin/bash ./start-wb-proxy.sh 8788      ← STAT=T = 被挂起
15388 15380  T    Python ...                              ← 也挂起
$ lsof -p 15388 | grep ttys
  fd=1u CHR /dev/ttys000                                  ← stdout 还指着已关闭的终端
```

关终端时进程收到 **SIGTTOU 被挂起（stopped）**：既不死、也不干活，**却继续占着 8788 端口**。
于是点「启动网关」会失败（`port is already in use`），而 `curl` 又连不上——僵局。

**恢复**：

```bash
# 1. 找出占着端口、且状态为 T 的进程
lsof -nP -iTCP:8788 -sTCP:LISTEN
ps -o pid,ppid,stat,command -p <上面的PID>

# 2. 清掉它
kill -9 <PID>

# 3. 让它归插件管：重启 DSH（autoStart 会拉起），或在面板里点「启动网关」
```

> 若这个僵尸是**本插件**上次启动的（数据目录里有 `dsh-gateway.pid`），
> 插件会在下次启动时自动 `SIGKILL` 掉它再重启，不需要你手动处理。

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 右下角没有胶囊 | bundle 层未加载 → 重启 DSH；检查 `package.json` 的 `dsh.profile.bundles` 是否含 `dsh-workbuddy` |
| 启动即弹崩溃窗「web boot: 1 entry did not activate」 | `client.js` 不是 DSH 模块格式（见「实现约束 3」）：必须 `__ModuleLoader__.load({id, factory})`、`factory` 返回 exports、exports 带 `apply` |
| 胶囊一直红「网关未运行」 | 看 `/tmp/dsh-workbuddy-plugin.log` 里的「自动拉起结果」，或 `dataDir` 下 `dsh-gateway.log` |
| 「启动网关」报 `port is already in use` 或「端口被占用但服务无响应」 | 8788 上有别的进程（多半是终端里起过、关终端后被 `SIGTTOU` 挂起的 `STAT=T` 僵尸），见上一节 |
| 「启动网关」返回 `stopped:false` | 端口上是**外部**网关，插件拒绝对它动手；想接管就先用 `mode: external` 或停掉它 |
| 找不到 Python | 装 Python 3.9+，或用 `pythonPath` 指定绝对路径 |
| 插件报「找不到内嵌网关」 | `vendor/wb-proxy/wb_proxy.py` 不存在——用 npm/tarball 安装时确认 `package.json` 的 `files` 含 `vendor` |
| 迁移没生效（账号仍是 0/1） | 目标 `dataDir` 已有 `accounts/` 时不会迁移；先删掉它，或用 `legacyDataDir` 显式指定旧装 |
| 面板提示「无法连接反代」 | 面板被反代了。必须让 iframe 直连 `gatewayUrl`（见「实现约束 1」） |
| 点「添加账号」报「发起失败: 405」 | 同上：面板的 `/accounts/*` 绝对路径请求落到了 DSH 源 |
| 面板抽屉空白 | 直接访问 `gatewayUrl` 确认面板本身可用；检查 `panelIframeUrl` 是否正确 |
| 切区域返回 401 | `panelPassword` 与面板当前密码不一致 |
| 模型可见但请求报 `No API key for provider: workbuddy` | provider patch 缺 `apiKeyEnv`，或 credentials `refs` 里没有对应键 |
| 模型请求 `TRANSPORT` 错误 | 网关进程挂了或端口不对（连接被拒绝） |

---

## 分享 / 发布清单

本插件可直接打包分享（MIT）。**包内已经是中性配置**（不含任何机器的路径或口令），
本机专属的值放在 profile 用户层，所以发布前不需要再清洗代码。

发布前只需确认：

| # | 事项 | 说明 |
|---|---|---|
| 1 | `cordis.patch.yml` 是中性默认 | `panelPassword: ''`、`dataDir: ''`；`lib/index.js` 的 `DEFAULTS` 同样无本机预设 |
| 2 | `package.json` 的 `files` 含 `vendor` | 否则 `npm pack` / tarball 安装会漏掉网关，插件启动时报「找不到内嵌网关」 |
| 3 | 自查无泄露 | `grep -rn "shang\|/Users/\|127.0.0.1:8" . --exclude-dir=.git --exclude-dir=node_modules` |
| 4 | 版本与目标对齐 | `package.json` 的 `dshTarget` 与你的 DSH 版本 |
| 5 | 网关许可证随包 | `vendor/wb-proxy/LICENSE.gateway`（上游 workbuddy2api-hub 为 MIT） |

推送（仓库已初始化并完成首次提交）：

```bash
cd ~/dsh-workbuddy
git remote add origin git@github.com:kekesharp/dsh-workbuddy.git
git push -u origin main
```

别人就能这样装：

```bash
dsh plugin --profile desktop add github:kekesharp/dsh-workbuddy
```

### 本机配置怎么放（重要）

插件 bundle 提供的 config 是**默认值**；本机专属的值请写在自己的 profile patch 里：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml —— 顶层追加
- id: workbuddy
  config:
    panelPassword: <你的面板密码>
    # 需要时还可覆盖：mode / dataDir / pythonPath / gatewayPort …
```

三点必须知道：

- profile 层对 `config` 是**替换**语义，不是深合并——只写要覆盖的字段即可，其余由
  `lib/index.js` 的 `DEFAULTS` 兜底。
- 这是**顶层 `- id: workbuddy`**（覆盖已有条目），**不是** `- insert:`。用 `insert`
  会因为 id 重复导致加载失败。
- 内置网关模式下**不再需要** `launchScript`；那个字段只在 `mode: external` 时用。

> 插件通过 `package.json` 的 `dsh.bundle.patch` 自带配置，并从
> `dsh.profile.bundles` 自动加载，**装进 profile 的 bundles 即可**。


### 同类插件（发布前先看一眼，避免重复造轮子）

| 项目 | ★ | 路线 | 与本插件的关系 |
|---|---|---|---|
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | 353 | 直接读 WorkBuddy 桌面 App 内的模型 | 不同路线：不需要网关 |
| [Axiaohungry/dsh-llm-workbuddy](https://github.com/Axiaohungry/dsh-llm-workbuddy) | 56 | 用 WorkBuddy API Key 接模型 | 只做 provider，无面板 |
| [tearslee/dsh-workbuddy2api](https://github.com/tearslee/dsh-workbuddy2api) | 4 | **守护 workbuddy2api 进程 + 自动注册 provider** | 最接近；它自动注册模型，本插件靠 profile patch |
| [Wei894348/dsh-wb2api](https://github.com/Wei894348/dsh-wb2api) | 0 | **自建网关 + web 设置面板 + 任务自动化** | 更重：自己实现网关 |
| [wdmb123/dsh-workbuddy2api-panel-bridge](https://github.com/wdmb123/dsh-workbuddy2api-panel-bridge) | 0 | 把自建网关接成 provider 路由 | 只做路由 |

**本插件的定位**：不重造网关，**附着在已装的 `workbuddy2api` 网关上**，把官方 Web 面板
嵌进 DSH，并管好网关生命周期。差异化在于「面板内嵌 + 三态状态图标 + 区域一键切换」。

---

## 许可证

MIT

