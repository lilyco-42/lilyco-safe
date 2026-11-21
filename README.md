# lilyco-relay

**100% MIT 协议、安全风控优先的 Rust AI API 中转网关（`new-api` 现代化替代品）**，严格按 [lyco_dev (`/dev`)](https://github.com/lilyco-42/lyco_dev) 工程规范构建。

## 核心特性
- **MIT 协议**：100% 自主知识产权，零 AGPL/GPL 风险，可自由闭源商用与企业私有化交付。
- **安全与风控优先（`relay-risk`）**：可信代理反 IP 伪造、单 IP 滑动窗口限流、暴力鉴权自动锁 IP、单 Key 异常大额盗刷自动熔断、零信任强类型入参（`deny_unknown_fields`）。
- **双钱包硬隔离 + 预扣核销（`relay-engine`）**：仅限实付余额调用高成本 AI 算力（严禁签到/赠分白嫖），上游失败自动 100% 退款，支持实付裂变邀请返佣。
- **多协议 + 多上游 + AI-Native MCP**：兼容 OpenAI (`/v1/chat/completions`)、Anthropic (`/v1/messages` / Claude Code)、Google AI Studio (Gemini)、OpenRouter、DeepSeek，并内置 Lilyco AI-Native `/mcp` 端点。
- **前后端彻底解耦**：Rust 后端零 UI，前端独立于 `web/`（TypeScript 强类型 + Vite）；所有配置与中英 i18n 外置为 `config/*.toml`。

## 快速运行与测试
```bash
# 运行全工作区单元测试 + 端到端风控/双协议集成测试
cargo test --workspace

# 启动网关（读取 config/gateway.toml 与 config/models.toml）
RELAY_ADMIN_KEY=your_secret GEMINI_API_KEY=... OPENROUTER_API_KEY=... cargo run -p relay-server

# 启动独立现代前端
cd web && npm install && npm run dev
```
