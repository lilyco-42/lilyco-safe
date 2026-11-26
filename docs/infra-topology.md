# Lain42 / Lilyco 全站模块化拓扑与低维护运维手册

> 目标：**降低维护成本，让每个模块的维护者只需关心自己那一小块**——边界清晰、故障隔离、老用户零感知兼容、单模块 1 条命令独立发布。

## 1. 四大独立故障域（Rule of 4）

| 故障域 | 归属模块 | 变更频率 | 隔离边界 |
|---|---|---|---|
| **1. 边缘网关域** | `pingap` (`8.153.102.122:80/443`) | 低 | 唯一对外 TLS 入口、限流、静态缓存、老路径路由重写 |
| **2. 稳态商业与老业务域** | `studio-billing` (`:4700`)、`proxy-panel` (`:8010`)、校园跑 `paodou` 存量接口、官网静态页 | 极低 | 独立进程与账本，**永不与 AI 实验功能混跑** |
| **3. AI 统一中转域** | `lilyco-relay` (`123.60.38.191:8090` — `relay-proxy` / `relay-admin`) + `lain42-portal-dev` | 高 | 统一 OpenAI / Anthropic / Gemini 原生多模态路由、Key 池熔断、双钱包计费 |
| **4. 异步媒体与算力域** | `lain42-moss-broker` (`:4720`)、`mc-asset-hub` (`:8088`)、Kaggle/Colab GPU 节点、Telegram Bot | 中 | 耗时生图/视频/缩略图任务，挂了也不影响聊天 API 与支付 |

---

## 2. 两台服务器与云资源分工

### 服务器 A：`8.153.102.122`（`lain42.top` — 入口网关 + 稳态堡垒）
- **配置**：1.6 GiB RAM / 40 GB Disk（已通过 `/etc/cron.daily/lain42-disk-hygiene` 治理，当前 **83%，7.0 GB 可用**）
- **重要网页文件与数据审计**：
  - `/var/www/studio/downloads`（5.3 GB）：活业务软件镜像（后续可逐步迁 Cloudflare R2）
  - `/root/lyco/data/media`（2.1 GB）：`lyco-web` 活媒体数据
  - Docker 运行中容器：`new-api` (`:3000`)、`postgres`、`lysource` (`:8790`)、`redis`（旧业务依赖，严禁盲删）
  - 可选进一步释放项（待确认）：`/root/.rustup`（1.5 GB，生产机无需编 Rust）
- **核心常驻服务**：
  - `pingap.service` (`:80`, `:443`) — 全站统一反代与 TLS
  - `studio-billing.service` (`127.0.0.1:4700`) — 商业订单与激活
  - `proxy-panel.service` (`:8010`) — 专线订阅管理
  - `lyco-ai-gateway` (`:4705`) / `lyco-relay` (`:4706`) — 老站点兼容计量网关
  - `lain42-moss-broker.service` (`127.0.0.1:4720`) — MOSS 画廊与云端/GPU 调度（后续可平滑迁至 Server B + R2）

### 服务器 B：`123.60.38.191`（`dev.lain42.top` — AI 业务与高频迭代区）
- **配置**：1.7 GiB RAM / 40 GB Disk（余量 19 GB，负载健康）
- **核心常驻服务**：
  - `lilyco-relay.service` (`:8090`) — MIT 零信任 Rust AI 中转站（OpenAI / Anthropic / Gemini 原生多模态）
  - `lain42-portal-dev.service` (`:80`) / `lain42-portal-test.service` (`:443`) — 商业门户与支付
  - `relay-egress-proxy.service` (`127.0.0.1:7890`) — 上游出海代理（Mihomo）
  - `mc-asset-hub.service` (`:8088`) — YSM / Litematica 资产中心
  - `lilyco-account-pool.service` (`127.0.0.1:8793`) — 私有账号池

### 外部零固定成本弹性资源
- **Cloudflare R2**：存放 APK 安装包、画廊成图与缩略图、软件镜像（免出口流量费）。
- **Google Cloud (`project-f29a64c9-3ee2-474a-bb1`) & AI Studio**：Vertex AI / Nano Banana / Imagen / TTS / Lyria / Veo。
- **Kaggle / Colab**：免费 T4×2 GPU 节点（离线时由 `broker.py` 自动无感切换云端免费 FLUX.1 兜底）。

---

## 3. 老用户（校园跑等写死 `lain42.top` API 的旧 APK）兼容铁律
1. **Pingap 永久保留旧路径**：`/etc/pingap.toml` 中已有的 `paodou_legacy_exact_*`、`paodou_legacy_prefix_routes`、`/panel/api/` 等入口路径**永远不删、不改路径**；后端拆分或迁机只改 Pingap 的 `upstream`。
2. **新能力统一走版本化路径**：新客户端与新功能使用 `/api/v2/...` 或 `/relay/v1/...`。
3. **APK 升级采用分级策略**：
   - 默认通过版本检查接口弹出**软提示升级**（允许“稍后再说”），APK 托管在 Cloudflare R2；
   - 仅当老协议存在安全风险时，才对 `< min_supported_version` 强制更新。

---

## 4. 维护者「只管自己一小块」独立发布速查

| 我只改了这一块 | 执行命令 | 影响范围 |
|---|---|---|
| **Rust AI 中转后端**（协议/路由/计费） | `./deploy/deploy-relay-backend.sh` | 仅备份并重启 Server B `lilyco-relay`（失败自动回滚） |
| **Relay 前端静态页**（`web_dist` / CSS / JS） | `./deploy/deploy-relay-web.sh` | **零重启**，仅热替换静态资源 |
| **MOSS 绘梦与画廊 Broker** | `./deploy/deploy-moss-broker.sh` | 仅校验并重启 `lain42-moss-broker`，不影响中转与支付 |
| **模型列表与费率**（`config/models.toml`） | 更新后执行 `deploy-relay-backend.sh --config-only` | 仅更新 TOML 并重载 `lilyco-relay` |
