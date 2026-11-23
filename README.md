# dsh-workbuddy

[![GitHub stars](https://img.shields.io/github/stars/kekesharp/dsh-workbuddy?label=stars&color=176BFF)](https://github.com/kekesharp/dsh-workbuddy/stargazers)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2%2B-blue)](https://github.com/deepseek-ai)
[![Gateway](https://img.shields.io/badge/gateway-2.0.0-FF6B35)](https://github.com/ardeyouxipianyi/workbuddy2api-hub)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](#前置条件)
[![Python](https://img.shields.io/badge/python-3.9%2B-3776AB?logo=python&logoColor=white)](#前置条件)

> **把 WorkBuddy / CodeBuddy 的订阅额度接进 DeepSeek Harness —— 网关自带、随 DSH 启停、面板内嵌，不用再手动开一个终端窗口跑代理。**

<sub>*English: A DSH plugin that bundles the WorkBuddy/CodeBuddy gateway. It starts with DSH, stops with DSH, self-heals when it crashes, and embeds the official web panel right inside DSH — no separate install, no terminal window, no manual supervision.*</sub>

![面板内嵌在 DSH 里](assets/panel.png)

---

## 30 秒上手

```bash
dsh plugin --profile desktop add github:kekesharp/dsh-workbuddy
```

然后**配置 provider**（这一步不能跳过，见「安装」）并重启 DSH。右下角会出现图标，点开就是面板。

---

## 为什么用它

| | 手动跑网关 | 大多数同类插件 | **本插件** |
|---|:---:|:---:|:---:|
| 需要单独安装网关 | 要 | 多数要 | **自带** |
| 占一个终端窗口 | 占 | — | **不占** |
| 关终端后网关变僵尸 | 会 | — | **不会**（不碰 tty） |
| DSH 关了后台还留进程 | 会 | — | **一起停** |
| 网关中途挂了 | 手动重启 | 手动重启 | **看门狗自愈** |
| 看面板要开浏览器 | 要 | 要 | **DSH 内嵌** |
| 切区域要登面板 | 要 | 要 | **一键** |
| 装完出问题 | 自己猜 | 自己猜 | **一键自检** |

---

## 安装

### 1. 装插件

```bash
dsh plugin --profile desktop add github:kekesharp/dsh-workbuddy
# 想同时给 web profile 用：
dsh plugin --profile web add github:kekesharp/dsh-workbuddy
```

### 2. 配置 provider（**必做**）

插件负责**网关**，但让模型出现在 DSH 的模型列表里，需要你自己在 profile patch 里声明 provider：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml —— 顶层追加
- id: llm-pi-ai
  config:
    providers:
      workbuddy:
        displayName: WorkBuddy
        api: openai-completions
        apiKeyEnv: WORKBUDDY_API_KEY
        baseURL: http://127.0.0.1:8788/v1
        defaultInput: [text, image]
        # 网关按标准 reasoning_effort 转发思考档位（DeepSeek 系的 thinking 块由网关补）
        compat:
          thinkingFormat: openai
          supportsReasoningEffort: true
        # WorkBuddy 的 429 冷却通常一分钟左右，而 DSH 默认重试约 15 秒就放弃，
        # 表现就是「对话到一半链接中断」。给这个 provider 单独放宽到约 2 分半。
        retryPolicy:
          mode: normal
          maxRetries: 8
          backoff:
            initialDelayMs: 2000
            maxDelayMs: 30000
            jitterRatio: 0.1
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1000000
            maxTokens: 128000
            input: [text, image]
            reasoningEfforts: [off, low, high, max]
```

并在 `~/.dsh/.credentials.yaml` 的 `refs` 里给这个 key 一个占位值（网关默认不校验它）：

```yaml
refs:
  WORKBUDDY_API_KEY: local-proxy
```

> ⚠️ 三个最常踩的坑：
> - **漏了 `apiKeyEnv`** → 请求报 `No API key for provider: workbuddy`
> - **模型没写 `contextWindow` / `input`** → 要么长会话报 `context overflow`，要么图片直接被拒
> - **漏了 `retryPolicy`** → 撞上 WorkBuddy 的 60 秒冷却时，DSH 默认约 15 秒就重试完，整回合以 `RATE_LIMIT` 失败（看起来像「聊到一半断了」）
>
> 面板里另有一个上游自带的**「DSH 一键配置」**按钮（1.7.x 新增）：它写的是另一个 provider
> `wb-proxy`（凭据 `WB_PROXY_API_KEY`），还会顺手改默认模型。它和上面这份 `workbuddy`
> 配置是**两套入口，二选一即可**。本插件已经负责网关生命周期，推荐按上面的方式手配
> `workbuddy`；如果点过一键配置，记得把重复的那份删掉，否则模型列表里会出现两个 WorkBuddy。

### 3. 重启 DSH

bundle 层是启动时加载的。重启后右下角出现图标即成功。

### 前置条件

- **DSH** 0.2.0-rc.2 或更新
- **Python 3.9+** —— macOS 自带的 `/usr/bin/python3` 即可；插件会自动探测，也可用 `pythonPath` 指定
- 一个已登录的 WorkBuddy / CodeBuddy 账号（在面板里登录一次）

---

## 界面

右下角是一个 32px 圆角图标（仿 WorkBuddy 图标），状态点三色：

| 颜色 | 含义 |
|---|---|
| 🟢 绿 | 网关在线且账号就绪 |
| 🟡 黄 | 网关在线但没账号/未登录 |
| 🔴 红 | 网关离线 |

悬停显示 `realm · ready/total 账号`，**不占界面**。点开是抽屉：内嵌官方 Web 面板 + 一排操作按钮。

![图标](assets/icon.png)

---

## 内置网关与生命周期

网关（`workbuddy2api` 系）**已经打包在插件里**（`vendor/wb-proxy`，对应上游 **v2.0.0**，约 3.6 MB），不需要另外安装。

> ⚠️ **上游已于 2026-11-06 停止维护**（`workbuddy2api-hub` 的最终版本即 v2.0.0，本插件已同步到该版本）。此后上游不再跟进渠道指纹与接口变化，WorkBuddy 对非官方客户端的识别与拦截持续收紧，可能随时彻底不可用。账号风控 / 限流 / 封禁风险由使用者自行承担；请优先使用官方客户端，不要使用主账号或商业转售。

### 随 DSH 启停

- **随 DSH 启动**：`autoStart: true` 时 DSH 一起来就探测，没跑就拉起，并**轮询等到就绪**
- **随 DSH 停止**：`stopOnExit: true` 时 DSH 退出会停掉由本插件启动/接管的网关（SIGTERM → `stopGraceMs` → SIGKILL）
- **不碰别人的进程**：如果端口上跑的是你自己起的网关，插件只探测、不接管，退出时也不去停它
- **挂了会自愈**：`watchdog: true`（默认）时，健康检查发现网关**连续两次**不可达就自动重拉，中断窗口约 30 秒
- **活着但连不上上游也会自愈**：网关进程可能还占着端口、`/health` 也照样 200，可它自己的 DNS/出网已经死了（上游请求一律卡两分钟再 503 `Errno 8`）。这种「半死」状态看门狗会从网关日志里认出来，同样自动重拉

> 判定用「连续两次」而不是单次，是为了避免上游一时卡顿就误重启、反而打断健康的网关。
> 两次重启之间有 `watchdogCooldownMs`（默认 30 秒）冷却，防止拉起风暴。

**出网自愈是怎么认的**（`logWatch`，默认开）：每轮健康检查顺带增量扫一遍网关日志，命中
`local network looks down` / `nodename nor servname provided` / `Temporary failure in name resolution`
这类解析失败特征就记一条证据；`logWatchWindowMs`（默认 10 分钟）窗口内累计满 `logWatchStreak`
（默认 2 条）才重启——单条抖动不动进程。只扫本次 DSH 启动之后新写入的日志，因此不会把上一次
故障的旧行当成本次证据。

> 背景：2026-11-09 DSH 更新到 0.2.2-rc.1 那次，系统代理切换把这个长寿命网关进程的 resolver 卡死，
> `/health` 一直 200、模型侧却全线 503。只看 `/health` 的看门狗永远发现不了，只能手点重启。
> 现在的自愈覆盖了这种情况，重启后指数退避（`watchdogCooldownMaxMs` 封顶）避免风暴。

### 代码目录与数据目录分离

```
代码：<插件>/vendor/wb-proxy/          （或外部安装目录）
数据：~/.dsh/workbuddy-gateway/        （accounts / usage / settings / catalog / 日志 / pidfile）
```

好处是**换代码来源不会丢登录态**。首次启动时如果数据目录还没有 `accounts/`，插件会**自动从旧装迁移**（默认探测 `~/workbuddy2api-hub/wb-proxy`、`~/workbuddy2api-hub`、`~/wb-proxy`，也可用 `legacyDataDir` 指定），不用重新登录。

### 三种来源

| `mode` | 行为 |
|---|---|
| `auto`（默认） | 有内置网关就用内置；否则回退到 `gatewayDir` / `launchScript`；都没有则只探测 |
| `vendored` | 强制用插件自带的 `vendor/wb-proxy` |
| `external` | 强制用外部安装的网关 |
| `off` | 只探测，从不启动 |

内置模式下插件直接 `python3 wb_proxy.py`，参数带 `--port` / `--accounts-dir` / `--usage-dir` / `--panel-password` —— **不经过任何 shell 启动脚本**，所以没有 CRLF、PATH、终端挂起之类的问题。运行时产生的目录归档（`catalog/`）也被 `WB_PROXY_CATALOG_DIR` 指到数据目录，插件升级时不会丢，也不会往代码目录里写东西。

### 这次同步回来的上游能力（1.10.7 → 2.0.0）

内置网关整体替换为上游 **v2.0.0**（`vendor/wb-proxy/UPSTREAM.json` 记录了 tag / commit）。从 1.10.7 到 2.0.0 主要带来：

- **CodeArts 出口工具归一化**（修 `Tool function cannot empty` / #750、#752）：空 `function`、裸服务端工具（`{"type":"web_search"}`）、扁平声明统一转成合规 function schema；缺失的 `parameters` 自动补 `{"type":"object","properties":{}}`；全部不可用时从请求体里移除 `tools` 与 `tool_choice`
- **CodeArts 账号与调度增强**：配置保存读-改-写加锁（并发安全 / #751）、账号 UID 注入防护（#757）、账号备注 / 任务开关 / 积分刷新 / 签到与令牌保活调度；关闭账号任务后不再被排队或惰性签到触发（#759、#762）
- **CodeArts 模型与请求**：支持图片输入与模型视觉能力，校验推理档位并转发采样参数；修复 OpenAI 格式错误响应中 429 状态码丢失（#758、#760、#761）；模型 ID 精确匹配（`deepseek-v4.1-flash` 与 `-1017` 不再互换 / #797）
- **请求健壮性**：413 先回响应再排空上传，不再被连接重置吞掉（#799）；`max_tokens` / `max_completion_tokens` 按目录上限收敛、字符串 `stop` 归一化，参数类错误返回 400 且**不再冷却账号池**（#794）；小账号池长会话固定同一账号，保住前缀缓存（#718）
- **面板**：默认控制台布局 + Alibaba 配色，新增可选新导航布局（桌面侧栏 / 移动端导航 / 分组设置 / #725、#764、#765）、可选「保持登录」（#763）；设置页分组在正體中文 / 英文下不再整页隐藏（#804）
- **计费与用量**：`x0.00` 免费倍率不再覆盖已知付费价（#774）；DeepSeek Flash 真实计费校准（#753/#754）；用量聚合缓存改异步补写（30s 起指数退避、封顶 15 分钟）+ 64MB 落后告警 + 按 pid 隔离临时文件（#805）
- **提示词与诊断**：恢复被改坏的 `Main branch` / `To give feedback` 改写规则并加回归护栏（#796）；日志轮转日限校验（#755）；新增出站身份诊断工具（#756）
- **11-128 文件引用段指纹中和继续保留**：`FILE_REFERENCE_PROMPT` 首句补 `that`，此前修好的 `unapproved channel` 不会回退

> 升级只替换 `vendor/wb-proxy` 的代码与 `dashboard.html` / `pricing.json`；账号、用量、设置都在数据目录，不受影响。

---

## 装完不对劲？先跑自检

```bash
curl -s http://127.0.0.1:19387/workbuddy/diagnose | python3 -m json.tool
```

它会逐项告诉你哪一环断了，并给出 `hints`：

```
✅ mode             vendored
✅ vendorGateway    /…/vendor/wb-proxy
ℹ️ gatewayVersion   v2.0.0
—  externalGateway              ← 当前模式不适用
✅ python           python3
✅ dataDir          /…/workbuddy-gateway
✅ accounts         /…/workbuddy-gateway/accounts
✅ port             port 8788
ℹ️ log              /…/dsh-gateway.log
ℹ️ managed          pid 36177
```

`✅` 通过 · `❌` 真有问题 · `—` 不适用 · `ℹ️` 信息项。

---

## 配置

写在 `cordis.patch.yml` 的 `config`，或你自己的 profile 覆盖层：

```yaml
- id: workbuddy
  config:
    panelPassword: <你的面板密码>
    # 需要时再覆盖下面这些
```

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `auto` | `auto` / `vendored` / `external` / `off` |
| `autoStart` | `true` | DSH 启动时未运行则拉起 |
| `stopOnExit` | `true` | DSH 退出时停止（仅限本插件托管的） |
| `watchdog` | `true` | 网关挂了自动重拉 |
| `watchdogCooldownMs` | `30000` | 两次自愈重启最小间隔（失败后指数退避） |
| `watchdogCooldownMaxMs` | `600000` | 退避封顶 |
| `logWatch` | `true` | 扫网关日志识别「活着但出网已死」 |
| `logWatchStreak` | `2` | 窗口内累计几条出网故障证据才重启 |
| `logWatchWindowMs` | `600000` | 出网故障证据的有效窗口 |
| `gatewayUrl` | `http://127.0.0.1:8788` | 面板 iframe 与 `/health` 探测都用它 |
| `gatewayPort` | `8788` | 须与 `gatewayUrl` 端口一致 |
| `dataDir` | `~/.dsh/workbuddy-gateway` | accounts / usage / catalog / 日志 / pidfile |
| `pythonPath` | 自动探测 | Python 3.9+ 的绝对路径 |
| `vendorDir` | 插件自带 | 内置网关目录 |
| `gatewayDir` | — | 外部网关目录（含 `wb_proxy.py`） |
| `launchScript` | — | 外部启动脚本（`mode: external` 时用） |
| `legacyDataDir` | 自动探测 | 迁移账号的来源 |
| `panelPassword` | — | 面板密码；留空则面板需手输、且不能切区域 |
| `healthIntervalMs` | `15000` | 后台健康检查间隔；`0` = 关闭 |
| `startTimeoutMs` | `25000` | 拉起后等就绪的上限 |
| `stopGraceMs` | `5000` | SIGTERM 后多久 SIGKILL |
| `logPath` | 数据目录下 | 网关 stdout/stderr 落盘位置 |

> **profile 层对 `config` 是替换语义，不是深合并** —— 只写要覆盖的字段即可，其余由插件默认值兜底。
> 这是**顶层 `- id: workbuddy`**，**不是** `- insert:`（用 `insert` 会因 id 重复导致加载失败）。

---

## 接口

挂在你 DSH 的源上（默认 `http://127.0.0.1:19387`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workbuddy/status` | 可达性 + `/health`，含 `mode` / `gatewayVersion` / `python` / `dataDir` / `managed` / `stopOnExit` |
| GET | `/workbuddy/diagnose` | **一键自检**，逐项 + `hints`；`?deep=1` 额外真发一次 1-token 对话验证出网 |
| POST | `/workbuddy/gateway/start` | 拉起并轮询等就绪；失败返回 `logTail` |
| POST | `/workbuddy/gateway/stop` | 停止本插件托管的网关 |
| POST | `/workbuddy/gateway/restart` | 重启本插件托管的网关（面板「重启网关」按钮也走它） |
| GET | `/workbuddy/models` | 代理网关 `/v1/models` |
| GET / POST | `/workbuddy/realm` | 查看 / 切换上游出口 `{"realm":"cn"\|"intl"}` |

---

## 排错

| 现象 | 处理 |
|---|---|
| 右下角没有图标 | bundle 未加载 → 重启 DSH；检查 `package.json` 的 `dsh.profile.bundles` 是否含 `dsh-workbuddy` |
| 启动弹崩溃窗「web boot: 1 entry did not activate」 | `client.js` 不是 DSH 模块格式（见「实现约束 3」） |
| 模型列表里没有 WorkBuddy | provider 没配 → 见「安装 第 2 步」 |
| 请求报 `No API key for provider: workbuddy` | provider 缺 `apiKeyEnv`，或 credentials `refs` 没有对应键 |
| 长会话报 `context overflow` | 模型没写 `contextWindow`，pi-ai 回退到约 256K 兜底 → 补上真实窗口 |
| 图片被拒 | 模型/路由缺 `input: [text, image]` |
| 模型报 `TRANSPORT` 错误 | 网关挂了。等看门狗自愈（约 30 秒）后重试；或跑 `/workbuddy/diagnose` |
| 模型全部 503、每次卡两分钟，但网关面板能打开 | 进程活着但出网/DNS 已死。看门狗会按日志证据自动重拉；急用就 `POST /workbuddy/gateway/restart`。诊断用 `/workbuddy/diagnose?deep=1`，`checks.outbound.ok=false` 即坐实 |
| 请求报 `400 / code 11128 Illegal API invocation from an unapproved channel` | 渠道指纹被拦。升级插件到 **0.9.0+**（内置网关 2.0.0 已中和 DSH 文件引用段的指纹）；仍出现说明上游新增了别的指纹，只能等上游跟进 |
| 聊到一半报 `RATE_LIMIT` / 链接中断 | WorkBuddy 429 冷却约 60 秒，provider 没配 `retryPolicy` → 按「安装 第 2 步」补上（约 2 分半的重试预算） |
| 「启动网关」报 `port is already in use` | 端口被占。多半是终端里起过、关终端后被 `SIGTTOU` 挂起（`STAT=T`）的僵尸，见下 |
| 面板提示「无法连接反代」/ 添加账号 405 | 做了路径前缀反代。必须让 iframe **直连** `gatewayUrl`（见「实现约束 1」） |
| 切区域返回 401 | `panelPassword` 与面板当前密码不一致 |
| 迁移没生效（账号仍是 0/1） | 目标 `dataDir` 已有 `accounts/` 时不会迁移；先清空或用 `legacyDataDir` 指定 |

### ⚠️ 不要再手动在终端里跑网关

尤其**不要前台启动后再关掉终端窗口**——进程会收到 `SIGTTOU` **被挂起（`STAT=T`）**：既不死也不干活，**却继续占着端口**。

```bash
lsof -nP -iTCP:8788 -sTCP:LISTEN        # 1. 找出占端口的进程
ps -o pid,ppid,stat,command -p <PID>    # 2. 确认是不是 STAT=T
kill -9 <PID>                           # 3. 清掉
# 4. 重启 DSH，交给插件 autoStart
```

---

## 实现约束（改代码前先读）

### 1. 面板必须**直连**网关源站

面板前端用**绝对路径**调自己的 API（`/panel/status`、`/accounts/*`、`/realm`…）。任何「路径前缀式」反向代理只能覆盖被改写过的相对路径，绝对路径请求会落到 DSH 源上并 404/405，表现为「无法连接反代」+ 添加账号 405。

网关源站没有 `X-Frame-Options` / CSP，所以跨源 iframe **可以直接嵌入**。

### 2. `webServer` 是后注入服务

`ctx.get('webServer')` 在 `apply()` 里是 `undefined`，把 `webServer` 列进 `inject` 又会让插件在 headless/Electron 组合里永不加载。正确做法是 `ctx.inject(['webServer'], cb)`：依赖就绪时执行回调，不就绪时插件照常加载，只是不注册 HTTP 路由。

### 3. 浏览器端入口必须是 DSH 的模块格式

```js
window.__ModuleLoader__.load({ id: 'dsh-workbuddy', factory })
// factory(require) 必须 return exports，且 exports 要带 apply
```

写成裸 IIFE 会让 DSH 启动时崩溃（`web boot: 1 entry did not activate`）。

### 4. 网关进程要落日志、补 PATH

`stdio: 'ignore'` 会让启动失败的原因彻底丢失（只剩一句 `HTTP 200`）。必须把 stdout/stderr 写进文件；并显式补 `PATH`，因为 GUI 启动的 DSH 未必继承登录 shell 的 PATH。

---

## 同类项目

| 项目 | ★ | 路线 | 与本插件的关系 |
|---|---|---|---|
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | 353 | 直读桌面 App 内模型 | 不同路线：不需要网关 |
| [Axiaohungry/dsh-llm-workbuddy](https://github.com/Axiaohungry/dsh-llm-workbuddy) | 56 | API Key 接模型 | 只做 provider，无面板 |
| [tearslee/dsh-workbuddy2api](https://github.com/tearslee/dsh-workbuddy2api) | 4 | 守护网关 + 自动注册 provider | 无面板 |
| [Wei894348/dsh-wb2api](https://github.com/Wei894348/dsh-wb2api) | 0 | 自建网关 + 面板 | 更重：自己实现网关 |
| [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | 3159 | 网关本体 | 本插件内置的就是它（v2.0.0，上游最终版） |

**本插件的定位**：不重造网关，把网关**打进来**并管好生命周期，同时把官方面板嵌进 DSH。

---

## 许可证与致谢

MIT。

内置网关来自 [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub)（MIT，见 `vendor/wb-proxy/LICENSE.gateway`），仅做打包与生命周期托管。

> 本项目与 WorkBuddy / CodeBuddy / DeepSeek 官方无关，仅供个人在自有账号下使用。
