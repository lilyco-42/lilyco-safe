import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Alibaba,
  Anthropic,
  DeepSeek,
  Google,
  Meta,
  Mistral,
  Moonshot,
  Nvidia,
  OpenAI,
  Tencent,
  XAI,
  Zhipu,
} from "@lobehub/icons";
import {
  Check,
  Crown,
  Gift,
  LayoutGrid,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { API_BASE } from "../api";
import "../company-cards.css";

export type ModelTier = "astra" | "sol" | "terra" | "luna";

export interface CompanyCatalogModel {
  id: string;
  owned_by: string;
  input_per_m: number;
  output_per_m: number;
  allow_free: boolean;
  tier: ModelTier;
  flagship: boolean;
  capabilities: string[];
  text: boolean;
}

export interface ModelCompanyCard {
  id: string;
  name: string;
  color: string;
  focus: string;
  card_number: string;
  models: CompanyCatalogModel[];
}

export interface ModelCompanyCardsProps {
  onPick: (id: string) => void;
  selected?: string;
  textOnly?: boolean;
  compact?: boolean;
}

interface ActiveCardState {
  companyId: string;
  originRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  phase: "entering" | "open" | "closing";
  showFront: boolean;
}

const BRAND_COLOR_FALLBACK: Record<string, string> = {
  openai: "#64748B",
  anthropic: "#D97757",
  google: "#4285F4",
  deepseek: "#486DFF",
  alibaba: "#7358FA",
  moonshot: "#5A81F0",
  zhipu: "#1674FF",
  xai: "#8796AE",
  meta: "#0866FF",
  mistral: "#FA720B",
  nvidia: "#76B900",
  tencent: "#00A3E8",
};

const TIER_META: {
  key: ModelTier;
  label: string;
  subtitle: string;
}[] = [
  { key: "astra", label: "ASTRA", subtitle: "星耀旗舰 · 深度推理与高阶创作" },
  { key: "sol", label: "SOL", subtitle: "曜阳主力 · 均衡全能日常模型" },
  { key: "terra", label: "TERRA", subtitle: "大地极速 · 高吞吐与快速响应" },
  { key: "luna", label: "LUNA", subtitle: "微月轻量 · 经济高效与低延迟" },
];

const FLIP_MS = 580;

let cachedCompanies: ModelCompanyCard[] | null = null;
let inflightFetch: Promise<ModelCompanyCard[]> | null = null;

async function fetchModelCompanies(force = false): Promise<ModelCompanyCard[]> {
  if (!force && cachedCompanies) {
    return cachedCompanies;
  }
  if (!force && inflightFetch) {
    return inflightFetch;
  }

  inflightFetch = (async () => {
    const res = await fetch(`${API_BASE}/v1/model-companies`);
    const text = await res.text();
    let parsed: { data?: ModelCompanyCard[]; message?: string; detail?: string; error?: string } =
      {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(parsed.message || parsed.detail || parsed.error || `HTTP ${res.status}`);
    }
    const list = Array.isArray(parsed.data) ? parsed.data : [];
    cachedCompanies = list;
    return list;
  })();

  try {
    return await inflightFetch;
  } finally {
    inflightFetch = null;
  }
}

function hexToRgbTuple(hex: string): string {
  const clean = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `${r}, ${g}, ${b}`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return `${r}, ${g}, ${b}`;
  }
  return "100, 116, 139";
}

function resolveColor(company: Pick<ModelCompanyCard, "id" | "color">): string {
  if (company.color && company.color.trim().startsWith("#")) {
    return company.color.trim();
  }
  return BRAND_COLOR_FALLBACK[company.id.toLowerCase()] || "#64748B";
}

function CompanyLogo({ companyId, size = 22 }: { companyId: string; size?: number }) {
  switch (companyId.toLowerCase()) {
    case "openai":
      return <OpenAI size={size} />;
    case "anthropic":
      return <Anthropic size={size} />;
    case "google":
      return <Google size={size} />;
    case "deepseek":
      return <DeepSeek size={size} />;
    case "alibaba":
      return <Alibaba size={size} />;
    case "moonshot":
      return <Moonshot size={size} />;
    case "zhipu":
      return <Zhipu size={size} />;
    case "xai":
      return <XAI size={size} />;
    case "meta":
      return <Meta size={size} />;
    case "mistral":
      return <Mistral size={size} />;
    case "nvidia":
      return <Nvidia size={size} />;
    case "tencent":
      return <Tencent size={size} />;
    default:
      return <Sparkles size={size} />;
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function formatPrice(m: CompanyCatalogModel): { text: string; isFree: boolean } {
  if (m.allow_free && m.input_per_m === 0 && m.output_per_m === 0) {
    return { text: "0 积分 · 免费", isFree: true };
  }
  return {
    text: `入 ${m.input_per_m} / 出 ${m.output_per_m}`,
    isFree: false,
  };
}

interface PassFaceFrontProps {
  company: ModelCompanyCard;
  isSelectedCompany: boolean;
  flagship: CompanyCatalogModel | undefined;
  freeCount: number;
  enlarged?: boolean;
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}

function PassCardFront({
  company,
  isSelectedCompany,
  flagship,
  freeCount,
  enlarged = false,
  onClick,
  buttonRef,
}: PassFaceFrontProps) {
  const accent = resolveColor(company);
  const rgb = hexToRgbTuple(accent);
  const style = {
    "--mcc-accent": accent,
    "--mcc-rgb": rgb,
  } as CSSProperties;

  const handleMouseMove = (e: ReactMouseEvent<HTMLElement>) => {
    if (enlarged || prefersReducedMotion()) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const rx = (0.5 - py) * 9;
    const ry = (px - 0.5) * 11;
    el.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);
    el.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
    el.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
  };

  const handleMouseLeave = (e: ReactMouseEvent<HTMLElement>) => {
    if (enlarged) return;
    const el = e.currentTarget;
    el.style.setProperty("--mx", "50%");
    el.style.setProperty("--my", "35%");
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
  };

  const content = (
    <>
      <span className="mcc-pass-grain" aria-hidden="true" />
      <span className="mcc-pass-sheen" aria-hidden="true" />
      <span className="mcc-pass-watermark" aria-hidden="true">
        <CompanyLogo companyId={company.id} size={enlarged ? 176 : 112} />
      </span>

      <div className="mcc-pass-top">
        <div className="mcc-pass-brand-row">
          <span className="mcc-pass-emblem" aria-hidden="true">
            <CompanyLogo companyId={company.id} size={enlarged ? 30 : 22} />
          </span>
          <span className="mcc-pass-chip" aria-hidden="true" />
        </div>

        <div className="mcc-corner-stack">
          <span className="mcc-card-num" title={`编号 ${company.card_number}`}>
            {company.card_number}
          </span>
          {isSelectedCompany && (
            <span className="mcc-active-badge">
              <Check size={11} strokeWidth={3} /> 当前已选
            </span>
          )}
        </div>
      </div>

      <div className="mcc-pass-mid">
        <div className="mcc-company-name">{company.name}</div>
        <div className="mcc-company-focus">{company.focus}</div>
      </div>

      <div className="mcc-pass-bottom">
        <div className="mcc-flagship-preview">
          <span className="mcc-flagship-label">
            <Crown size={11} />
            {flagship ? "API 旗舰" : "模型目录"}
          </span>
          <span className="mcc-flagship-id" title={flagship?.id || ""}>
            {flagship
              ? flagship.id
              : company.models[0]?.id || "暂无可用模型"}
          </span>
        </div>

        {!enlarged && (
          <span className="mcc-pass-count">
            {company.models.length} 模型
            {freeCount > 0 ? ` · ${freeCount} 免费` : ""}
          </span>
        )}
      </div>
    </>
  );

  if (enlarged) {
    return (
      <div className="mcc-pass" style={style}>
        {content}
      </div>
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`mcc-pass${isSelectedCompany ? " mcc-pass--active" : ""}${company.models.length === 0 ? " mcc-pass--empty" : ""}`}
      style={style}
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      aria-label={`${company.name}（编号 ${company.card_number}），${company.models.length} 个模型，点击展开选择`}
    >
      {content}
    </button>
  );
}

export function ModelCompanyCards({
  onPick,
  selected,
  textOnly = false,
  compact = false,
}: ModelCompanyCardsProps) {
  const [rawCompanies, setRawCompanies] = useState<ModelCompanyCard[]>(
    () => cachedCompanies || [],
  );
  const [loading, setLoading] = useState<boolean>(() => cachedCompanies === null);
  const [error, setError] = useState<string>("");

  const [galleryOpen, setGalleryOpen] = useState(false);
  const [activeCard, setActiveCard] = useState<ActiveCardState | null>(null);
  const [search, setSearch] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);

  const cardBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const stageRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const compactTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const loadCompanies = useCallback(async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const list = await fetchModelCompanies(force);
      setRawCompanies(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载模型厂商卡片失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (cachedCompanies) {
      setRawCompanies(cachedCompanies);
      setLoading(false);
      return;
    }
    void loadCompanies(false);
  }, [loadCompanies]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const companies = useMemo(() => {
    if (!textOnly) return rawCompanies;
    return rawCompanies.map((c) => ({
      ...c,
      models: c.models.filter((m) => m.text),
    }));
  }, [rawCompanies, textOnly]);

  const totalModels = useMemo(
    () => companies.reduce((sum, c) => sum + c.models.length, 0),
    [companies],
  );

  const selectedMatch = useMemo(() => {
    if (!selected) return null;
    for (const c of companies) {
      const found = c.models.find((m) => m.id === selected);
      if (found) return { company: c, model: found };
    }
    return null;
  }, [companies, selected]);

  const activeCompany = useMemo(() => {
    if (!activeCard) return null;
    return companies.find((c) => c.id === activeCard.companyId) || null;
  }, [activeCard, companies]);

  const activeFreeCount = useMemo(() => {
    if (!activeCompany) return 0;
    return activeCompany.models.filter((m) => m.allow_free).length;
  }, [activeCompany]);

  const groupedActiveModels = useMemo(() => {
    if (!activeCompany) return [];
    const q = search.trim().toLowerCase();
    const filtered = activeCompany.models.filter((m) => {
      if (freeOnly && !m.allow_free) return false;
      if (!q) return true;
      if (m.id.toLowerCase().includes(q)) return true;
      if (m.owned_by.toLowerCase().includes(q)) return true;
      if (m.tier.toLowerCase().includes(q)) return true;
      if (m.capabilities.some((cap) => cap.toLowerCase().includes(q))) return true;
      if (m.allow_free && (q === "free" || q.includes("免费"))) return true;
      if (m.flagship && (q.includes("flagship") || q.includes("旗舰"))) return true;
      return false;
    });

    return TIER_META.map((meta) => ({
      ...meta,
      models: filtered.filter((m) => m.tier === meta.key),
    })).filter((group) => group.models.length > 0);
  }, [activeCompany, search, freeOnly]);

  const closeActiveCard = useCallback((immediate = false) => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    setActiveCard((prev) => {
      if (!prev) return null;
      const returnId = prev.companyId;
      if (immediate || prefersReducedMotion()) {
        window.requestAnimationFrame(() => {
          cardBtnRefs.current[returnId]?.focus();
        });
        return null;
      }

      const freshEl = cardBtnRefs.current[returnId];
      const freshRect = freshEl?.getBoundingClientRect();
      const originRect = freshRect
        ? {
            left: freshRect.left,
            top: freshRect.top,
            width: freshRect.width,
            height: freshRect.height,
          }
        : prev.originRect;

      closeTimerRef.current = window.setTimeout(() => {
        setActiveCard(null);
        closeTimerRef.current = null;
        window.requestAnimationFrame(() => {
          cardBtnRefs.current[returnId]?.focus();
        });
      }, FLIP_MS);

      return {
        ...prev,
        originRect,
        phase: "closing",
        showFront: false,
      };
    });
  }, []);

  const openCompanyCard = useCallback(
    (companyId: string, buttonEl: HTMLButtonElement) => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }

      const rect = buttonEl.getBoundingClientRect();
      setSearch("");
      setFreeOnly(false);

      const reduced = prefersReducedMotion();
      setActiveCard({
        companyId,
        originRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        phase: reduced ? "open" : "entering",
        showFront: false,
      });

      if (!reduced) {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            setActiveCard((curr) =>
              curr && curr.companyId === companyId && curr.phase === "entering"
                ? { ...curr, phase: "open" }
                : curr,
            );
          });
        });
      }
    },
    [],
  );

  // Focus search input after opening the backplate
  useEffect(() => {
    if (activeCard?.phase === "open" && !activeCard.showFront) {
      const delay = prefersReducedMotion() ? 20 : 280;
      const timer = window.setTimeout(() => {
        searchInputRef.current?.focus();
      }, delay);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [activeCard?.phase, activeCard?.showFront, activeCard?.companyId]);

  // Body scroll lock while either overlay is open
  useEffect(() => {
    const locked = Boolean(activeCard || (compact && galleryOpen));
    if (!locked) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [activeCard, compact, galleryOpen]);

  // Escape key closes zoomed card first, then compact gallery
  useEffect(() => {
    if (!activeCard && !(compact && galleryOpen)) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (activeCard) {
        closeActiveCard(false);
      } else if (compact && galleryOpen) {
        setGalleryOpen(false);
        window.requestAnimationFrame(() => compactTriggerRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeCard, compact, galleryOpen, closeActiveCard]);

  const handlePickModel = useCallback(
    (modelId: string) => {
      onPick(modelId);
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setActiveCard(null);
      if (compact) {
        setGalleryOpen(false);
        window.requestAnimationFrame(() => compactTriggerRef.current?.focus());
      }
    },
    [onPick, compact],
  );

  // Compute FLIP transform deltas from source card rect to viewport dialog center
  const proxyTransformStyle = useMemo((): CSSProperties => {
    if (!activeCard || typeof window === "undefined") return {};
    const stageW = Math.min(880, window.innerWidth - 32);
    const stageH = Math.min(
      window.innerWidth <= 720 ? Math.min(window.innerHeight * 0.86, 660) : 555,
      window.innerHeight - (window.innerWidth <= 720 ? 20 : 40),
    );
    const targetCx = window.innerWidth / 2;
    const targetCy = window.innerHeight / 2;
    const originCx = activeCard.originRect.left + activeCard.originRect.width / 2;
    const originCy = activeCard.originRect.top + activeCard.originRect.height / 2;
    const dx = originCx - targetCx;
    const dy = originCy - targetCy;
    const sx = Math.max(0.18, activeCard.originRect.width / Math.max(1, stageW));
    const sy = Math.max(0.18, activeCard.originRect.height / Math.max(1, stageH));

    return {
      "--from-dx": `${dx.toFixed(1)}px`,
      "--from-dy": `${dy.toFixed(1)}px`,
      "--from-sx": sx.toFixed(4),
      "--from-sy": sy.toFixed(4),
    } as CSSProperties;
  }, [activeCard]);

  const renderGridContent = () => {
    if (loading && companies.length === 0) {
      return (
        <div className="mcc-grid" aria-busy="true" aria-label="正在加载模型厂商卡片">
          {Array.from({ length: 12 }).map((_, idx) => (
            <div key={idx} className="mcc-skeleton" />
          ))}
        </div>
      );
    }

    if (error && companies.length === 0) {
      return (
        <div className="mcc-error-box" role="alert">
          <span>加载模型厂商目录失败：{error}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void loadCompanies(true)}
          >
            <RefreshCw size={13} /> 重试
          </button>
        </div>
      );
    }

    return (
      <div className="mcc-grid">
        {companies.map((company) => {
          const flagship = company.models.find((m) => m.flagship);
          const freeCount = company.models.filter((m) => m.allow_free).length;
          const isSelectedCompany = selectedMatch?.company.id === company.id;
          const isHiddenByPortal = activeCard?.companyId === company.id;

          return (
            <div
              key={company.id}
              className={`mcc-card-slot${isHiddenByPortal ? " mcc-card-slot--hidden" : ""}`}
            >
              <PassCardFront
                company={company}
                isSelectedCompany={isSelectedCompany}
                flagship={flagship}
                freeCount={freeCount}
                buttonRef={(el) => {
                  cardBtnRefs.current[company.id] = el;
                }}
                onClick={(e) => openCompanyCard(company.id, e.currentTarget)}
              />
            </div>
          );
        })}
      </div>
    );
  };

  // Portal Proxy Zoom & 3D Flip Dialog
  const renderCardPortal = () => {
    if (!activeCard || !activeCompany || typeof document === "undefined") {
      return null;
    }

    const accent = resolveColor(activeCompany);
    const rgb = hexToRgbTuple(accent);
    const flagship = activeCompany.models.find((m) => m.flagship);
    const isOpenPhase = activeCard.phase === "open";
    const backStyle = {
      "--mcc-accent": accent,
      "--mcc-rgb": rgb,
    } as CSSProperties;

    const proxyClasses = [
      "mcc-portal-proxy",
      isOpenPhase && !activeCard.showFront ? "mcc-portal-proxy--open" : "",
      isOpenPhase && activeCard.showFront ? "mcc-portal-proxy--front" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return createPortal(
      <div
        className={`mcc-portal-backdrop${isOpenPhase ? " mcc-portal-backdrop--open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${activeCompany.name} 模型目录`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            closeActiveCard(false);
          }
        }}
      >
        <div className="mcc-portal-stage" ref={stageRef}>
          <div className={proxyClasses} style={proxyTransformStyle}>
            {/* Enlarged Front Face */}
            <div className="mcc-proxy-face mcc-proxy-face--front">
              <PassCardFront
                company={activeCompany}
                isSelectedCompany={selectedMatch?.company.id === activeCompany.id}
                flagship={flagship}
                freeCount={activeFreeCount}
                enlarged
              />
              {activeCard.showFront && (
                <div className="mcc-front-actions">
                  <button
                    type="button"
                    className="mcc-front-btn"
                    onClick={() =>
                      setActiveCard((prev) =>
                        prev ? { ...prev, showFront: false } : null,
                      )
                    }
                  >
                    <RotateCcw size={14} /> 翻回模型列表
                  </button>
                  <button
                    type="button"
                    className="mcc-front-btn"
                    onClick={() => closeActiveCard(false)}
                    aria-label="关闭卡片"
                  >
                    <X size={15} /> 关闭
                  </button>
                </div>
              )}
            </div>

            {/* Interactive Back Face */}
            <div className="mcc-proxy-face mcc-proxy-face--back" style={backStyle}>
              <div className="mcc-back-stripe" aria-hidden="true" />

              <div className="mcc-back-header">
                <div className="mcc-back-identity">
                  <span className="mcc-back-emblem" aria-hidden="true">
                    <CompanyLogo companyId={activeCompany.id} size={22} />
                  </span>
                  <div className="mcc-back-title-wrap">
                    <div className="mcc-back-title-row">
                      <h3 className="mcc-back-title">{activeCompany.name}</h3>
                      <span className="mcc-back-serial">{activeCompany.card_number}</span>
                    </div>
                    <div className="mcc-back-sub">
                      <span>{activeCompany.focus}</span>
                      <span>·</span>
                      <span>
                        共 {activeCompany.models.length} 个{textOnly ? "文本" : ""}模型
                      </span>
                      {flagship && (
                        <>
                          <span>·</span>
                          <span style={{ color: "#fbbf24" }}>
                            旗舰 {flagship.id}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mcc-back-actions">
                  <button
                    type="button"
                    className="mcc-icon-btn"
                    onClick={() =>
                      setActiveCard((prev) =>
                        prev ? { ...prev, showFront: true } : null,
                      )
                    }
                    title="查看卡面正面"
                  >
                    <RotateCcw size={14} /> 卡面
                  </button>
                  <button
                    type="button"
                    className="mcc-icon-btn mcc-icon-btn--close"
                    onClick={() => closeActiveCard(false)}
                    aria-label="关闭弹窗"
                    title="关闭 (Esc)"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              <div className="mcc-back-search-bar">
                <div className="mcc-search-input-wrap">
                  <Search size={15} className="mcc-search-icon" aria-hidden="true" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    className="mcc-search-input"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={`搜索 ${activeCompany.name} 模型 ID、能力标签或路由...`}
                    aria-label={`搜索 ${activeCompany.name} 模型`}
                  />
                  {search && (
                    <button
                      type="button"
                      className="mcc-search-clear"
                      onClick={() => setSearch("")}
                      aria-label="清除搜索"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                {activeFreeCount > 0 && (
                  <button
                    type="button"
                    className={`mcc-filter-chip${freeOnly ? " mcc-filter-chip--on" : ""}`}
                    onClick={() => setFreeOnly((v) => !v)}
                    aria-pressed={freeOnly}
                  >
                    <Gift size={14} />
                    仅免费 ({activeFreeCount})
                  </button>
                )}
              </div>

              <div className="mcc-back-body">
                {groupedActiveModels.length === 0 ? (
                  <div className="mcc-empty">
                    <Search size={24} opacity={0.5} />
                    <div>
                      {activeCompany.models.length === 0
                        ? textOnly
                          ? `${activeCompany.name} 暂无可用文本模型`
                          : `${activeCompany.name} 暂无已接入模型`
                        : "没有符合条件的模型，请调整关键词或筛选"}
                    </div>
                    {(search || freeOnly) && (
                      <button
                        type="button"
                        className="mcc-icon-btn"
                        onClick={() => {
                          setSearch("");
                          setFreeOnly(false);
                        }}
                      >
                        重置筛选
                      </button>
                    )}
                  </div>
                ) : (
                  groupedActiveModels.map((group) => (
                    <section
                      key={group.key}
                      className={`mcc-tier-group mcc-tier-group--${group.key}`}
                      aria-label={`${group.label} 分组`}
                    >
                      <div className="mcc-tier-header">
                        <div className="mcc-tier-label-wrap">
                          <span className="mcc-tier-dot" aria-hidden="true" />
                          <span className="mcc-tier-name">{group.label}</span>
                          <span className="mcc-tier-desc">{group.subtitle}</span>
                        </div>
                        <span className="mcc-tier-count">{group.models.length}</span>
                      </div>

                      <div className="mcc-model-list">
                        {group.models.map((m) => {
                          const isSelected = selected === m.id;
                          const price = formatPrice(m);
                          return (
                            <button
                              key={m.id}
                              type="button"
                              className={`mcc-model-btn${m.flagship ? " mcc-model-btn--flagship" : ""}${isSelected ? " mcc-model-btn--selected" : ""}`}
                              onClick={() => handlePickModel(m.id)}
                            >
                              <div className="mcc-model-top">
                                <span className="mcc-model-id" title={m.id}>
                                  {m.id}
                                </span>
                                <span className="mcc-model-badges">
                                  {m.flagship && (
                                    <span className="mcc-badge mcc-badge--flagship">
                                      <Crown size={10} /> 旗舰
                                    </span>
                                  )}
                                  {m.allow_free && (
                                    <span className="mcc-badge mcc-badge--free">免费</span>
                                  )}
                                  {isSelected && (
                                    <span className="mcc-badge mcc-badge--selected">
                                      <Check size={10} strokeWidth={3} /> 已选
                                    </span>
                                  )}
                                </span>
                              </div>

                              <div className="mcc-model-bottom">
                                <div className="mcc-caps">
                                  {m.capabilities.map((cap) => (
                                    <span key={cap} className="mcc-cap-tag">
                                      {cap}
                                    </span>
                                  ))}
                                </div>
                                <span
                                  className={`mcc-price${price.isFree ? " mcc-price--free" : ""}`}
                                  title={`路由池：${m.owned_by}`}
                                >
                                  {price.text}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );
  };

  // Compact Mode: Button trigger + 12-card Gallery Portal
  if (compact) {
    const triggerAccent = selectedMatch
      ? resolveColor(selectedMatch.company)
      : "#4F46E5";
    const triggerStyle = {
      "--mcc-accent": triggerAccent,
      "--mcc-rgb": hexToRgbTuple(triggerAccent),
    } as CSSProperties;

    return (
      <div className="mcc-root">
        <button
          ref={compactTriggerRef}
          type="button"
          className="mcc-compact-trigger"
          style={triggerStyle}
          onClick={() => setGalleryOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={galleryOpen}
        >
          <span className="mcc-compact-left">
            <span className="mcc-compact-swatch" aria-hidden="true">
              {selectedMatch ? (
                <CompanyLogo companyId={selectedMatch.company.id} size={16} />
              ) : (
                <LayoutGrid size={15} />
              )}
            </span>
            <span className="mcc-compact-text">
              <span className="mcc-compact-label">
                {selectedMatch ? selectedMatch.company.name : "模型厂商卡片"}
              </span>
              <span className="mcc-compact-model" title={selected || ""}>
                {selected || "点击挑选模型"}
              </span>
            </span>
          </span>
          <span className="mcc-compact-action">
            <LayoutGrid size={12} /> 12 厂商
          </span>
        </button>

        {galleryOpen &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              className="mcc-gallery-backdrop"
              role="dialog"
              aria-modal="true"
              aria-label="模型厂商卡片选择"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget && !activeCard) {
                  setGalleryOpen(false);
                  window.requestAnimationFrame(() => compactTriggerRef.current?.focus());
                }
              }}
            >
              <div className="mcc-gallery-dialog">
                <div className="mcc-gallery-header">
                  <div className="mcc-toolbar-title">
                    <LayoutGrid size={18} color="var(--primary, #4f46e5)" />
                    <div>
                      <h3 className="mcc-toolbar-heading">
                        选择模型厂商（{companies.length || 12} 张金属卡 · {totalModels} 个
                        {textOnly ? "文本" : ""}模型）
                      </h3>
                      <div className="mcc-toolbar-sub">
                        点击任意厂商卡片放大翻转，按 Astra / Sol / Terra / Luna 分层挑选模型
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="mcc-gallery-close"
                    onClick={() => {
                      setGalleryOpen(false);
                      window.requestAnimationFrame(() => compactTriggerRef.current?.focus());
                    }}
                    aria-label="关闭厂商列表"
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="mcc-gallery-body">{renderGridContent()}</div>
              </div>
            </div>,
            document.body,
          )}

        {renderCardPortal()}
      </div>
    );
  }

  // Full 12-Card Grid Mode
  return (
    <div className="mcc-root">
      <div className="mcc-toolbar">
        <div className="mcc-toolbar-title">
          <div>
            <h3 className="mcc-toolbar-heading">模型厂商名片墙</h3>
            <div className="mcc-toolbar-sub">
              点击任意金属名片放大翻转，查看 Astra / Sol / Terra / Luna 四档模型与实时费率
            </div>
          </div>
        </div>
        <div className="mcc-toolbar-meta">
          <span className="mcc-chip-pill">
            {companies.length || 12} 家厂商 · {totalModels} 个{textOnly ? "文本" : ""}模型
          </span>
          {selected && (
            <span className="mcc-chip-pill mcc-chip-pill--selected" title={selected}>
              当前：{selected}
            </span>
          )}
        </div>
      </div>

      {renderGridContent()}
      {renderCardPortal()}
    </div>
  );
}

export default ModelCompanyCards;
