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
| 网关要手动启动、忘记开就报 `TRANSPORT` 错误 | `autoStart`：DSH 启动时探测 `/health`，未运行就按 `launchScript` 拉起（detached，不随 DSH 退出） |
| 官方面板在 8788，DSH 里看不到 | 右下角 **32px 圆角方形图标**（WorkBuddy 官方图标内联为 data URI；右下角状态点绿/黄/红）+ 抽屉内嵌面板，零跳转；状态文字只在悬停 tooltip 中出现，不占界面 |
| 想看账号/积分/区域状态要开浏览器 | `GET /workbuddy/status`；悬停图标即显示 `realm · ready/total 账号`，点开抽屉看完整数据 |
| 切区域必须手动登面板（API key 会被拒） | 插件代持面板会话（`panelPassword`），一键 `POST /workbuddy/realm` |
| 跨源 iframe 被策略挡住 | 无需处理：网关源站**没有** X-Frame-Options / CSP，iframe 直连即可（见「实现约束」） |

---

## 安装

```bash
# 本地源码目录（link 模式，改代码即生效）
dsh plugin --profile desktop add /path/to/dsh-workbuddy
dsh plugin --profile web     add /path/to/dsh-workbuddy
```

装完**重启 DSH**（bundle 层是启动时加载的）。

---

## 配置

`cordis.patch.yml` 的 `config`，或 profile 的用户覆盖层：

```yaml
gatewayUrl: http://127.0.0.1:8788   # 网关地址；面板 iframe 同源反代也用它
autoStart: true                     # DSH 启动时未运行则拉起
launchScript: ~/workbuddy2api-hub/wb-proxy/start-wb-proxy.sh
gatewayPort: 8788                   # 必须与 gatewayUrl 端口一致
panelPassword: admin                # 面板密码，仅用于插件代持会话；留空则禁用切区域
healthIntervalMs: 15000             # 后台健康检查间隔；0 = 关闭
```

> `panelPassword` 只在内存里用于换取面板会话 token，不会写入日志。
> 若你在面板里改过密码，这里要同步改，否则 `/workbuddy/realm` 返回 401。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workbuddy/status` | 网关可达性 + `/health` 原样返回（realm、accounts、ready、uid、过期时间） |
| POST | `/workbuddy/gateway/start` | 拉起网关（已在运行则直接返回），3 秒后复探 |
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

## 网关的后台运行（不占终端）

`autoStart` 用 `spawn(..., { detached: true, stdio: [ignore, fd, fd] })` 拉起网关，效果：

- **不占终端窗口**：`fd 0/1/2` 分别指向 `/dev/null` 与日志文件，从不碰 tty；
- **脱离 DSH**：`unref()` 后父进程变成 `launchd`（`PPID=1`），DSH 退出网关照常服务；
- **状态可查**：`ps` 里应为 `STAT=Ss`（会话首进程、正常调度）。

### ⚠️ 不要手动在终端里跑网关

在终端里前台启动、然后**关掉终端窗口**，会造成一个很隐蔽的状态：

```
$ ps -o pid,ppid,stat,command -p <pid>
  PID  PPID STAT  COMMAND
15380  1069  T    /bin/bash ./start-wb-proxy.sh 8788      ← STAT=T = 被挂起
15388 15380  T    Python ...                              ← 也挂起
$ lsof -p 15388 | grep ttys
  fd=1u CHR /dev/ttys000                                  ← stdout 还指着已关闭的终端
```

关终端时进程收到 **SIGTTOU 被挂起（stopped）**：既不死、也不干活，**却继续占着 8788 端口**。
后果是点「启动网关」会失败（新进程报 `port is already in use`），而 `curl` 又连不上——
一个「端口被占但服务不响应」的僵局。

**恢复办法**：

```bash
# 1. 找出占着端口、且状态为 T 的僵尸进程
lsof -nP -iTCP:8788 -sTCP:LISTEN
ps -o pid,ppid,stat,command -p <上面的PID>

# 2. 清掉它
kill -9 <PID>

# 3. 交给插件拉起（重启 DSH 即会 autoStart；或在右下角点「启动网关」）
```

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 右下角没有胶囊 | bundle 层未加载 → 重启 DSH；检查 `package.json` 的 `dsh.profile.bundles` 是否含 `dsh-workbuddy` |
| 启动即弹崩溃窗「web boot: 1 entry did not activate」 | `client.js` 不是 DSH 模块格式（见「实现约束 3」）：必须 `__ModuleLoader__.load({id, factory})`、`factory` 返回 exports、exports 带 `apply` |
| 胶囊一直红「网关未运行」 | 网关没起：看 `launchScript` 路径是否存在、`/tmp/dsh-workbuddy-plugin.log` 是否记录拉起失败 |
| 点「启动网关」失败，提示里带 `port is already in use` | 端口被占用。多半是终端里起过又被关终端挂起（`STAT=T`）的旧进程，见上一节 |
| 点「启动网关」失败但只显示「HTTP 200」 | 旧版本症状：`stdio:'ignore'` 吞掉了网关输出。现在会把 `dsh-gateway.log` 末几行放进弹窗 |
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
| 1 | `cordis.patch.yml` 是中性默认 | `launchScript: ''`、`panelPassword: ''`；`lib/index.js` 的 `DEFAULTS` 同样无预设 |
| 2 | 自查无泄露 | `grep -rn "shang\|/Users/\|127.0.0.1:8" . --exclude-dir=.git --exclude-dir=node_modules` |
| 3 | 版本与目标对齐 | `package.json` 的 `dshTarget` 与你的 DSH 版本 |

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
    launchScript: ~/workbuddy2api-hub/wb-proxy/start-wb-proxy.sh
    panelPassword: <你的面板密码>
```

两点必须知道：

- profile 层对 `config` 是**替换**语义，不是深合并——所以只写你要覆盖的字段即可，
  其余字段（`gatewayUrl` / `gatewayPort` / `autoStart` / `healthIntervalMs` /
  `panelAutoLogin`）由 `lib/index.js` 的 `DEFAULTS` 兜底。
- 这是**顶层 `- id: workbuddy`**（覆盖已有条目），**不是** `- insert:`。用 `insert`
  会因为 id 重复导致加载失败。

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

