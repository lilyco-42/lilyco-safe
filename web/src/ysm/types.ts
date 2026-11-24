/**
 * Lilyco YSM Engine — Strongly-Typed Bedrock 1.12.0 & YSM Spec 2 Contracts
 * MIT Licensed · Zero-Trust Schema Definitions
 */

export type Vec3 = [number, number, number];
export type MolangValue = number | string;
export type MolangVec3 = [MolangValue, MolangValue, MolangValue];

export interface BedrockFaceUV {
  uv: [number, number];
  uv_size: [number, number];
  uv_rotation?: number;
}

export interface BedrockPerFaceUV {
  north?: BedrockFaceUV;
  south?: BedrockFaceUV;
  east?: BedrockFaceUV;
  west?: BedrockFaceUV;
  up?: BedrockFaceUV;
  down?: BedrockFaceUV;
}

export interface BedrockCube {
  origin: Vec3;
  size: Vec3;
  uv?: [number, number] | BedrockPerFaceUV;
  inflate?: number;
  mirror?: boolean;
  pivot?: Vec3;
  rotation?: Vec3;
}

export interface BedrockBone {
  name: string;
  parent?: string;
  pivot?: Vec3;
  rotation?: Vec3;
  mirror?: boolean;
  cubes?: BedrockCube[];
}

export interface BedrockGeoDescription {
  identifier?: string;
  texture_width: number;
  texture_height: number;
  visible_bounds_width?: number;
  visible_bounds_height?: number;
  visible_bounds_offset?: Vec3;
}

export interface BedrockGeometryEntry {
  description: BedrockGeoDescription;
  bones: BedrockBone[];
}

export interface BedrockGeoFile {
  format_version?: string;
  'minecraft:geometry'?: BedrockGeometryEntry[];
  [legacyKey: string]: unknown;
}

export interface KeyframeObject {
  pre?: MolangVec3;
  post?: MolangVec3;
  lerp_mode?: 'linear' | 'catmullrom';
}

export type KeyframeMap = Record<string, MolangVec3 | KeyframeObject>;
export type AnimChannel = MolangVec3 | KeyframeMap | MolangValue;

export interface BoneAnimation {
  rotation?: AnimChannel;
  position?: AnimChannel;
  scale?: AnimChannel;
}

export interface BedrockAnimation {
  loop?: boolean | 'hold_on_last_frame';
  animation_length?: number;
  bones?: Record<string, BoneAnimation>;
}

export interface BedrockAnimationFile {
  format_version?: string;
  animations: Record<string, BedrockAnimation>;
}

export interface YsmManifest {
  spec?: number;
  metadata?: {
    name?: string;
    tips?: string;
    authors?: Array<{ name: string; role?: string }>;
    license?: { type?: string };
  };
  properties?: {
    height_scale?: number;
    width_scale?: number;
    default_texture?: string;
  };
}

export interface YsmTextureVariant {
  id: string;
  label: string;
  url: string;
}

export interface YsmBlenderRender {
  id: string;
  label: string;
  url: string;
  source?: 'blender' | 'engine';
}

export interface YsmPackage {
  id: string;
  name: string;
  subtitle: string;
  authors: string[];
  spec: number;
  heightScale: number;
  geometry: BedrockGeometryEntry;
  animations: Record<string, BedrockAnimation>;
  textures: YsmTextureVariant[];
  blenderRenders?: YsmBlenderRender[];
  rawGeoJson?: string;
  rawAnimJson?: string;
}

export interface YsmModelStats {
  boneCount: number;
  cubeCount: number;
  animationCount: number;
  textureWidth: number;
  textureHeight: number;
}
