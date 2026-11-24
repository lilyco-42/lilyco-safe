import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Download,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Star,
} from "lucide-react";
import { fetchYsmCatalog, type YsmCatalogItem } from "../api";

interface Props {
  selectedRef: YsmCatalogItem | null;
  onSelectRef: (item: YsmCatalogItem | null) => void;
  onToast: (msg: string) => void;
}

type SourceTab = "all" | "lain42" | "alltheysm" | "custom";
type SortMode = "downloads" | "featured" | "newest";

export function YsmReferenceHub({ selectedRef, onSelectRef, onToast }: Props) {
  const [source, setSource] = useState<SourceTab>("all");
  const [sort, setSort] = useState<SortMode>("downloads");
  const [freeOnly, setFreeOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<YsmCatalogItem[]>([]);
  const [sourcesUsed, setSourcesUsed] = useState<string[]>([]);
  const [regionBadge, setRegionBadge] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const resp = await fetchYsmCatalog({
        source,
        q: submittedQuery,
        sort,
        freeOnly,
        page,
        limit: 12,
        customSource: source === "custom" ? customUrl : "",
      });
      setItems(resp.items || []);
      setSourcesUsed(resp.sources_used || []);
      setRegionBadge(
        resp.nsfw_filtered
          ? `地区合规 (${resp.region_country || "CN"}) · 已自动屏蔽 18+ 资源`
          : "",
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载 YSM 参考源失败");
    } finally {
      setLoading(false);
    }
  }, [source, submittedQuery, sort, freeOnly, page, customUrl]);

  useEffect(() => {
    if (source === "custom" && !customUrl.trim().startsWith("https://")) return;
    loadCatalog();
  }, [loadCatalog, source, customUrl]);

  const handleSearch = () => {
    setPage(1);
    setSubmittedQuery(query.trim());
  };

  return (
    <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Globe size={17} color="var(--primary)" />
          <strong style={{ fontSize: 15.5 }}>高分 YSM 参考模型库 & 多源下载中心</strong>
          <span className="pill pill-ok" style={{ fontSize: 11 }}>
            dev.lain42.top 2,266+ · AllTheYSM.st 2,254+
          </span>
          {regionBadge && (
            <span className="pill" style={{ fontSize: 11 }}>
              {regionBadge}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <a
            href="https://dev.lain42.top/mc-assets/"
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm"
            style={{ textDecoration: "none" }}
          >
            <ExternalLink size={12} /> 站内素材库
          </a>
          <a
            href="https://alltheysm.st/models"
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm"
            style={{ textDecoration: "none" }}
          >
            <ExternalLink size={12} /> AllTheYSM.st
          </a>
          <button type="button" className="btn btn-sm" onClick={loadCatalog} disabled={loading}>
            <RefreshCw size={12} className={loading ? "spin" : ""} /> 刷新
          </button>
        </div>
      </div>

      {/* Source Tabs + Filters */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(
            [
              { id: "all", label: "全部高分源" },
              { id: "lain42", label: "dev.lain42.top 站内库" },
              { id: "alltheysm", label: "AllTheYSM.st 社区榜" },
              { id: "custom", label: "自定义源" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`btn btn-sm ${source === tab.id ? "btn-primary" : ""}`}
              onClick={() => {
                setSource(tab.id);
                setPage(1);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <select
            aria-label="排序方式"
            className="input"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as SortMode);
              setPage(1);
            }}
            style={{ width: "auto", padding: "5px 10px", fontSize: 12 }}
          >
            <option value="downloads">最高评分 / 下载排行</option>
            <option value="featured">站内精选推荐</option>
            <option value="newest">最新收录</option>
          </select>

          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={freeOnly}
              onChange={(e) => {
                setFreeOnly(e.target.checked);
                setPage(1);
              }}
            />
            仅免费
          </label>
        </div>
      </div>

      {/* Custom Source URL input */}
      {source === "custom" && (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input mono"
            placeholder="输入兼容 /api/v1/manifest.json 协议的 HTTPS 源地址，例如 https://dev.lain42.top/mc-assets"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            style={{ fontSize: 12.5 }}
          />
          <button type="button" className="btn btn-sm btn-primary" onClick={loadCatalog}>
            连接源
          </button>
        </div>
      )}

      {/* Search Bar */}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          placeholder="搜索角色名、题材（如 碧蓝航线、女仆、猫娘、机甲、古风、凯尔希、绫波）..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSearch();
          }}
          style={{ fontSize: 12.5 }}
        />
        <button type="button" className="btn btn-sm btn-primary" onClick={handleSearch}>
          <Search size={13} /> 搜索
        </button>
      </div>

      {/* Results Grid */}
      {loading ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 32, color: "var(--text-muted)" }}>
          <Loader2 size={18} className="spin" />
          <span style={{ fontSize: 13 }}>正在聚合高评分 YSM 参考源...</span>
        </div>
      ) : err ? (
        <div style={{ padding: 14, borderRadius: 10, border: "1px solid var(--danger)", color: "var(--danger)", fontSize: 12.5 }}>
          {err}
        </div>
      ) : items.length === 0 ? (
        <div style={{ padding: 28, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
          未找到匹配的 YSM 模型，试试清空搜索词或切换其他源。
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          {items.map((item) => {
            const isSelected = selectedRef?.id === item.id;
            return (
              <div
                key={item.id}
                style={{
                  borderRadius: 12,
                  border: isSelected ? "1.5px solid var(--primary)" : "1px solid var(--border)",
                  background: isSelected ? "var(--primary-soft)" : "var(--bg-subtle)",
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ position: "relative", height: 148, background: "#0d0f17", overflow: "hidden" }}>
                  {item.cover_url ? (
                    <img
                      src={item.cover_url}
                      alt={item.title}
                      loading="lazy"
                      style={{ width: "100%", height: 148, objectFit: "cover", display: "block" }}
                    />
                  ) : (
                    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#52525b", fontSize: 12 }}>
                      无封面预览
                    </div>
                  )}
                  <span
                    style={{
                      position: "absolute",
                      top: 6,
                      left: 6,
                      fontSize: 10.5,
                      fontWeight: 700,
                      padding: "2px 7px",
                      borderRadius: 99,
                      background: "rgba(9,9,11,0.78)",
                      color: "#fbbf24",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                    }}
                  >
                    <Star size={10} fill="#fbbf24" /> {item.rating.toFixed(1)}
                  </span>
                  <span
                    style={{
                      position: "absolute",
                      top: 6,
                      right: 6,
                      fontSize: 10,
                      padding: "2px 6px",
                      borderRadius: 99,
                      background: item.free ? "rgba(16,185,129,0.88)" : "rgba(139,92,246,0.88)",
                      color: "#fff",
                      fontWeight: 600,
                    }}
                  >
                    {item.free ? "免费" : "精选"}
                  </span>
                  <span
                    style={{
                      position: "absolute",
                      bottom: 6,
                      left: 6,
                      fontSize: 10,
                      padding: "1px 6px",
                      borderRadius: 6,
                      background: "rgba(9,9,11,0.75)",
                      color: "#e4e4e7",
                    }}
                  >
                    {item.source_label}
                  </span>
                </div>

                <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.35 }} title={item.title}>
                    {item.title}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.4, flex: 1 }}>
                    {item.description || (item.authors.length ? `作者：${item.authors.join(" / ")}` : "社区 YSM 角色包")}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
                    <span>下载 {item.downloads.toLocaleString()}</span>
                    <span>{item.license}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                    <button
                      type="button"
                      className={`btn btn-sm ${isSelected ? "btn-primary" : ""}`}
                      style={{ flex: 1, justifyContent: "center" }}
                      onClick={() => {
                        if (isSelected) {
                          onSelectRef(null);
                          onToast("已取消选中的 YSM 参考模型");
                        } else {
                          onSelectRef(item);
                          onToast(`已将「${item.title}」设为 YSM 生成风格参考`);
                        }
                      }}
                    >
                      {isSelected ? <Check size={12} /> : <Sparkles size={12} />}
                      {isSelected ? "已选参考" : "设为生成参考"}
                    </button>
                    {item.download_url && (
                      <a
                        href={item.download_url}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-sm"
                        title="下载或前往源站"
                        style={{ textDecoration: "none", padding: "4px 8px" }}
                      >
                        <Download size={12} />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination & Active Sources Footer */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5, color: "var(--text-muted)", flexWrap: "wrap", gap: 8 }}>
        <span>当前数据源：{sourcesUsed.join(" + ") || "准备就绪"} · 第 {page} 页</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            上一页
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={items.length === 0 || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
