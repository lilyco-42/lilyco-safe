import { useCallback, useEffect, useState } from "react";
import { Check, EyeOff, Search, XCircle } from "lucide-react";
import {
  fetchAdminGallery,
  reviewAdminGalleryItem,
  type GalleryItem,
} from "../../api/multimodal";

interface AdminReviewDrawerProps {
  jwt: string;
  onChanged: () => void;
  onToast: (msg: string) => void;
}

export function AdminReviewDrawer({ jwt, onChanged, onToast }: AdminReviewDrawerProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const data = await fetchAdminGallery(jwt, { q: query.trim(), status, page });
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      onToast(`加载审核列表失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [jwt, query, status, page, onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleReview = async (id: string, action: "approve" | "reject" | "unpublish") => {
    try {
      await reviewAdminGalleryItem(jwt, id, action);
      onToast(action === "approve" ? "已审核通过并公开" : action === "reject" ? "已驳回投稿" : "已从公开画廊下架");
      onChanged();
      await load();
    } catch (e) {
      onToast(`操作失败：${(e as Error).message}`);
    }
  };

  return (
    <section className="ms-admin-box" aria-label="画廊审核与管理">
      <div className="ms-admin-bar">
        <input
          className="input"
          type="search"
          value={query}
          placeholder="搜索标题、提示词、作者或 ID"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
        />
        <select
          className="input"
          style={{ width: "auto", minWidth: 120 }}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">全部状态 ({total})</option>
          <option value="pending">待审核</option>
          <option value="approved">已公开</option>
          <option value="private">私密</option>
          <option value="rejected">已驳回</option>
        </select>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void load()}>
          <Search size={13} /> 筛选
        </button>
      </div>

      <div className="ms-admin-list">
        {items.map((it) => (
          <div key={it.id} className="ms-admin-row">
            <img src={it.thumb_url || it.image_url} alt="" loading="lazy" />
            <div className="ms-admin-info">
              <strong>{it.title || it.prompt.slice(0, 64)}</strong>
              <span>
                {it.review_status} · 作者: {it.owner_id} · {it.width}×{it.height}
              </span>
            </div>
            <div className="ms-admin-acts">
              {it.review_status !== "approved" && (
                <button type="button" className="btn btn-sm" onClick={() => void handleReview(it.id, "approve")}>
                  <Check size={13} /> 通过
                </button>
              )}
              {it.review_status === "pending" && (
                <button type="button" className="btn btn-sm" onClick={() => void handleReview(it.id, "reject")}>
                  <XCircle size={13} /> 驳回
                </button>
              )}
              {it.review_status === "approved" && (
                <button type="button" className="btn btn-sm" onClick={() => void handleReview(it.id, "unpublish")}>
                  <EyeOff size={13} /> 下架
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
