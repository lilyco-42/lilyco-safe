//! Native Google AI Studio / Gemini multimodal protocol adapter.
//! Translates unified OpenAI-style / multimodal requests into native Gemini REST endpoints:
//! - Nano Banana (`gemini-*-image*`): `models/{m}:generateContent` (`responseModalities: ["IMAGE", "TEXT"]`)
//! - Imagen 3 / 4 (`imagen-*`): `models/{m}:predict`
//! - Gemini TTS (`gemini-*-tts*`): `models/{m}:generateContent` (`responseModalities: ["AUDIO"]`)
//! - Lyria (`lyria-*`): `models/{m}:predict`
//! - Veo 2 / 3 (`veo-*`): `models/{m}:predictLongRunning` + operation polling

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use backon::{ExponentialBuilder, Retryable};
use base64::Engine as _;
use relay_core::{AudioSpeechReq, ImageGenReq, MediaProtocol, MusicGenReq, RelayError, VideoGenReq};
use reqwest::Client;
use secrecy::ExposeSecret;
use serde_json::{Value, json};

use crate::ledger::LiveChannel;

/// Check whether a channel can speak native Google AI Studio REST protocol.
pub fn is_gemini_channel(ch: &LiveChannel) -> bool {
    ch.provider == "gemini_openai"
        || ch.provider == "gemini_native"
        || ch.base_url.contains("generativelanguage.googleapis.com")
}

/// Derive native `.../v1beta` root URL from an OpenAI-compat or native Gemini base URL.
pub fn native_v1beta_root(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if let Some(root) = trimmed.strip_suffix("/openai") {
        return root.to_string();
    }
    if trimmed.ends_with("/v1beta") || trimmed.ends_with("/v1") {
        return trimmed.to_string();
    }
    format!("{trimmed}/v1beta")
}

/// Normalize upstream model id for Gemini REST path (`models/{id}`).
fn clean_model_id(upstream_model: &str) -> String {
    upstream_model
        .trim()
        .trim_start_matches("free:")
        .trim_start_matches("google/")
        .trim_start_matches("models/")
        .to_string()
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn size_to_aspect_ratio(size: Option<&str>) -> &'static str {
    match size.unwrap_or("1024x1024").trim() {
        "768x1024" | "896x1152" => "3:4",
        "1024x768" | "1152x896" => "4:3",
        "1280x720" | "1344x768" | "1792x1024" => "16:9",
        "720x1280" | "768x1280" | "1024x1792" => "9:16",
        _ => "1:1",
    }
}

/// Send native Gemini JSON request with `backon` exponential backoff on transient 429/5xx.
async fn post_gemini_json(
    client: &Client,
    ch: &LiveChannel,
    url: &str,
    payload: &Value,
) -> Result<Value, RelayError> {
    let key = ch.api_key.expose_secret();
    let backoff = ExponentialBuilder::default()
        .with_min_delay(Duration::from_millis(350))
        .with_max_delay(Duration::from_secs(2))
        .with_max_times(2);

    let send_once = || async {
        let resp = client
            .post(url)
            .header("x-goog-api-key", key)
            .json(payload)
            .send()
            .await
            .map_err(|_| RelayError::UpstreamFailed(format!("upstream {} timeout", ch.id)))?;
        let status = resp.status();
        if status.is_success() {
            return resp
                .json::<Value>()
                .await
                .map_err(|_| RelayError::UpstreamFailed("invalid gemini upstream json".into()));
        }
        let code = status.as_u16();
        Err(RelayError::UpstreamFailed(format!(
            "upstream {} HTTP {code}",
            ch.id
        )))
    };

    send_once
        .retry(backoff)
        .when(|err| {
            let msg = err.to_string();
            msg.contains("HTTP 429") || msg.contains("HTTP 503") || msg.contains("timeout")
        })
        .await
}

/// Dispatch native Gemini image generation (Nano Banana or Imagen 3/4) and normalize to OpenAI format.
pub async fn generate_image(
    client: &Client,
    ch: &LiveChannel,
    upstream_model: &str,
    req: &ImageGenReq,
) -> Result<Value, RelayError> {
    let proto = MediaProtocol::detect(upstream_model);
    let model = clean_model_id(upstream_model);
    let root = native_v1beta_root(&ch.base_url);

    match proto {
        MediaProtocol::GeminiImagenPredict => {
            let url = format!("{root}/models/{model}:predict");
            let count = req.n.unwrap_or(1).clamp(1, 4);
            let aspect = size_to_aspect_ratio(req.size.as_deref());
            let body = json!({
                "instances": [{ "prompt": req.prompt }],
                "parameters": { "sampleCount": count, "aspectRatio": aspect }
            });
            let raw = post_gemini_json(client, ch, &url, &body).await?;
            let preds = raw
                .get("predictions")
                .and_then(Value::as_array)
                .ok_or_else(|| RelayError::UpstreamFailed("imagen returned no predictions".into()))?;
            let data: Vec<Value> = preds
                .iter()
                .filter_map(|p| p.get("bytesBase64Encoded").and_then(Value::as_str))
                .map(|b64| json!({ "b64_json": b64, "revised_prompt": req.prompt }))
                .collect();
            if data.is_empty() {
                return Err(RelayError::UpstreamFailed("imagen returned empty image payload".into()));
            }
            Ok(json!({ "created": now_unix(), "data": data }))
        }
        MediaProtocol::GeminiGenerateImage => {
            let url = format!("{root}/models/{model}:generateContent");
            let body = json!({
                "contents": [{ "role": "user", "parts": [{ "text": req.prompt }] }],
                "generationConfig": { "responseModalities": ["IMAGE", "TEXT"] }
            });
            let raw = post_gemini_json(client, ch, &url, &body).await?;
            let data = extract_inline_media(&raw, "image/", &req.prompt);
            if data.is_empty() {
                return Err(RelayError::UpstreamFailed(
                    "nano-banana returned no inline image".into(),
                ));
            }
            Ok(json!({ "created": now_unix(), "data": data }))
        }
        _ => Err(RelayError::UpstreamFailed(
            "non-gemini image model routed to gemini adapter".into(),
        )),
    }
}

/// Extract inlineData parts matching a MIME prefix from Gemini `generateContent` response.
fn extract_inline_media(raw: &Value, mime_prefix: &str, prompt: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(cands) = raw.get("candidates").and_then(Value::as_array) else {
        return out;
    };
    for cand in cands {
        let Some(parts) = cand
            .get("content")
            .and_then(|c| c.get("parts"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for part in parts {
            let Some(inline) = part.get("inlineData").or_else(|| part.get("inline_data")) else {
                continue;
            };
            let mime = inline
                .get("mimeType")
                .or_else(|| inline.get("mime_type"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !mime.starts_with(mime_prefix) {
                continue;
            }
            if let Some(b64) = inline.get("data").and_then(Value::as_str) {
                out.push(json!({
                    "b64_json": b64,
                    "mime_type": mime,
                    "revised_prompt": prompt,
                }));
            }
        }
    }
    out
}

/// Wrap raw 16-bit signed mono 24kHz PCM bytes in a minimal 44-byte RIFF/WAV header (zero deps).
pub fn pcm24k_to_wav(pcm: &[u8]) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let riff_len = data_len.saturating_add(36);
    let mut wav = Vec::with_capacity(pcm.len() + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_len.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM format
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&24_000u32.to_le_bytes()); // 24kHz
    wav.extend_from_slice(&48_000u32.to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

/// Generate TTS audio via native Gemini TTS (`gemini-2.5-flash-preview-tts`).
pub async fn generate_speech(
    client: &Client,
    ch: &LiveChannel,
    upstream_model: &str,
    req: &AudioSpeechReq,
) -> Result<Value, RelayError> {
    let model = clean_model_id(upstream_model);
    let root = native_v1beta_root(&ch.base_url);
    let url = format!("{root}/models/{model}:generateContent");
    let voice = req.voice.as_deref().unwrap_or("Kore");
    let body = json!({
        "contents": [{ "role": "user", "parts": [{ "text": req.input }] }],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice } }
            }
        }
    });
    let raw = post_gemini_json(client, ch, &url, &body).await?;
    let media = extract_inline_media(&raw, "audio/", &req.input);
    let first = media
        .first()
        .ok_or_else(|| RelayError::UpstreamFailed("gemini tts returned no audio".into()))?;
    let raw_b64 = first.get("b64_json").and_then(Value::as_str).unwrap_or("");
    let mime = first.get("mime_type").and_then(Value::as_str).unwrap_or("audio/L16;rate=24000");

    let want_wav = req.response_format.as_deref().unwrap_or("wav") == "wav";
    if want_wav && mime.contains("L16") {
        let pcm = base64::engine::general_purpose::STANDARD
            .decode(raw_b64)
            .map_err(|_| RelayError::UpstreamFailed("invalid base64 audio from gemini".into()))?;
        let wav_b64 = base64::engine::general_purpose::STANDARD.encode(pcm24k_to_wav(&pcm));
        return Ok(json!({
            "ok": true,
            "format": "wav",
            "mime_type": "audio/wav",
            "voice": voice,
            "audio_base64": wav_b64,
        }));
    }
    Ok(json!({
        "ok": true,
        "format": "pcm",
        "mime_type": mime,
        "voice": voice,
        "audio_base64": raw_b64,
    }))
}

/// Generate background music via Lyria (`lyria-002`).
pub async fn generate_music(
    client: &Client,
    ch: &LiveChannel,
    upstream_model: &str,
    req: &MusicGenReq,
) -> Result<Value, RelayError> {
    let model = clean_model_id(upstream_model);
    let root = native_v1beta_root(&ch.base_url);
    let url = format!("{root}/models/{model}:predict");
    let mut inst = json!({ "prompt": req.prompt });
    if let Some(ref neg) = req.negative_prompt
        && !neg.trim().is_empty()
    {
        inst["negative_prompt"] = json!(neg.trim());
    }
    let body = json!({ "instances": [inst] });
    let raw = post_gemini_json(client, ch, &url, &body).await?;
    Ok(json!({ "ok": true, "created": now_unix(), "data": raw }))
}

/// Start an asynchronous Veo video generation job (`predictLongRunning`).
pub async fn start_video_job(
    client: &Client,
    ch: &LiveChannel,
    upstream_model: &str,
    req: &VideoGenReq,
) -> Result<Value, RelayError> {
    let model = clean_model_id(upstream_model);
    let root = native_v1beta_root(&ch.base_url);
    let url = format!("{root}/models/{model}:predictLongRunning");
    let aspect = req.aspect_ratio.as_deref().unwrap_or("16:9");
    let duration = req.duration_sec.unwrap_or(5);
    let body = json!({
        "instances": [{ "prompt": req.prompt }],
        "parameters": { "aspectRatio": aspect, "durationSeconds": duration }
    });
    let raw = post_gemini_json(client, ch, &url, &body).await?;
    let op_name = raw.get("name").and_then(Value::as_str).unwrap_or("");
    Ok(json!({
        "ok": true,
        "status": "queued",
        "operation": op_name,
        "raw": raw,
    }))
}

/// Poll an existing Veo long-running operation by operation path.
pub async fn poll_video_job(
    client: &Client,
    ch: &LiveChannel,
    operation: &str,
) -> Result<Value, RelayError> {
    let clean_op = operation.trim().trim_start_matches('/');
    if clean_op.is_empty() || clean_op.contains("..") {
        return Err(RelayError::InvalidInput("invalid operation path".into()));
    }
    let root = native_v1beta_root(&ch.base_url);
    let url = format!("{root}/{clean_op}");
    let resp = client
        .get(&url)
        .header("x-goog-api-key", ch.api_key.expose_secret())
        .send()
        .await
        .map_err(|_| RelayError::UpstreamFailed(format!("upstream {} poll timeout", ch.id)))?;
    if !resp.status().is_success() {
        return Err(RelayError::UpstreamFailed(format!(
            "upstream {} poll HTTP {}",
            ch.id,
            resp.status().as_u16()
        )));
    }
    resp.json::<Value>()
        .await
        .map_err(|_| RelayError::UpstreamFailed("invalid poll json".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_gemini_native_root() {
        assert_eq!(
            native_v1beta_root("https://generativelanguage.googleapis.com/v1beta/openai"),
            "https://generativelanguage.googleapis.com/v1beta"
        );
        assert_eq!(
            native_v1beta_root("https://generativelanguage.googleapis.com/v1beta/"),
            "https://generativelanguage.googleapis.com/v1beta"
        );
    }

    #[test]
    fn builds_valid_wav_header() {
        let wav = pcm24k_to_wav(&[0u8; 100]);
        assert_eq!(wav.len(), 144);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
    }
}
