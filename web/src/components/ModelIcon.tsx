import { Baidu, Claude, DeepSeek, Gemini, Github, Kimi, Meta, Nvidia, OpenAI, Qwen, Zhipu } from "@lobehub/icons";
import { Image as ImageIcon, Zap } from "lucide-react";

export function ModelIcon({ modelId, size = 18 }: { modelId: string; size?: number }) {
  const id = modelId.toLowerCase();
  if (id.includes("deepseek")) return <DeepSeek.Color size={size} />;
  if (id.includes("gemini") || id.includes("gemma") || id.includes("imagen")) return <Gemini.Color size={size} />;
  if (id.includes("claude")) return <Claude.Color size={size} />;
  if (id.includes("kimi") || id.includes("moonshot")) return <Kimi.Color size={size} />;
  if (id.includes("glm") || id.includes("z-ai")) return <Zhipu.Color size={size} />;
  if (id.includes("nemotron") || id.includes("nvidia") || id.includes("nim-")) return <Nvidia.Color size={size} />;
  if (id.includes("qwen") || id.includes("sf-")) return <Qwen.Color size={size} />;
  if (id.includes("ernie") || id.includes("baidu")) return <Baidu.Color size={size} />;
  if (id.includes("github")) return <Github size={size} />;
  if (id.includes("llama") || id.includes("meta/")) return <Meta.Color size={size} />;
  if (id.includes("cerebras")) return <Zap size={size} color="#f59e0b" />;
  if (id.includes("flux") || id.includes("kolors") || id.includes("image")) return <ImageIcon size={size} color="#10b981" />;
  return <OpenAI size={size} />;
}
