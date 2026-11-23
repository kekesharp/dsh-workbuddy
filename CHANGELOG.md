# Changelog

本插件自带一份 [workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) 网关（`vendor/wb-proxy`）。每次同步上游都会在这里记一笔，方便对照 `vendor/wb-proxy/UPSTREAM.json` 里的 tag / commit。

## 未发布

**自愈升级：认得「网关活着但出网已死」**

- 新增 `logWatch`（默认开）：每轮健康检查增量扫网关日志，命中 DNS/解析失败特征（`local network looks down`、`nodename nor servname provided`、`Temporary failure in name resolution` 等）就记一条证据，窗口内累计满 `logWatchStreak`（默认 2 条）自动重启网关。只扫本次 DSH 启动之后的新日志，不把上一轮故障的旧行算进来。
- 新增 `watchdogCooldownMaxMs`（默认 10 分钟）：自愈重启改为指数退避，重启后连续 4 个干净周期才清零。
- 修复并发自杀：看门狗、面板按钮、启动探测同时进来时，`startGateway` 会把「刚 spawn、还在 bind」的自己人当成占端口的僵尸 `SIGKILL` 掉（表现为日志里刚「已启动」就 `signal=SIGKILL`）。现在生命周期操作串成一条链串行化，且自己的子进程一律等就绪、不当僵尸清。
- 崩溃后必须能自愈：进程不在、也没有托管对象时，自愈改为直接拉起（此前会判「不由本插件托管」而跳过），外部启动的网关仍然一律不碰。
- 新路由 `POST /workbuddy/gateway/restart`；`/workbuddy/diagnose?deep=1` 会真发一次 1-token 对话，把结果写进 `checks.outbound`；`/workbuddy/status` 新增 `selfHeal`（`count` / `backoffMs` / `last` / `logWatch`）便于确认自愈是否真的跑过。
- 看门狗 tick 全包 try/catch：单轮异常不再可能带崩 DSH 宿主进程。
- 背景故障：2026-11-09 DSH 更新到 0.2.2-rc.1 时系统代理切换，把长寿命网关进程的 resolver 卡死，`/health` 仍 200、所有模型请求卡 126 秒后 503 `URLError: [Errno 8]`；旧看门狗只探 `/health`，永远不重启。

## 0.9.0 — 2026-11-07

**内置网关 1.10.7 → 2.0.0（上游 `d234396`，tag `v2.0.0`，上游最终版）**

- 整体替换 `vendor/wb-proxy` 的 `wb_*.py`、`dashboard.html`、`pricing/pricing.json`，与上游同版本逐字节一致（行尾统一 CRLF）。
- ⚠️ 上游已于 2026-11-06 宣布**停止维护**，v2.0.0 为最后一个版本；后续渠道指纹变化不再有上游跟进。
- CodeArts 出口工具归一化（修 `Tool function cannot empty`）：空 `function`、裸服务端工具、扁平声明统一转合规 function schema，`parameters` 缺失自动补 `{"type":"object","properties":{}}`，全部不可用时移除 `tools`/`tool_choice`。
- CodeArts 配置保存加锁（读-改-写原子化）、账号备注 / 任务开关 / 积分刷新 / 签到与令牌保活调度；支持图片输入与模型视觉能力；修复 OpenAI 格式错误响应丢失 429 状态码。
- 面板：默认控制台布局 + Alibaba 配色，新增可选新导航布局与「保持登录」；设置页分组在正體中文 / 英文下不再整页隐藏。
- 稳定性：413 响应不再被连接重置吞掉；参数类错误返回 400 且不冷却账号池；小账号池长会话固定同号（保住前缀缓存）；`x0.00` 免费倍率不再覆盖付费价；CodeArts 模型 ID 精确匹配（`deepseek-v4.1-flash` ≠ `-1017`）。
- 用量聚合缓存改异步补写（30s 起指数退避、封顶 15 分钟）+ 64MB 落后告警 + 按 pid 隔离临时文件；日志轮转日限校验；新增出站身份诊断工具。
- 启动契约不变：`--host/--port/--accounts-dir/--usage-dir/--panel-password`、`/health`、`/panel/login`、`/realm`、`?pwd=` 全部兼容。

## 0.8.0 — 2026-11-03

**内置网关 1.10.1 → 1.10.7（上游 `d177043`，tag `v1.10.7`）**

- 整体替换 `vendor/wb-proxy` 的 `wb_*.py`、`dashboard.html`、`pricing/pricing.json`，与上游同版本逐字节一致（行尾统一 CRLF）。
- 新增 `wb_media` / `wb_media_client` / `wb_media_tasks`：生图 / 图生图 / 异步生视频（默认关闭），本地排队与按分辨率计价。
- 新增 `wb_usage_io`：usage 日志并发原子追加（Windows 文件锁 + POSIX `O_APPEND`）。
- 国内版 `deepseek-v4.1-flash` 计费与出站修正：不再误标免费、不再误走 `-sg`；国际版恢复原生免费通道，`WB_DEEPSEEK_FLASH_FORCE_SG` 可切付费通道。
- CodeArts 每日签到按活动类型识别，支持可选自动签到（默认关）。
- 11-128 文件引用段指纹中和继续保留；启动契约不变（`/health` 新增 `crypto_ok` / `codearts` / `models_ready` 等子字段）。

## 0.7.0 — 2026-11-02

**内置网关 1.9.0 → 1.10.1（上游 `28527f4`，tag `v1.10.1`）**

- 整体替换 `vendor/wb-proxy` 的 `wb_*.py`、`dashboard.html`、`pricing/pricing.json`，与上游同版本逐字节一致（行尾统一 CRLF）。
- 新增模块 `wb_codearts` / `wb_codearts_crypto`：CodeArts 原生第三出口（默认关闭），面板可在国际版 / 国内版 / CodeArts 之间切换；OAuth2 PKCE + DPoP、token 续期、账号池与模型发现都在网关进程内完成。
- 429 响应新增 `X-RateLimit-Reset` / `X-RateLimit-Reset-At` 与正文 `reset_at`；工具名归一化过滤非法 `function.name`（修 11133）；CodeArts 会话上限与排队修复；代理槽支持 `user:pass` 认证与格式规整。
- 请求体上限可在面板动态调节（1–256 MB）；新增可选 `WB_STOP_AT_SSE_DONE=1` 与 `WB_CACHE_HTTP_ERROR_BODY=1`。
- 11128 文件引用段（`@deepseek-ai/dsh-file-reference`）指纹中和继续保留，之前修好的 `unapproved channel` 不会回退。
- 启动契约不变：`--host/--port/--accounts-dir/--usage-dir/--panel-password`、`/health`、`/panel/login`、`/realm`、`?pwd=` 均兼容；`/health` 新增 `crypto_ok`、`codearts` 等子字段。

## 0.6.0 — 2026-10-29

**内置网关 1.7.33 → 1.9.0（上游 `a6a967e`，tag `v1.9.0`）—— 修复 11128 渠道校验**

- 修复 `400 / code 11128 Illegal API invocation from an unapproved channel`：DSH 官方插件 `@deepseek-ai/dsh-file-reference` 注入的 `FILE_REFERENCE_PROMPT` 会被上游判成非官方客户端。v1.9.0 只给该段首句补一个 `that`（`paths the user` → `paths that the user`），打断整段连续匹配，语义不变且幂等；本地验证 `sanitize_text` 命中并保持二次调用不变。
- 其他同步内容：401 认 `WWW-Authenticate: invalid_token`（国内版 APISIX HTML 401）、国内版 6004 配额耗尽写入 `model_windows.json` 跨重启恢复、`/health` 按区域与模型细分、池空 503/429 精准归因 + `Retry-After`、国际版每日活跃 11140 持久化避让、可选 `WB_DESKTOP_CHAT_COMPAT=1`、SSE 心跳与零费率模型豁免。
- 模块集不变（30 个 `wb_*.py`），`--host/--port/--accounts-dir/--usage-dir/--panel-password`、`/health`、`/panel/login`、`/realm`、`?pwd=` 面板登录均保持兼容。
- 上游仍处于低频维护，README 保留风控收紧与责任提示，并新增 11128 排错条目。

## 0.5.0 — 2026-10-24

**内置网关 1.7.17 → 1.7.33（上游 `47775c5`，tag `v1.7.33`）**

- 整体替换 `vendor/wb-proxy` 的 `wb_*.py`、`dashboard.html`、`pricing/pricing.json`，与上游同版本逐字节一致（行尾统一 CRLF）。
- 新增模块：`wb_tiers`（账号档位 / 计费摘要）、`wb_webprompts`（网页活跃随机提示词）、`wb_update_portable` / `wb_update_apply` / `wb_update_external`（面板一键更新与版本回退的执行链）。
- 移除已被合并的 `wb_entitlements`（模型可用性标注改由目录 tier / `wb_tiers` 驱动）。
- 上游自 **v1.7.33（2026-10-23）起进入低频维护**，并提示风控持续收紧；README 增加对应提示（风险自担、优先官方客户端）。
- 这一批带来的主要能力：流式断流发标准 error 帧（不再伪造 `[DONE]`）、429 模型窗口跨重启恢复、静态 API Key（`ck_...`）账号、账号独立任务开关、账号级并发 + 会话粘滞、跨出口回退（默认关）、每日活跃预算 + 有序模型候选、身份句指纹扩展、思考档位映射、Pro Only 由目录 tier 驱动。
- 插件侧无需改启动契约：`--host/--port/--accounts-dir/--usage-dir/--panel-password`、`/health`、`/panel/login`、`/realm`、`?pwd=` 面板登录均保持不变；`gatewayVersion` 继续从 `UPSTREAM.json` 读取。
- README 的能力清单、徽章、同类项目星标同步更新。

## 0.4.0 — 2026-10-20

**内置网关 1.6.19 → 1.7.17（上游 `af706fc`，tag `v1.7.17`）**

- 整体替换 `vendor/wb-proxy` 的 `wb_*.py`、`dashboard.html`、`pricing/pricing.json`，与上游同版本逐字节一致（行尾统一 CRLF）。
- 新增 7 个模块：`wb_egress`（出口级退避）、`wb_entitlements`（模型可用性标注）、`wb_logstore`（日志看板存储）、`wb_quota_scan`（额度定时查询）、`wb_update_request`（面板更新请求）、`wb_upstream_pool`（上游连接复用）、`wb_window_probe`（窗口探针）。
- 新增 `vendor/wb-proxy/UPSTREAM.json`：记录上游 repo / tag / commit / 同步日期，升级时一起更新。
- `/workbuddy/status` 与 `/workbuddy/diagnose` 新增 `gatewayVersion`（及 commit / 同步日期）；右下角抽屉的状态 tooltip 也会显示网关版本。
- 网关的 catalog 归档改用 `WB_PROXY_CATALOG_DIR` 指到数据目录（`<dataDir>/catalog`），升级替换 vendor 时不丢，也不往代码目录写运行时文件。
- README 的 provider 配置补上 `compat`（思考档位）与 `retryPolicy`（熬过 WorkBuddy 约 60 秒的 429 冷却，避免「对话到一半中断」），并说明面板自带的「DSH 一键配置」写的是 `wb-proxy` provider，与本插件的 `workbuddy` 二选一。
- 上游这一版带来的主要能力：流式断流重试、模型级 5xx 不熔断整池、账号权重/备注、出口级退避、上游连接复用、模型额度定时主动查询、`/v1/models` 的 `entitlement` 标注、按账号定址路由 `/u/<ref>/v1/...`、面板一键配置更多客户端。

## 0.3.0 — 2026-10-13

- 自愈看门狗：连续两次健康检查失败后自动重拉，带冷却，避免拉起风暴。
- 一键自检 `/workbuddy/diagnose`：逐项检查 vendor / python / 数据目录 / 端口 / 账号，并给出 hints。
- 彻底脱离外部旧装：账号数据与代码目录分离，首次启动自动从旧装迁移。

## 0.2.0 — 2026-10-10

- 内置网关：插件自带 `vendor/wb-proxy`，随 DSH 启动拉起、退出停止。
- 网关 stdout/stderr 落盘，启动失败能带回真实原因。
- 同源反向代理改为「面板直连网关源站」，修掉路径前缀反代导致的 405。

## 0.1.0 — 2026-10-10

- 初始版本：WorkBuddy / CodeBuddy 网关接入、DSH 右下角状态图标与内嵌官方面板。
