# YSM Generation & High-Rated Reference Catalog API

## 1. High-Craft Multi-Stage YSM Generation (`POST /v1/ysm/generations`)

Supports single-pass fast generation (`fast`), Bilibili top-rated **Head-First 2-Stage sculpting** (`head_first`), and **3-Stage SSAO Vision Self-Check refinement** (`studio_refine`), powered by `ysm-web` and `chenx5452321/ysm-ai-engine`.

### Request Schema (Zero-Trust Typed, Backwards-Compatible)

```json
{
  "model": "free:gemini-2.5-flash",
  "prompt": "赛博猫耳女仆少女，银白渐变双马尾配发光翡翠丝带与长筒靴",
  "persona": {
    "name": "霓虹猫耳女仆",
    "personality": "元气灵动、带一点俏皮赛博感",
    "proportions": "slim",
    "outfit_notes": "黑白哥特女仆裙、发光翡翠丝带、猫耳与猫尾、头戴发光耳机"
  },
  "reference": {
    "turnaround_images": ["data:image/png;base64,..."],
    "ref_model_name": "绫波 (AllTheYSM.st 社区榜)",
    "ref_model_summary": "题材：碧蓝航线 · Rating: 4.9",
    "pipeline": "head_first"
  }
}
```

- **3-View Turnaround Analysis**: When `turnaround_images` are supplied, `ysm_engine.analyze_ref` extracts quantitative Bedrock proportions and dominant palette colors, AND the images are passed as multimodal `image_url` parts to vision-capable models (with automatic graceful fallback to text + quantitative summary for text-only models).
- **Atomic Credit Hold & Refund**: Compilation & YSM 2.6.0 validation run inside the billing transaction; any upstream or packaging failure automatically refunds credits.
- **Output**: Validated `application/zip` containing `ysm.json`, `models/main.json`, `models/arm.json`, 29 standard animations, 512×512 PNG texture, 4-view SSAO `renders/turnaround.png`, and `renders/head_closeup.png`.

## 2. High-Rated Multi-Source YSM Reference Catalog (`GET /api/v1/ysm/catalog`)

Aggregates high-rated YSM models from `dev.lain42.top/mc-assets` (2,266+ station catalog), `alltheysm.st` (2,254+ community models), and optional HTTPS compatible custom sources (`/api/v1/manifest.json`).

### Geo-IP & 18+/NSFW Region Compliance

Both `GET /api/v1/ysm/catalog` and `dev.lain42.top/mc-assets` inspect visitor country (`CF-IPCountry`, `X-Country-Code`, `X-Forwarded-For`, `X-Real-IP` + cached GeoIP lookup, fail-safe default `CN`). For restricted regions (default `CN`, configurable via `NSFW_RESTRICTED_COUNTRIES`), 18+/NSFW YSM models are excluded from listings and blocked with `HTTP 451 Unavailable For Legal Reasons` on direct preview/texture/download endpoints.
