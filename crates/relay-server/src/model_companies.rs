use relay_core::ModelConfig;
use serde::Serialize;

struct Company {
    id: &'static str,
    name: &'static str,
    color: &'static str,
    focus: &'static str,
}

const COMPANIES: [Company; 12] = [
    Company {
        id: "openai",
        name: "OpenAI",
        color: "#64748B",
        focus: "推理 · 编程",
    },
    Company {
        id: "anthropic",
        name: "Anthropic",
        color: "#D97757",
        focus: "编程 · 长文分析",
    },
    Company {
        id: "google",
        name: "Google",
        color: "#4285F4",
        focus: "多模态 · 长上下文",
    },
    Company {
        id: "deepseek",
        name: "DeepSeek",
        color: "#486DFF",
        focus: "推理 · 开发",
    },
    Company {
        id: "alibaba",
        name: "阿里巴巴",
        color: "#7358FA",
        focus: "中文 · 开放模型",
    },
    Company {
        id: "moonshot",
        name: "月之暗面",
        color: "#5A81F0",
        focus: "长文 · 编程",
    },
    Company {
        id: "zhipu",
        name: "智谱",
        color: "#1674FF",
        focus: "中文 · 工具调用",
    },
    Company {
        id: "xai",
        name: "xAI",
        color: "#8796AE",
        focus: "推理 · 多模态",
    },
    Company {
        id: "meta",
        name: "Meta",
        color: "#0866FF",
        focus: "开放模型 · 多语种",
    },
    Company {
        id: "mistral",
        name: "Mistral AI",
        color: "#FA720B",
        focus: "多语种 · 编程",
    },
    Company {
        id: "nvidia",
        name: "NVIDIA",
        color: "#76B900",
        focus: "开放模型 · 推理",
    },
    Company {
        id: "tencent",
        name: "腾讯",
        color: "#00A3E8",
        focus: "中文 · 多模态",
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
enum Tier {
    Luna,
    Terra,
    Sol,
    Astra,
}

#[derive(Serialize)]
pub(crate) struct CompanyCard<'a> {
    id: &'static str,
    name: &'static str,
    color: &'static str,
    focus: &'static str,
    card_number: String,
    models: Vec<CatalogModel<'a>>,
}

#[derive(Serialize)]
struct CatalogModel<'a> {
    id: &'a str,
    owned_by: &'a str,
    input_per_m: u64,
    output_per_m: u64,
    allow_free: bool,
    tier: Tier,
    flagship: bool,
    capabilities: Vec<&'static str>,
    text: bool,
}

fn company(raw: &str) -> Option<usize> {
    let id = raw.to_ascii_lowercase();
    let aliases: [&[&str]; 12] = [
        &["openai/", "gpt-", "gptoss", "sora-", "o1-", "o3-", "o4-"],
        &["anthropic/", "claude-"],
        &[
            "google/",
            "gemini-",
            "gemma-",
            "imagen-",
            "nano-banana",
            "veo-",
            "lyria-",
            "genie-",
        ],
        &["deepseek"],
        &["qwen", "tongyi", "z-image", "alibaba/", "wan-"],
        &["moonshot", "kimi-"],
        &["z-ai/", "glm-", "thudm/"],
        &["x-ai/", "xai/", "grok-"],
        &["meta/", "meta-llama", "llama-", "muse-spark"],
        &[
            "mistral",
            "ministral",
            "codestral",
            "pixtral",
            "devstral",
            "voxtral",
            "magistral",
        ],
        &["nvidia/", "nemotron", "nvclip", "nvidia-"],
        &["tencent/", "hunyuan", "hy4", "hunyuan-"],
    ];
    aliases
        .iter()
        .position(|patterns| patterns.iter().any(|marker| id.contains(marker)))
}

fn capabilities(id: &str) -> (bool, Vec<&'static str>) {
    let mut tags = Vec::new();
    if any(id, &["embedding", "embed-", "nvclip"]) {
        tags.push("向量");
    }
    if any(id, &["rerank"]) {
        tags.push("重排");
    }
    if any(id, &["image", "imagen", "nano-banana", "pixtral-image"]) {
        tags.push("图像");
    }
    if any(id, &["tts", "transcrib", "voxtral", "audio", "lyria"]) {
        tags.push("音频");
    }
    if any(id, &["sora-", "veo-", "genie-"]) {
        tags.push("视频");
    }
    let text = tags.is_empty();
    if text {
        tags.push("文本");
        if any(
            id,
            &["thinking", "reason", "deepseek-r", "deep-research", "o3-"],
        ) {
            tags.push("推理");
        }
        if any(id, &["code", "customtools", "devstral"]) {
            tags.push("开发");
        }
        if any(id, &["omni", "vision", "-vl", "pixtral"]) {
            tags.push("多模态");
        }
    }
    (text, tags)
}

fn any(id: &str, parts: &[&str]) -> bool {
    parts.iter().any(|part| id.contains(part))
}

fn model_slug(raw: &str) -> &str {
    raw.rsplit('/')
        .next()
        .unwrap_or(raw)
        .trim_start_matches("free:")
}

fn tier(raw: &str) -> Tier {
    let id = model_slug(raw);
    let has = |part| id.split(['-', ':', '.']).any(|token| token == part);

    // Match full tokens so "Gemini" doesn't get classified as "mini", and
    // vendor route prefixes like "Pro/Qwen/..." don't change product tier.
    if [
        "luna",
        "haiku",
        "nano",
        "mini",
        "lite",
        "small",
        "lightning",
        "7b",
        "8b",
        "4b",
    ]
    .into_iter()
    .any(has)
    {
        return Tier::Luna;
    }
    if has("terra") {
        return Tier::Terra;
    }
    if has("sol") || has("sonnet") {
        return Tier::Sol;
    }
    if [
        "astra", "opus", "neon", "ultra", "heavy", "large", "r1", "prime", "pro", "max",
    ]
    .into_iter()
    .any(has)
        || id.starts_with("grok-4")
        || id.starts_with("muse-spark")
    {
        return Tier::Astra;
    }
    if ["flash", "speed", "quick", "fast"].into_iter().any(has) {
        return Tier::Terra;
    }
    Tier::Sol
}

fn generations(raw: &str) -> [u32; 3] {
    let id = model_slug(raw);
    let version = id.split(['-', ':']).find_map(|token| {
        let candidate = token.trim_start_matches(|c: char| c.is_ascii_alphabetic());
        (!candidate.is_empty() && candidate.bytes().all(|b| b.is_ascii_digit() || b == b'.'))
            .then_some(candidate)
    });
    let mut key = [0; 3];
    if let Some(version) = version {
        for (slot, number) in key.iter_mut().zip(version.split('.')) {
            *slot = number.parse().unwrap_or_default();
        }
    }
    key
}

fn catalog_rank(model: &CatalogModel<'_>) -> (bool, Tier, bool, [u32; 3], bool, bool) {
    let id = model.id.to_ascii_lowercase();
    // Retired/batch/preview aliases remain selectable when supported by that interface.
    // Promote ordinary interactive SKUs ahead of wrappers for the company flagship.
    let interactive = !any(
        &id,
        &[":batch", "preview", "~", "experimental", "deprecated"],
    );
    (
        model.text,
        model.tier,
        interactive,
        generations(&id),
        id.contains("-pro"),
        !id.contains('/'),
    )
}

pub(crate) fn cards(models: &[ModelConfig]) -> Vec<CompanyCard<'_>> {
    let mut groups: Vec<Vec<CatalogModel<'_>>> = (0..COMPANIES.len()).map(|_| Vec::new()).collect();
    for model in models {
        let Some(index) = company(&model.id).or_else(|| company(&model.upstream_model)) else {
            continue;
        };
        let raw = model.id.to_ascii_lowercase();
        let id = if raw.starts_with("wb-") || company(&raw).is_none() {
            model.upstream_model.to_ascii_lowercase()
        } else {
            raw
        };
        let (text, capabilities) = capabilities(&id);
        groups[index].push(CatalogModel {
            id: &model.id,
            owned_by: &model.channel_id,
            input_per_m: model.input_per_m,
            output_per_m: model.output_per_m,
            allow_free: model.allow_free,
            tier: tier(&id),
            flagship: false,
            capabilities,
            text,
        });
    }
    COMPANIES
        .iter()
        .zip(groups)
        .enumerate()
        .map(|(rank, (company, mut models))| {
            models.sort_by(|a, b| {
                catalog_rank(b)
                    .cmp(&catalog_rank(a))
                    .then_with(|| a.id.cmp(b.id))
            });
            if let Some(model) = models.first_mut() {
                model.flagship = model.text;
            }
            CompanyCard {
                id: company.id,
                name: company.name,
                color: company.color,
                focus: company.focus,
                card_number: format!("{:06}", rank + 1),
                models,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, upstream: &str) -> ModelConfig {
        ModelConfig {
            id: id.into(),
            channel_id: "gateway".into(),
            upstream_model: upstream.into(),
            input_per_m: 0,
            output_per_m: 0,
            allow_free: true,
            billing_mode: relay_core::BillingMode::Token,
            unit_credits: 0,
        }
    }

    #[test]
    fn routes_do_not_affect_compute_tier_and_brand_is_not_a_size_token() {
        assert_eq!(tier("free:gemini-4-neon"), Tier::Astra);
        assert_eq!(tier("gemini-3.8-flash"), Tier::Terra);
        assert_eq!(
            tier("Pro/Qwen/Qwen2.5-7B-Instruct".to_ascii_lowercase().as_str()),
            Tier::Luna
        );
        assert_eq!(tier("qwen/qwen4-max"), Tier::Astra);
        assert!(generations("qwen/qwen4-max") > generations("qwen/qwen3.8-max-prime"));
    }

    #[test]
    fn groups_authors_and_selects_one_flagship_without_promoting_images() {
        let models = [
            model("openai/gpt-6-luna-pro:batch", ""),
            model("gpt-6.2-astra-pro", ""),
            model("alias", "anthropic/claude-opus-5.5"),
            model("claude-haiku-5.5", ""),
            model("free:groq-llama-3.3-70b", ""),
            model("gemini-3-pro-image-preview", ""),
            model("free:gemma-4-31b", ""),
        ];
        let result = cards(&models);
        assert_eq!(result.len(), 12);
        assert_eq!(result[0].models[0].id, "gpt-6.2-astra-pro");
        assert_eq!(result[0].models[1].tier, Tier::Luna);
        assert_eq!(result[1].models.len(), 2);
        assert_eq!(result[2].models[0].id, "free:gemma-4-31b");
        assert_eq!(result[2].models.iter().filter(|m| m.flagship).count(), 1);
        assert_eq!(result[8].models[0].id, "free:groq-llama-3.3-70b");
        assert_eq!(result[11].card_number, "000012");
    }
}
