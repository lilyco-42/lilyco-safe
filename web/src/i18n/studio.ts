export type StudioLocale = "zh-CN" | "en-US";

export interface StudioMessages {
  title: string;
  tabImage: string;
  tabMedia: string;
  langToggle: string;
  gpuReady: string;
  cloudReady: string;
  poolStandby: string;
  promptLabel: string;
  promptPlaceholder: string;
  expandBtn: string;
  expanding: string;
  advancedOpen: string;
  advancedClose: string;
  generateBtn: string;
  generating: string;
  shortcutHint: string;
  stageTitle: string;
  stageDesc: string;
  viewRaw: string;
  downloadPng: string;
  refUploadTitle: string;
  refUploadHint: string;
  refUrlPlaceholder: string;
  reverseBtn: string;
  reversing: string;
  img2imgLabel: string;
  strengthLabel: string;
  negLabel: string;
  stepsLabel: string;
  cfgLabel: string;
  seedLabel: string;
  exportComfy: string;
  galleryPublic: string;
  galleryPersonal: string;
  refreshBtn: string;
  adminManageBtn: string;
  loginForPersonal: string;
  emptyPersonal: string;
  emptyPublic: string;
  submitReview: string;
  publishDirect: string;
  deleteBtn: string;
  remixBtn: string;
  closeBtn: string;
  ttsTitle: string;
  ttsPlaceholder: string;
  ttsBtn: string;
  lyriaTitle: string;
  lyriaPlaceholder: string;
  lyriaBtn: string;
  veoTitle: string;
  veoPlaceholder: string;
  veoBtn: string;
  needApiKey: string;
  goTokens: string;
  statusPrivate: string;
  statusPending: string;
  statusApproved: string;
  statusRejected: string;
}

export const STUDIO_I18N: Record<StudioLocale, StudioMessages> = {
  "zh-CN": {
    title: "多模态创作工坊",
    tabImage: "绘梦生图 & 画廊",
    tabMedia: "配音 · 音乐 · 视频",
    langToggle: "EN",
    gpuReady: "GPU + 云端就绪",
    cloudReady: "云端极速就绪",
    poolStandby: "算力待机",
    promptLabel: "画面描述",
    promptPlaceholder: "输入中文画面描述或英文标签（Ctrl/⌘ + Enter 快速生成）...",
    expandBtn: "✦ AI 润色扩写",
    expanding: "扩写中...",
    advancedOpen: "参考图与高级设置 ▾",
    advancedClose: "收起高级设置 ▴",
    generateBtn: "一键生成高清插画",
    generating: "正在生成...",
    shortcutHint: "快捷键：Ctrl/⌘ + Enter 生成 · Esc 关闭预览",
    stageTitle: "实时创作画布",
    stageDesc: "选择预设或输入画面描述，自动调度云端 FLUX / Nano Banana / 在线 GPU 算力池生成。",
    viewRaw: "查看原图",
    downloadPng: "下载原图",
    refUploadTitle: "点击上传 / 拖拽 / Ctrl+V 粘贴参考图",
    refUploadHint: "支持 PNG 元数据秒解析、视觉反推提示词或作为底图重绘",
    refUrlPlaceholder: "或粘贴图片 URL...",
    reverseBtn: "反推提示词",
    reversing: "反推中...",
    img2imgLabel: "启用图生图 (Img2Img)",
    strengthLabel: "重绘幅度",
    negLabel: "负向提示词（可选）",
    stepsLabel: "推理步数",
    cfgLabel: "CFG 强度",
    seedLabel: "随机种子 (-1 随机)",
    exportComfy: "导出 ComfyUI JSON",
    galleryPublic: "精选画廊",
    galleryPersonal: "个人空间",
    refreshBtn: "刷新",
    adminManageBtn: "管理画廊",
    loginForPersonal: "请先点击右上角登录账号，即可自动同步个人空间画廊。",
    emptyPersonal: "个人空间暂无作品，去上方生成第一张吧（默认私密保存，满意后可投稿公开）。",
    emptyPublic: "精选画廊暂无公开作品",
    submitReview: "投稿审核",
    publishDirect: "直接公开",
    deleteBtn: "删除",
    remixBtn: "填入提示词复刻",
    closeBtn: "关闭",
    ttsTitle: "Gemini TTS 角色配音",
    ttsPlaceholder: "输入需要朗读的台词或旁白...",
    ttsBtn: "生成 WAV 配音",
    lyriaTitle: "Gemini Lyria AI 音乐",
    lyriaPlaceholder: "描述背景音乐风格，如：轻快日系钢琴与雨声、Lo-fi 赛博氛围...",
    lyriaBtn: "生成音乐",
    veoTitle: "Gemini Veo 视频生成",
    veoPlaceholder: "描述镜头与画面动态，如：樱花随海风飘落的镰仓电车道口，电影级慢动作...",
    veoBtn: "启动视频任务",
    needApiKey: "请先在「令牌管理」生成或选择一把 API Key，用于调用统一多模态接口。",
    goTokens: "前往令牌管理",
    statusPrivate: "私密",
    statusPending: "待审核",
    statusApproved: "已公开",
    statusRejected: "已驳回",
  },
  "en-US": {
    title: "Multimodal Studio",
    tabImage: "Image & Gallery",
    tabMedia: "TTS · Music · Video",
    langToggle: "中文",
    gpuReady: "GPU + Cloud Ready",
    cloudReady: "Cloud Fast Ready",
    poolStandby: "Standby",
    promptLabel: "Prompt",
    promptPlaceholder: "Describe your image in Chinese or English (Ctrl/⌘ + Enter to generate)...",
    expandBtn: "✦ AI Expand",
    expanding: "Expanding...",
    advancedOpen: "Reference & Advanced ▾",
    advancedClose: "Hide Advanced ▴",
    generateBtn: "Generate Illustration",
    generating: "Generating...",
    shortcutHint: "Shortcuts: Ctrl/⌘ + Enter generate · Esc close modal",
    stageTitle: "Live Canvas",
    stageDesc: "Pick a preset or enter a prompt to render via Cloud FLUX, Nano Banana, or GPU workers.",
    viewRaw: "Open Original",
    downloadPng: "Download",
    refUploadTitle: "Click, Drop, or Paste (Ctrl+V) Reference Image",
    refUploadHint: "Supports instant PNG metadata extraction, vision reverse-prompt, and Img2Img",
    refUrlPlaceholder: "Or paste image URL...",
    reverseBtn: "Reverse Prompt",
    reversing: "Analyzing...",
    img2imgLabel: "Enable Img2Img",
    strengthLabel: "Denoise",
    negLabel: "Negative Prompt (optional)",
    stepsLabel: "Steps",
    cfgLabel: "CFG Scale",
    seedLabel: "Seed (-1 random)",
    exportComfy: "Export ComfyUI JSON",
    galleryPublic: "Featured Gallery",
    galleryPersonal: "Personal Space",
    refreshBtn: "Refresh",
    adminManageBtn: "Manage Gallery",
    loginForPersonal: "Sign in at the top right to automatically sync your personal gallery.",
    emptyPersonal: "No artworks in your personal space yet. Generate your first image above!",
    emptyPublic: "No published artworks yet.",
    submitReview: "Submit for Review",
    publishDirect: "Publish Now",
    deleteBtn: "Delete",
    remixBtn: "Use Prompt",
    closeBtn: "Close",
    ttsTitle: "Gemini TTS Voiceover",
    ttsPlaceholder: "Enter dialogue or narration to synthesize...",
    ttsBtn: "Generate WAV",
    lyriaTitle: "Gemini Lyria Music",
    lyriaPlaceholder: "Describe soundtrack style, e.g. gentle piano with summer rain...",
    lyriaBtn: "Generate Music",
    veoTitle: "Gemini Veo Video",
    veoPlaceholder: "Describe camera motion and scene for Veo video generation...",
    veoBtn: "Start Video Job",
    needApiKey: "Select or create an API Key in Tokens to call unified multimodal endpoints.",
    goTokens: "Open Tokens",
    statusPrivate: "Private",
    statusPending: "Pending",
    statusApproved: "Published",
    statusRejected: "Rejected",
  },
};

export function loadSavedLocale(): StudioLocale {
  const saved = localStorage.getItem("lilyco-locale");
  return saved === "en-US" ? "en-US" : "zh-CN";
}

export function saveLocale(loc: StudioLocale): void {
  localStorage.setItem("lilyco-locale", loc);
}
