import { useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { adminMintResellKeys } from "../../api";

interface ResellTabProps {
  jwt: string;
  adminKey: string;
  hasAuth: boolean;
  onToast: (msg: string) => void;
}

export function ResellTab({ jwt, adminKey, hasAuth, onToast }: ResellTabProps) {
  const [resellCount, setResellCount] = useState("5");
  const [resellQuota, setResellQuota] = useState("1000");
  const [resellBatch, setResellBatch] = useState("RESELL-100CNY");
  const [resellDays, setResellDays] = useState("30");
  const [resellKeys, setResellKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "https://dev.lain42.top";

  const handleMintResell = async () => {
    setBusy(true);
    try {
      const res = await adminMintResellKeys(jwt, adminKey, {
        count: Math.max(1, Number(resellCount) || 1),
        quota_credits: Math.max(1, Number(resellQuota) || 100),
        batch_name: resellBatch.trim() || "RESELL",
        expires_days: Math.max(0, Number(resellDays) || 0),
      });
      setResellKeys(res.keys);
      onToast(`已批量生成 ${res.count} 张预充值转售 API Key（每张 ${res.quota_credits} 积分）！`);
    } catch (e) {
      onToast(`生成失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">
          <KeyRound size={17} color="var(--warning)" /> 转售 API Key 批发发卡（买家免注册，即插即用）
        </h3>
      </div>
      <p style={{ marginTop: 0, fontSize: 12.5, color: "var(--text-secondary)" }}>
        批量签发带独立预充值额度的 <span className="mono">sk-l42-...</span> 转售密钥，可直接上架发卡网 / 闲鱼 / 爱发电；买家拿到即可填入 Cursor / Claude Code / cc-switch 直接调用。
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <input className="input" placeholder="生成数量 (1~100)" value={resellCount} onChange={(e) => setResellCount(e.target.value)} />
        <input className="input" placeholder="单 Key 额度 (积分)" value={resellQuota} onChange={(e) => setResellQuota(e.target.value)} />
        <input className="input" placeholder="批次名称" value={resellBatch} onChange={(e) => setResellBatch(e.target.value)} />
        <input className="input" placeholder="有效天数 (0=永久)" value={resellDays} onChange={(e) => setResellDays(e.target.value)} />
        <button className="btn btn-primary" disabled={!hasAuth || busy} onClick={handleMintResell}>
          批量签发转售 Key
        </button>
      </div>
      {resellKeys.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--success)" }}>
              已生成 {resellKeys.length} 张可转售密钥（Base URL: {origin}/relay/v1）
            </span>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                const csv = resellKeys.map((k) => `${k} | BaseURL: ${origin}/relay/v1 | 额度: ${resellQuota}积分`).join("\n");
                navigator.clipboard?.writeText(csv);
                onToast("已复制发卡网格式密钥清单！");
              }}
            >
              <Copy size={13} /> 一键复制发卡格式
            </button>
          </div>
          <div className="code-box">{resellKeys.join("\n")}</div>
        </div>
      )}
    </div>
  );
}
