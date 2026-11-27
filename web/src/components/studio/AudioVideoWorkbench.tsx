import { useEffect, useState } from "react";
import { Film, KeyRound, Music, RefreshCw, Volume2 } from "lucide-react";
import { fetchAsyncTasks, fetchModels, type AsyncTaskRecord, type ModelItem } from "../../api";
import {
  callRelayMusic,
  callRelaySpeech,
  pollRelayVideo,
  startRelayVideo,
} from "../../api/multimodal";
import type { StudioMessages } from "../../i18n/studio";

interface AudioVideoWorkbenchProps {
  apiKey: string;
  msg: StudioMessages;
  onGoTokens: () => void;
  onToast: (msg: string) => void;
}

export function AudioVideoWorkbench({ apiKey, msg, onGoTokens, onToast }: AudioVideoWorkbenchProps) {
  const [models, setModels] = useState<ModelItem[]>([]);
  const [ttsText, setTtsText] = useState("你好，欢迎使用云枢智创统一多模态引擎。");
  const [ttsVoice, setTtsVoice] = useState("Kore");
  const [ttsModel, setTtsModel] = useState("gemini-2.5-flash-preview-tts");
  const [ttsAudioUrl, setTtsAudioUrl] = useState("");
  const [ttsBusy, setTtsBusy] = useState(false);

  const [musicPrompt, setMusicPrompt] = useState("Gentle anime piano with soft summer rain, relaxing lo-fi");
  const [musicAudioUrl, setMusicAudioUrl] = useState("");
  const [musicResult, setMusicResult] = useState("");
  const [musicBusy, setMusicBusy] = useState(false);

  const [videoPrompt, setVideoPrompt] = useState("Cherry blossom petals drifting across a seaside railway crossing at sunset, cinematic slow motion");
  const [videoDuration, setVideoDuration] = useState<4 | 6 | 8>(4);
  const [videoOp, setVideoOp] = useState("");
  const [videoStatus, setVideoStatus] = useState("");
  const [videoBusy, setVideoBusy] = useState(false);
  const [tasks, setTasks] = useState<AsyncTaskRecord[]>([]);

  const loadTasks = () => {
    const jwt = typeof window !== "undefined" ? window.localStorage.getItem("lain42_jwt") || "" : "";
    if (!jwt) return;
    fetchAsyncTasks(jwt)
      .then((res) => setTasks(res.tasks || []))
      .catch(() => {});
  };

  useEffect(() => {
    fetchModels().then(setModels).catch(() => {});
    loadTasks();
  }, []);

  const lyriaCredits = models.find((m) => m.id === "lyria-002")?.unit_credits ?? 15;
  const veoPerSec = models.find((m) => m.id === "veo-3.1-fast-generate-001")?.unit_credits ?? 20;
  const veoTotalCredits = veoPerSec * videoDuration;

  if (!apiKey.trim()) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 36 }}>
        <KeyRound size={28} color="var(--primary)" style={{ marginBottom: 10 }} />
        <p style={{ margin: "0 0 14px", color: "var(--text-muted)", fontSize: 13.5 }}>{msg.needApiKey}</p>
        <button type="button" className="btn btn-primary" onClick={onGoTokens}>
          {msg.goTokens}
        </button>
      </div>
    );
  }

  const runTts = async () => {
    if (!ttsText.trim()) return;
    setTtsBusy(true);
    try {
      const res = await callRelaySpeech(apiKey, {
        model: ttsModel,
        input: ttsText.trim(),
        voice: ttsVoice,
        response_format: "wav",
      });
      setTtsAudioUrl(`data:${res.mime_type};base64,${res.audio_base64}`);
      onToast("WAV 配音生成成功");
    } catch (e) {
      onToast(`配音生成失败：${(e as Error).message}`);
    } finally {
      setTtsBusy(false);
    }
  };

  const runMusic = async () => {
    if (!musicPrompt.trim()) return;
    setMusicBusy(true);
    try {
      const res = await callRelayMusic(apiKey, {
        model: "lyria-002",
        prompt: musicPrompt.trim(),
        duration_sec: 30,
      });
      if (res.audio_base64) {
        setMusicAudioUrl(`data:${res.mime_type || "audio/wav"};base64,${res.audio_base64}`);
        setMusicResult("");
        onToast("Lyria AI 音乐生成成功，可直接试听！");
      } else {
        setMusicResult(JSON.stringify(res.data, null, 2).slice(0, 600));
        onToast("Lyria 音乐请求已完成");
      }
    } catch (e) {
      onToast(`音乐生成失败：${(e as Error).message}`);
    } finally {
      setMusicBusy(false);
    }
  };

  const runVideo = async () => {
    if (!videoPrompt.trim()) return;
    setVideoBusy(true);
    try {
      const res = await startRelayVideo(apiKey, {
        model: "veo-3.1-fast-generate-001",
        prompt: videoPrompt.trim(),
        aspect_ratio: "16:9",
        duration_sec: videoDuration,
      });
      setVideoOp(res.operation);
      setVideoStatus(`已入队：${res.operation}`);
      onToast("Veo 视频异步任务已启动");
      loadTasks();
    } catch (e) {
      onToast(`视频任务失败：${(e as Error).message}`);
    } finally {
      setVideoBusy(false);
    }
  };

  const checkVideo = async () => {
    if (!videoOp) return;
    setVideoBusy(true);
    try {
      const res = await pollRelayVideo(apiKey, videoOp);
      setVideoStatus(JSON.stringify(res, null, 2).slice(0, 500));
    } catch (e) {
      onToast(`查询失败：${(e as Error).message}`);
    } finally {
      setVideoBusy(false);
    }
  };

  return (
    <div className="ms-media-grid">
      {/* 1. Gemini TTS */}
      <section className="card ms-media-card">
        <div className="ms-media-head">
          <Volume2 size={16} color="var(--primary)" />
          <h3>{msg.ttsTitle}</h3>
        </div>
        <textarea
          className="input"
          rows={3}
          value={ttsText}
          placeholder={msg.ttsPlaceholder}
          onChange={(e) => setTtsText(e.target.value)}
        />
        <div className="ms-ctrl-row">
          <select className="input" value={ttsModel} onChange={(e) => setTtsModel(e.target.value)}>
            <option value="gemini-2.5-flash-preview-tts">gemini-2.5-flash-preview-tts</option>
            <option value="free:gemini-2.5-flash-preview-tts">free:gemini-2.5-flash-preview-tts</option>
          </select>
          <select className="input" style={{ width: "auto" }} value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)}>
            <option value="Kore">Kore</option>
            <option value="Puck">Puck</option>
            <option value="Zephyr">Zephyr</option>
            <option value="Aoede">Aoede</option>
          </select>
        </div>
        <button type="button" className="btn btn-primary" disabled={ttsBusy} onClick={() => void runTts()}>
          {ttsBusy ? msg.generating : msg.ttsBtn}
        </button>
        {ttsAudioUrl && <audio controls src={ttsAudioUrl} style={{ width: "100%" }} />}
      </section>

      {/* 2. Gemini Lyria */}
      <section className="card ms-media-card">
        <div className="ms-media-head">
          <Music size={16} color="var(--primary)" />
          <h3>{msg.lyriaTitle}</h3>
        </div>
        <textarea
          className="input"
          rows={3}
          value={musicPrompt}
          placeholder={msg.lyriaPlaceholder}
          onChange={(e) => setMusicPrompt(e.target.value)}
        />
        <button type="button" className="btn btn-primary" disabled={musicBusy} onClick={() => void runMusic()}>
          {musicBusy ? msg.generating : `${msg.lyriaBtn} (${lyriaCredits} 积分/次)`}
        </button>
        {musicAudioUrl && <audio controls src={musicAudioUrl} style={{ width: "100%" }} />}
        {musicResult && <pre className="ms-code">{musicResult}</pre>}
      </section>

      {/* 3. Gemini Veo */}
      <section className="card ms-media-card">
        <div className="ms-media-head">
          <Film size={16} color="var(--primary)" />
          <h3>{msg.veoTitle}</h3>
        </div>
        <textarea
          className="input"
          rows={3}
          value={videoPrompt}
          placeholder={msg.veoPlaceholder}
          onChange={(e) => setVideoPrompt(e.target.value)}
        />
        <div className="ms-ctrl-row">
          <select
            className="input"
            style={{ width: "auto" }}
            value={videoDuration}
            onChange={(e) => setVideoDuration(Number(e.target.value) as 4 | 6 | 8)}
          >
            <option value={4}>4 秒 ({veoPerSec * 4} 积分)</option>
            <option value={6}>6 秒 ({veoPerSec * 6} 积分)</option>
            <option value={8}>8 秒 ({veoPerSec * 8} 积分)</option>
          </select>
          <button type="button" className="btn btn-primary" style={{ flex: 1 }} disabled={videoBusy} onClick={() => void runVideo()}>
            {videoBusy ? msg.generating : `${msg.veoBtn} (${veoTotalCredits} 积分)`}
          </button>
          {videoOp && (
            <button type="button" className="btn" disabled={videoBusy} onClick={() => void checkVideo()}>
              <RefreshCw size={14} /> 查进度
            </button>
          )}
        </div>
        {videoStatus && <pre className="ms-code">{videoStatus}</pre>}
      </section>

      {/* 4. Unified Async Task Queue History */}
      {tasks.length > 0 && (
        <section className="card ms-media-card" style={{ gridColumn: "1 / -1" }}>
          <div className="ms-media-head" style={{ justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Film size={16} color="var(--primary)" />
              <h3>统一异步任务记录（{tasks.length}）</h3>
            </div>
            <button type="button" className="btn btn-sm" onClick={loadTasks}>
              <RefreshCw size={13} /> 刷新
            </button>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>任务 ID</th>
                  <th>类型 / 模型</th>
                  <th>状态</th>
                  <th>消耗积分</th>
                  <th style={{ textAlign: "right" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.slice(0, 12).map((t) => (
                  <tr key={t.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{t.id}</td>
                    <td>
                      <span className="pill pill-guest" style={{ marginRight: 6 }}>{t.meta.task_type}</span>
                      <span className="mono" style={{ fontSize: 12 }}>{t.meta.model}</span>
                    </td>
                    <td>
                      <span className={`pill ${t.status === "succeeded" ? "pill-ok" : t.status === "failed" ? "pill-danger" : "pill-vip"}`}>
                        {t.status}
                      </span>
                    </td>
                    <td><b>{t.result.credits_charged}</b></td>
                    <td style={{ textAlign: "right" }}>
                      {t.meta.task_type === "video" && t.meta.provider_op && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            setVideoOp(t.meta.provider_op);
                            onToast(`已载入任务 ${t.id}，点击「查进度」即可查询实时状态`);
                          }}
                        >
                          载入查询
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
