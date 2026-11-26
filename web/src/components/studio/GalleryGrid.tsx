import { useEffect, useRef, useState } from "react";
import { ExternalLink, Trash2, UploadCloud, X } from "lucide-react";
import type { GalleryItem, ReviewStatus } from "../../api/multimodal";
import type { StudioMessages } from "../../i18n/studio";

interface GalleryGridProps {
  items: GalleryItem[];
  scope: "public" | "personal";
  isAdmin: boolean;
  msg: StudioMessages;
  onRemix: (item: GalleryItem) => void;
  onSubmitReview: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const STATUS_BADGE: Record<ReviewStatus, string> = {
  approved: "ms-st-approved",
  pending: "ms-st-pending",
  private: "ms-st-private",
  rejected: "ms-st-rejected",
};

export function GalleryGrid({
  items,
  scope,
  isAdmin,
  msg,
  onRemix,
  onSubmitReview,
  onDelete,
}: GalleryGridProps) {
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!preview) return;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPreview(null);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  const statusText = (st: ReviewStatus): string => {
    if (st === "approved") return msg.statusApproved;
    if (st === "pending") return msg.statusPending;
    if (st === "rejected") return msg.statusRejected;
    return msg.statusPrivate;
  };

  return (
    <>
      <div className="ms-gallery" role="list">
        {items.map((it) => {
          const thumb = it.thumb_url || it.image_url || "";
          const title = it.title || it.prompt || "Untitled";
          return (
            <article key={it.id} className="ms-gitem" role="listitem">
              <button
                type="button"
                className="ms-gcard-btn"
                aria-label={title}
                onClick={(e) => {
                  triggerRef.current = e.currentTarget;
                  setPreview(it);
                }}
              >
                <img src={thumb} alt={title} loading="lazy" decoding="async" />
                <div className="ms-gcap">
                  <div className="ms-gtitle" title={title}>{title}</div>
                  <div className="ms-gsub">
                    <span>
                      {it.width}×{it.height}
                      {it.elapsed_s ? ` · ${it.elapsed_s}s` : ""}
                    </span>
                    {scope === "personal" && (
                      <span className={`ms-st ${STATUS_BADGE[it.review_status]}`}>
                        {statusText(it.review_status)}
                      </span>
                    )}
                  </div>
                </div>
              </button>

              {scope === "personal" && (
                <div className="ms-gbar">
                  {(it.review_status === "private" || it.review_status === "rejected") && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void onSubmitReview(it.id)}
                    >
                      <UploadCloud size={13} />
                      {isAdmin ? msg.publishDirect : msg.submitReview}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ color: "#b91c1c" }}
                    onClick={() => void onDelete(it.id)}
                  >
                    <Trash2 size={13} />
                    {msg.deleteBtn}
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {preview && (
        <div
          className="ms-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={preview.title || "Artwork preview"}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setPreview(null);
              triggerRef.current?.focus();
            }
          }}
        >
          <div className="ms-lb-card">
            <div className="ms-lb-img">
              <img src={preview.image_url || preview.thumb_url} alt={preview.title || preview.prompt} />
            </div>
            <div className="ms-lb-info">
              <div className="ms-lb-head">
                <strong>{preview.title || msg.title}</strong>
                <button
                  ref={closeBtnRef}
                  type="button"
                  className="btn btn-sm"
                  aria-label={msg.closeBtn}
                  onClick={() => {
                    setPreview(null);
                    triggerRef.current?.focus();
                  }}
                >
                  <X size={14} />
                </button>
              </div>
              <div className="ms-lb-meta">
                {preview.width}×{preview.height} · {preview.model || "moss-image-sft"} · Seed {preview.seed ?? "-"}
              </div>
              <div className="ms-lb-prompt">{preview.prompt || preview.description || "-"}</div>
              <div className="ms-lb-acts">
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  onClick={() => {
                    onRemix(preview);
                    setPreview(null);
                  }}
                >
                  {msg.remixBtn}
                </button>
                {preview.image_url && (
                  <a className="btn" href={preview.image_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={14} />
                    {msg.viewRaw}
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
