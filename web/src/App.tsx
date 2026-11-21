import { useEffect, useState } from "react";
import { Cpu, MessageSquare, Shield } from "lucide-react";
import { fetchHealth, fetchModels, type HealthResp, type ModelItem } from "./api";
import { ChatPanel } from "./components/ChatPanel";
import { HeaderBar } from "./components/HeaderBar";
import { ModelsPanel } from "./components/ModelsPanel";
import { RiskAdminPanel } from "./components/RiskAdminPanel";

type Tab = "models" | "chat" | "risk";

export function App() {
  const [tab, setTab] = useState<Tab>("models");
  const [health, setHealth] = useState<HealthResp | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [h, m] = await Promise.all([fetchHealth(), fetchModels()]);
      setHealth(h);
      setModels(m);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="wrap">
      <HeaderBar health={health} error={error} />
      <nav className="tabs">
        <button className={`tab ${tab === "models" ? "active" : ""}`} onClick={() => setTab("models")}>
          <Cpu size={15} /> 模型与实付价格 ({models.length})
        </button>
        <button className={`tab ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}>
          <MessageSquare size={15} /> AI 对话测试台
        </button>
        <button className={`tab ${tab === "risk" ? "active" : ""}`} onClick={() => setTab("risk")}>
          <Shield size={15} /> 密钥签发与 IP 风控
        </button>
      </nav>
      {tab === "models" && <ModelsPanel models={models} />}
      {tab === "chat" && <ChatPanel models={models} />}
      {tab === "risk" && <RiskAdminPanel onRefresh={() => void refresh()} />}
    </div>
  );
}
