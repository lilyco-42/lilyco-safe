/**
 * Lilyco YSM Engine — Package Loader & AI-Friendly Exporter
 * Loads built-in showcase models, user .zip/.geo.json/.png uploads, or AI-generated geometry.
 * Exports standard YSM Spec 2 .zip packages and Blender headless multi-view render scripts.
 */

import JSZip from 'jszip';
import type {
  BedrockAnimation,
  BedrockAnimationFile,
  BedrockGeoFile,
  BedrockGeometryEntry,
  YsmBlenderRender,
  YsmManifest,
  YsmPackage,
  YsmTextureVariant,
} from './types';

function extractGeometryEntry(raw: BedrockGeoFile): BedrockGeometryEntry {
  if (Array.isArray(raw['minecraft:geometry']) && raw['minecraft:geometry'].length > 0) {
    return raw['minecraft:geometry'][0];
  }
  // Legacy 1.8.0 / 1.10.0 Bedrock geometry fallback: { "geometry.xxx": { texturewidth, textureheight, bones } }
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('geometry.') && v && typeof v === 'object') {
      const legacy = v as {
        texturewidth?: number;
        textureheight?: number;
        bones?: BedrockGeometryEntry['bones'];
      };
      return {
        description: {
          identifier: k,
          texture_width: legacy.texturewidth || 64,
          texture_height: legacy.textureheight || 64,
        },
        bones: legacy.bones || [],
      };
    }
  }
  throw new Error('未识别的 Bedrock 几何格式（缺少 minecraft:geometry 或 geometry.* 节点）');
}

export async function loadBuiltinShowcaseDemo(): Promise<YsmPackage> {
  const base = `${import.meta.env.BASE_URL}ysm-demo/skull_hoodie_girl`;
  const [manifestRes, geoRes, animRes] = await Promise.all([
    fetch(`${base}/ysm.json`),
    fetch(`${base}/models/main.json`),
    fetch(`${base}/animations/main.animation.json`),
  ]);

  if (!geoRes.ok) {
    return loadBuiltinLycoDemo();
  }

  const manifest: YsmManifest = manifestRes.ok ? await manifestRes.json() : {};
  const rawGeoText = await geoRes.text();
  const rawAnimText = animRes.ok ? await animRes.text() : '{}';

  const geoFile: BedrockGeoFile = JSON.parse(rawGeoText);
  const animFile: Partial<BedrockAnimationFile> = animRes.ok ? JSON.parse(rawAnimText) : {};

  return {
    id: 'builtin-skull-hoodie-girl',
    name: manifest.metadata?.name || 'Skull Hoodie Girl (YSM AI Engine 官方案例)',
    subtitle: 'MIT 开源高精示范 · 28 骨骼 · 169  sculpted cubes · 完整 SSAO 三视图与动作集',
    authors: (manifest.metadata?.authors || [{ name: 'ysm-ai-engine' }]).map((a) => a.name),
    spec: manifest.spec || 2,
    heightScale: manifest.properties?.height_scale || 0.94,
    geometry: extractGeometryEntry(geoFile),
    animations: animFile.animations || {},
    textures: [
      {
        id: 'default',
        label: 'default.png (512px)',
        url: `${base}/textures/default.png`,
      },
    ],
    blenderRenders: [
      { id: 'turnaround', label: 'SSAO 三视图对照', url: `${base}/renders/turnaround.png`, source: 'engine' },
      { id: 'head_overlay', label: '50/50 叠图校验', url: `${base}/renders/head_overlay.png`, source: 'engine' },
      { id: 'poses', label: '动作姿态实拍', url: `${base}/renders/poses.png`, source: 'engine' },
      { id: 'clay', label: '纯白模 SSAO 自检', url: `${base}/renders/clay.png`, source: 'engine' },
    ],
    rawGeoJson: rawGeoText,
    rawAnimJson: rawAnimText,
  };
}

export async function loadBuiltinLycoDemo(): Promise<YsmPackage> {
  const base = `${import.meta.env.BASE_URL}ysm-demo/lyco_ip`;
  const [manifestRes, geoRes, animRes] = await Promise.all([
    fetch(`${base}/ysm.json`),
    fetch(`${base}/models/main.json`),
    fetch(`${base}/animations/main.animation.json`),
  ]);

  if (!geoRes.ok) {
    throw new Error(`加载内置示范模型失败 (HTTP ${geoRes.status})`);
  }

  const manifest: YsmManifest = manifestRes.ok ? await manifestRes.json() : {};
  const rawGeoText = await geoRes.text();
  const rawAnimText = animRes.ok ? await animRes.text() : '{}';

  const geoFile: BedrockGeoFile = JSON.parse(rawGeoText);
  const animFile: Partial<BedrockAnimationFile> = animRes.ok ? JSON.parse(rawAnimText) : {};

  return {
    id: 'builtin-lyco-ip',
    name: manifest.metadata?.name || 'lyco_ip (莉可)',
    subtitle: manifest.metadata?.tips || 'LYCO (莉可) — 静态的秩序，动态的锋芒',
    authors: (manifest.metadata?.authors || []).map((a) => a.name),
    spec: manifest.spec || 2,
    heightScale: manifest.properties?.height_scale || 0.72,
    geometry: extractGeometryEntry(geoFile),
    animations: animFile.animations || {},
    textures: [
      {
        id: 'default',
        label: 'default.png (1024px)',
        url: `${base}/textures/default.png`,
      },
    ],
    blenderRenders: [
      { id: 'turnaround', label: '原设三视图对照', url: `${base}/renders/turnaround.png`, source: 'engine' },
      { id: 'poses', label: '动作姿态集', url: `${base}/renders/poses.png`, source: 'engine' },
      { id: 'closeups', label: '面部/细节特写', url: `${base}/renders/closeups.png`, source: 'engine' },
      { id: 'clay', label: '白模布线审查', url: `${base}/renders/clay.png`, source: 'engine' },
      { id: 'skeleton', label: '骨骼权重绑定', url: `${base}/renders/skeleton.png`, source: 'engine' },
    ],
    rawGeoJson: rawGeoText,
    rawAnimJson: rawAnimText,
  };
}

export async function loadYsmFromZipFile(file: File): Promise<YsmPackage> {
  const buf = await file.arrayBuffer();
  const header = new Uint8Array(buf.slice(0, 4));
  // Check PK zip magic bytes (0x50 0x4B)
  if (header[0] !== 0x50 || header[1] !== 0x4b) {
    throw new Error(
      '检测到加密二进制 .ysm 格式。请先使用 OpenYSM / YSMParser (MIT) 解包为标准 .zip 目录包后再拖入预览。',
    );
  }

  const zip = await JSZip.loadAsync(buf);
  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);

  // Locate ysm.json
  const manifestPath = paths.find((p) => /(^|\/)ysm\.json$/i.test(p));
  let manifest: YsmManifest = {};
  if (manifestPath) {
    try {
      manifest = JSON.parse(await zip.files[manifestPath].async('string')) as YsmManifest;
    } catch {
      throw new Error(`压缩包中的清单文件 ${manifestPath} 不是有效的 JSON`);
    }
  }

  // Locate main geometry JSON
  const geoPath =
    paths.find((p) => /(^|\/)models\/main\.json$/i.test(p)) ||
    paths.find((p) => /(^|\/)main\.json$/i.test(p)) ||
    paths.find((p) => /\.geo\.json$/i.test(p)) ||
    paths.find((p) => /model.*\.json$/i.test(p) && !/arm/i.test(p));

  if (!geoPath) {
    throw new Error('压缩包中未找到主模型文件（models/main.json 或 *.geo.json）');
  }

  const rawGeoText = await zip.files[geoPath].async('string');
  let parsedGeo: BedrockGeoFile;
  try {
    parsedGeo = JSON.parse(rawGeoText) as BedrockGeoFile;
  } catch {
    throw new Error(`主模型文件 ${geoPath} JSON 解析失败`);
  }
  const geometry = extractGeometryEntry(parsedGeo);

  // Locate animations JSON
  const animPath =
    paths.find((p) => /(^|\/)animations\/main\.animation\.json$/i.test(p)) ||
    paths.find((p) => /main\.animation\.json$/i.test(p)) ||
    paths.find((p) => /\.animation\.json$/i.test(p) && !/arm/i.test(p));

  let animations: Record<string, BedrockAnimation> = {};
  let rawAnimText = '';
  if (animPath) {
    rawAnimText = await zip.files[animPath].async('string');
    try {
      const parsed: Partial<BedrockAnimationFile> = JSON.parse(rawAnimText);
      animations = parsed.animations || {};
    } catch {
      animations = {};
    }
  }

  // Locate engine-rendered turnaround image (renders/turnaround.png) if present in ZIP
  const turnaroundPath = paths.find((p) => /(^|\/)renders\/turnaround\.png$/i.test(p));
  const blenderRenders: YsmBlenderRender[] = [];
  if (turnaroundPath) {
    const renderBuf = await zip.files[turnaroundPath].async('arraybuffer');
    const renderBlob = new Blob([renderBuf], { type: 'image/png' });
    blenderRenders.push({
      id: 'turnaround',
      label: '引擎三视图',
      url: URL.createObjectURL(renderBlob),
      source: 'engine',
    });
  }

  // Locate all PNG textures (fallback to non-turnaround PNGs if none remain after filtering preview/icon/render)
  const filteredPngPaths = paths.filter((p) => /\.png$/i.test(p) && !/preview|icon|render/i.test(p));
  const pngPaths =
    filteredPngPaths.length > 0
      ? filteredPngPaths
      : paths.filter((p) => /\.png$/i.test(p) && p !== turnaroundPath);
  const textures: YsmTextureVariant[] = [];
  for (const p of pngPaths) {
    const texBuf = await zip.files[p].async('arraybuffer');
    const blob = new Blob([texBuf], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const label = p.split('/').pop() || p;
    textures.push({ id: p, label, url });
  }

  const defaultTex = manifest.properties?.default_texture?.replace(/^\.\//, '');
  if (defaultTex && textures.length > 1) {
    textures.sort((a, b) => {
      const aMatch = a.id === defaultTex || a.id.endsWith(`/${defaultTex}`) ? 0 : 1;
      const bMatch = b.id === defaultTex || b.id.endsWith(`/${defaultTex}`) ? 0 : 1;
      return aMatch - bMatch;
    });
  }

  const cleanName = manifest.metadata?.name || file.name.replace(/\.(zip|ysm)$/i, '');
  return {
    id: `zip-${Date.now()}`,
    name: cleanName,
    subtitle: manifest.metadata?.tips || `来自 YSM 压缩包 · ${file.name}`,
    authors: (manifest.metadata?.authors || []).map((a) => a.name),
    spec: manifest.spec || 2,
    heightScale: manifest.properties?.height_scale || 0.75,
    geometry,
    animations,
    textures,
    ...(blenderRenders.length > 0 ? { blenderRenders } : {}),
    rawGeoJson: rawGeoText,
    rawAnimJson: rawAnimText,
  };
}

export function createPackageFromGeoJson(
  geoText: string,
  name = 'AI-Generated YSM',
  textureUrl?: string,
): YsmPackage {
  const parsed: BedrockGeoFile = JSON.parse(geoText);
  const geometry = extractGeometryEntry(parsed);
  // Provide clean default idle/walk procedural animations so AI-generated models immediately animate!
  const defaultAnimations: Record<string, BedrockAnimation> = {
    idle: {
      loop: true,
      animation_length: 3.0,
      bones: {
        Body: { rotation: ['math.sin(q.anim_time * 120) * 1.2', 0, 0] },
        Head: { rotation: ['math.sin(q.anim_time * 120 - 30) * 1.5', 'math.cos(q.anim_time * 60) * 2.5', 0] },
        RightArm: { rotation: ['math.sin(q.anim_time * 120) * 2.5', 0, 3] },
        LeftArm: { rotation: ['-math.sin(q.anim_time * 120) * 2.5', 0, -3] },
      },
    },
    walk: {
      loop: true,
      animation_length: 1.0,
      bones: {
        RightLeg: { rotation: ['math.sin(q.anim_time * 360) * 28', 0, 0] },
        LeftLeg: { rotation: ['-math.sin(q.anim_time * 360) * 28', 0, 0] },
        RightArm: { rotation: ['-math.sin(q.anim_time * 360) * 24', 0, 3] },
        LeftArm: { rotation: ['math.sin(q.anim_time * 360) * 24', 0, -3] },
        Body: { position: [0, 'math.abs(math.cos(q.anim_time * 360)) * 0.4', 0] },
      },
    },
    run: {
      loop: true,
      animation_length: 0.65,
      bones: {
        Body: { rotation: [8, 0, 0], position: [0, 'math.abs(math.cos(q.anim_time * 554)) * 0.7', 0] },
        RightLeg: { rotation: ['math.sin(q.anim_time * 554) * 45', 0, 0] },
        LeftLeg: { rotation: ['-math.sin(q.anim_time * 554) * 45', 0, 0] },
        RightArm: { rotation: ['-math.sin(q.anim_time * 554) * 42', 0, 6] },
        LeftArm: { rotation: ['math.sin(q.anim_time * 554) * 42', 0, -6] },
      },
    },
  };

  return {
    id: `ai-${Date.now()}`,
    name,
    subtitle: 'AI 生成的 Bedrock 1.12.0 YSM 模型 · 已自动绑定基础呼吸/行走/奔跑骨骼动画',
    authors: ['Lilyco AI Studio'],
    spec: 2,
    heightScale: 0.85,
    geometry,
    animations: defaultAnimations,
    textures: textureUrl ? [{ id: 'ai-tex', label: 'AI Texture', url: textureUrl }] : [],
    rawGeoJson: geoText,
    rawAnimJson: JSON.stringify({ format_version: '1.8.0', animations: defaultAnimations }, null, 2),
  };
}

export async function exportYsmSpec2Zip(pkg: YsmPackage): Promise<Blob> {
  const zip = new JSZip();
  const safeId = pkg.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_') || 'lilyco_ysm';

  const manifest: YsmManifest = {
    spec: 2,
    metadata: {
      name: safeId,
      tips: pkg.subtitle,
      authors: (pkg.authors.length ? pkg.authors : ['Lilyco AI Studio']).map((name) => ({
        name,
        role: 'Creator',
      })),
      license: { type: 'MIT' },
    },
    properties: {
      height_scale: pkg.heightScale,
      width_scale: pkg.heightScale,
      default_texture: 'textures/default.png',
    },
  };

  zip.file('ysm.json', JSON.stringify(manifest, null, 2));
  zip.file(
    'models/main.json',
    pkg.rawGeoJson ||
      JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [pkg.geometry] }, null, 2),
  );
  zip.file(
    'animations/main.animation.json',
    pkg.rawAnimJson || JSON.stringify({ format_version: '1.8.0', animations: pkg.animations }, null, 2),
  );

  if (pkg.textures[0]?.url) {
    try {
      const res = await fetch(pkg.textures[0].url);
      if (res.ok) {
        zip.file('textures/default.png', await res.blob());
      }
    } catch {
      // Ignore texture fetch failure on export
    }
  }

  return zip.generateAsync({ type: 'blob' });
}

export function generateBlenderPreviewScript(pkgName: string): string {
  return `# Lilyco YSM -> Blender 4.x Headless Multi-View Turntable Renderer (MIT)
# Usage: blender -b -P render_ysm_preview.py -- models/main.json textures/default.png out_turnaround.png
import bpy, json, math, sys

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["models/main.json", "textures/default.png", "turnaround.png"]
geo_path, tex_path, out_path = argv[0], argv[1], argv[2]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in dir(bpy.types) else 'CYCLES'
scene.render.resolution_x, scene.render.resolution_y = 1280, 720

with open(geo_path, "r", encoding="utf-8") as f:
    geo = json.load(f)["minecraft:geometry"][0]

mat = bpy.data.materials.new(name="${pkgName}_Mat")
mat.use_nodes = True
nodes = mat.node_tree.nodes
bsdf = nodes.get("Principled BSDF")
tex = nodes.new("ShaderNodeTexImage")
tex.interpolation = 'Closest'
try:
    tex.image = bpy.data.images.load(tex_path)
    mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
except Exception as e:
    print("Texture fallback:", e)

SCALE = 1.0 / 16.0
for bone in geo.get("bones", []):
    for idx, cube in enumerate(bone.get("cubes", [])):
        ox, oy, oz = cube["origin"]
        sx, sy, sz = cube["size"]
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=((ox + sx/2)*SCALE, -(oz + sz/2)*SCALE, (oy + sy/2)*SCALE))
        obj = bpy.context.active_object
        obj.name = f"{bone['name']}_{idx}"
        obj.scale = (sx*SCALE, sz*SCALE, sy*SCALE)
        obj.data.materials.append(mat)

# Three-point studio lighting + camera
bpy.ops.object.light_add(type='AREA', location=(2.2, -2.5, 2.8))
bpy.context.active_object.data.energy = 160
bpy.ops.object.camera_add(location=(0.0, -3.2, 1.15), rotation=(math.radians(82), 0, 0))
scene.camera = bpy.context.active_object
scene.render.filepath = out_path
bpy.ops.render.render(write_still=True)
print("Rendered Blender preview ->", out_path)
`;
}
