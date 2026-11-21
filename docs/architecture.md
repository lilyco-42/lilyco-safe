# `lilyco-relay` 架构与安全设计原理文档

## 1. 目标（Goal）
构建一个 **100% MIT 协议、零 AGPL 传染、以安全风控为第一优先级** 的 `new-api` 现代化 Rust 替代品，彻底杜绝上游注册漏洞导致批量刷号与 Token 盗刷，同时原生对接 `dev.lain42.top` 统一实付账户与 AI-Native MCP 协议。

## 2. 安全防盗刷架构（四道防线）
1. **零信任强类型边界（`relay-core`）**：
   - 所有外部 JSON 请求启用 `#[serde(deny_unknown_fields)]`，杜绝未声明字段注入与后端类型擦除。
   - `ClientIp` 等关键输入采用强类型构造校验；所有错误以结构化 `ErrorBody` + 外置 `config/i18n/*.toml` 多语言文案返回，生产代码零 `.unwrap()`。
2. **独立风控引擎（`relay-risk`）**：
   - **反 IP 伪造**：仅当 TCP 对端位于 `trusted_proxies` 时才信任 `X-Forwarded-For`。
   - **单 IP 滑动窗口限流 + 黑名单**：防止高频扫描与突发打爆。
   - **暴力破解 / 批量刷号自动锁定**：连续鉴权失败达 `max_auth_fail_per_ip` 自动封锁 `lockout_secs`。
   - **异常消耗熔断（Drain Guard）**：单次请求超上限或 1 分钟内突发大额扣费自动冻结 Key，阻止密钥泄露后余额被瞬间抽干。
3. **双钱包硬隔离 + 预扣核销（`relay-engine`）**：
   - AI API 仅允许扣减**实付余额 (`paid_credits`)**，彻底隔离免费/签到赠分；API Key 落库仅存 SHA-256 哈希，支持子 Key 模型白名单与单 Key 额度上限。
   - 请求前原子预扣，上游失败 100% 自动退还（0 扣费），成功或断连按精确 token 核销。
   - 邀请返佣仅在真实实付充值（`credit_real_topup`）时按 `affiliate_rate_bps` 结算，杜绝小号刷返佣。
4. **前后端硬解耦（`relay-server` + `web/`）**：
   - Rust 后端**绝不绘制 UI**，仅提供 OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`（Claude Code 兼容）、`/v1/models`、风控管理 API 与 Lilyco AI-Native `/mcp` 端点。
   - 现代前端位于 `web/`（TypeScript 强类型契约 + Vite），零 `any`、显式 XSS 转义。

## 3. 遵守 `lyco_dev` 四原则（Rule of 4）
- 顶层可见目录：4 个（`config/`、`crates/`、`docs/`、`web/`）。
- `crates/` 子目录：4 个（`relay-core`、`relay-risk`、`relay-engine`、`relay-server`）。
- 业务配置与多语言文案全外置至 `config/*.toml`，零硬编码常量。
