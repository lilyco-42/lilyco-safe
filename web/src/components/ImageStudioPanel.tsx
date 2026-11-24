import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Box,
  CheckCircle2,
  Download,
  Gamepad2,
  Image as ImageIcon,
  KeyRound,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Star,
  Upload,
  UserCheck,
  Wand2,
  X,
} from "lucide-react";
import {
  generateImage,
  generateYsmPackage,
  sendChat,
  type ChatContentPart,
  type ModelItem,
  type YsmCatalogItem,
} from "../api";
import { loadYsmFromZipFile } from "../ysm/ysmLoader";
import type { YsmPackage } from "../ysm/types";
import { YsmStudioViewer } from "./YsmStudioViewer";
import { YsmReferenceHub } from "./YsmReferenceHub";
import { ModelCompanyCards } from "./ModelCompanyCards";

interface Props {
  models: ModelItem[];
  apiKey: string;
  onApiKeyChange: (k: string) => void;
  onAfterGenerate: () => void;
  onToast: (msg: string) => void;
}

type StudioMode = "avatar" | "ysm";
type AvatarOutputKind = "avatar" | "portrait" | "turnaround";
type ProportionPreset = "standard" | "slim" | "chibi" | "tall";

interface RefSlot {
  id: string;
  dataUrl: string;
  name: string;
  palette: string;
}

interface GeneratedAvatarResult {
  id: string;
  style: string;
  model: string;
  outputKind: AvatarOutputKind;
  prompt: string;
  expandedPrompt: string;
  src: string;
  elapsedSec: string;
  createdAt: string;
}

interface GeneratedYsmEntry {
  id: string;
  pkg: YsmPackage;
  blob: Blob;
  filename: string;
  model: string;
  prompt: string;
  elapsedSec: string;
  createdAt: string;
}

const AVATAR_STYLES = [
  { id: "anime", label: "二次元精绘", tag: "high-craft anime illustration, crisp clean lineart, luminous layered eyes, studio lighting, masterpiece" },
  { id: "impasto", label: "日系厚涂", tag: "japanese anime illustration, rich painterly impasto, atmospheric volumetric rim light, detailed hair strands" },
  { id: "cyber", label: "赛博霓虹", tag: "cyberpunk anime character art, glowing emerald and cyan rim light, intricate techwear, sharp focus" },
  { id: "chibi", label: "Q版萌系", tag: "cute chibi anime character design, soft pastel shading, expressive starry eyes, clean white background" },
  { id: "pixel", label: "体素建模风", tag: "stylized minecraft bedrock anime character render, crisp studio 3-point lighting, clean silhouette" },
];

const AVATAR_OUTPUT_KINDS: Array<{ id: AvatarOutputKind; label: string; size: string; hint: string }> = [
  { id: "avatar", label: "头像特写", size: "1024x1024", hint: "1:1 高清头像" },
  { id: "portrait", label: "角色立绘", size: "768x1024", hint: "3:4 全身人设" },
  { id: "turnaround", label: "人物三视图", size: "1280x720", hint: "正/侧/背纯白底 · YSM 专用" },
];

const AVATAR_EXAMPLES = [
  { label: "海边银发少女", prompt: "海边黄昏微风吹起银白色长发，蓝紫色瞳孔，白色水手服配翡翠丝带，温柔微笑" },
  { label: "赛博猫耳女仆三视图", prompt: "银白双马尾赛博猫耳女仆，蓝绿异瞳，黑白哥特女仆装点缀发光翡翠丝带与长筒靴，纯白背景正面/侧面/背面三视图设定" },
  { label: "樱花古风剑客", prompt: "飘落樱花下的白衣古风少年，墨黑高马尾配青玉发簪，青白交领汉服与玄色束腰" },
  { label: "星辉学院魔女", prompt: "薰衣草紫长卷发小魔女，尖顶星空巫师帽，深蓝金色星纹斗篷与百褶短裙" },
];

const YSM_EXAMPLES = [
  {
    label: "赛博猫耳女仆",
    name: "霓虹猫耳女仆",
    personality: "元气灵动、带一点俏皮赛博感",
    proportions: "slim" as ProportionPreset,
    outfitNotes: "黑白哥特女仆裙、发光翡翠丝带、猫耳与猫尾、头戴发光耳机",
    prompt: "赛博猫耳女仆少女，银白渐变双马尾配黑色发光猫耳与猫尾，星空蓝眼，黑白哥特女仆装点缀霓虹翡翠丝带、百褶短裙、过膝袜与长筒靴",
  },
  {
    label: "银白机甲骑士",
    name: "银翼星辉骑士",
    personality: "冷静果敢、高挑御姐骑士气质",
    proportions: "tall" as ProportionPreset,
    outfitNotes: "银灰分层肩甲、发光蓝色胸甲核心、深蓝战裙与能量披风",
    prompt: "轻机甲银白骑士角色，银灰高马尾、冷峻锐利蓝瞳，银白分层肩甲与胸甲、深蓝战裙、背后飘逸披风与装甲战靴",
  },
  {
    label: "水墨青衫书生",
    name: "青玉墨衫客",
    personality: "温润清雅、古风侠气",
    proportions: "standard" as ProportionPreset,
    outfitNotes: "青白交领汉服宽袖、玄色束腰配青玉挂饰、墨黑高马尾",
    prompt: "国风青衫水墨书生，墨黑高马尾配白玉发饰，青白渐变交领汉服宽袖、玄色束腰与青玉腰佩，袖口带浅云纹装饰",
  },
  {
    label: "星辉学院魔女",
    name: "星轨见习魔女",
    personality: "古灵精怪、星辰魔法少女",
    proportions: "chibi" as ProportionPreset,
    outfitNotes: "尖顶星空巫师帽、星纹魔法披风、金色系带短靴",
    prompt: "星辉学院小魔女，薰衣草紫长卷发配尖顶星空巫师帽与光环，深蓝金色星纹斗篷、百褶短裙、白丝与系带短靴",
  },
];

const PREFERRED_YSM_TEXT_MODELS = [
  "free:gemini-2.5-flash",
  "free:gemma-4-31b",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "claude-sonnet-5.5",
  "gpt-6.2-astra",
  "deepseek-v4.1-flash",
];

const IMAGE_MODEL_RE = /(\bflux\b|imagen|dall-?e|kolors|stable-diffusion|sdxl|midjourney|qwen-image)/i;
const NON_TEXT_MODEL_RE = /(\bflux\b|imagen|dall-?e|kolors|stable-diffusion|sdxl|midjourney|qwen-image|embedding|rerank|whisper|tts|speech)/i;
const VISION_MODEL_RE = /(gemini|gemma-4|claude|gpt-4o|gpt-5|gpt-6|omni|vision|vl)/i;

function isImageModel(m: ModelItem): boolean {
  return Boolean(m.id) && IMAGE_MODEL_RE.test(m.id);
}

function isTextModel(m: ModelItem): boolean {
  return Boolean(m.id) && !NON_TEXT_MODEL_RE.test(m.id);
}

function isVisionCapable(id: string): boolean {
  return VISION_MODEL_RE.test(id);
}

function isFreeModel(m: ModelItem): boolean {
  return m.allow_free || (m.input_per_m === 0 && m.output_per_m === 0) || m.id.startsWith("free:");
}

function formatBytesKB(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function triggerZipDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function extractPaletteFromDataUrl(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 24;
        c.height = 24;
        const ctx = c.getContext("2d");
        if (!ctx) return resolve("balanced studio tones");
        ctx.drawImage(img, 0, 0, 24, 24);
        const data = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 16) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
        const hex = (v: number) => Math.round(v / Math.max(1, n)).toString(16).padStart(2, "0");
        resolve(`#${hex(r)}${hex(g)}${hex(b)}`);
      } catch {
        resolve("vivid anime palette");
      }
    };
    img.onerror = () => resolve("vivid anime palette");
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((res) => {
    const reader = new FileReader();
    reader.onload = () => res(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

export function ImageStudioPanel({
  models,
  apiKey,
  onApiKeyChange,
  onAfterGenerate,
  onToast,
}: Props) {
  const [mode, setMode] = useState<StudioMode>("ysm");
  const [showKey, setShowKey] = useState(!apiKey);

  // Derived model lists from AI Relay
  const imageModels = useMemo(() => models.filter(isImageModel), [models]);
  const textModels = useMemo(() => models.filter(isTextModel), [models]);
  const freeTextModels = useMemo(() => textModels.filter(isFreeModel), [textModels]);
  const paidTextModels = useMemo(() => textModels.filter((m) => !isFreeModel(m)), [textModels]);

  // Avatar & Turnaround Studio State
  const [imageModelId, setImageModelId] = useState("free:flux-1-schnell");
  const [assistModelId, setAssistModelId] = useState("free:gemini-2.5-flash");
  const [outputKind, setOutputKind] = useState<AvatarOutputKind>("avatar");
  const [styleId, setStyleId] = useState("anime");
  const [size, setSize] = useState("1024x1024");
  const [aiAssist, setAiAssist] = useState(true);
  const [refs, setRefs] = useState<RefSlot[]>([]);
  const [refNote, setRefNote] = useState("");
  const [prompt, setPrompt] = useState(AVATAR_EXAMPLES[0].prompt);
  const [busy, setBusy] = useState(false);
  const [stageText, setStageText] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [gallery, setGallery] = useState<GeneratedAvatarResult[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // YSM 3D Studio State
  const [textModelId, setTextModelId] = useState<string>("free:gemini-2.5-flash");
  const userPickedModelRef = useRef(false);
  const [ysmPrompt, setYsmPrompt] = useState(YSM_EXAMPLES[0].prompt);
  const [personaName, setPersonaName] = useState(YSM_EXAMPLES[0].name);
  const [personaPersonality, setPersonaPersonality] = useState(YSM_EXAMPLES[0].personality);
  const [personaProportions, setPersonaProportions] = useState<ProportionPreset>(YSM_EXAMPLES[0].proportions);
  const [personaOutfitNotes, setPersonaOutfitNotes] = useState(YSM_EXAMPLES[0].outfitNotes);
  const [turnaroundSlots, setTurnaroundSlots] = useState<Array<RefSlot | null>>([null, null, null]);
  const [selectedYsmRef, setSelectedYsmRef] = useState<YsmCatalogItem | null>(null);
  const [ysmPipeline, setYsmPipeline] = useState<"head_first" | "studio_refine" | "fast">("head_first");
  const turnaroundInputRef = useRef<HTMLInputElement>(null);
  const activeTurnaroundSlotRef = useRef<number>(0);

  const [ysmBusy, setYsmBusy] = useState(false);
  const [ysmStage, setYsmStage] = useState<"idle" | "requesting" | "parsing">("idle");
  const [ysmStageText, setYsmStageText] = useState("");
  const [ysmElapsedMs, setYsmElapsedMs] = useState(0);
  const [ysmError, setYsmError] = useState<string | null>(null);
  const [ysmHistory, setYsmHistory] = useState<GeneratedYsmEntry[]>([]);
  const [activeYsmId, setActiveYsmId] = useState<string | null>(null);
  const [ysmViewRev, setYsmViewRev] = useState(0);
  const ysmAbortRef = useRef<AbortController | null>(null);
  const ysmHistoryRef = useRef<GeneratedYsmEntry[]>([]);

  useEffect(() => {
    ysmHistoryRef.current = ysmHistory;
  }, [ysmHistory]);

  useEffect(() => {
    return () => {
      ysmAbortRef.current?.abort();
      for (const entry of ysmHistoryRef.current) {
        for (const tex of entry.pkg.textures) {
          if (tex.url.startsWith("blob:")) URL.revokeObjectURL(tex.url);
        }
        for (const render of entry.pkg.blenderRenders || []) {
          if (render.url.startsWith("blob:")) URL.revokeObjectURL(render.url);
        }
      }
    };
  }, []);

  useEffect(() => {
    if (textModels.length === 0) return;
    if (!userPickedModelRef.current || !textModels.some((m) => m.id === textModelId)) {
      const preferred =
        PREFERRED_YSM_TEXT_MODELS.find((id) => textModels.some((m) => m.id === id)) || textModels[0].id;
      setTextModelId(preferred);
      setAssistModelId(preferred);
    }
  }, [textModels, textModelId]);

  useEffect(() => {
    if (imageModels.length > 0 && !imageModels.some((m) => m.id === imageModelId)) {
      setImageModelId(imageModels[0].id);
    }
  }, [imageModels, imageModelId]);

  useEffect(() => {
    if (!busy) return;
    const t0 = performance.now();
    const timer = window.setInterval(() => setElapsedMs(Math.round(performance.now() - t0)), 100);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (!ysmBusy) return;
    const t0 = performance.now();
    const timer = window.setInterval(() => setYsmElapsedMs(Math.round(performance.now() - t0)), 100);
    return () => window.clearInterval(timer);
  }, [ysmBusy]);

  const activeStyle = AVATAR_STYLES.find((s) => s.id === styleId) || AVATAR_STYLES[0];
  const activeResult = gallery[activeIdx] || null;
  const activeYsmEntry = ysmHistory.find((item) => item.id === activeYsmId) || ysmHistory[0] || null;
  const ysmPromptLen = ysmPrompt.trim().length;
  const uploadedTurnaroundCount = turnaroundSlots.filter(Boolean).length;

  const handleFileUpload = async (files: FileList | null) => {
    if (!files) return;
    const remaining = 3 - refs.length;
    if (remaining <= 0) {
      onToast("最多上传 3 张角色参考图");
      return;
    }
    const list = Array.from(files).slice(0, remaining);
    for (const file of list) {
      if (!file.type.startsWith("image/")) continue;
      const dataUrl = await readFileAsDataUrl(file);
      const palette = await extractPaletteFromDataUrl(dataUrl);
      setRefs((prev) => [
        ...prev.slice(0, 2),
        { id: `${Date.now()}-${Math.random()}`, dataUrl, name: file.name, palette },
      ]);
    }
    onToast("已载入角色参考图，AI 视觉模型将直接识别五官、发色与服饰细节");
  };

  const handleTurnaroundUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const slotIndex = activeTurnaroundSlotRef.current;
    const validFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (validFiles.length === 0) return;

    const next = [...turnaroundSlots];
    for (let i = 0; i < validFiles.length && slotIndex + i < 3; i++) {
      const file = validFiles[i];
      const dataUrl = await readFileAsDataUrl(file);
      const palette = await extractPaletteFromDataUrl(dataUrl);
      next[slotIndex + i] = { id: `ta-${Date.now()}-${i}`, dataUrl, name: file.name, palette };
    }
    setTurnaroundSlots(next);
    onToast("已上传人物三视图！生成时将自动提取比例与色板并送入视觉大模型");
  };

  const sendImageToYsmTurnaround = (item: GeneratedAvatarResult) => {
    setTurnaroundSlots((prev) => {
      const next = [...prev];
      const emptyIdx = next.findIndex((s) => !s);
      const idx = emptyIdx === -1 ? 0 : emptyIdx;
      next[idx] = {
        id: `from-avatar-${Date.now()}`,
        dataUrl: item.src,
        name: `${item.outputKind}-${item.id}.png`,
        palette: "generated character sheet",
      };
      return next;
    });
    if (item.prompt.trim()) {
      setYsmPrompt(item.prompt.trim());
    }
    setMode("ysm");
    onToast("已将该角色图送入 YSM 人物三视图参考槽，可直接一键生成 3D 模型包！");
  };

  const addResultAsRef = (item: GeneratedAvatarResult) => {
    if (refs.length >= 3) {
      onToast("参考图槽位已满（最多 3 张），请先删除一张");
      return;
    }
    setRefs((prev) => [
      ...prev,
      { id: `gen-${Date.now()}`, dataUrl: item.src, name: "avatar-ref.png", palette: "consistent character" },
    ]);
    onToast("已设为参考图！现在可以换姿势、换场景或生成人物三视图");
  };

  const handleGenerateAvatar = async () => {
    if (!apiKey.trim()) {
      setShowKey(true);
      onToast("请先在左侧「令牌管理」签发或填入 API Key");
      return;
    }
    if (!prompt.trim() || busy) return;

    const t0 = performance.now();
    setBusy(true);
    setElapsedMs(0);

    const outputDirective =
      outputKind === "turnaround"
        ? "character turnaround reference sheet, full body front view, side profile view, and back view standing side by side in A-pose on pure solid white background, consistent proportions, clean anime concept art, no text, no watermark"
        : outputKind === "portrait"
          ? "full body anime character illustration, balanced composition, clean lighting, crisp silhouette"
          : "high-craft anime portrait avatar, upper body close-up, expressive detailed eyes, crisp lighting";

    try {
      let finalPrompt = `${prompt.trim()}, ${activeStyle.tag}, ${outputDirective}`;

      if (aiAssist) {
        const useVision = refs.length > 0 && isVisionCapable(assistModelId);
        setStageText(
          useVision
            ? `① AI 视觉帮画（${assistModelId}）：正在直接解析 ${refs.length} 张参考图角色特征并编写精修提示词...`
            : `① AI 帮画（${assistModelId}）：正在将描述扩写为高精度英文出图提示词...`,
        );

        const sys =
          "You are a senior anime character art director. Expand the user's request (and any attached reference images) into ONE concise, vivid English image-generation prompt (under 110 words). Faithfully preserve exact hair color/style, eye color, outfit layers, and accessories from the reference images. Output ONLY the English prompt with no quotes or preamble.";
        const textBody = [
          `画面描述：${prompt.trim()}`,
          `输出类型：${outputDirective}`,
          `目标画风：${activeStyle.label} (${activeStyle.tag})`,
          refs.length > 0 ? `参考图主色锚点：${refs.map((r) => r.palette).join(", ")}` : "",
          refNote.trim() ? `角色固定特征：${refNote.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        const userContent: string | ChatContentPart[] = useVision
          ? [
              { type: "text", text: textBody },
              ...refs.map((r) => ({ type: "image_url" as const, image_url: { url: r.dataUrl } })),
            ]
          : textBody;

        try {
          const expanded = await sendChat(
            apiKey.trim(),
            assistModelId,
            [
              { role: "system", content: sys },
              { role: "user", content: userContent },
            ],
            260,
          );
          if (expanded.reply.trim().length > 12) {
            finalPrompt = expanded.reply.trim().replace(/^["']|["']$/g, "");
          }
        } catch {
          // Graceful fallback to text-only prompt if vision/assist fails
          finalPrompt = `${prompt.trim()}, ${activeStyle.tag}, ${outputDirective}`;
        }
      }

      setStageText(`② 视觉生图引擎渲染中 (${imageModelId} · ${size})...`);
      const res = await generateImage(apiKey.trim(), {
        model: imageModelId,
        prompt: finalPrompt,
        size,
        n: 1,
      });
      const first = res.data?.[0];
      const src = first?.url || (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : "");
      if (!src) throw new Error("上游未返回图片数据");

      const elapsedSec = ((performance.now() - t0) / 1000).toFixed(1);
      const item: GeneratedAvatarResult = {
        id: `${Date.now()}`,
        style: activeStyle.label,
        model: imageModelId,
        outputKind,
        prompt: prompt.trim(),
        expandedPrompt: finalPrompt,
        src,
        elapsedSec,
        createdAt: new Date().toLocaleTimeString(),
      };
      setGallery((prev) => [item, ...prev]);
      setActiveIdx(0);
      onToast(`高清${outputKind === "turnaround" ? "人物三视图" : "角色图"}已生成（${elapsedSec}s）！`);
      onAfterGenerate();
    } catch (e) {
      onToast(`生成失败（已自动退回积分）：${(e as Error).message}`);
    } finally {
      setBusy(false);
      setStageText("");
    }
  };

  const handleCancelYsm = () => {
    ysmAbortRef.current?.abort();
    ysmAbortRef.current = null;
    setYsmBusy(false);
    setYsmStage("idle");
    setYsmStageText("");
    onToast("已取消本次 YSM 模型包生成");
  };

  const handleGenerateYsm = async () => {
    const trimmedKey = apiKey.trim();
    const trimmedPrompt = ysmPrompt.trim();

    if (!trimmedKey) {
      setShowKey(true);
      const msg = "请先在左侧「令牌管理」签发或在此填写 Bearer API Key（sk-l42-...）";
      setYsmError(msg);
      onToast(`YSM 生成失败：${msg}`);
      return;
    }
    if (!trimmedPrompt) {
      setYsmError("请输入角色外观、配色与服饰描述（1～4000 字符）");
      return;
    }
    if (trimmedPrompt.length > 4000) {
      setYsmError(`提示词长度为 ${trimmedPrompt.length} 字符，超过服务端 4000 字符上限`);
      return;
    }
    if (!textModelId.trim()) {
      setYsmError("请先选择一个可用的文本/视觉模型");
      return;
    }
    if (ysmBusy) return;

    const ctrl = new AbortController();
    ysmAbortRef.current = ctrl;
    const t0 = performance.now();

    const turnaroundImages = turnaroundSlots.filter((s): s is RefSlot => Boolean(s)).map((s) => s.dataUrl);
    const hasPersona = Boolean(
      personaName.trim() || personaPersonality.trim() || personaOutfitNotes.trim() || personaProportions !== "standard",
    );

    setYsmBusy(true);
    setYsmError(null);
    setYsmElapsedMs(0);
    setYsmStage("requesting");
    const pipeLabel =
      ysmPipeline === "studio_refine"
        ? "三阶段（头部精雕 → 躯干服饰 → SSAO 视觉自检精修）"
        : ysmPipeline === "head_first"
          ? "两阶段头身分离精雕（B站高赞方案）"
          : "极速单轮生成";
    setYsmStageText(
      `① 正在调用 ${textModelId} · ${pipeLabel}` +
        (turnaroundImages.length > 0 ? `（含 ${turnaroundImages.length} 张三视图视觉量尺）` : "") +
        (selectedYsmRef ? ` + 参考「${selectedYsmRef.title}」` : "") +
        "...",
    );

    try {
      const result = await generateYsmPackage(
        trimmedKey,
        {
          model: textModelId,
          prompt: trimmedPrompt,
          persona: hasPersona
            ? {
                name: personaName.trim(),
                personality: personaPersonality.trim(),
                outfit_notes: personaOutfitNotes.trim(),
                proportions: personaProportions,
              }
            : undefined,
          reference: {
            turnaround_images: turnaroundImages,
            ref_model_name: selectedYsmRef ? `${selectedYsmRef.title} (${selectedYsmRef.source_label})` : "",
            ref_model_summary: selectedYsmRef
              ? `${selectedYsmRef.description} | Tags: ${selectedYsmRef.tags.join(", ")} | Rating: ${selectedYsmRef.rating}`
              : "",
            pipeline: ysmPipeline,
          },
        },
        ctrl.signal,
      );

      setYsmStage("parsing");
      setYsmStageText(`② 已接收 ${result.filename}（${formatBytesKB(result.blob.size)}），正在解包 3D 模型、贴图与四视图 SSAO 渲染...`);

      const loadedPkg = await loadYsmFromZipFile(result.file);
      const elapsedSec = ((performance.now() - t0) / 1000).toFixed(1);
      const entryId = `ysm-${Date.now()}`;
      const entry: GeneratedYsmEntry = {
        id: entryId,
        pkg: loadedPkg,
        blob: result.blob,
        filename: result.filename,
        model: textModelId,
        prompt: trimmedPrompt,
        elapsedSec,
        createdAt: new Date().toLocaleTimeString(),
      };

      setYsmHistory((prev) => [entry, ...prev]);
      setActiveYsmId(entryId);
      setYsmViewRev((v) => v + 1);
      onToast(
        `YSM 模型包「${loadedPkg.name}」已生成并载入 3D 预览（${loadedPkg.geometry.bones.length} 骨骼 · ${elapsedSec}s）`,
      );
      onAfterGenerate();
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const msg = e instanceof Error && e.message ? e.message : "未知网络或解析错误";
      setYsmError(msg);
      if (/401|unauthorized|api key|bearer/i.test(msg)) setShowKey(true);
      onToast(`YSM 生成失败：${msg}`);
    } finally {
      if (ysmAbortRef.current === ctrl) ysmAbortRef.current = null;
      setYsmBusy(false);
      setYsmStage("idle");
      setYsmStageText("");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Top Mode Switcher */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className={`btn ${mode === "ysm" ? "btn-primary" : ""}`}
            onClick={() => setMode("ysm")}
          >
            <Box size={15} /> 我的世界 YSM · 三视图/人设建模 & 高分参考库
            <span
              className="pill pill-vip"
              style={{
                fontSize: 10.5,
                padding: "1px 6px",
                marginLeft: 4,
                ...(mode === "ysm" ? { background: "rgba(255,255,255,0.22)", color: "#fff", border: "none" } : {}),
              }}
            >
              YSM 2.6.0
            </span>
          </button>
          <button
            type="button"
            className={`btn ${mode === "avatar" ? "btn-primary" : ""}`}
            onClick={() => setMode("avatar")}
          >
            <Sparkles size={15} /> 角色头像 & 三视图工坊
            <span
              className="pill pill-ok"
              style={{
                fontSize: 10.5,
                padding: "1px 6px",
                marginLeft: 4,
                ...(mode === "avatar" ? { background: "rgba(255,255,255,0.22)", color: "#fff", border: "none" } : {}),
              }}
            >
              多引擎
            </span>
          </button>
        </div>

        <button type="button" className="btn btn-sm" onClick={() => setShowKey((v) => !v)}>
          <KeyRound size={13} /> {apiKey ? "API Key 已同步" : "填写 API Key"}
        </button>
      </div>

      {mode === "ysm" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Main YSM AI Generator Card */}
          <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Gamepad2 size={18} color="var(--primary)" />
                <strong style={{ fontSize: 16 }}>YSM AI Engine · 三视图 + 人设 + 高分参考联合建模</strong>
                <span className="pill pill-ok" style={{ fontSize: 11 }}>
                  {isVisionCapable(textModelId) ? "支持视觉三视图" : "文本 + 量尺模式"}
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <fieldset disabled={ysmBusy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                  <ModelCompanyCards
                    compact
                    textOnly
                    selected={textModelId}
                    onPick={(id) => {
                      userPickedModelRef.current = true;
                      setTextModelId(id);
                    }}
                  />
                </fieldset>
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 12 }}>全部中转站模型</summary>
                  <select
                    aria-label="全部文本与视觉模型"
                    id="ysm-text-model"
                    className="input mono"
                    value={textModelId}
                    disabled={ysmBusy}
                    onChange={(e) => {
                      userPickedModelRef.current = true;
                      setTextModelId(e.target.value);
                    }}
                    style={{ width: "auto", minWidth: 260, padding: "6px 10px", fontSize: 12.5, marginTop: 6 }}
                  >
                    {textModels.length === 0 ? (
                      <option value={textModelId}>{textModelId}</option>
                    ) : (
                      <>
                        {freeTextModels.length > 0 && (
                          <optgroup label={`免费模型 (${freeTextModels.length})`}>
                            {freeTextModels.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.id} {isVisionCapable(m.id) ? "[视觉]" : ""} · 0积分
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {paidTextModels.length > 0 && (
                          <optgroup label={`高配旗舰模型 (${paidTextModels.length})`}>
                            {paidTextModels.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.id} {isVisionCapable(m.id) ? "[视觉]" : ""} · {m.input_per_m}/{m.output_per_m} 积分/M
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </>
                    )}
                  </select>
                </details>
              </div>
            </div>

            {showKey && (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  className="input mono"
                  type="password"
                  placeholder="sk-l42-... Bearer API Key（复用 AI 中转站额度，失败自动退费）"
                  value={apiKey}
                  onChange={(e) => onApiKeyChange(e.target.value)}
                />
              </div>
            )}

            {/* Selected High-Rated YSM Reference Banner */}
            {selectedYsmRef && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "8px 12px",
                  borderRadius: 10,
                  border: "1px solid var(--primary)",
                  background: "var(--primary-soft)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  {selectedYsmRef.cover_url && (
                    <img
                      src={selectedYsmRef.cover_url}
                      alt={selectedYsmRef.title}
                      style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", flexShrink: 0 }}
                    />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                      <Star size={12} fill="#fbbf24" color="#fbbf24" />
                      已绑定高分参考：{selectedYsmRef.title}
                      <span className="pill" style={{ fontSize: 10 }}>{selectedYsmRef.source_label}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {selectedYsmRef.description}
                    </div>
                  </div>
                </div>
                <button type="button" className="btn btn-sm" onClick={() => setSelectedYsmRef(null)}>
                  <X size={12} /> 取消参考
                </button>
              </div>
            )}

            {/* Two-Column Input: 3-View Turnaround Upload + Character Persona */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
              {/* Left: 3-View Turnaround Uploader */}
              <div
                style={{
                  padding: 12,
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: "var(--bg-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Layers size={14} color="var(--primary)" /> 人物三视图上传（正面 / 侧面 / 背面）
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {uploadedTurnaroundCount} / 3 · 支持自动量尺
                  </span>
                </div>
                <input
                  ref={turnaroundInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => handleTurnaroundUpload(e.target.files)}
                />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                  {["正面 / 三视图", "侧面参考", "背面参考"].map((label, idx) => {
                    const slot = turnaroundSlots[idx];
                    return slot ? (
                      <div
                        key={slot.id}
                        style={{
                          position: "relative",
                          aspectRatio: "1 / 1",
                          borderRadius: 8,
                          overflow: "hidden",
                          border: "1px solid var(--primary)",
                          background: "#0d0f17",
                        }}
                      >
                        <img src={slot.dataUrl} alt={label} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        <button
                          type="button"
                          onClick={() =>
                            setTurnaroundSlots((prev) => prev.map((s, i) => (i === idx ? null : s)))
                          }
                          style={{
                            position: "absolute",
                            top: 4,
                            right: 4,
                            width: 20,
                            height: 20,
                            borderRadius: 99,
                            border: "none",
                            background: "rgba(0,0,0,0.7)",
                            color: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: "pointer",
                          }}
                        >
                          <X size={11} />
                        </button>
                        <span
                          style={{
                            position: "absolute",
                            bottom: 4,
                            left: 4,
                            fontSize: 10,
                            background: "rgba(0,0,0,0.68)",
                            color: "#fff",
                            padding: "1px 5px",
                            borderRadius: 5,
                          }}
                        >
                          {label}
                        </span>
                      </div>
                    ) : (
                      <button
                        key={label}
                        type="button"
                        disabled={ysmBusy}
                        onClick={() => {
                          activeTurnaroundSlotRef.current = idx;
                          turnaroundInputRef.current?.click();
                        }}
                        style={{
                          aspectRatio: "1 / 1",
                          borderRadius: 8,
                          border: "1.5px dashed var(--border)",
                          background: "var(--bg)",
                          color: "var(--text-muted)",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 4,
                          cursor: "pointer",
                          fontSize: 11,
                          padding: 6,
                          textAlign: "center",
                        }}
                      >
                        <Upload size={15} />
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
                  <span>没有三视图？去头像工坊先画一张</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setOutputKind("turnaround");
                      setSize("1280x720");
                      setMode("avatar");
                    }}
                    style={{ fontSize: 11, padding: "2px 8px" }}
                  >
                    AI 生成三视图 <ArrowRight size={11} />
                  </button>
                </div>
              </div>

              {/* Right: Character Persona Card */}
              <div
                style={{
                  padding: 12,
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: "var(--bg-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <UserCheck size={14} color="var(--primary)" /> 角色人设与体型设定（增强建模还原度）
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <input
                    className="input"
                    disabled={ysmBusy}
                    placeholder="角色名称（如：霓虹猫耳女仆）"
                    value={personaName}
                    onChange={(e) => setPersonaName(e.target.value)}
                    style={{ fontSize: 12 }}
                  />
                  <select
                    aria-label="体型比例"
                    className="input"
                    disabled={ysmBusy}
                    value={personaProportions}
                    onChange={(e) => setPersonaProportions(e.target.value as ProportionPreset)}
                    style={{ fontSize: 12 }}
                  >
                    <option value="standard">标准二次元比例</option>
                    <option value="slim">纤细少女比例</option>
                    <option value="chibi">Q版萌系比例</option>
                    <option value="tall">高挑御姐/骑士比例</option>
                  </select>
                </div>
                <input
                  className="input"
                  disabled={ysmBusy}
                  placeholder="性格与表情气质（如：元气微笑 / 高冷酷姐 / 腹黑邪笑 / 害羞软萌）"
                  value={personaPersonality}
                  onChange={(e) => setPersonaPersonality(e.target.value)}
                  style={{ fontSize: 12 }}
                />
                <input
                  className="input"
                  disabled={ysmBusy}
                  placeholder="服饰与招牌配饰（如：猫耳、光环、恶魔翼、蝴蝶结、耳机、斗篷）"
                  value={personaOutfitNotes}
                  onChange={(e) => setPersonaOutfitNotes(e.target.value)}
                  style={{ fontSize: 12 }}
                />
              </div>
            </div>

            {/* Pipeline Quality Mode Selector (Bilibili Top-Liked Workflow) */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>建模流水线：</span>
                {(
                  [
                    { id: "head_first", label: "头身分离精雕 (推荐 · B站高赞方案)" },
                    { id: "studio_refine", label: "头身分离 + SSAO 视觉自检精修 (旗舰)" },
                    { id: "fast", label: "极速单轮" },
                  ] as const
                ).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={ysmBusy}
                    className={`btn btn-sm ${ysmPipeline === p.id ? "btn-primary" : ""}`}
                    onClick={() => setYsmPipeline(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                推荐 Gemini 2.5/3.8 · GPT-6.2 Astra · Claude Sonnet 5.5（实测不推荐 DeepSeek 建模）
              </span>
            </div>

            {/* Quick Example Chips */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>一键填入人设示例：</span>
              {YSM_EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  className="btn btn-sm"
                  disabled={ysmBusy}
                  onClick={() => {
                    setYsmPrompt(ex.prompt);
                    setPersonaName(ex.name);
                    setPersonaPersonality(ex.personality);
                    setPersonaProportions(ex.proportions);
                    setPersonaOutfitNotes(ex.outfitNotes);
                    setYsmError(null);
                  }}
                >
                  <Sparkles size={12} color="var(--primary)" /> {ex.label}
                </button>
              ))}
            </div>

            {/* Prompt Input */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                  YSM 提示词（发型、发色渐变、瞳色、服饰层次、主副配色、挂件细节）
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    color: ysmPromptLen > 4000 ? "var(--danger)" : "var(--text-muted)",
                    fontWeight: ysmPromptLen > 4000 ? 700 : 400,
                  }}
                >
                  {ysmPromptLen} / 4000
                </span>
              </div>
              <textarea
                className="input"
                rows={3}
                disabled={ysmBusy}
                style={{ width: "100%", resize: "vertical", lineHeight: 1.6 }}
                placeholder="结合上方三视图与人设，补充你想强化的细节..."
                value={ysmPrompt}
                onChange={(e) => {
                  setYsmPrompt(e.target.value);
                  if (ysmError) setYsmError(null);
                }}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault();
                    handleGenerateYsm();
                  }
                }}
              />
            </div>

            {/* Action Bar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
                paddingTop: 10,
                borderTop: "1px solid var(--border)",
              }}
            >
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                支持 12 种精细发型 · 15 套多层次服饰 · 20 种立体配饰 · 四视图 SSAO 校验与 YSM 2.6.0 .zip 导出
              </span>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {activeYsmEntry && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      triggerZipDownload(activeYsmEntry.blob, activeYsmEntry.filename);
                      onToast(`已下载 YSM 模型包：${activeYsmEntry.filename}`);
                    }}
                  >
                    <Download size={13} /> 下载 ZIP ({formatBytesKB(activeYsmEntry.blob.size)})
                  </button>
                )}

                {ysmBusy && (
                  <button type="button" className="btn btn-sm" onClick={handleCancelYsm}>
                    <Square size={12} /> 取消
                  </button>
                )}

                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={ysmBusy || ysmPromptLen === 0 || ysmPromptLen > 4000}
                  onClick={handleGenerateYsm}
                  style={{ minWidth: 196, justifyContent: "center" }}
                >
                  {ysmBusy ? <Loader2 size={15} className="spin" /> : <Wand2 size={15} />}
                  {ysmBusy ? `生成中 ${(ysmElapsedMs / 1000).toFixed(1)}s...` : "一键生成高精 YSM 模型"}
                </button>
              </div>
            </div>

            {/* Multi-Stage Progress Strip */}
            {ysmBusy && (
              <div
                style={{
                  borderRadius: 10,
                  border: "1px solid var(--primary)",
                  background: "var(--primary-soft)",
                  padding: "10px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
                    <Loader2 size={15} className="spin" color="var(--primary)" />
                    <span>{ysmStageText}</span>
                  </div>
                  <span className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {(ysmElapsedMs / 1000).toFixed(1)}s
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11.5 }}>
                  <span className={`pill ${ysmStage === "requesting" ? "pill-vip" : "pill-ok"}`} style={{ fontSize: 11 }}>
                    1. 三视图量尺 · AI 角色蓝图 · YSM 引擎塑形校验
                  </span>
                  <span className={`pill ${ysmStage === "parsing" ? "pill-vip" : ""}`} style={{ fontSize: 11, opacity: ysmStage === "parsing" ? 1 : 0.65 }}>
                    2. 解包 3D 骨骼、512px 贴图与四视图 SSAO
                  </span>
                </div>
              </div>
            )}

            {/* Error Alert */}
            {ysmError && (
              <div
                role="alert"
                style={{
                  borderRadius: 10,
                  border: "1px solid var(--danger)",
                  background: "var(--danger-soft)",
                  padding: "12px 14px",
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                  <AlertCircle size={17} color="var(--danger)" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--danger)" }}>YSM 模型包生成失败</div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.5, wordBreak: "break-word" }}>{ysmError}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setYsmError(null)}
                  aria-label="关闭错误提示"
                  style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2 }}
                >
                  <X size={15} />
                </button>
              </div>
            )}

            {/* Session Generated YSM History */}
            {ysmHistory.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                  本次已生成 YSM 模型包（{ysmHistory.length}）· 点击切换 3D 预览或下载 ZIP
                </span>
                <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
                  {ysmHistory.map((item) => {
                    const isActive = activeYsmEntry?.id === item.id;
                    return (
                      <div
                        key={item.id}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "7px 10px",
                          borderRadius: 10,
                          border: isActive ? "1.5px solid var(--primary)" : "1px solid var(--border)",
                          background: isActive ? "var(--primary-soft)" : "var(--bg-subtle)",
                          flexShrink: 0,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setActiveYsmId(item.id);
                            setYsmViewRev((v) => v + 1);
                          }}
                          style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", textAlign: "left", padding: 0 }}
                        >
                          <div style={{ fontSize: 12.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}>
                            <CheckCircle2 size={13} color="var(--success)" />
                            {item.pkg.name}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {item.model} · {item.pkg.geometry.bones.length} 骨骼 · {item.elapsedSec}s
                          </div>
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          title={`下载 ${item.filename}`}
                          onClick={() => {
                            triggerZipDownload(item.blob, item.filename);
                            onToast(`已下载 ${item.filename}`);
                          }}
                          style={{ padding: "4px 7px" }}
                        >
                          <Download size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* 3D Interactive Stage (Defaults to MIT Skull Hoodie Girl Showcase) */}
          <YsmStudioViewer
            externalPackage={activeYsmEntry?.pkg ?? null}
            externalZip={activeYsmEntry ? { blob: activeYsmEntry.blob, filename: activeYsmEntry.filename } : null}
            externalKey={ysmViewRev}
            generating={ysmBusy}
            generatingText={ysmStageText}
            generatingElapsedMs={ysmElapsedMs}
          />

          {/* High-Rated Multi-Source YSM Reference Hub */}
          <YsmReferenceHub
            selectedRef={selectedYsmRef}
            onSelectRef={setSelectedYsmRef}
            onToast={onToast}
          />
        </div>
      ) : (
        /* Avatar & 3-View Turnaround Sheet Studio */
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(340px, 1.15fr) minmax(340px, 1fr)",
            gap: 16,
            alignItems: "start",
          }}
        >
          {/* Left Control Card */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="card" style={{ padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <ImageIcon size={18} color="var(--primary)" />
                  <strong style={{ fontSize: 16 }}>角色头像 & 三视图工坊</strong>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, cursor: "pointer", userSelect: "none" }}>
                  <input type="checkbox" checked={aiAssist} onChange={(e) => setAiAssist(e.target.checked)} />
                  <Wand2 size={13} color="var(--primary)" /> AI 视觉帮画
                </label>
              </div>

              {showKey && (
                <div style={{ marginBottom: 12 }}>
                  <input
                    className="input mono"
                    type="password"
                    placeholder="sk-l42-... API Key"
                    value={apiKey}
                    onChange={(e) => onApiKeyChange(e.target.value)}
                  />
                </div>
              )}

              {/* Image Engine + Vision Assist Selectors */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 4 }}>生图引擎（中转站）</div>
                  <select
                    aria-label="生图引擎"
                    className="input mono"
                    value={imageModelId}
                    onChange={(e) => setImageModelId(e.target.value)}
                    style={{ fontSize: 12 }}
                  >
                    {imageModels.length > 0 ? (
                      imageModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id} {isFreeModel(m) ? "· 0积分" : `· ${m.input_per_m}积分`}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="free:flux-1-schnell">free:flux-1-schnell · 0积分</option>
                        <option value="imagen-3.0-generate-002">imagen-3.0-generate-002 · Google Imagen 3</option>
                      </>
                    )}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 4 }}>AI 视觉扩写模型</div>
                  <select
                    aria-label="AI 视觉扩写模型"
                    className="input mono"
                    value={assistModelId}
                    disabled={!aiAssist}
                    onChange={(e) => setAssistModelId(e.target.value)}
                    style={{ fontSize: 12 }}
                  >
                    {textModels.length > 0 ? (
                      textModels.slice(0, 20).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id} {isVisionCapable(m.id) ? "[视觉]" : ""}
                        </option>
                      ))
                    ) : (
                      <option value={assistModelId}>{assistModelId}</option>
                    )}
                  </select>
                </div>
              </div>

              {/* Output Kind Switcher (Avatar / Portrait / 3-View Turnaround) */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>出图类型：</span>
                {AVATAR_OUTPUT_KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    className={`btn btn-sm ${outputKind === k.id ? "btn-primary" : ""}`}
                    onClick={() => {
                      setOutputKind(k.id);
                      setSize(k.size);
                    }}
                  >
                    {k.label} <span style={{ fontSize: 10.5, opacity: 0.8 }}>({k.hint})</span>
                  </button>
                ))}
              </div>

              {/* 3-Slot Reference Image Uploader */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                    角色参考图（视觉模型直接读图，保持发色/瞳色/服饰一致）
                  </span>
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{refs.length} / 3</span>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => handleFileUpload(e.target.files)}
                />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                  {[0, 1, 2].map((slotIdx) => {
                    const slot = refs[slotIdx];
                    return slot ? (
                      <div
                        key={slot.id}
                        style={{
                          position: "relative",
                          aspectRatio: "1 / 1",
                          borderRadius: 10,
                          overflow: "hidden",
                          border: "1px solid var(--primary)",
                          background: "var(--bg-subtle)",
                        }}
                      >
                        <img src={slot.dataUrl} alt={slot.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        <button
                          type="button"
                          onClick={() => setRefs((prev) => prev.filter((_, i) => i !== slotIdx))}
                          style={{
                            position: "absolute",
                            top: 6,
                            right: 6,
                            width: 22,
                            height: 22,
                            borderRadius: 99,
                            border: "none",
                            background: "rgba(0,0,0,0.68)",
                            color: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: "pointer",
                          }}
                        >
                          <X size={12} />
                        </button>
                        <span
                          style={{
                            position: "absolute",
                            bottom: 4,
                            left: 4,
                            fontSize: 10,
                            background: "rgba(0,0,0,0.65)",
                            color: "#fff",
                            padding: "1px 6px",
                            borderRadius: 6,
                          }}
                        >
                          参考图 {slotIdx + 1}
                        </span>
                      </div>
                    ) : (
                      <button
                        key={slotIdx}
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        style={{
                          aspectRatio: "1 / 1",
                          borderRadius: 10,
                          border: "1.5px dashed var(--border)",
                          background: "var(--bg-subtle)",
                          color: "var(--text-muted)",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 6,
                          cursor: "pointer",
                          fontSize: 12,
                        }}
                      >
                        {slotIdx === 0 ? <Upload size={18} /> : <Plus size={18} />}
                        <span>参考图 {slotIdx + 1}</span>
                      </button>
                    );
                  })}
                </div>
                {refs.length > 0 && (
                  <input
                    className="input"
                    style={{ marginTop: 8, fontSize: 12.5 }}
                    placeholder="可选补充角色固定特征锚点，如：银白长发、蓝瞳、黑色猫耳、翡翠丝带..."
                    value={refNote}
                    onChange={(e) => setRefNote(e.target.value)}
                  />
                )}
              </div>

              {/* Example Chips */}
              <div style={{ marginBottom: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {AVATAR_EXAMPLES.map((ex) => (
                  <button
                    key={ex.label}
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setPrompt(ex.prompt);
                      if (ex.label.includes("三视图")) {
                        setOutputKind("turnaround");
                        setSize("1280x720");
                      }
                    }}
                  >
                    <Sparkles size={12} color="var(--primary)" /> {ex.label}
                  </button>
                ))}
              </div>

              {/* Prompt Box */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>角色与画面描述</div>
                <textarea
                  className="input"
                  rows={4}
                  style={{ width: "100%", resize: "vertical", lineHeight: 1.6 }}
                  placeholder="描述角色外貌、发型、服饰与画风（可先生成三视图，再一键送入 YSM 建模）"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>

              {/* Style Preset Strip */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>画风：</span>
                {AVATAR_STYLES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`btn btn-sm ${styleId === s.id ? "btn-primary" : ""}`}
                    onClick={() => setStyleId(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              {/* Action Bar */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {imageModelId} · {size} · 失败自动退回积分
                </span>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={handleGenerateAvatar} style={{ minWidth: 168 }}>
                  {busy ? <Loader2 size={15} className="spin" /> : <ImageIcon size={15} />}
                  {busy ? `绘制中 ${(elapsedMs / 1000).toFixed(1)}s...` : outputKind === "turnaround" ? "生成人物三视图" : "生成高清角色图"}
                </button>
              </div>
            </div>
          </div>

          {/* Right Result Stage & Gallery */}
          <div className="card" style={{ padding: 20, minHeight: 540, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <strong style={{ fontSize: 15 }}>生成结果</strong>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {gallery.length > 0 ? `本次已生成 ${gallery.length} 张` : "支持一键送入 YSM 3D 建模"}
              </span>
            </div>

            {busy ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 360,
                  borderRadius: 12,
                  border: "1px solid var(--border)",
                  background: "var(--bg-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  padding: 24,
                  textAlign: "center",
                }}
              >
                <Loader2 size={32} color="var(--primary)" className="spin" />
                <div style={{ fontWeight: 600, fontSize: 14 }}>{stageText || "正在绘制中..."}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>已耗时 {(elapsedMs / 1000).toFixed(1)}s</div>
              </div>
            ) : activeResult ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid var(--border)", background: "#0b0f17" }}>
                  <img
                    src={activeResult.src}
                    alt={activeResult.prompt}
                    style={{ width: "100%", maxHeight: 420, objectFit: "contain", display: "block" }}
                  />
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => sendImageToYsmTurnaround(activeResult)}>
                    <Box size={13} /> 送入 YSM 三视图建模
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => addResultAsRef(activeResult)}>
                    <RefreshCw size={13} /> 设为参考图继续画
                  </button>
                  <a
                    href={activeResult.src}
                    download={`lilyco-${activeResult.outputKind}-${activeResult.id}.png`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm"
                    style={{ textDecoration: "none" }}
                  >
                    <Download size={13} /> 下载原图
                  </a>
                </div>

                <div style={{ fontSize: 12, color: "var(--text-muted)", background: "var(--bg-subtle)", padding: 10, borderRadius: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, color: "var(--success)", fontWeight: 600 }}>
                    <CheckCircle2 size={13} /> {activeResult.model} · {activeResult.style} · {activeResult.elapsedSec}s
                  </div>
                  <div style={{ lineHeight: 1.5 }}>{activeResult.expandedPrompt}</div>
                </div>

                {gallery.length > 1 && (
                  <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingTop: 4 }}>
                    {gallery.map((g, idx) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => setActiveIdx(idx)}
                        style={{
                          width: 58,
                          height: 58,
                          padding: 0,
                          borderRadius: 8,
                          overflow: "hidden",
                          border: idx === activeIdx ? "2px solid var(--primary)" : "1px solid var(--border)",
                          cursor: "pointer",
                          flexShrink: 0,
                        }}
                      >
                        <img src={g.src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  flex: 1,
                  minHeight: 380,
                  borderRadius: 12,
                  border: "1px dashed var(--border)",
                  background: "var(--bg-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  color: "var(--text-muted)",
                  textAlign: "center",
                  padding: 24,
                }}
              >
                <ImageIcon size={30} style={{ opacity: 0.4 }} />
                <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>
                  支持多引擎切换（免费 / Google Imagen 3）与人物三视图直出
                </div>
                <div style={{ fontSize: 12, maxWidth: 340 }}>
                  上传角色参考图由中转站视觉大模型直接读图精修；生成的头像或三视图可一键送入 YSM 3D 模型工坊建模。
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
