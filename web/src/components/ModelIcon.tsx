import { Claude, DeepSeek, Gemini, Kimi, Nvidia, OpenAI, Qwen, Zhipu } from "@lobehub/icons";

export function ModelIcon({ modelId, size = 18 }: { modelId: string; size?: number }) {
  const id = modelId.toLowerCase();
  if (id.includes("deepseek")) return <DeepSeek.Color size={size} />;
  if (id.includes("gemini")) return <Gemini.Color size={size} />;
  if (id.includes("claude")) return <Claude.Color size={size} />;
  if (id.includes("kimi")) return <Kimi.Color size={size} />;
  if (id.includes("glm")) return <Zhipu.Color size={size} />;
  if (id.includes("nemotron")) return <Nvidia.Color size={size} />;
  if (id.includes("qwen")) return <Qwen.Color size={size} />;
  return <OpenAI size={size} />;
}
