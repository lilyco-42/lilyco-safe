import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  Bone,
  Box,
  Check,
  Download,
  Eye,
  FileCode2,
  Focus,
  Footprints,
  Grid3X3,
  Layers,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { buildBedrockRig, type BuiltYsmRig } from "../ysm/bedrockBuilder";
import { applyBedrockAnimation } from "../ysm/animator";
import {
  createPackageFromGeoJson,
  exportYsmSpec2Zip,
  generateBlenderPreviewScript,
  loadBuiltinShowcaseDemo,
  loadYsmFromZipFile,
} from "../ysm/ysmLoader";
import type { YsmPackage } from "../ysm/types";

export interface YsmExternalZip {
  blob: Blob;
  filename: string;
}

export interface YsmStudioViewerProps {
  externalPackage?: YsmPackage | null;
  externalZip?: YsmExternalZip | null;
  externalKey?: number;
  generating?: boolean;
  generatingText?: string;
  generatingElapsedMs?: number;
}

const QUICK_ANIMS: Array<{ key: string; label: string }> = [
  { key: "idle", label: "待机" },
  { key: "walk", label: "行走" },
  { key: "run", label: "奔跑" },
  { key: "jump", label: "跳跃" },
  { key: "swing_hand", label: "挥手" },
  { key: "fly", label: "飞行" },
  { key: "sit", label: "坐姿" },
];

function formatBytesKB(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export const YsmStudioViewer: React.FC<YsmStudioViewerProps> = ({
  externalPackage,
  externalZip,
  externalKey = 0,
  generating = false,
  generatingText,
  generatingElapsedMs = 0,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rigRef = useRef<BuiltYsmRig | null>(null);
  const parentMapRef = useRef<Map<string, string | undefined>>(new Map());
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [pkg, setPkg] = useState<YsmPackage | null>(externalPackage ?? null);
  const [sourceZip, setSourceZip] = useState<YsmExternalZip | null>(externalZip ?? null);
  const [loading, setLoading] = useState(!externalPackage);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [activeAnim, setActiveAnim] = useState<string>(
    externalPackage
      ? externalPackage.animations.idle
        ? "idle"
        : Object.keys(externalPackage.animations)[0] || ""
      : "idle",
  );
  const [activeTextureId, setActiveTextureId] = useState<string>(externalPackage?.textures[0]?.id || "");
  const [playing, setPlaying] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [animSpeed, setAnimSpeed] = useState(1.0);
  const [lightboxUrl, setLightboxUrl] = useState<{ url: string; label: string } | null>(null);
  const [copiedJson, setCopiedJson] = useState(false);

  const animStateRef = useRef({
    pkg: null as YsmPackage | null,
    activeAnim: "idle",
    playing: true,
    autoRotate: false,
    animSpeed: 1.0,
    elapsed: 0,
  });

  useEffect(() => {
    animStateRef.current.pkg = pkg;
    animStateRef.current.activeAnim = activeAnim;
    animStateRef.current.playing = playing;
    animStateRef.current.autoRotate = autoRotate;
    animStateRef.current.animSpeed = animSpeed;
  }, [pkg, activeAnim, playing, autoRotate, animSpeed]);

  const loadDemo = async () => {
    setLoading(true);
    setErrorMsg(null);
    setSourceZip(null);
    try {
      const demo = await loadBuiltinShowcaseDemo();
      setPkg(demo);
      setActiveTextureId(demo.textures[0]?.id || "");
      setActiveAnim(demo.animations.idle ? "idle" : Object.keys(demo.animations)[0] || "");
      animStateRef.current.elapsed = 0;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "加载示范模型失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!externalPackage) {
      loadDemo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!externalPackage) return;
    setPkg(externalPackage);
    setSourceZip(externalZip ?? null);
    setActiveTextureId(externalPackage.textures[0]?.id || "");
    setActiveAnim(externalPackage.animations.idle ? "idle" : Object.keys(externalPackage.animations)[0] || "");
    setErrorMsg(null);
    setLoading(false);
    animStateRef.current.elapsed = 0;
  }, [externalPackage, externalZip, externalKey]);

  // Initialize Three.js WebGL Stage
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 760;
    const height = container.clientHeight || 500;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111116);

    const camera = new THREE.PerspectiveCamera(36, width / height, 0.05, 100);
    camera.position.set(0.42, 1.18, 3.55);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(0, 0.82, 0);
    controls.minDistance = 0.8;
    controls.maxDistance = 10;
    controls.update();
    controlsRef.current = controls;

    // 3-Point Studio Lighting (AllTheYSM / Blender EEVEE clean look)
    const ambient = new THREE.AmbientLight(0xffffff, 0.88);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xfff7ed, 1.15);
    keyLight.position.set(2.5, 4.2, 3.2);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xc7d2fe, 0.55);
    fillLight.position.set(-3.0, 2.2, 2.0);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xf9a8d4, 0.45);
    rimLight.position.set(0.0, 3.0, -3.5);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(10, 20, 0x3f3f46, 0x22222a);
    grid.position.y = 0;
    scene.add(grid);
    gridRef.current = grid;

    (container as HTMLDivElement & { __scene?: THREE.Scene }).__scene = scene;

    let rafId = 0;
    let lastTs = performance.now();

    const animate = (now: number) => {
      rafId = requestAnimationFrame(animate);
      const dt = Math.min((now - lastTs) / 1000, 0.1);
      lastTs = now;

      const st = animStateRef.current;
      if (st.playing && rigRef.current && st.pkg) {
        st.elapsed += dt * st.animSpeed;
        const animClip = st.pkg.animations[st.activeAnim];
        applyBedrockAnimation(rigRef.current, parentMapRef.current, animClip, st.elapsed);
      }

      controls.autoRotate = st.autoRotate;
      controls.autoRotateSpeed = 2.0;
      controls.update();
      renderer.render(scene, camera);
    };
    rafId = requestAnimationFrame(animate);

    const ro = new ResizeObserver(() => {
      if (!container) return;
      const w = container.clientWidth || 760;
      const h = container.clientHeight || 500;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
    };
  }, []);

  // Mount/Rebuild YSM Rig
  useEffect(() => {
    const container = mountRef.current as (HTMLDivElement & { __scene?: THREE.Scene }) | null;
    const scene = container?.__scene;
    if (!scene || !pkg) return;

    let cancelled = false;
    let loadedTex: THREE.Texture | null = null;

    const mountRig = (texture: THREE.Texture | null) => {
      if (cancelled) {
        texture?.dispose();
        return;
      }
      if (rigRef.current) {
        scene.remove(rigRef.current.root);
        rigRef.current.dispose();
        rigRef.current = null;
      }

      const rig = buildBedrockRig(pkg.geometry, texture, pkg.heightScale);
      rig.skeletonGroup.visible = showSkeleton;
      rig.materials.forEach((m) => {
        m.wireframe = wireframe;
      });

      const pMap = new Map<string, string | undefined>();
      for (const b of pkg.geometry.bones || []) {
        pMap.set(b.name, b.parent);
      }
      parentMapRef.current = pMap;

      scene.add(rig.root);
      rigRef.current = rig;

      const animClip = pkg.animations[activeAnim];
      applyBedrockAnimation(rig, pMap, animClip, 0);
    };

    const texVariant = pkg.textures.find((t) => t.id === activeTextureId) || pkg.textures[0];
    if (texVariant?.url) {
      const loader = new THREE.TextureLoader();
      loader.load(
        texVariant.url,
        (tex) => {
          tex.magFilter = THREE.NearestFilter;
          tex.minFilter = THREE.NearestFilter;
          tex.generateMipmaps = false;
          tex.colorSpace = THREE.SRGBColorSpace;
          loadedTex = tex;
          mountRig(tex);
        },
        undefined,
        () => mountRig(null),
      );
    } else {
      mountRig(null);
    }

    return () => {
      cancelled = true;
      loadedTex?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg, activeTextureId]);

  useEffect(() => {
    if (rigRef.current) {
      rigRef.current.skeletonGroup.visible = showSkeleton;
      rigRef.current.materials.forEach((m) => {
        m.wireframe = wireframe;
      });
    }
  }, [showSkeleton, wireframe]);

  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.visible = showGrid;
    }
  }, [showGrid]);

  const handleResetCamera = () => {
    if (cameraRef.current && controlsRef.current) {
      cameraRef.current.position.set(0.42, 1.18, 3.55);
      controlsRef.current.target.set(0, 0.82, 0);
      controlsRef.current.update();
    }
  };

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    setLoading(true);
    setErrorMsg(null);
    try {
      if (/\.(zip|ysm)$/i.test(file.name)) {
        const loaded = await loadYsmFromZipFile(file);
        setPkg(loaded);
        setSourceZip({ blob: file, filename: file.name });
        setActiveTextureId(loaded.textures[0]?.id || "");
        setActiveAnim(loaded.animations.idle ? "idle" : Object.keys(loaded.animations)[0] || "");
        animStateRef.current.elapsed = 0;
        toast.success(`已加载 YSM 模型包：${loaded.name}`);
      } else if (/\.json$/i.test(file.name)) {
        const text = await file.text();
        const loaded = createPackageFromGeoJson(text, file.name.replace(/\.geo\.json$|\.json$/i, ""));
        setPkg(loaded);
        setSourceZip(null);
        setActiveTextureId("");
        setActiveAnim("idle");
        animStateRef.current.elapsed = 0;
        toast.success(`已加载 Bedrock 几何文件：${file.name}`);
      } else if (/\.png$/i.test(file.name) && pkg) {
        const url = URL.createObjectURL(file);
        const newTex = { id: `upload-${Date.now()}`, label: file.name, url };
        setPkg({ ...pkg, textures: [newTex, ...pkg.textures] });
        setSourceZip(null);
        setActiveTextureId(newTex.id);
        toast.success(`已应用新贴图：${file.name}`);
      } else {
        toast.error("支持上传 .zip (YSM 包)、.geo.json 或 .png 贴图");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "加载失败";
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleExportZip = async () => {
    if (!pkg) return;
    try {
      const blob = sourceZip ? sourceZip.blob : await exportYsmSpec2Zip(pkg);
      const downloadName = sourceZip
        ? sourceZip.filename
        : `${pkg.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_ysm_spec2.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadName;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(sourceZip ? `已下载 YSM 模型包：${downloadName}` : "已导出标准 YSM Spec 2 模型包 (.zip)");
    } catch {
      toast.error("导出失败");
    }
  };

  const handleDownloadBlenderScript = () => {
    if (!pkg) return;
    const script = generateBlenderPreviewScript(pkg.name);
    const blob = new Blob([script], { type: "text/x-python" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `render_${pkg.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_blender.py`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("已下载 Blender 无头三视图渲染脚本");
  };

  const handleCopyGeoJson = () => {
    if (!pkg?.rawGeoJson) return;
    navigator.clipboard.writeText(pkg.rawGeoJson);
    setCopiedJson(true);
    toast.success("已复制 AI 友好 Bedrock 1.12.0 JSON");
    setTimeout(() => setCopiedJson(false), 1800);
  };

  const allAnimKeys = useMemo(() => Object.keys(pkg?.animations || {}), [pkg]);
  const cubeCount = useMemo(
    () => (pkg?.geometry.bones || []).reduce((acc, b) => acc + (b.cubes?.length || 0), 0),
    [pkg],
  );
  const isBlenderGallery = useMemo(
    () =>
      Boolean(
        pkg?.blenderRenders?.some(
          (r) => r.source === "blender" || (r.source === undefined && pkg.id === "builtin-lyco-ip"),
        ),
      ),
    [pkg],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Main 2-column layout: 3D WebGL Stage + Studio Inspector */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(420px, 1.85fr) minmax(290px, 1fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* Left: Flagship Dark 3D Stage (AllTheYSM aesthetic) */}
        <div
          style={{
            borderRadius: 16,
            border: "1px solid #27272a",
            background: "#111116",
            overflow: "hidden",
            boxShadow: "0 12px 32px rgba(0,0,0,0.28)",
          }}
        >
          {/* Stage Top Bar */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "10px 14px",
              background: "rgba(9,9,11,0.88)",
              borderBottom: "1px solid #27272a",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "3px 10px",
                  borderRadius: 99,
                  fontSize: 11,
                  fontWeight: 600,
                  background: "rgba(16,185,129,0.14)",
                  color: "#34d399",
                  border: "1px solid rgba(16,185,129,0.32)",
                }}
              >
                <Box size={13} /> Lilyco YSM 3D Engine · MIT
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#f4f4f5" }}>
                {pkg?.name || "加载中..."}
              </span>
              <span style={{ fontSize: 11.5, color: "#a1a1aa" }}>
                Spec {pkg?.spec ?? 2} · {pkg?.geometry.bones.length ?? 0} 骨骼 · {cubeCount} 方块
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 11px",
                  borderRadius: 8,
                  border: "1px solid #3f3f46",
                  background: "#18181b",
                  color: "#e4e4e7",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                <Upload size={13} /> 上传 .zip / .geo.json / .png
              </button>
              <button
                type="button"
                onClick={loadDemo}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 11px",
                  borderRadius: 8,
                  border: "1px solid rgba(129,140,248,0.4)",
                  background: "rgba(99,102,241,0.18)",
                  color: "#c7d2fe",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                <Sparkles size={13} /> LYCO-IP · 原设示范
              </button>
              <a
                className="btn btn-sm"
                href="https://github.com/chenx5452321/ysm-ai-engine#-效果展示"
                target="_blank"
                rel="noreferrer"
              >
                上游示范
              </a>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,.ysm,.json,.png"
                style={{ display: "none" }}
                onChange={(e) => handleFileUpload(e.target.files)}
              />
            </div>
          </div>

          {/* 3D WebGL Canvas + Floating Controls */}
          <div style={{ position: "relative", height: 500, width: "100%", userSelect: "none" }}>
            <div ref={mountRef} style={{ width: "100%", height: "100%", cursor: "grab" }} />

            {/* Floating Pill Toolbar (Inspired by alltheysm.st) */}
            <div
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 4,
                padding: "5px 8px",
                borderRadius: 99,
                background: "rgba(24,24,27,0.88)",
                backdropFilter: "blur(10px)",
                border: "1px solid rgba(63,63,70,0.8)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              }}
            >
              {QUICK_ANIMS.filter((a) => allAnimKeys.includes(a.key)).map((item) => {
                const isAct = activeAnim === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      setActiveAnim(item.key);
                      setPlaying(true);
                      animStateRef.current.elapsed = 0;
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 99,
                      border: "none",
                      fontSize: 11.5,
                      fontWeight: isAct ? 700 : 500,
                      background: isAct ? "#fda4af" : "transparent",
                      color: isAct ? "#09090b" : "#d4d4d8",
                      cursor: "pointer",
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}

              <div style={{ width: 1, height: 16, background: "#3f3f46", margin: "0 3px" }} />

              {[
                {
                  active: false,
                  onClick: () => setPlaying((p) => !p),
                  title: playing ? "暂停动作" : "播放动作",
                  icon: playing ? <Pause size={14} /> : <Play size={14} />,
                },
                {
                  active: autoRotate,
                  onClick: () => setAutoRotate((r) => !r),
                  title: "自动旋转展示",
                  icon: <RefreshCw size={14} />,
                },
                {
                  active: showSkeleton,
                  onClick: () => setShowSkeleton((s) => !s),
                  title: "显示骨骼骨架",
                  icon: <Bone size={14} />,
                },
                {
                  active: wireframe,
                  onClick: () => setWireframe((w) => !w),
                  title: "线框模式",
                  icon: <Layers size={14} />,
                },
                {
                  active: showGrid,
                  onClick: () => setShowGrid((g) => !g),
                  title: "地面网格",
                  icon: <Grid3X3 size={14} />,
                },
                {
                  active: false,
                  onClick: handleResetCamera,
                  title: "重置镜头",
                  icon: <Focus size={14} />,
                },
              ].map((btn, idx) => (
                <button
                  key={idx}
                  type="button"
                  title={btn.title}
                  onClick={btn.onClick}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 99,
                    border: "none",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: btn.active ? "rgba(99,102,241,0.32)" : "transparent",
                    color: btn.active ? "#a5b4fc" : "#d4d4d8",
                    cursor: "pointer",
                  }}
                >
                  {btn.icon}
                </button>
              ))}
            </div>

            {/* Bottom-left Animation Wheel & Speed HUD */}
            <div
              style={{
                position: "absolute",
                bottom: 12,
                left: 12,
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
                padding: "6px 12px",
                borderRadius: 12,
                background: "rgba(9,9,11,0.85)",
                backdropFilter: "blur(8px)",
                border: "1px solid #27272a",
                fontSize: 11.5,
                color: "#d4d4d8",
              }}
            >
              <Footprints size={14} color="#fda4af" />
              <span style={{ color: "#a1a1aa" }}>动作轮盘 ({allAnimKeys.length}):</span>
              <select
                value={activeAnim}
                onChange={(e) => {
                  setActiveAnim(e.target.value);
                  setPlaying(true);
                  animStateRef.current.elapsed = 0;
                }}
                style={{
                  background: "#18181b",
                  color: "#f4f4f5",
                  border: "1px solid #3f3f46",
                  borderRadius: 6,
                  padding: "2px 6px",
                  fontSize: 11.5,
                }}
              >
                {allAnimKeys.length > 0 ? (
                  allAnimKeys.map((k) => (
                    <option key={k} value={k}>
                      {k} ({pkg?.animations[k]?.animation_length ?? 2}s)
                    </option>
                  ))
                ) : (
                  <option value="">默认绑定姿势</option>
                )}
              </select>

              <span style={{ color: "#52525b" }}>|</span>
              <span style={{ color: "#a1a1aa" }}>倍速:</span>
              <select
                value={animSpeed}
                onChange={(e) => setAnimSpeed(parseFloat(e.target.value))}
                style={{
                  background: "#18181b",
                  color: "#f4f4f5",
                  border: "1px solid #3f3f46",
                  borderRadius: 6,
                  padding: "2px 6px",
                  fontSize: 11.5,
                }}
              >
                <option value={0.5}>0.5x</option>
                <option value={1.0}>1.0x</option>
                <option value={1.5}>1.5x</option>
                <option value={2.0}>2.0x</option>
              </select>
            </div>

            {(generating || loading) && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: 20,
                  textAlign: "center",
                  background: "rgba(9,9,11,0.78)",
                  backdropFilter: "blur(4px)",
                  color: "#e4e4e7",
                  fontSize: 13,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                  <RotateCcw size={16} className="spin" />
                  {generating
                    ? generatingText || "正在执行 YSM 引擎塑形、贴图绘制与质量校验..."
                    : "正在解析 Bedrock 1.12.0 骨骼与贴图..."}
                </div>
                {generating && (
                  <div style={{ fontSize: 11.5, color: "#a1a1aa" }}>
                    已耗时 {(generatingElapsedMs / 1000).toFixed(1)}s · 完成后自动载入带真实贴图的 3D 模型
                  </div>
                )}
              </div>
            )}

            {errorMsg && (
              <div
                style={{
                  position: "absolute",
                  left: 16,
                  right: 16,
                  bottom: 58,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "rgba(127,29,29,0.92)",
                  border: "1px solid #b91c1c",
                  color: "#fecaca",
                  fontSize: 12,
                }}
              >
                {errorMsg}
              </div>
            )}
          </div>
        </div>

        {/* Right: Studio Inspector & Commercial Exports */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{pkg?.name || "YSM 成品模型"}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
                  {pkg?.subtitle}
                </div>
              </div>
              <span className="pill pill-vip" style={{ fontSize: 11 }}>
                YSM v{pkg?.spec ?? 2}
              </span>
            </div>

            {/* Stats Row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {[
                { val: pkg?.geometry.bones.length ?? 0, label: "骨骼节点" },
                { val: cubeCount, label: "几何方块" },
                { val: allAnimKeys.length, label: "动作轨道" },
              ].map((s) => (
                <div
                  key={s.label}
                  style={{
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    background: "var(--bg-subtle)",
                    padding: "8px 6px",
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: 17, fontWeight: 700 }}>{s.val}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Texture Variants */}
            {pkg && pkg.textures.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                  贴图变体 ({pkg.textures.length})
                </span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {pkg.textures.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`btn btn-sm ${activeTextureId === t.id ? "btn-primary" : ""}`}
                      onClick={() => setActiveTextureId(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Export Buttons */}
            <div
              style={{
                borderTop: "1px solid var(--border)",
                paddingTop: 12,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <button
                type="button"
                className="btn btn-primary"
                disabled={!pkg || loading || generating}
                onClick={handleExportZip}
                style={{ justifyContent: "center" }}
              >
                <Download size={14} />
                {sourceZip
                  ? `下载 YSM 模型包 (${sourceZip.filename} · ${formatBytesKB(sourceZip.blob.size)})`
                  : "导出标准 YSM Spec 2 模型包 (.zip)"}
              </button>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleDownloadBlenderScript}
                  style={{ justifyContent: "center" }}
                >
                  <Zap size={13} color="#f59e0b" /> Blender 脚本
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleCopyGeoJson}
                  style={{ justifyContent: "center" }}
                >
                  {copiedJson ? <Check size={13} color="#10b981" /> : <FileCode2 size={13} color="#38bdf8" />}
                  {copiedJson ? "已复制 JSON" : "AI 几何 JSON"}
                </button>
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 14, background: "var(--bg-subtle)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>
              <Eye size={14} color="var(--primary)" /> Lilyco YSM Engine · AI 友好架构
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
              纯 <strong>MIT Three.js + Zero-Eval Molang</strong> 原生重写：支持 Bedrock 1.12.0 骨骼层级、Per-Face/Box UV、像素级 NearestFilter 与 29 轨动作轮盘。加密 <code>.ysm</code> 经 <code>OpenYSM/YSMParser (MIT)</code> 解包为 <code>.zip</code> 后可直接拖入测试。
            </div>
          </div>
        </div>
      </div>

      {/* Bottom: 3D Multi-View Render Gallery (Built-in Blender Assets vs Engine Turnaround) */}
      {pkg?.blenderRenders && pkg.blenderRenders.length > 0 && (
        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontSize: 14.5, fontWeight: 700 }}>
                {isBlenderGallery
                  ? `Blender 3D 成品渲染审查画廊（${pkg.name}）`
                  : `引擎渲染审查画廊（${pkg.name}）`}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {isBlenderGallery
                  ? "真实 Blender 三视图、姿态集、细节特写、白模布线与骨骼权重图，点击可放大检视"
                  : "模型包内附引擎三视图，用于检视塑形轮廓、贴图与结构校验效果，点击可放大检视"}
              </div>
            </div>
            <span className="pill pill-ok" style={{ fontSize: 11 }}>
              {isBlenderGallery ? "Blender Cycles / EEVEE" : "引擎三视图"}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            {pkg.blenderRenders.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setLightboxUrl({ url: r.url, label: r.label })}
                style={{
                  padding: 0,
                  borderRadius: 12,
                  overflow: "hidden",
                  border: "1px solid var(--border)",
                  background: "#09090b",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <div style={{ aspectRatio: "16 / 10", overflow: "hidden", background: "#141418", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <img
                    src={r.url}
                    alt={r.label}
                    style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                  />
                </div>
                <div style={{ padding: "7px 10px", fontSize: 12, fontWeight: 600, color: "#e4e4e7" }}>
                  {r.label}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Lightbox Modal */}
      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.82)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 1000,
              width: "100%",
              borderRadius: 16,
              overflow: "hidden",
              background: "#09090b",
              border: "1px solid #27272a",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 16px",
                borderBottom: "1px solid #27272a",
                color: "#f4f4f5",
                fontWeight: 600,
                fontSize: 13.5,
              }}
            >
              <span>{lightboxUrl.label}</span>
              <button
                type="button"
                onClick={() => setLightboxUrl(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#a1a1aa",
                  cursor: "pointer",
                  display: "flex",
                }}
              >
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: 12, display: "flex", justifyContent: "center", maxHeight: "80vh", overflow: "auto" }}>
              <img
                src={lightboxUrl.url}
                alt={lightboxUrl.label}
                style={{ maxWidth: "100%", maxHeight: "74vh", objectFit: "contain", borderRadius: 8 }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
