# Unified Multimodal API Pool & Gemini Native Adapter (`v2`)

## Goal
打通 `lilyco-relay` 的全协议多模态 API 池子，消除此前“只能走 OpenAI `/v1beta/openai` 兼容层导致 Imagen / Nano Banana / TTS / Lyria / Veo 无法调用或误路由到 OpenRouter”的架构缺口，复用现有 `gemini-aistudio-pool-1` / `gemini-aistudio-free` Key 池、双钱包预扣/退费事务与无锁熔断。

## Design & Why (`lyco_dev` + `lib.rs` Ecosystem)
1. **强类型协议分派（`crates/relay-core/src/multimodal.rs`）**：
   - 使用编译期穷尽枚举 `MediaProtocol`（`OpenAiCompat`, `GeminiGenerateImage`, `GeminiImagenPredict`, `GeminiTts`, `GeminiLyria`, `GeminiVeo`），消灭运行时字符串猜字段。
   - 所有新增请求 DTO（`AudioSpeechReq`, `MusicGenReq`, `VideoGenReq`）均满足 Rule of 4（≤ 4 字段）、`#[serde(deny_unknown_fields)]` 与显式 `validate()`。
2. **原生多模态适配器（`crates/relay-engine/src/gemini_adapter.rs`）**：
   - 引入 `lib.rs` 成熟生态 **`backon`**（MIT/Apache-2.0，`no_std` 友好）对 429/503/超时执行指数退避重试，配合 `DashMap` 无锁熔断冷却器。
   - 自动将现有 `generativelanguage.googleapis.com/v1beta/openai` 规范化为原生 `/v1beta`，使用 `x-goog-api-key` 认证，**零额外渠道配置即可激活现有 AI Studio Key 池**。
   - 将 Nano Banana (`gemini-*-image*`) 与 Imagen 3/4 (`imagen-*`) 的原生响应统一标准化为 OpenAI `ImageGenResp`（`data[].b64_json`）。
   - 为 Gemini TTS 内置零依赖 44 字节 RIFF/WAV 封装（`pcm24k_to_wav`），确保前端 `<audio>` 直接播放。
3. **原子计费与统一端点（`crates/relay-server`）**：
   - `POST /v1/images/generations` 自动识别 Nano Banana / Imagen 并隔离过滤出 Gemini 渠道池，防止误路由。
   - 新增 `POST /v1/audio/speech`、`POST /v1/music/generations`、`POST /v1/videos/generations`、`GET /v1/videos/operations/{*op}`，全部复用 `run_paid_multimodal`（IP 风控 → Key 鉴权 → 预扣双钱包 → 上游失败自动全额退费）。
   - 所有新增模型费率与渠道映射外置至 `config/models.toml`。
