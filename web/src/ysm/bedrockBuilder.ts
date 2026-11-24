/**
 * Lilyco YSM Engine — Pure Three.js (MIT) Bedrock 1.12.0 Geometry & Rig Builder
 * Supports nested bone hierarchies, per-face & box UV mapping, inflate, mirror,
 * pixel-crisp NearestFilter textures, wireframe, and skeleton visualization.
 */

import * as THREE from 'three';
import type {
  BedrockBone,
  BedrockCube,
  BedrockFaceUV,
  BedrockGeometryEntry,
  BedrockPerFaceUV,
  YsmModelStats,
} from './types';

const SCALE = 1 / 16;
const DEG2RAD = Math.PI / 180;

export interface BuiltBone {
  name: string;
  group: THREE.Group;
  bindPivot: [number, number, number];
  bindRotation: [number, number, number];
}

export interface BuiltYsmRig {
  root: THREE.Group;
  bones: Map<string, BuiltBone>;
  materials: THREE.MeshStandardMaterial[];
  skeletonGroup: THREE.Group;
  stats: YsmModelStats;
  dispose: () => void;
}

function setFaceUV(
  uvAttr: THREE.BufferAttribute,
  faceIndex: number,
  u: number,
  v: number,
  uw: number,
  vh: number,
  texW: number,
  texH: number,
  flipU = false,
) {
  const u0 = (flipU ? u + uw : u) / texW;
  const u1 = (flipU ? u : u + uw) / texW;
  // Flip V because Three.js texture origin is bottom-left while Bedrock UV origin is top-left
  const vTop = 1 - v / texH;
  const vBot = 1 - (v + vh) / texH;

  // BoxGeometry face vertex order: 0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right
  const base = faceIndex * 4;
  uvAttr.setXY(base + 0, u0, vTop);
  uvAttr.setXY(base + 1, u1, vTop);
  uvAttr.setXY(base + 2, u0, vBot);
  uvAttr.setXY(base + 3, u1, vBot);
}

function applyPerFaceUV(
  geo: THREE.BoxGeometry,
  uvMap: BedrockPerFaceUV,
  texW: number,
  texH: number,
) {
  const uvAttr = geo.attributes.uv as THREE.BufferAttribute;
  // Three.js BoxGeometry face order: 0:+X(east), 1:-X(west), 2:+Y(up), 3:-Y(down), 4:+Z(south), 5:-Z(north)
  const mapping: Array<[number, BedrockFaceUV | undefined, boolean]> = [
    [0, uvMap.west, false],
    [1, uvMap.east, false],
    [2, uvMap.up, false],
    [3, uvMap.down, false],
    [4, uvMap.south, false],
    [5, uvMap.north, false],
  ];

  for (const [faceIdx, face, flipU] of mapping) {
    if (!face || !face.uv || !face.uv_size) {
      setFaceUV(uvAttr, faceIdx, 0, 0, 0, 0, texW, texH);
      continue;
    }
    const [u, v] = face.uv;
    const [uw, vh] = face.uv_size;
    setFaceUV(uvAttr, faceIdx, u, v, uw, vh, texW, texH, flipU);
  }
  uvAttr.needsUpdate = true;
}

function applyBoxUV(
  geo: THREE.BoxGeometry,
  uv: [number, number],
  size: [number, number, number],
  texW: number,
  texH: number,
  mirror: boolean,
) {
  const uvAttr = geo.attributes.uv as THREE.BufferAttribute;
  const [u, v] = uv;
  const w = Math.floor(size[0]);
  const h = Math.floor(size[1]);
  const d = Math.floor(size[2]);

  // Standard Minecraft box UV layout
  const eastFace: [number, number, number, number] = [u, v + d, d, h];
  const northFace: [number, number, number, number] = [u + d, v + d, w, h];
  const westFace: [number, number, number, number] = [u + d + w, v + d, d, h];
  const southFace: [number, number, number, number] = [u + d + w + d, v + d, w, h];
  const upFace: [number, number, number, number] = [u + d, v, w, d];
  const downFace: [number, number, number, number] = [u + d + w, v + d, w, -d];

  const f0 = mirror ? eastFace : westFace;
  const f1 = mirror ? westFace : eastFace;

  setFaceUV(uvAttr, 0, f0[0], f0[1], f0[2], f0[3], texW, texH, mirror);
  setFaceUV(uvAttr, 1, f1[0], f1[1], f1[2], f1[3], texW, texH, mirror);
  setFaceUV(uvAttr, 2, upFace[0], upFace[1], upFace[2], upFace[3], texW, texH, mirror);
  setFaceUV(uvAttr, 3, downFace[0], downFace[1], downFace[2], downFace[3], texW, texH, mirror);
  setFaceUV(uvAttr, 4, southFace[0], southFace[1], southFace[2], southFace[3], texW, texH, mirror);
  setFaceUV(uvAttr, 5, northFace[0], northFace[1], northFace[2], northFace[3], texW, texH, mirror);
  uvAttr.needsUpdate = true;
}

function buildCubeMesh(
  cube: BedrockCube,
  bonePivot: [number, number, number],
  boneMirror: boolean,
  texW: number,
  texH: number,
  material: THREE.MeshStandardMaterial,
): THREE.Object3D {
  const inf = cube.inflate ?? 0;
  const sx = Math.max(0.001, cube.size[0] + inf * 2);
  const sy = Math.max(0.001, cube.size[1] + inf * 2);
  const sz = Math.max(0.001, cube.size[2] + inf * 2);

  const geo = new THREE.BoxGeometry(sx * SCALE, sy * SCALE, sz * SCALE);

  if (Array.isArray(cube.uv)) {
    applyBoxUV(geo, cube.uv, cube.size, texW, texH, cube.mirror ?? boneMirror);
  } else if (cube.uv && typeof cube.uv === 'object') {
    applyPerFaceUV(geo, cube.uv, texW, texH);
  }

  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Cube center in model space
  const cx = cube.origin[0] + cube.size[0] / 2;
  const cy = cube.origin[1] + cube.size[1] / 2;
  const cz = cube.origin[2] + cube.size[2] / 2;

  if (cube.rotation && (cube.rotation[0] !== 0 || cube.rotation[1] !== 0 || cube.rotation[2] !== 0)) {
    const cp = cube.pivot ?? [cx, cy, cz];
    const holder = new THREE.Group();
    holder.position.set(
      (cp[0] - bonePivot[0]) * SCALE,
      (cp[1] - bonePivot[1]) * SCALE,
      (cp[2] - bonePivot[2]) * SCALE,
    );
    holder.rotation.order = 'ZYX';
    holder.rotation.set(
      -cube.rotation[0] * DEG2RAD,
      -cube.rotation[1] * DEG2RAD,
      cube.rotation[2] * DEG2RAD,
    );
    mesh.position.set((cx - cp[0]) * SCALE, (cy - cp[1]) * SCALE, (cz - cp[2]) * SCALE);
    holder.add(mesh);
    return holder;
  }

  mesh.position.set(
    (cx - bonePivot[0]) * SCALE,
    (cy - bonePivot[1]) * SCALE,
    (cz - bonePivot[2]) * SCALE,
  );
  return mesh;
}

export function buildBedrockRig(
  geometry: BedrockGeometryEntry,
  texture: THREE.Texture | null,
  heightScale = 1,
): BuiltYsmRig {
  const texW = geometry.description?.texture_width || 64;
  const texH = geometry.description?.texture_height || 64;

  const material = new THREE.MeshStandardMaterial({
    map: texture ?? undefined,
    color: texture ? 0xffffff : 0xdbeafe,
    roughness: 0.78,
    metalness: 0.04,
    alphaTest: 0.12,
    side: THREE.DoubleSide,
    transparent: false,
  });

  const root = new THREE.Group();
  // Rotate 180 deg around Y so Bedrock North (-Z) faces the Three.js camera (+Z)
  root.rotation.y = Math.PI;
  root.scale.setScalar(heightScale);

  const boneDefs = geometry.bones || [];
  const boneMap = new Map<string, BuiltBone>();
  const rawByName = new Map<string, BedrockBone>();
  let cubeCount = 0;

  // Pass 1: create groups
  for (const b of boneDefs) {
    rawByName.set(b.name, b);
    const group = new THREE.Group();
    group.name = b.name;
    group.rotation.order = 'ZYX';
    const pivot: [number, number, number] = b.pivot ? [b.pivot[0], b.pivot[1], b.pivot[2]] : [0, 0, 0];
    const rot: [number, number, number] = b.rotation ? [b.rotation[0], b.rotation[1], b.rotation[2]] : [0, 0, 0];

    group.rotation.set(-rot[0] * DEG2RAD, -rot[1] * DEG2RAD, rot[2] * DEG2RAD);

    for (const cube of b.cubes || []) {
      const obj = buildCubeMesh(cube, pivot, Boolean(b.mirror), texW, texH, material);
      group.add(obj);
      cubeCount++;
    }

    boneMap.set(b.name, { name: b.name, group, bindPivot: pivot, bindRotation: rot });
  }

  // Pass 2: link parent-child hierarchy & relative pivots
  const skeletonGroup = new THREE.Group();
  skeletonGroup.visible = false;
  const jointGeo = new THREE.SphereGeometry(0.022, 8, 8);
  const jointMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, depthTest: false });
  const lineMat = new THREE.LineBasicMaterial({ color: 0x818cf8, depthTest: false });

  for (const b of boneDefs) {
    const built = boneMap.get(b.name)!;
    const parentBuilt = b.parent ? boneMap.get(b.parent) : undefined;
    if (parentBuilt) {
      built.group.position.set(
        (built.bindPivot[0] - parentBuilt.bindPivot[0]) * SCALE,
        (built.bindPivot[1] - parentBuilt.bindPivot[1]) * SCALE,
        (built.bindPivot[2] - parentBuilt.bindPivot[2]) * SCALE,
      );
      parentBuilt.group.add(built.group);

      // Bone line in skeleton overlay
      const pts = [
        new THREE.Vector3(parentBuilt.bindPivot[0] * SCALE, parentBuilt.bindPivot[1] * SCALE, parentBuilt.bindPivot[2] * SCALE),
        new THREE.Vector3(built.bindPivot[0] * SCALE, built.bindPivot[1] * SCALE, built.bindPivot[2] * SCALE),
      ];
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
      skeletonGroup.add(new THREE.Line(lineGeo, lineMat));
    } else {
      built.group.position.set(
        built.bindPivot[0] * SCALE,
        built.bindPivot[1] * SCALE,
        built.bindPivot[2] * SCALE,
      );
      root.add(built.group);
    }

    const joint = new THREE.Mesh(jointGeo, jointMat);
    joint.position.set(
      built.bindPivot[0] * SCALE,
      built.bindPivot[1] * SCALE,
      built.bindPivot[2] * SCALE,
    );
    skeletonGroup.add(joint);
  }

  root.add(skeletonGroup);

  const dispose = () => {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry?.dispose();
      }
    });
    material.dispose();
    jointGeo.dispose();
    jointMat.dispose();
    lineMat.dispose();
  };

  return {
    root,
    bones: boneMap,
    materials: [material],
    skeletonGroup,
    stats: {
      boneCount: boneDefs.length,
      cubeCount,
      animationCount: 0,
      textureWidth: texW,
      textureHeight: texH,
    },
    dispose,
  };
}
