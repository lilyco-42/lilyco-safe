# Lilyco Relay 多二进制商业化架构与前端热更新指南

## 1. 设计目标（遵循 `lyco_dev` 商业级工程规范）
- **替代 `new-api` 商业安全隐患**：100% MIT 协议、零信任强类型边界、双钱包硬隔离、无 AGPL 传染风险。
- **故障域与编译隔离**：改一个模块只编译并重启对应二进制，绝不引发全站中断或全量慢编译。
- **前端零重启热更新**：前端静态产物完全外置在 `RELAY_WEB_DIR`（默认 `./web_dist`），服务端对 `index.html` 返回 `Cache-Control: no-cache, no-store, must-revalidate`，对带 Hash 的 `/assets/*` 返回 `immutable` 永久缓存；`rsync` 覆盖即瞬时生效，**无需重启任何 Rust 进程**。

## 2. 三个独立生产二进制（`bins/`）

| 二进制 | 默认端口 | 职责 | 重启影响 |
| :--- | :--- | :--- | :--- |
| `relay-proxy` | `:8091` | 数据面：`/v1/chat/completions`、`/v1/messages`、`/v1/images/generations`、`/v1/embeddings`、`/v1/rerank`、`/v1/models`、`/mcp` | 仅极少更新，支持 `SIGTERM` 优雅摘流 |
| `relay-admin` | `:8092` | 控制面：`/api/v1/*`（登录、Key 签发、钱包、日志、渠道池、动态同步、风控、兑换码）+ 前端热静态托管 | 高频迭代随时重启，**零影响在线 AI 推理** |
| `relay-worker` | 无端口 | 后台守护：定时上游测活、余额巡检、动态拉取上游模型 | 随时独立重启，无 HTTP 流量影响 |

> 本地开发仍可运行单进程一体化 `cargo run -p relay-server`。

## 3. 极速独立发布命令

```bash
# 仅热更新前端（零重启，1 秒生效）
cd web && npm run build && rsync -avz --delete dist/ lain42-dev:/opt/lilyco-relay/web_dist/

# 仅编译/重启数据面、控制面或后台巡检（互不影响）
cargo build --release -p relay-proxy
cargo build --release -p relay-admin
cargo build --release -p relay-worker
```

反向代理分流配置见 `deploy/pingap-split.toml`。
