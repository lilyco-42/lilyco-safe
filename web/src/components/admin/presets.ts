export const PROVIDER_TYPES = [
  { value: "openai_compat", label: "OpenAI 兼容 (openai_compat)" },
  { value: "gemini_openai", label: "Google AI Studio / Gemini (gemini_openai)" },
  { value: "vertex_ai", label: "Google Cloud Vertex AI OAuth2 (vertex_ai)" },
  { value: "anthropic_native", label: "Anthropic 原生 (anthropic_native)" },
  { value: "openrouter", label: "OpenRouter (openrouter)" },
  { value: "moss_gpu", label: "自建 MOSS / AnimeXL GPU (moss_gpu)" },
];

export const PROVIDER_PRESETS = [
  { key: "vertex_ai", label: "Google Cloud Vertex AI (Veo / Lyria / Nano Banana · OAuth2 JSON)", provider: "vertex_ai", baseUrl: "https://us-central1-aiplatform.googleapis.com/v1", models: "lyria-002,veo-3.1-fast-generate-001,veo-2.0-generate-001,gemini-nano-banana-2.1" },
  { key: "aistudio", label: "Google AI Studio (Gemini / TTS / Imagen)", provider: "gemini_openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: "gemini-3.8-flash,gemini-2.5-flash,gemini-2.5-pro,gemini-2.5-flash-preview-tts,imagen-3.0-generate-002" },
  { key: "aistudio_free", label: "Google AI Studio 免费池 (14.4K RPD)", provider: "gemini_openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: "free:gemma-4-31b,free:gemma-4-26b,free:gemini-3.5-flash-lite,free:gemini-3.1-flash-lite,free:gemini-2.5-flash-preview-tts" },
  { key: "anthropic", label: "Anthropic 官方原生 (Claude)", provider: "anthropic_native", baseUrl: "https://api.anthropic.com/v1", models: "claude-sonnet-4,claude-sonnet-5.5" },
  { key: "moss_gpu", label: "自建 MOSS / AnimeXL GPU 算力池", provider: "moss_gpu", baseUrl: "http://127.0.0.1:4720", models: "free:moss-image-sft,free:noobai-xl-1.1,free:animagine-xl-4.0" },
  { key: "cloudflare", label: "Cloudflare AI Gateway / Workers AI", provider: "openai_compat", baseUrl: "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai", models: "deepseek-v4.1-flash,gemini-2.5-flash" },
  { key: "aws", label: "AWS Bedrock (OpenAI 兼容)", provider: "openai_compat", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", models: "claude-sonnet-4,deepseek-v4-pro" },
  { key: "openrouter", label: "OpenRouter (支持查余额 + 免费池)", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", models: "claude-sonnet-5.5,gpt-6.2-astra,free:qwen3-8b" },
  { key: "groq", label: "Groq 免费高速推理", provider: "openai_compat", baseUrl: "https://api.groq.com/openai/v1", models: "free:groq-llama-3.3-70b" },
  { key: "cerebras", label: "Cerebras 免费极速推理", provider: "openai_compat", baseUrl: "https://api.cerebras.ai/v1", models: "free:cerebras-llama-3.3-70b" },
  { key: "nvidia_nim", label: "NVIDIA NIM 免费推理", provider: "openai_compat", baseUrl: "https://integrate.api.nvidia.com/v1", models: "free:nim-llama-3.3-70b,free:nim-deepseek-r1" },
  { key: "siliconflow", label: "SiliconFlow 硅基流动 (免费生图 FLUX + 查余额)", provider: "openai_compat", baseUrl: "https://api.siliconflow.cn/v1", models: "free:sf-qwen2.5-7b,free:flux-1-schnell" },
  { key: "github_models", label: "GitHub Models 免费推理", provider: "openai_compat", baseUrl: "https://models.inference.ai.azure.com", models: "free:github-gpt-4o-mini,free:github-deepseek-r1" },
  { key: "openai", label: "OpenAI 官方 (Chat + Responses)", provider: "openai_compat", baseUrl: "https://api.openai.com/v1", models: "gpt-4o,gpt-4.1-mini" },
  { key: "deepseek", label: "DeepSeek 官方 (支持查余额)", provider: "openai_compat", baseUrl: "https://api.deepseek.com/v1", models: "deepseek-v3,deepseek-v4.1-flash" },
  { key: "xai", label: "xAI (Grok)", provider: "openai_compat", baseUrl: "https://api.x.ai/v1", models: "grok-3" },
  { key: "custom", label: "自定义 OpenAI 兼容中转站", provider: "openai_compat", baseUrl: "https://your-upstream.example.com/v1", models: "*" },
];
