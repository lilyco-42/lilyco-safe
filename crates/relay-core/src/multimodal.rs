use serde::{Deserialize, Serialize};

use crate::error::RelayError;

/// Compile-time exhaustive multimodal protocol discriminator (zero string-guessing at dispatch).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaProtocol {
    OpenAiCompat,
    GeminiGenerateImage,
    GeminiImagenPredict,
    GeminiTts,
    GeminiLyria,
    GeminiVeo,
}

impl MediaProtocol {
    /// Detect native protocol from normalized upstream model identifier.
    pub fn detect(upstream_model: &str) -> Self {
        let m = upstream_model
            .trim()
            .trim_start_matches("free:")
            .trim_start_matches("google/")
            .to_ascii_lowercase();
        if m.starts_with("imagen-") {
            return Self::GeminiImagenPredict;
        }
        if m.starts_with("gemini-") && (m.contains("-image") || m.contains("nano-banana")) {
            return Self::GeminiGenerateImage;
        }
        if m.starts_with("gemini-") && m.contains("-tts") {
            return Self::GeminiTts;
        }
        if m.starts_with("lyria-") {
            return Self::GeminiLyria;
        }
        if m.starts_with("veo-") {
            return Self::GeminiVeo;
        }
        Self::OpenAiCompat
    }

    pub fn is_gemini_native(self) -> bool {
        !matches!(self, Self::OpenAiCompat)
    }
}

/// Strictly typed OpenAI-compatible `/v1/audio/speech` request (4 fields, Rule of 4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AudioSpeechReq {
    pub model: String,
    pub input: String,
    #[serde(default)]
    pub voice: Option<String>,
    #[serde(default)]
    pub response_format: Option<String>,
}

impl AudioSpeechReq {
    pub fn validate(&self) -> Result<(), RelayError> {
        if self.model.trim().is_empty() || self.model.len() > 128 {
            return Err(RelayError::InvalidInput("model id must be 1..128 chars".into()));
        }
        let text = self.input.trim();
        if text.is_empty() || text.len() > 8_000 {
            return Err(RelayError::InvalidInput("speech input must be 1..8000 chars".into()));
        }
        if let Some(ref fmt) = self.response_format {
            let valid = matches!(fmt.as_str(), "wav" | "pcm" | "mp3");
            if !valid {
                return Err(RelayError::InvalidInput(
                    "response_format must be wav, pcm, or mp3".into(),
                ));
            }
        }
        Ok(())
    }
}

/// Strictly typed `/v1/music/generations` request for Lyria (4 fields, Rule of 4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MusicGenReq {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub duration_sec: Option<u16>,
    #[serde(default)]
    pub negative_prompt: Option<String>,
}

impl MusicGenReq {
    pub fn validate(&self) -> Result<(), RelayError> {
        if self.model.trim().is_empty() || self.model.len() > 128 {
            return Err(RelayError::InvalidInput("model id must be 1..128 chars".into()));
        }
        let p = self.prompt.trim();
        if p.is_empty() || p.len() > 2_000 {
            return Err(RelayError::InvalidInput("music prompt must be 1..2000 chars".into()));
        }
        if let Some(d) = self.duration_sec
            && !(5..=120).contains(&d)
        {
            return Err(RelayError::InvalidInput("duration_sec must be 5..120".into()));
        }
        Ok(())
    }
}

/// Strictly typed `/v1/videos/generations` request for Veo async jobs (4 fields, Rule of 4).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoGenReq {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    #[serde(default)]
    pub duration_sec: Option<u8>,
}

impl VideoGenReq {
    pub fn validate(&self) -> Result<(), RelayError> {
        if self.model.trim().is_empty() || self.model.len() > 128 {
            return Err(RelayError::InvalidInput("model id must be 1..128 chars".into()));
        }
        let p = self.prompt.trim();
        if p.is_empty() || p.len() > 2_000 {
            return Err(RelayError::InvalidInput("video prompt must be 1..2000 chars".into()));
        }
        if let Some(ref ar) = self.aspect_ratio {
            let valid = matches!(ar.as_str(), "16:9" | "9:16" | "1:1");
            if !valid {
                return Err(RelayError::InvalidInput(
                    "aspect_ratio must be 16:9, 9:16, or 1:1".into(),
                ));
            }
        }
        if let Some(d) = self.duration_sec
            && !(4..=8).contains(&d)
        {
            return Err(RelayError::InvalidInput("duration_sec must be 4..8".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_gemini_multimodal_protocols() {
        assert_eq!(MediaProtocol::detect("gemini-2.5-flash-image"), MediaProtocol::GeminiGenerateImage);
        assert_eq!(MediaProtocol::detect("free:gemini-3.1-flash-image-preview"), MediaProtocol::GeminiGenerateImage);
        assert_eq!(MediaProtocol::detect("imagen-4.0-generate-001"), MediaProtocol::GeminiImagenPredict);
        assert_eq!(MediaProtocol::detect("gemini-2.5-flash-preview-tts"), MediaProtocol::GeminiTts);
        assert_eq!(MediaProtocol::detect("lyria-002"), MediaProtocol::GeminiLyria);
        assert_eq!(MediaProtocol::detect("veo-3.0-generate-preview"), MediaProtocol::GeminiVeo);
        assert_eq!(MediaProtocol::detect("free:flux-1-schnell"), MediaProtocol::OpenAiCompat);
    }

    #[test]
    fn rejects_invalid_multimodal_inputs() {
        let bad_tts = AudioSpeechReq {
            model: "gemini-2.5-flash-preview-tts".into(),
            input: "   ".into(),
            voice: None,
            response_format: None,
        };
        assert!(bad_tts.validate().is_err());

        let bad_vid = VideoGenReq {
            model: "veo-2.0-generate-001".into(),
            prompt: "cinematic ocean".into(),
            aspect_ratio: Some("21:9".into()),
            duration_sec: Some(5),
        };
        assert!(bad_vid.validate().is_err());
    }
}
