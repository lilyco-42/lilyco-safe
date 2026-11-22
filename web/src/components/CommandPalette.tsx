import { useEffect } from "react";
import { Command } from "cmdk";
import {
  Bot,
  Coins,
  History,
  KeyRound,
  LayoutDashboard,
  Moon,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  Sun,
  UserCog,
} from "lucide-react";
import type { ModelItem } from "../api";
import { ModelIcon } from "./ModelIcon";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  models: ModelItem[];
  onNavigate: (nav: string) => void;
  onTestModel: (modelId: string) => void;
  onToggleTheme: () => void;
  theme: "light" | "dark";
}

export function CommandPalette({
  open,
  onOpenChange,
  models,
  onNavigate,
  onTestModel,
  onToggleTheme,
  theme,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      } else if (e.key === "Escape" && open) {
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  const go = (id: string) => {
    onNavigate(id);
    onOpenChange(false);
  };

  return (
    <div className="modal-backdrop" style={{ alignItems: "flex-start", paddingTop: "11vh" }} onClick={() => onOpenChange(false)}>
      <div className="cmdk-card" onClick={(e) => e.stopPropagation()}>
        <Command>
          <div className="cmdk-input-wrap">
            <Search size={16} color="var(--text-muted)" />
            <Command.Input autoFocus placeholder="搜索模型、页面或快捷操作 (Esc 关闭)..." className="cmdk-input" />
          </div>
          <Command.List className="cmdk-list">
            <Command.Empty className="cmdk-empty">未找到匹配项</Command.Empty>

            <Command.Group heading="快速测试模型" className="cmdk-group">
              {models.map((m) => (
                <Command.Item
                  key={m.id}
                  value={`model ${m.id} ${m.owned_by}`}
                  className="cmdk-item"
                  onSelect={() => {
                    onTestModel(m.id);
                    onOpenChange(false);
                  }}
                >
                  <ModelIcon modelId={m.id} size={17} />
                  <span className="mono" style={{ fontWeight: 600 }}>{m.id}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-muted)" }}>
                    {m.allow_free ? "免费" : `${m.input_per_m}/${m.output_per_m}`}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="控制台导航" className="cmdk-group">
              <Command.Item className="cmdk-item" onSelect={() => go("dashboard")}><LayoutDashboard size={15} /> 数据看板</Command.Item>
              <Command.Item className="cmdk-item" onSelect={() => go("models")}><Sparkles size={15} /> 模型广场</Command.Item>
              <Command.Item className="cmdk-item" onSelect={() => go("chat")}><Bot size={15} /> 对话演练场</Command.Item>
              <Command.Item className="cmdk-item" onSelect={() => go("tokens")}><KeyRound size={15} /> 令牌管理与 cc-switch</Command.Item>
              <Command.Item className="cmdk-item" onSelect={() => go("wallet")}><Coins size={15} /> 钱包与充值</Command.Item>
              <Command.Item className="cmdk-item" onSelect={() => go("logs")}><History size={15} /> 调用日志</Command.Item>
              <Command.Item className="cmdk-item" onSelect={() => go("admin-channels")}><Server size={15} /> 渠道 Key 池</Command.Item>
              <Command.Item className="cmdk-item" onSelect={() => go("admin-users")}><UserCog size={15} /> 用户与权限 (RBAC)</Command.Item>
              <Command.Item className="cmdk-item" onSelect={() => go("admin-risk")}><ShieldAlert size={15} /> 风控与兑换码</Command.Item>
            </Command.Group>

            <Command.Group heading="外观" className="cmdk-group">
              <Command.Item
                className="cmdk-item"
                onSelect={() => {
                  onToggleTheme();
                  onOpenChange(false);
                }}
              >
                {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
                切换为{theme === "light" ? "深色" : "浅色"}主题
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
