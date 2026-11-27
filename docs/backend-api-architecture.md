# Lilyco Relay — 后端 API 架构设计（全量对标 new-api）

> **设计定位**：MIT 协议、零信任强类型、前后端彻底解耦的 Rust AI API 网关。前端可随时替换或重绘（React / Vue / 移动端 / CLI），后端提供稳定、正交、100% 兼容主流 SDK 与 `new-api` 生态的统一 REST 契约。

---

## 一、双平面分离架构

```
                  ┌──────────────────────────────────────┐
                  │         Pingap Edge / HTTPS          │
                  └──────────────────┬───────────────────┘
                                     │
         ┌───────────────────────────┴───────────────────────────┐
         ▼                                                       ▼
┌─────────────────────────────────────┐ ┌─────────────────────────────────────┐
│    Data Plane（AI 推理数据面）       │ │    Control Plane（控制与管理面）     │
│    /v1/*  &  /v1beta/*  &  /mcp     │ │    /api/v1/*                        │
│    鉴权: sk-l42-... API Key         │ │    鉴权: Portal JWT / X-Admin-Key   │
│    (Bearer / x-api-key /            │ │    用户、钱包、令牌、渠道池、实时改价 │
│     x-goog-api-key / ?key=)         │ │    兑换码、系统公告、风控、异步任务   │
└─────────────────┬───────────────────┘ └─────────────────┬───────────────────┘
                  └───────────────────┬───────────────────┘
                                      ▼
         ┌───────────────────────────────────────────────────────┐
         │  relay-core (强类型契约 + BillingMode + deny_unknown)  │
         │  relay-risk (GCRA 限流 + IP 白名单 + 暴刷熔断)         │
         │  relay-engine (Turso 双钱包账本 + 归属优先多协议路由)  │
         └───────────────────────────────────────────────────────┘
```

### 统一请求生命周期（Data Plane 零信任 7 步管线）
1. **IP 解析与风控**：仅信任 `trusted_proxies` 的 `X-Forwarded-For`，执行黑名单 / 认证失败锁定 / GCRA 限流。
2. **多协议密钥鉴权**：自动兼容 `Authorization: Bearer`（OpenAI / Codex）、`x-api-key`（Anthropic / Claude Code）、`x-goog-api-key` 或 `?key=`（Google Gemini CLI），数据库仅存 SHA-256 哈希。
3. **RBAC 与白名单**：校验账号封禁、Key 过期时间、Key IP 白名单、Key 模型白名单、VIP/Admin 折扣率。
4. **统一计费预扣（Pre-Hold）**：
   - `token`：按输入/输出百万 Token 费率预估并预扣实付余额；
   - `per_call`：按 `unit_credits` 固定扣费（如 Lyria 15 积分/次、Nano Banana 10 积分/次）；
   - `per_second`：按 `duration_sec * unit_credits` 扣费（如 Veo 3.1：4s=80、8s=160 积分，防倒挂）；
   - `allow_free = true`：0 扣费。
5. **归属渠道优先 + 多协议路由**：优先命中 `model.channel_id` 归属渠道，再按 `priority/weight` 容灾切换；自动应用渠道级 `model_mapping` 重定向、渠道级 `daily_limit` 日上限、`backon` 指数退避重试与 429/5xx 冷却熔断。
6. **原子结算 / 失败全额退款**：上游成功按真实 `usage` 多退少补并写入 `relay_usage_logs`（异步长任务同步写入 `relay_async_tasks`）；上游任何失败 100% 自动退还预扣积分。
7. **错误脱敏**：所有上游异常统一清洗，绝不向客户端泄露上游 API Key 或内网 URL。

---

## 二、完整后端 API 契约清单

### 1. Data Plane — AI 推理与标准计费查询（API Key 鉴权）

| 方法 | 路径 | 兼容标准 / 用途 |
| :--- | :--- | :--- |
| `GET` | `/v1/models` | 模型广场（含 `billing_mode`, `unit_credits`, `allow_free`, 实时改价结果） |
| `GET` | `/v1/models/{model}` | 单模型详情与实时费率 |
| `POST` | `/v1/chat/completions` | OpenAI 对话 + 多模态 Vision + SSE 真流式（`include_usage` 精确结算） |
| `POST` | `/v1/completions` | OpenAI Legacy 文本补全（兼容 Continue / Vim 等旧插件） |
| `POST` | `/v1/responses` | OpenAI Responses API（Codex / 新版 OpenAI SDK） |
| `POST` | `/v1/messages` | Anthropic 原生消息（支持 `x-api-key` 与 `Bearer`，Claude Code 直连） |
| `POST` | `/v1/messages/count_tokens` | Anthropic Token 计数（Claude Code SDK 上下文预估） |
| `POST` | `/v1beta/models/{*model_action}` | Google Gemini 原生 REST 透传（`gemini-api-cli` 直连，支持 `free:` 多冒号模型） |
| `POST` | `/v1/embeddings` | 向量嵌入 |
| `POST` | `/v1/rerank` | 检索重排（RAG） |
| `POST` | `/v1/moderations` | OpenAI 内容安全审核 |
| `POST` | `/v1/images/generations` | 文生图（自动适配 SiliconFlow / Imagen 3/4 / Nano Banana / Vertex AI / MOSS） |
| `POST` | `/v1/images/edits` | 图像编辑（原始 multipart/form-data 25MB 透传） |
| `POST` | `/v1/audio/speech` | Gemini TTS 语音合成（自动封装 24kHz WAV） |
| `POST` | `/v1/audio/transcriptions` | Whisper / STT 语音转文字（原始 multipart 透传） |
| `POST` | `/v1/audio/translations` | Whisper / STT 语音翻译（原始 multipart 透传） |
| `POST` | `/v1/music/generations` | Lyria 002 AI 音乐生成（Vertex AI 优先 + 自动入异步任务表） |
| `POST` | `/v1/videos/generations` | Veo 2/3/3.1 异步视频生成（按秒计费 + 自动入异步任务表） |
| `GET` | `/v1/videos/operations/{*op}` | Veo 异步任务轮询（完成自动回写 `relay_async_tasks`） |
| `GET` | `/v1/dashboard/billing/subscription` | OpenAI 标准查总额度（CherryStudio / NextChat / OpenWebUI 通用） |
| `GET` | `/v1/dashboard/billing/usage` | OpenAI 标准查已用额度 |
| `GET` | `/v1/dashboard/billing/credit_grants` | OpenAI 标准查剩余可用额度 |
| `POST` | `/mcp` | AI-Native MCP JSON-RPC 2.0 工具接口 |

### 2. Control Plane — 公开与用户接口（JWT / 无鉴权）

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| `GET` | `/api/v1/health` | 网关健康探针与风控遥测 |
| `GET` | `/api/v1/pricing` | 公开价目表（含汇率 `10 credits/CNY`、分组折扣、`billing_mode`） |
| `GET` | `/api/v1/options/public` | 公开站点配置（公告、站名、备案号、客服链接） |
| `POST` | `/api/v1/auth/login` / `register` | 统一门户账号登录与注册 |
| `GET` | `/api/v1/me` | 当前用户角色、双钱包余额、令牌列表、用量与体验卡 |
| `GET` | `/api/v1/dashboard/stats` | 全局/个人聚合统计 |
| `GET` | `/api/v1/dashboard/breakdown` | 按模型聚合请求数 / Token / 扣费 Top 排行（前端图表专用） |
| `GET` | `/api/v1/logs` | 调用与计费明细日志（用户看自己，Admin 看全站） |
| `GET` | `/api/v1/tasks` & `/api/v1/tasks/{id}` | 统一多模态异步任务历史与详情 |
| `POST` | `/api/v1/keys` | 签发带额度/RPM/IP白名单/模型白名单/过期时间的 `sk-l42-...` 令牌 |
| `PUT` | `/api/v1/keys/{id}` | 修改令牌名称、额度上限、白名单与启停状态 |
| `POST` | `/api/v1/keys/revoke` | 即时吊销令牌 |
| `POST` | `/api/v1/redeem` | 兑换码充值 |
| `POST` | `/api/v1/affiliate/bind` & `transfer` | 推广绑定与返佣划转至实付余额 |

### 3. Control Plane — 系统管理接口（Admin JWT 或 `X-Admin-Key`）

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| `GET` / `POST` | `/api/v1/admin/channels` | 渠道列表与热接入/编辑（支持 6 种协议 + `model_mapping` + `daily_limit` + 留空保原 Key） |
| `PATCH` | `/api/v1/admin/channels/{id}/toggle` | 一键切换渠道启用/停用 |
| `DELETE` | `/api/v1/admin/channels/{id}` | 删除渠道 |
| `POST` | `/api/v1/admin/channels/{id}/probe` | 单渠道多协议测活 + 上游余额查询 |
| `POST` | `/api/v1/admin/channels/probe-all` | 一键批量测活全池所有启用渠道 |
| `POST` | `/api/v1/admin/models/sync` | 从全部启用上游动态拉取 `/models` |
| `POST` / `DELETE` | `/api/v1/admin/models/pricing` (`/{model}`) | 后台实时改价零重启生效（带成本倒挂异常预警）与恢复默认价 |
| `POST` | `/api/v1/admin/resell/keys` | 批量签发独立钱包转售 API Key |
| `GET` / `POST` | `/api/v1/admin/users` & `users/role` | 用户列表与 RBAC 角色/折扣/封禁管理 |
| `POST` | `/api/v1/admin/topup` | 幂等实付充值 + 自动推广分佣 |
| `GET` / `POST` / `DELETE` | `/api/v1/admin/redemptions` (`/{code}`) | 兑换码查询、批量生成、删除未使用码 |
| `GET` / `PUT` | `/api/v1/admin/options` | 系统公告与站点配置持久化（零重启生效） |
| `POST` | `/api/v1/admin/risk/block_ip` & `unblock_ip` | 实时 IP 封禁与解封 |
