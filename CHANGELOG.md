# Changelog

本插件自带一份 [workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) 网关（`vendor/wb-proxy`）。每次同步上游都会在这里记一笔，方便对照 `vendor/wb-proxy/UPSTREAM.json` 里的 tag / commit。

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
