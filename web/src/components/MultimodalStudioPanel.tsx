import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  Languages,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import {
  deletePersonalGalleryItem,
  expandMossPrompt,
  fetchGallery,
  fetchMossStatus,
  pollMossJob,
  reverseMossPrompt,
  submitGalleryForReview,
  submitMossJob,
  type GalleryItem,
  type MossJob,
  type MossStatusResp,
} from "../api/multimodal";
import { loadSavedLocale, saveLocale, STUDIO_I18N, type StudioLocale } from "../i18n/studio";
import { AdminReviewDrawer } from "./studio/AdminReviewDrawer";
import { AudioVideoWorkbench } from "./studio/AudioVideoWorkbench";
import { GalleryGrid } from "./studio/GalleryGrid";
import "./studio/studio.css";

interface MultimodalStudioPanelProps {
  jwt: string;
  isAdmin: boolean;
  authed: boolean;
  apiKey: string;
  onGoTokens: () => void;
  onToast: (msg: string) => void;
}

const PRESETS = [
  {
    nameZh: "海滨樱花电车",
    nameEn: "Sakura Tram",
    ratio: "768x1024",
    prompt:
      "精美的日系赛璐璐二次元插画，镰仓海边斜坡街道。一位拥有黑色长发与狼耳狼尾的冷峻少女背对镜头回头侧望，左侧是古老石墙与盛开的粉色樱花树枝，斜坡尽头是一列绿白相间的江之电电车正驶过铁路道口，远方是波光粼粼的蔚蓝大海。超高细节线条，通透清新的日系电影光影。",
  },
  {
    nameZh: "红发逆光立绘",
    nameEn: "Crimson Portrait",
    ratio: "768x1024",
    prompt:
      "顶级二次元半身角色立绘，红发少女扎着蓬松双丸子头佩戴金属金色铃铛与黑色贝雷帽，鲜红清澈的眼眸直视镜头。身穿奶白色针织长袖毛衣与格纹百褶短裙，背景是朦胧城市小巷，空气中漂浮着梦幻彩虹色散光斑与丁达尔逆光尘埃。",
  },
  {
    nameZh: "莫比乌斯六翼天使",
    nameEn: "Six-Winged Angel",
    ratio: "1280x720",
    prompt:
      "超现实动漫风格游戏CG画面，空间如同莫比乌斯环般循环缠绕。巨大史前生物骨架被冷色调光线照亮，绿色藤蔓与淡黄小花攀缘，六翼浅金卷发白裙少女端坐于硕大骨骼下，远方是远古废墟，天空由青绿、米白、暗金三色晕染。",
  },
];

export function MultimodalStudioPanel({
  jwt,
  isAdmin,
  authed,
  apiKey,
  onGoTokens,
  onToast,
}: MultimodalStudioPanelProps) {
  const [locale, setLocale] = useState<StudioLocale>(() => loadSavedLocale());
  const msg = STUDIO_I18N[locale];

  const [mode, setMode] = useState<"image" | "media">("image");
  const [model, setModel] = useState("flux-1-schnell");
  const [prompt, setPrompt] = useState(PRESETS[0].prompt);
  const [activePreset, setActivePreset] = useState(0);
  const [ratio, setRatio] = useState(PRESETS[0].ratio);
  const [advOpen, setAdvOpen] = useState(false);

  const [negPrompt, setNegPrompt] = useState("");
  const [steps, setSteps] = useState(28);
  const [cfg, setCfg] = useState(3.0);
  const [seed, setSeed] = useState(-1);
  const [useImg2Img, setUseImg2Img] = useState(false);
  const [strength, setStrength] = useState(0.55);
  const [refDataUrl, setRefDataUrl] = useState("");
  const [refUrl, setRefUrl] = useState("");
  const [revStyle, setRevStyle] = useState("moss_cn");
  const [revBusy, setRevBusy] = useState(false);
  const [expBusy, setExpBusy] = useState(false);

  const [poolStatus, setPoolStatus] = useState<MossStatusResp | null>(null);
  const [job, setJob] = useState<MossJob | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [galleryTab, setGalleryTab] = useState<"public" | "personal">("public");
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [galleryErr, setGalleryErr] = useState("");
  const [adminOpen, setAdminOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);

  const toggleLocale = () => {
    const next: StudioLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    setLocale(next);
    saveLocale(next);
  };

  const loadPool = useCallback(async () => {
    try {
      setPoolStatus(await fetchMossStatus());
    } catch {
      // ignore transient network glitches
    }
  }, []);

  const loadGallery = useCallback(async () => {
    setGalleryErr("");
    try {
      const res = await fetchGallery(jwt, galleryTab);
      setGalleryItems(res.items || []);
    } catch (e) {
      setGalleryItems([]);
      setGalleryErr(galleryTab === "personal" && !authed ? msg.loginForPersonal : (e as Error).message);
    }
  }, [jwt, galleryTab, authed, msg.loginForPersonal]);

  useEffect(() => {
    void loadPool();
    const id = window.setInterval(() => void loadPool(), 8000);
    return () => window.clearInterval(id);
  }, [loadPool]);

  useEffect(() => {
    void loadGallery();
  }, [loadGallery]);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const handleGenerate = useCallback(async () => {
    const text = prompt.trim();
    if (!text || submitting) return;
    const [w, h] = ratio.split("x").map(Number);
    setSubmitting(true);
    setJob({
      id: "pending",
      status: "queued",
      prompt: text,
      width: w,
      height: h,
      progress: 8,
      progress_text: msg.generating,
    });
    try {
      const res = await submitMossJob(jwt, {
        model,
        prompt: text,
        negative_prompt: negPrompt.trim(),
        width: w,
        height: h,
        steps,
        guidance_scale: cfg,
        seed,
        strength,
        ...(useImg2Img && refDataUrl ? { init_image_base64: refDataUrl } : {}),
        ...(useImg2Img && !refDataUrl && refUrl.trim() ? { init_image_url: refUrl.trim() } : {}),
      });
      setJob(res.job);
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const p = await pollMossJob(res.job.id);
          setJob(p.job);
          if (p.job.status === "done" || p.job.status === "error") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            setSubmitting(false);
            void loadGallery();
          }
        } catch {
          // retry next tick
        }
      }, 1600);
    } catch (e) {
      setSubmitting(false);
      setJob(null);
      onToast(`提交失败：${(e as Error).message}`);
    }
  }, [
    prompt,
    submitting,
    ratio,
    msg.generating,
    jwt,
    model,
    negPrompt,
    steps,
    cfg,
    seed,
    strength,
    useImg2Img,
    refDataUrl,
    refUrl,
    loadGallery,
    onToast,
  ]);

  const handleExpand = async () => {
    if (!prompt.trim() || expBusy) return;
    setExpBusy(true);
    try {
      const res = await expandMossPrompt(prompt.trim(), model);
      setPrompt(res.prompt);
      onToast("AI 提示词润色完成");
    } catch (e) {
      onToast(`扩写失败：${(e as Error).message}`);
    } finally {
      setExpBusy(false);
    }
  };

  const readRefFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxSide = 1024;
        let w = img.width;
        let h = img.height;
        if (Math.max(w, h) > maxSide) {
          const s = maxSide / Math.max(w, h);
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        cv.getContext("2d")?.drawImage(img, 0, 0, w, h);
        setRefDataUrl(cv.toDataURL("image/jpeg", 0.85));
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  };

  const handleReverse = async () => {
    if (!refDataUrl && !refUrl.trim()) {
      onToast("请先上传参考图或输入图片 URL");
      return;
    }
    setRevBusy(true);
    try {
      const res = await reverseMossPrompt({
        style: revStyle,
        ...(refDataUrl ? { image_base64: refDataUrl } : { image_url: refUrl.trim() }),
      });
      setPrompt(res.prompt);
      onToast(`反推完成 (${res.elapsed_s ?? "-"}s)`);
    } catch (e) {
      onToast(`反推失败：${(e as Error).message}`);
    } finally {
      setRevBusy(false);
    }
  };

  const exportComfyJson = () => {
    const [width, height] = ratio.split("x").map(Number);
    const finalSeed = seed >= 0 ? seed : Math.floor(Math.random() * 2147483647);
    const wf = {
      model,
      prompt: prompt.trim(),
      negative_prompt: negPrompt.trim(),
      width,
      height,
      steps,
      cfg,
      seed: finalSeed,
      denoise: useImg2Img ? strength : 1.0,
    };
    const blob = new Blob([JSON.stringify(wf, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `lain42-studio-${finalSeed}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };

  const statusPill = () => {
    const n = poolStatus?.workers_online ?? 0;
    if (n > 0) return { ok: true, label: `${n} ${msg.gpuReady}` };
    if (poolStatus?.cloud_ready) return { ok: true, label: msg.cloudReady };
    return { ok: false, label: msg.poolStandby };
  };
  const st = statusPill();

  return (
    <div className="ms-root">
      {/* Top Bar: Rule of 4 (2 left + 2 right) */}
      <div className="ms-topbar">
        <div className="ms-top-group">
          <div className="ms-seg" role="tablist" aria-label={msg.title}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "image"}
              className={mode === "image" ? "active" : ""}
              onClick={() => setMode("image")}
            >
              {msg.tabImage}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "media"}
              className={mode === "media" ? "active" : ""}
              onClick={() => setMode("media")}
            >
              {msg.tabMedia}
            </button>
          </div>
          {mode === "image" && (
            <select
              className="ms-model-sel"
              aria-label="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="flux-1-schnell">FLUX.1-schnell · 云端秒出</option>
              <option value="moss-image-sft">MOSS-Image-SFT · 中文精绘</option>
              <option value="noobai-xl-1.1">NoobAI-XL 1.1 · 画师风</option>
              <option value="animagine-xl-4.0">Animagine XL 4.0 · 赛璐璐</option>
            </select>
          )}
        </div>

        <div className="ms-top-group">
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Switch language"
            onClick={toggleLocale}
          >
            <Languages size={14} /> {msg.langToggle}
          </button>
          <span className={`ms-pill ${st.ok ? "ok" : ""}`} role="status">
            <span className="ms-dot" />
            {st.label}
          </span>
        </div>
      </div>

      {mode === "media" ? (
        <AudioVideoWorkbench apiKey={apiKey} msg={msg} onGoTokens={onGoTokens} onToast={onToast} />
      ) : (
        <>
          {/* Creation Card: Left Rule-of-4 + Right Canvas */}
          <section className="card ms-card">
            <div className="ms-grid">
              <div className="ms-col">
                <div>
                  <div className="ms-prompt-head">
                    <label htmlFor="ms-prompt" className="ms-prompt-lbl">
                      {msg.promptLabel}
                      <span className="ms-count">{prompt.length} / 4000</span>
                    </label>
                    <button
                      type="button"
                      className="ms-btn-ghost"
                      disabled={expBusy}
                      onClick={() => void handleExpand()}
                    >
                      {expBusy ? msg.expanding : msg.expandBtn}
                    </button>
                  </div>
                  <textarea
                    id="ms-prompt"
                    className="input ms-textarea"
                    value={prompt}
                    placeholder={msg.promptPlaceholder}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                        e.preventDefault();
                        void handleGenerate();
                      }
                    }}
                  />
                </div>

                <div className="ms-presets">
                  {PRESETS.map((p, i) => (
                    <button
                      key={p.nameEn}
                      type="button"
                      className={`ms-chip ${activePreset === i ? "active" : ""}`}
                      onClick={() => {
                        setActivePreset(i);
                        setPrompt(p.prompt);
                        setRatio(p.ratio);
                      }}
                    >
                      {locale === "zh-CN" ? p.nameZh : p.nameEn}
                    </button>
                  ))}
                </div>

                <div className="ms-ctrl-row">
                  <select
                    className="input"
                    aria-label="Aspect Ratio"
                    value={ratio}
                    onChange={(e) => setRatio(e.target.value)}
                  >
                    <option value="768x1024">3:4 (768×1024)</option>
                    <option value="1024x1024">1:1 (1024×1024)</option>
                    <option value="1280x720">16:9 (1280×720)</option>
                    <option value="768x1280">9:16 (768×1280)</option>
                  </select>
                  <button
                    type="button"
                    className="btn"
                    aria-expanded={advOpen}
                    onClick={() => setAdvOpen((v) => !v)}
                  >
                    {advOpen ? msg.advancedClose : msg.advancedOpen}
                  </button>
                </div>

                {advOpen && (
                  <div className="ms-drawer">
                    <div
                      className="ms-drop"
                      role="button"
                      tabIndex={0}
                      onClick={() => fileInputRef.current?.click()}
                      onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const f = e.dataTransfer.files[0];
                        if (f) readRefFile(f);
                      }}
                    >
                      {refDataUrl ? (
                        <img src={refDataUrl} alt="Reference" />
                      ) : (
                        <Upload size={18} color="var(--primary)" />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{msg.refUploadTitle}</div>
                        <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{msg.refUploadHint}</div>
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) readRefFile(f);
                        }}
                      />
                    </div>

                    <div className="ms-ctrl-row">
                      <input
                        className="input"
                        placeholder={msg.refUrlPlaceholder}
                        value={refUrl}
                        onChange={(e) => setRefUrl(e.target.value)}
                      />
                      <select
                        className="input"
                        style={{ width: "auto" }}
                        value={revStyle}
                        onChange={(e) => setRevStyle(e.target.value)}
                      >
                        <option value="moss_cn">中文精绘</option>
                        <option value="anime_tags">二次元标签</option>
                        <option value="style_remix">提取画风</option>
                      </select>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={revBusy}
                        onClick={() => void handleReverse()}
                      >
                        {revBusy ? msg.reversing : msg.reverseBtn}
                      </button>
                    </div>

                    <div className="ms-ctrl-row" style={{ fontSize: 12.5 }}>
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={useImg2Img}
                          onChange={(e) => setUseImg2Img(e.target.checked)}
                        />
                        {msg.img2imgLabel}
                      </label>
                      <span style={{ marginLeft: "auto", color: "var(--text-muted)" }}>
                        {msg.strengthLabel} <b>{strength.toFixed(2)}</b>
                      </span>
                      <input
                        type="range"
                        min="0.2"
                        max="0.9"
                        step="0.05"
                        value={strength}
                        style={{ width: 92 }}
                        onChange={(e) => setStrength(Number(e.target.value))}
                      />
                    </div>

                    <input
                      className="input"
                      placeholder={msg.negLabel}
                      value={negPrompt}
                      onChange={(e) => setNegPrompt(e.target.value)}
                    />

                    <div className="ms-row2">
                      <label className="ms-fl">
                        {msg.stepsLabel}
                        <input
                          className="input"
                          type="number"
                          min={12}
                          max={50}
                          value={steps}
                          onChange={(e) => setSteps(Number(e.target.value))}
                        />
                      </label>
                      <label className="ms-fl">
                        {msg.cfgLabel}
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={8}
                          step={0.5}
                          value={cfg}
                          onChange={(e) => setCfg(Number(e.target.value))}
                        />
                      </label>
                    </div>

                    <div className="ms-row2">
                      <label className="ms-fl">
                        {msg.seedLabel}
                        <input
                          className="input"
                          type="number"
                          value={seed}
                          onChange={(e) => setSeed(Number(e.target.value))}
                        />
                      </label>
                      <div style={{ display: "flex", alignItems: "flex-end" }}>
                        <button type="button" className="btn" style={{ width: "100%" }} onClick={exportComfyJson}>
                          {msg.exportComfy}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ width: "100%", padding: "11px 18px", fontSize: 14 }}
                    disabled={submitting}
                    onClick={() => void handleGenerate()}
                  >
                    <Sparkles size={15} />
                    {submitting ? msg.generating : msg.generateBtn}
                  </button>
                  <div className="ms-hint">{msg.shortcutHint}</div>
                </div>
              </div>

              {/* Right Canvas */}
              <div>
                <div className="ms-stage" aria-live="polite">
                  {job?.status === "done" && job.image_url ? (
                    <img src={job.image_url} alt={job.prompt} />
                  ) : job?.status === "error" ? (
                    <div style={{ color: "#b91c1c" }}>
                      <strong>生成失败</strong>
                      <p style={{ fontSize: 12.5, marginTop: 6 }}>{job.error}</p>
                    </div>
                  ) : job ? (
                    <div style={{ width: "100%", maxWidth: 320 }}>
                      <div style={{ fontWeight: 600 }}>{job.progress_text}</div>
                      <div className="ms-bar">
                        <i style={{ width: `${Math.max(8, job.progress)}%` }} />
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{job.progress}%</div>
                    </div>
                  ) : (
                    <div style={{ maxWidth: 300, color: "var(--text-muted)", lineHeight: 1.7 }}>
                      <Sparkles size={26} color="var(--primary)" style={{ marginBottom: 8 }} />
                      <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{msg.stageTitle}</div>
                      <div style={{ fontSize: 12.5 }}>{msg.stageDesc}</div>
                    </div>
                  )}
                </div>

                {job?.status === "done" && job.image_url && (
                  <div className="ms-meta">
                    <span>
                      {job.width}×{job.height} · {job.elapsed_s ?? "-"}s · Seed {job.seed ?? "-"}
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <a className="btn btn-sm" href={job.image_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={13} /> {msg.viewRaw}
                      </a>
                      <a className="btn btn-sm" href={job.image_url} download={`${job.id}.png`}>
                        <Download size={13} /> {msg.downloadPng}
                      </a>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Gallery Card */}
          <section className="card ms-card">
            <div className="ms-ghead">
              <div className="ms-seg" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={galleryTab === "public"}
                  className={galleryTab === "public" ? "active" : ""}
                  onClick={() => setGalleryTab("public")}
                >
                  {msg.galleryPublic}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={galleryTab === "personal"}
                  className={galleryTab === "personal" ? "active" : ""}
                  onClick={() => setGalleryTab("personal")}
                >
                  {msg.galleryPersonal}
                </button>
              </div>
              <div className="ms-top-group">
                <button type="button" className="btn btn-sm" onClick={() => void loadGallery()}>
                  <RefreshCw size={13} /> {msg.refreshBtn}
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-expanded={adminOpen}
                    onClick={() => setAdminOpen((v) => !v)}
                  >
                    <ShieldCheck size={13} /> {msg.adminManageBtn}
                  </button>
                )}
              </div>
            </div>

            {isAdmin && adminOpen && (
              <AdminReviewDrawer jwt={jwt} onChanged={() => void loadGallery()} onToast={onToast} />
            )}

            {galleryErr ? (
              <p style={{ color: "var(--text-muted)", fontSize: 13 }}>{galleryErr}</p>
            ) : galleryItems.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
                {galleryTab === "personal" ? msg.emptyPersonal : msg.emptyPublic}
              </p>
            ) : (
              <GalleryGrid
                items={galleryItems}
                scope={galleryTab}
                isAdmin={isAdmin}
                msg={msg}
                onRemix={(it) => {
                  setPrompt(it.prompt || "");
                  if (it.seed != null) setSeed(it.seed);
                  setJob(it);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                onSubmitReview={async (id) => {
                  try {
                    await submitGalleryForReview(jwt, id, isAdmin);
                    onToast(isAdmin ? "已直接发布到精选画廊" : "已提交审核");
                    await loadGallery();
                  } catch (e) {
                    onToast(`操作失败：${(e as Error).message}`);
                  }
                }}
                onDelete={async (id) => {
                  if (!window.confirm("确认删除这张作品？")) return;
                  try {
                    await deletePersonalGalleryItem(jwt, id);
                    onToast("已删除");
                    await loadGallery();
                  } catch (e) {
                    onToast(`删除失败：${(e as Error).message}`);
                  }
                }}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}
