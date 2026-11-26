import { useState } from "react";
import { Film, KeyRound, Music, RefreshCw, Volume2 } from "lucide-react";
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
  const [ttsText, setTtsText] = useState("你好，欢迎使用云枢智创统一多模态引擎。");
  const [ttsVoice, setTtsVoice] = useState("Kore");
  const [ttsModel, setTtsModel] = useState("gemini-2.5-flash-preview-tts");
  const [ttsAudioUrl, setTtsAudioUrl] = useState("");
  const [ttsBusy, setTtsBusy] = useState(false);

  const [musicPrompt, setMusicPrompt] = useState("Gentle anime piano with soft summer rain, relaxing lo-fi");
  const [musicResult, setMusicResult] = useState("");
  const [musicBusy, setMusicBusy] = useState(false);

  const [videoPrompt, setVideoPrompt] = useState("Cherry blossom petals drifting across a seaside railway crossing at sunset, cinematic slow motion");
  const [videoOp, setVideoOp] = useState("");
  const [videoStatus, setVideoStatus] = useState("");
  const [videoBusy, setVideoBusy] = useState(false);

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
      setMusicResult(JSON.stringify(res.data, null, 2).slice(0, 600));
      onToast("Lyria 音乐请求已完成");
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
        model: "veo-2.0-generate-001",
        prompt: videoPrompt.trim(),
        aspect_ratio: "16:9",
        duration_sec: 5,
      });
      setVideoOp(res.operation);
      setVideoStatus(`已入队：${res.operation}`);
      onToast("Veo 视频异步任务已启动");
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
          {musicBusy ? msg.generating : msg.lyriaBtn}
        </button>
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
          <button type="button" className="btn btn-primary" style={{ flex: 1 }} disabled={videoBusy} onClick={() => void runVideo()}>
            {videoBusy ? msg.generating : msg.veoBtn}
          </button>
          {videoOp && (
            <button type="button" className="btn" disabled={videoBusy} onClick={() => void checkVideo()}>
              <RefreshCw size={14} /> 查进度
            </button>
          )}
        </div>
        {videoStatus && <pre className="ms-code">{videoStatus}</pre>}
      </section>
    </div>
  );
}
