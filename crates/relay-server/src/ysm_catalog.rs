use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

const LAIN42_MANIFEST_URL: &str = "https://dev.lain42.top/mc-assets/api/v1/manifest.json";
const ALLTHEYSM_API_BASE: &str = "https://api.alltheysm.st/v1";
const GEO_CACHE_TTL: Duration = Duration::from_secs(24 * 3600);

const NSFW_KEYWORDS: &[&str] = &[
    "nsfw", "r18", "r-18", "18+", "18禁", "成人", "色情", "涩涩", "涩图",
    "全裸", "裸体", "露点", "情趣", "透明兔女郎", "兔女郎", "魅魔", "爆衣",
    "工口", "里番", "大尺度", "擦边", "乳摇", "绅士", "内衣", "比基尼",
    "bikini", "lingerie", "nude", "naked", "topless", "hentai", "lewd",
    "ecchi", "erotic", "porn", "bdsm", "fetish", "succubus", "ahegao",
    "uncensored", "oppai", "panties", "stripper",
];

static GEO_CACHE: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();

fn geo_cache() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    GEO_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Query params for `GET /api/v1/ysm/catalog` (DTO exception: HTTP query mirror).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct YsmCatalogQuery {
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub q: String,
    #[serde(default = "default_sort")]
    pub sort: String,
    #[serde(default)]
    pub free_only: bool,
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_limit")]
    pub limit: u32,
    #[serde(default)]
    pub custom_source: String,
}

fn default_source() -> String {
    "all".into()
}
fn default_sort() -> String {
    "downloads".into()
}
fn default_page() -> u32 {
    1
}
fn default_limit() -> u32 {
    24
}

/// Unified high-rated YSM reference entry (DTO exception: frontend catalog card contract).
#[derive(Debug, Clone, Serialize)]
pub struct YsmCatalogItem {
    pub id: String,
    pub source: String,
    pub source_label: String,
    pub title: String,
    pub description: String,
    pub authors: Vec<String>,
    pub downloads: u64,
    pub rating: f32,
    pub free: bool,
    pub license: String,
    pub tags: Vec<String>,
    pub cover_url: String,
    pub download_url: String,
    pub homepage_url: String,
}

#[derive(Debug, Serialize)]
pub struct YsmCatalogResp {
    pub ok: bool,
    pub total: usize,
    pub region_country: String,
    pub nsfw_filtered: bool,
    pub sources_used: Vec<String>,
    pub items: Vec<YsmCatalogItem>,
}

// === Upstream response mirrors (DTO exceptions) ===

#[derive(Deserialize)]
struct Lain42ManifestResp {
    #[serde(default)]
    items: Vec<Lain42Item>,
}

#[derive(Deserialize)]
struct Lain42Item {
    #[serde(default)]
    id: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    cost_points: u64,
    #[serde(default)]
    preview_url: String,
    #[serde(default)]
    download_url: String,
    #[serde(default)]
    category: String,
}

#[derive(Deserialize)]
struct AllTheYsmListResp {
    #[serde(default)]
    items: Vec<AllTheYsmItem>,
}

#[derive(Deserialize)]
struct AllTheYsmAuthor {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct AllTheYsmBrand {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct AllTheYsmItem {
    #[serde(rename = "modelId", default)]
    model_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    authors: Vec<AllTheYsmAuthor>,
    #[serde(rename = "versionCount", default)]
    version_count: u32,
    #[serde(rename = "latestVersion", default)]
    latest_version: String,
    #[serde(default)]
    free: Option<bool>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(rename = "modSupport", default)]
    mod_support: Vec<String>,
    #[serde(default)]
    nsfw: bool,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    brand: Option<AllTheYsmBrand>,
}

fn is_nsfw_item(title: &str, description: &str, tags: &[String], nsfw_flag: bool) -> bool {
    if nsfw_flag {
        return true;
    }
    let combined = format!("{title} {description} {}", tags.join(" ")).to_ascii_lowercase();
    NSFW_KEYWORDS.iter().any(|kw| combined.contains(kw))
}

fn is_restricted_country(code: &str) -> bool {
    let upper = code.trim().to_ascii_uppercase();
    if std::env::var("NSFW_FORCE_RESTRICT").ok().as_deref() == Some("1") {
        return true;
    }
    let list = std::env::var("NSFW_RESTRICTED_COUNTRIES").unwrap_or_else(|_| "CN".into());
    list.split(',')
        .map(|s| s.trim().to_ascii_uppercase())
        .any(|c| !c.is_empty() && c == upper)
}

fn extract_ip(headers: &HeaderMap, peer: SocketAddr) -> String {
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok())
        && let Some(first) = xff.split(',').next().map(str::trim)
        && first.parse::<IpAddr>().is_ok()
    {
        return first.to_string();
    }
    for key in ["cf-connecting-ip", "x-real-ip"] {
        if let Some(raw) = headers.get(key).and_then(|v| v.to_str().ok()).map(str::trim)
            && raw.parse::<IpAddr>().is_ok()
        {
            return raw.to_string();
        }
    }
    peer.ip().to_string()
}

fn is_private_ip(ip: &str) -> bool {
    match ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified(),
        Ok(IpAddr::V6(v6)) => v6.is_loopback() || v6.is_unspecified(),
        Err(_) => true,
    }
}

#[derive(Deserialize)]
struct IpApiResp {
    #[serde(default)]
    status: String,
    #[serde(rename = "countryCode", default)]
    country_code: String,
}

async fn resolve_region(client: &reqwest::Client, headers: &HeaderMap, peer: SocketAddr) -> (String, bool) {
    for key in ["cf-ipcountry", "x-country-code", "x-geoip-country", "x-vercel-ip-country"] {
        if let Some(raw) = headers.get(key).and_then(|v| v.to_str().ok()).map(str::trim) {
            let upper = raw.to_ascii_uppercase();
            if upper.len() == 2 && upper.chars().all(|c| c.is_ascii_alphabetic()) && upper != "XX" {
                return (upper.clone(), is_restricted_country(&upper));
            }
        }
    }
    let ip = extract_ip(headers, peer);
    if !is_private_ip(&ip) {
        if let Ok(guard) = geo_cache().lock()
            && let Some((code, ts)) = guard.get(&ip)
            && ts.elapsed() < GEO_CACHE_TTL
        {
            return (code.clone(), is_restricted_country(code));
        }
        let url = format!("http://ip-api.com/json/{ip}?fields=status,countryCode");
        if let Ok(resp) = client.get(&url).timeout(Duration::from_secs(2)).send().await
            && resp.status().is_success()
            && let Ok(parsed) = resp.json::<IpApiResp>().await
            && parsed.status == "success"
            && parsed.country_code.len() == 2
        {
            let code = parsed.country_code.to_ascii_uppercase();
            if let Ok(mut guard) = geo_cache().lock() {
                if guard.len() >= 4096 {
                    guard.clear();
                }
                guard.insert(ip, (code.clone(), Instant::now()));
            }
            return (code.clone(), is_restricted_country(&code));
        }
    }
    // Fail-safe mainland compliance default when country cannot be verified
    ("CN".into(), true)
}

fn score_alltheysm(item: &AllTheYsmItem) -> f32 {
    let dl_score = ((item.downloads as f32 + 1.0).log10() * 0.55).min(2.1);
    let mut bonus = 2.6_f32;
    if item.tags.iter().any(|t| t == "rich-actions") {
        bonus += 0.15;
    }
    if item.tags.iter().any(|t| t == "multi-texture") {
        bonus += 0.10;
    }
    if item.tags.iter().any(|t| t == "mod-compatible") || !item.mod_support.is_empty() {
        bonus += 0.10;
    }
    if item.version_count >= 3 {
        bonus += 0.10;
    }
    let raw = (bonus + dl_score).clamp(3.6, 5.0);
    (raw * 10.0).round() / 10.0
}

fn score_lain42(item: &Lain42Item) -> f32 {
    let dl_score = ((item.downloads as f32 + 1.0).log10() * 0.45).min(1.2);
    let bone_bonus = if item.title.contains("骨骼") { 0.45 } else { 0.15 };
    let desc_bonus = if item.description.chars().count() > 10 { 0.2 } else { 0.0 };
    let raw = (4.1 + bone_bonus + desc_bonus + dl_score).clamp(4.0, 5.0);
    (raw * 10.0).round() / 10.0
}

fn is_safe_custom_source(raw: &str) -> bool {
    let trimmed = raw.trim();
    if !trimmed.starts_with("https://") || trimmed.len() > 240 {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    let blocked = ["localhost", "127.", "10.", "192.168.", "169.254.", "0.0.0.0", "[::1]"];
    !blocked.iter().any(|b| lower.contains(b))
}

async fn fetch_lain42_source(
    client: &reqwest::Client,
    base_url: &str,
    source_id: &str,
    source_label: &str,
    q: &YsmCatalogQuery,
) -> Vec<YsmCatalogItem> {
    let sort_param = match q.sort.as_str() {
        "newest" => "newest",
        "downloads" => "downloads",
        _ => "featured",
    };
    let price_param = if q.free_only { "free" } else { "all" };
    let resp = client
        .get(base_url)
        .query(&[
            ("kind", "ysm"),
            ("page", &q.page.max(1).to_string()),
            ("limit", &q.limit.clamp(1, 48).to_string()),
            ("sort", sort_param),
            ("price", price_param),
            ("q", q.q.trim()),
        ])
        .timeout(Duration::from_secs(6))
        .send()
        .await;
    let Ok(r) = resp else { return Vec::new() };
    if !r.status().is_success() {
        return Vec::new();
    }
    let Ok(parsed) = r.json::<Lain42ManifestResp>().await else {
        return Vec::new();
    };
    parsed
        .items
        .into_iter()
        .map(|it| {
            let rating = score_lain42(&it);
            let mut tags = vec!["lain42-hub".to_string()];
            if !it.category.is_empty() {
                tags.push(it.category.clone());
            }
            if it.cost_points == 0 {
                tags.push("free".to_string());
            }
            YsmCatalogItem {
                id: if it.id.is_empty() { format!("lain42:{}", it.slug) } else { it.id },
                source: source_id.into(),
                source_label: source_label.into(),
                title: it.title,
                description: it.description,
                authors: vec!["dev.lain42.top 站内收录".into()],
                downloads: it.downloads,
                rating,
                free: it.cost_points == 0,
                license: "Community".into(),
                tags,
                cover_url: it.preview_url,
                download_url: it.download_url,
                homepage_url: "https://dev.lain42.top/mc-assets/".into(),
            }
        })
        .collect()
}

async fn fetch_alltheysm_source(
    client: &reqwest::Client,
    q: &YsmCatalogQuery,
    restrict_nsfw: bool,
) -> Vec<YsmCatalogItem> {
    let limit = q.limit.clamp(1, 48);
    let page = q.page.max(1);
    let trimmed_q = q.q.trim();
    let req = if !trimmed_q.is_empty() {
        client
            .get(format!("{ALLTHEYSM_API_BASE}/search"))
            .query(&[
                ("q", trimmed_q.to_string()),
                ("page", page.to_string()),
                ("limit", limit.to_string()),
            ])
    } else {
        let sort_val = if q.sort == "newest" { "newest" } else { "downloads" };
        client
            .get(format!("{ALLTHEYSM_API_BASE}/models"))
            .query(&[
                ("page", page.to_string()),
                ("limit", limit.to_string()),
                ("sort", sort_val.to_string()),
            ])
    };
    let Ok(r) = req.timeout(Duration::from_secs(6)).send().await else {
        return Vec::new();
    };
    if !r.status().is_success() {
        return Vec::new();
    }
    let Ok(parsed) = r.json::<AllTheYsmListResp>().await else {
        return Vec::new();
    };
    parsed
        .items
        .into_iter()
        .filter(|it| !q.free_only || it.free.unwrap_or(false))
        .filter(|it| !restrict_nsfw || !is_nsfw_item(&it.name, "", &it.tags, it.nsfw))
        .map(|it| {
            let rating = score_alltheysm(&it);
            let is_free = it.free.unwrap_or(false);
            let mut tags = it.tags.clone();
            if let Some(brand) = &it.brand
                && !brand.name.is_empty()
            {
                tags.insert(0, brand.name.clone());
            }
            let ver = if it.latest_version.is_empty() { "1.0" } else { it.latest_version.as_str() };
            let authors: Vec<String> = it
                .authors
                .iter()
                .map(|a| a.name.clone())
                .filter(|n| !n.is_empty())
                .collect();
            let desc_parts: Vec<String> = [
                it.brand.as_ref().map(|b| format!("题材：{}", b.name)),
                if !it.mod_support.is_empty() {
                    Some(format!("模组兼容：{}", it.mod_support.join("/")))
                } else {
                    None
                },
                Some(format!("版本数：{} · 最新 v{}", it.version_count.max(1), ver)),
            ]
            .into_iter()
            .flatten()
            .collect();
            YsmCatalogItem {
                id: format!("alltheysm:{}", it.model_id),
                source: "alltheysm".into(),
                source_label: "AllTheYSM.st 社区榜".into(),
                title: it.name,
                description: desc_parts.join(" · "),
                authors,
                downloads: it.downloads,
                rating,
                free: is_free,
                license: it.license.unwrap_or_else(|| "Unspecified".into()),
                tags,
                cover_url: format!("{ALLTHEYSM_API_BASE}/model/{}/cover", it.model_id),
                download_url: if is_free {
                    format!("{ALLTHEYSM_API_BASE}/download/{}/{ver}", it.model_id)
                } else {
                    format!("https://alltheysm.st/models/{}", it.model_id)
                },
                homepage_url: format!("https://alltheysm.st/models/{}", it.model_id),
            }
        })
        .collect()
}

pub async fn api_ysm_catalog(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<YsmCatalogQuery>,
) -> Response {
    let client = &st.runtime.portal_client;
    let (region_country, nsfw_filtered) = resolve_region(client, &headers, peer).await;
    let src = q.source.trim().to_ascii_lowercase();
    let mut sources_used = Vec::new();
    let mut items = Vec::new();

    match src.as_str() {
        "lain42" => {
            sources_used.push("dev.lain42.top/mc-assets".into());
            items.extend(
                fetch_lain42_source(client, LAIN42_MANIFEST_URL, "lain42", "dev.lain42.top 站内库", &q).await,
            );
        }
        "alltheysm" => {
            sources_used.push("alltheysm.st".into());
            items.extend(fetch_alltheysm_source(client, &q, nsfw_filtered).await);
        }
        "custom" if is_safe_custom_source(&q.custom_source) => {
            let base = q.custom_source.trim().trim_end_matches('/');
            let url = if base.ends_with("manifest.json") {
                base.to_string()
            } else {
                format!("{base}/api/v1/manifest.json")
            };
            sources_used.push(base.to_string());
            items.extend(fetch_lain42_source(client, &url, "custom", "自定义兼容源", &q).await);
        }
        _ => {
            sources_used.push("dev.lain42.top/mc-assets".into());
            sources_used.push("alltheysm.st".into());
            let (lain, all) = tokio::join!(
                fetch_lain42_source(client, LAIN42_MANIFEST_URL, "lain42", "dev.lain42.top 站内库", &q),
                fetch_alltheysm_source(client, &q, nsfw_filtered),
            );
            items.extend(lain);
            items.extend(all);
        }
    }

    if nsfw_filtered {
        items.retain(|it| !is_nsfw_item(&it.title, &it.description, &it.tags, false));
    }

    if q.sort == "downloads" {
        items.sort_by(|a, b| {
            b.rating
                .partial_cmp(&a.rating)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.downloads.cmp(&a.downloads))
        });
    }

    let total = items.len();
    Json(YsmCatalogResp {
        ok: true,
        total,
        region_country,
        nsfw_filtered,
        sources_used,
        items,
    })
    .into_response()
}
