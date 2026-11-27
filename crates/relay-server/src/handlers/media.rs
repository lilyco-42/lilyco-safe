use std::future::Future;
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use axum::Json;
use relay_core::{
    AsyncTaskMeta, AudioSpeechReq, ChatReq, ClientIp, MusicGenReq, RelayError, TokenUsage,
    VideoGenReq,
};
use serde::Deserialize;
use serde_json::json;

use super::chat::execute_chat_pipeline;
use super::client_ip_from;
use crate::state::AppState;

/// Shared zero-trust paid-hold wrapper for native Gemini multimodal endpoints (Rule of 4).
async fn run_paid_multimodal<F, Fut>(
    st: &AppState,
    client: (&ClientIp, &HeaderMap),
    billing: (&str, u64),
    call: F,
) -> Result<(serde_json::Value, String, u64), RelayError>
where
    F: FnOnce(relay_core::ModelConfig, Vec<relay_engine::LiveChannel>) -> Fut,
    Fut: Future<Output = Result<serde_json::Value, RelayError>>,
{
    let (ip, headers) = client;
    let (model_id, units) = billing;
    st.risk.check_ip(ip)?;
    let raw_key = AppState::extract_bearer(headers).ok_or_else(|| {
        st.risk.record_auth_failure(ip);
        RelayError::Unauthorized("missing bearer api key".into())
    })?;
    let model = st
        .router
        .find_model(model_id)
        .ok_or_else(|| RelayError::ModelNotFound(format!("unknown model {model_id}")))?;
    let verified = st.ledger.verify_api_key(&raw_key, &model.id).await?;
    st.risk.check_key_ip_whitelist(ip, &verified.allowed_ips)?;
    let policy = st.ledger.get_user_policy(&verified.record.username).await?;
    if policy.banned {
        return Err(RelayError::Forbidden("account is suspended".into()));
    }
    let hold_cost = policy.apply_discount(model.compute_fixed_cost(units));
    st.risk.check_key_spend(&verified.record.id, hold_cost)?;
    let hold = st.ledger.pre_hold_paid(&verified.record, hold_cost).await?;
    let pool = st.ledger.find_live_channels_with_owner(&model.id, &model.channel_id).await.unwrap_or_default();
    let mid = model.id.clone();
    let username = verified.record.username.clone();
    match call(model, pool).await {
        Ok(val) => {
            let _ = st.ledger.settle_hold(&hold, &mid, TokenUsage::default(), hold_cost).await;
            Ok((val, username, hold_cost))
        }
        Err(e) => {
            let _ = st.ledger.refund_hold(&hold, &mid).await;
            Err(e)
        }
    }
}

pub async fn api_audio_speech(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<AudioSpeechReq>,
) -> Response {
    if let Err(e) = req.validate() {
        return st.err_response(&headers, e);
    }
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    let router = st.router.clone();
    let model_id = req.model.clone();
    match run_paid_multimodal(&st, (&ip, &headers), (&model_id, 1), |m, pool| async move {
        router.call_speech_with_pool(&m, &req, &pool).await
    })
    .await
    {
        Ok((v, _, _)) => Json(v).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_music_generations(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<MusicGenReq>,
) -> Response {
    if let Err(e) = req.validate() {
        return st.err_response(&headers, e);
    }
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    let router = st.router.clone();
    let model_id = req.model.clone();
    match run_paid_multimodal(&st, (&ip, &headers), (&model_id, 1), |m, pool| async move {
        router.call_music_with_pool(&m, &req, &pool).await
    })
    .await
    {
        Ok((mut v, username, cost)) => {
            if let Ok(task) = st
                .ledger
                .create_async_task(
                    &AsyncTaskMeta {
                        username,
                        task_type: "music".into(),
                        model: model_id,
                        provider_op: format!("music:{}", v.get("created").and_then(|x| x.as_u64()).unwrap_or(0)),
                    },
                    cost,
                    "{\"ok\":true,\"format\":\"wav\"}",
                )
                .await
                && let Some(obj) = v.as_object_mut()
            {
                obj.insert("task_id".into(), json!(task.id));
            }
            Json(v).into_response()
        }
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_video_generations(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<VideoGenReq>,
) -> Response {
    if let Err(e) = req.validate() {
        return st.err_response(&headers, e);
    }
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    let router = st.router.clone();
    let model_id = req.model.clone();
    let duration_units = req.duration_sec.unwrap_or(4).clamp(4, 8) as u64;
    match run_paid_multimodal(&st, (&ip, &headers), (&model_id, duration_units), |m, pool| async move {
        router.call_video_with_pool(&m, &req, &pool).await
    })
    .await
    {
        Ok((mut v, username, cost)) => {
            let op_name = v.get("operation").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if !op_name.is_empty()
                && let Ok(task) = st
                    .ledger
                    .create_async_task(
                        &AsyncTaskMeta {
                            username,
                            task_type: "video".into(),
                            model: model_id,
                            provider_op: op_name,
                        },
                        cost,
                        "{}",
                    )
                    .await
                && let Some(obj) = v.as_object_mut()
            {
                obj.insert("task_id".into(), json!(task.id));
            }
            Json(v).into_response()
        }
        Err(e) => st.err_response(&headers, e),
    }
}


pub async fn api_video_operation(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(op): Path<String>,
    headers: HeaderMap,
) -> Response {
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    if let Err(e) = st.risk.check_ip(&ip) {
        return st.err_response(&headers, e);
    }
    let Some(raw_key) = AppState::extract_bearer(&headers) else {
        st.risk.record_auth_failure(&ip);
        return st.err_response(&headers, RelayError::Unauthorized("missing bearer api key".into()));
    };
    if let Err(e) = st.ledger.verify_api_key(&raw_key, "veo-2.0-generate-001").await {
        return st.err_response(&headers, e);
    }
    let pool = st.ledger.find_live_channels("veo-2.0-generate-001").await.unwrap_or_default();
    match st.router.poll_video_with_pool(&op, &pool).await {
        Ok(v) => {
            if v.get("done").and_then(|x| x.as_bool()).unwrap_or(false) {
                let status = if v.get("error").is_some() { "failed" } else { "succeeded" };
                let summary = serde_json::to_string(&v).unwrap_or_else(|_| "{}".into());
                let trimmed = if summary.len() > 4000 { &summary[..4000] } else { &summary };
                let _ = st.ledger.update_async_task_by_op(&op, status, trimmed).await;
            }
            Json(v).into_response()
        }
        Err(e) => st.err_response(&headers, e),
    }
}

/// Optional structured character persona for YSM generation (4 fields, Rule of 4).
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct YsmPersonaInput {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub personality: String,
    #[serde(default)]
    pub outfit_notes: String,
    #[serde(default)]
    pub proportions: String,
}

/// Optional 3-view turnaround images, high-rated YSM reference, and pipeline mode (4 fields, Rule of 4).
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct YsmReferenceInput {
    #[serde(default)]
    pub turnaround_images: Vec<String>,
    #[serde(default)]
    pub ref_model_name: String,
    #[serde(default)]
    pub ref_model_summary: String,
    #[serde(default)]
    pub pipeline: String,
}

/// Request payload for `POST /v1/ysm/generations` (4 fields, backwards-compatible with `{model, prompt}`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct YsmGenerationReq {
    model: String,
    prompt: String,
    #[serde(default)]
    persona: Option<YsmPersonaInput>,
    #[serde(default)]
    reference: Option<YsmReferenceInput>,
}

fn decode_image_data_url(url: &str) -> Option<Vec<u8>> {
    let trimmed = url.trim();
    if !trimmed.starts_with("data:image/") {
        return None;
    }
    let (_, b64) = trimmed.split_once(";base64,")?;
    if b64.len() > 8_000_000 {
        return None;
    }
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).ok()
}

fn build_ysm_text_prompt(
    prompt: &str,
    persona: Option<&YsmPersonaInput>,
    reference: Option<&YsmReferenceInput>,
    analysis: Option<&ysm_web::RefAnalysis>,
) -> String {
    let mut extras = Vec::new();
    if let Some(p) = persona {
        let mut items = Vec::new();
        if !p.name.trim().is_empty() {
            items.push(format!("Name: {}", p.name.trim()));
        }
        if !p.personality.trim().is_empty() {
            items.push(format!("Persona/Vibe: {}", p.personality.trim()));
        }
        if !p.proportions.trim().is_empty() {
            items.push(format!("Proportions: {}", p.proportions.trim()));
        }
        if !p.outfit_notes.trim().is_empty() {
            items.push(format!("Outfit & Accessory Notes: {}", p.outfit_notes.trim()));
        }
        if !items.is_empty() {
            extras.push(format!("Character Persona:\n{}", items.join("\n")));
        }
    }
    if let Some(r) = reference
        && (!r.ref_model_name.trim().is_empty() || !r.ref_model_summary.trim().is_empty())
    {
        extras.push(format!(
            "High-Rated YSM Reference Style: {}\nReference Notes: {}",
            r.ref_model_name.trim(),
            r.ref_model_summary.trim()
        ));
    }
    if let Some(a) = analysis {
        extras.push(format!("Quantitative 3-View Turnaround Analysis:\n{}", a.summary));
    }
    if extras.is_empty() {
        return prompt.to_string();
    }
    format!("Character prompt:\n{prompt}\n\n{}", extras.join("\n\n"))
}

fn make_ysm_user_content(text: &str, images: &[String]) -> relay_core::ChatContent {
    if images.is_empty() {
        return relay_core::ChatContent::Text(text.to_string());
    }
    let mut parts = vec![relay_core::ContentPart::Text {
        text: text.to_string(),
    }];
    for img_url in images {
        parts.push(relay_core::ContentPart::ImageUrl {
            image_url: relay_core::ImageUrlPart {
                url: img_url.clone(),
            },
        });
    }
    relay_core::ChatContent::Parts(parts)
}

async fn run_ysm_llm_stage(
    st: &AppState,
    ctx: (&ClientIp, &HeaderMap),
    model: &str,
    system_prompt: &str,
    text: &str,
    images: &[String],
) -> Result<String, RelayError> {
    let chat = ChatReq {
        model: model.to_string(),
        messages: vec![
            relay_core::ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            relay_core::ChatMessage {
                role: "user".into(),
                content: make_ysm_user_content(text, images),
            },
        ],
        stream: false,
        max_tokens: Some(4096),
    };
    let first = execute_chat_pipeline(st, ctx, &chat, |reply| async move { Ok(reply.content) }).await;
    if first.is_ok() || images.is_empty() {
        return first;
    }
    // Graceful fallback: retry text-only if upstream model rejects multimodal image_url parts.
    let fallback = ChatReq {
        model: model.to_string(),
        messages: vec![
            relay_core::ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            relay_core::ChatMessage {
                role: "user".into(),
                content: relay_core::ChatContent::Text(text.to_string()),
            },
        ],
        stream: false,
        max_tokens: Some(4096),
    };
    execute_chat_pipeline(st, ctx, &fallback, |reply| async move { Ok(reply.content) }).await
}

async fn run_ysm_compile_stage(
    st: &AppState,
    ctx: (&ClientIp, &HeaderMap),
    model: &str,
    system_prompt: &str,
    text: &str,
    images: &[String],
) -> Result<(String, Vec<u8>), RelayError> {
    let chat = ChatReq {
        model: model.to_string(),
        messages: vec![
            relay_core::ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            relay_core::ChatMessage {
                role: "user".into(),
                content: make_ysm_user_content(text, images),
            },
        ],
        stream: false,
        max_tokens: Some(4096),
    };
    let first = execute_chat_pipeline(st, ctx, &chat, |reply| async move {
        let zip = ysm_web::package_design(&reply.content).await.map_err(|error| {
            RelayError::UpstreamFailed(format!("model did not return a usable YSM design: {error}"))
        })?;
        Ok((reply.content, zip))
    })
    .await;
    if first.is_ok() || images.is_empty() {
        return first;
    }
    let fallback = ChatReq {
        model: model.to_string(),
        messages: vec![
            relay_core::ChatMessage {
                role: "system".into(),
                content: system_prompt.into(),
            },
            relay_core::ChatMessage {
                role: "user".into(),
                content: relay_core::ChatContent::Text(text.to_string()),
            },
        ],
        stream: false,
        max_tokens: Some(4096),
    };
    execute_chat_pipeline(st, ctx, &fallback, |reply| async move {
        let zip = ysm_web::package_design(&reply.content).await.map_err(|error| {
            RelayError::UpstreamFailed(format!("model did not return a usable YSM design: {error}"))
        })?;
        Ok((reply.content, zip))
    })
    .await
}

pub async fn api_ysm(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<YsmGenerationReq>,
) -> Response {
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(ip) => ip,
        Err(error) => return st.err_response(&headers, error),
    };
    let prompt = req.prompt.trim();
    if prompt.is_empty() || prompt.chars().count() > 4000 {
        return st.err_response(
            &headers,
            RelayError::InvalidInput("YSM prompt must be 1..4000 characters".into()),
        );
    }
    let turnaround_imgs: Vec<String> = req
        .reference
        .as_ref()
        .map(|r| r.turnaround_images.iter().take(3).cloned().collect())
        .unwrap_or_default();
    let pipeline = req
        .reference
        .as_ref()
        .map(|r| r.pipeline.trim().to_ascii_lowercase())
        .unwrap_or_default();

    // Run quantitative 3-view analysis on the primary turnaround image if provided (graceful fallback).
    let analysis = match turnaround_imgs.first().and_then(|u| decode_image_data_url(u)) {
        Some(bytes) => ysm_web::analyze_reference(&bytes).await.ok(),
        None => None,
    };

    let text_prompt = build_ysm_text_prompt(
        prompt,
        req.persona.as_ref(),
        req.reference.as_ref(),
        analysis.as_ref(),
    );

    // Stage 1 + 2 (Bilibili top-rated Head-First sculpting) or Single-Pass Fast mode
    // Packaging runs INSIDE execute_chat_pipeline so invalid designs atomically refund credits!
    let (design_reply, mut compiled_zip) = if pipeline == "head_first" || pipeline == "studio_refine" {
        let head_json = match run_ysm_llm_stage(
            &st,
            (&ip, &headers),
            &req.model,
            ysm_web::HEAD_STAGE_PROMPT,
            &text_prompt,
            &turnaround_imgs,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => return st.err_response(&headers, e),
        };
        let stage2_text = format!(
            "Stage 1 Finalized Head & Palette Blueprint:\n{head_json}\n\nOriginal Character Brief:\n{text_prompt}"
        );
        match run_ysm_compile_stage(
            &st,
            (&ip, &headers),
            &req.model,
            ysm_web::BODY_STAGE_PROMPT,
            &stage2_text,
            &turnaround_imgs,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => return st.err_response(&headers, e),
        }
    } else {
        match run_ysm_compile_stage(
            &st,
            (&ip, &headers),
            &req.model,
            ysm_web::DESIGN_PROMPT,
            &text_prompt,
            &turnaround_imgs,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => return st.err_response(&headers, e),
        }
    };

    // Stage 3: Optional SSAO Vision Self-Check & Refinement loop (graceful fallback to Stage 2 ZIP)
    if pipeline == "studio_refine"
        && let Ok(turnaround_png) = ysm_web::extract_turnaround_png(&compiled_zip).await
    {
        let render_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &turnaround_png);
        let mut refine_imgs = vec![format!("data:image/png;base64,{render_b64}")];
        if let Some(ref_img) = turnaround_imgs.first() {
            refine_imgs.push(ref_img.clone());
        }
        let refine_text = format!(
            "Current YSM Design JSON:\n{design_reply}\n\nOriginal Character Brief:\n{text_prompt}"
        );
        if let Ok((_, refined_zip)) = run_ysm_compile_stage(
            &st,
            (&ip, &headers),
            &req.model,
            ysm_web::REFINE_STAGE_PROMPT,
            &refine_text,
            &refine_imgs,
        )
        .await
        {
            compiled_zip = refined_zip;
        }
    }

    (
        [
            (header::CONTENT_TYPE, "application/zip"),
            (header::CONTENT_DISPOSITION, "attachment; filename=character-ysm.zip"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        compiled_zip,
    )
        .into_response()
}
