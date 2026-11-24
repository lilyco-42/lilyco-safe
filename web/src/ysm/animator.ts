/**
 * Lilyco YSM Engine — Bedrock Animation Runtime
 * Evaluates keyframe maps, static vectors, and Molang expressions per bone channel.
 */

import type { BuiltYsmRig } from './bedrockBuilder';
import { evalMolang, type MolangContext } from './molang';
import type { AnimChannel, BedrockAnimation, KeyframeObject, MolangVec3, Vec3 } from './types';

const SCALE = 1 / 16;
const DEG2RAD = Math.PI / 180;

function evalVec3(v: MolangVec3 | number | string, ctx: MolangContext): Vec3 {
  if (Array.isArray(v)) {
    return [evalMolang(v[0], ctx), evalMolang(v[1], ctx), evalMolang(v[2], ctx)];
  }
  const scalar = evalMolang(v, ctx);
  return [scalar, scalar, scalar];
}

function extractKeyframeVec(entry: MolangVec3 | KeyframeObject, usePre: boolean, ctx: MolangContext): Vec3 {
  if (Array.isArray(entry)) {
    return evalVec3(entry, ctx);
  }
  const vec = usePre ? entry.pre ?? entry.post : entry.post ?? entry.pre;
  if (!vec) return [0, 0, 0];
  return evalVec3(vec, ctx);
}

function evalChannel(channel: AnimChannel | undefined, time: number, ctx: MolangContext, fallback: Vec3): Vec3 {
  if (channel === undefined || channel === null) return fallback;
  if (typeof channel === 'number' || typeof channel === 'string' || Array.isArray(channel)) {
    return evalVec3(channel, ctx);
  }
  // Keyframe map: { "0.0": [...], "0.25": [...] }
  const keys = Object.keys(channel)
    .map((k) => ({ raw: k, t: parseFloat(k) }))
    .filter((k) => Number.isFinite(k.t))
    .sort((a, b) => a.t - b.t);

  if (keys.length === 0) return fallback;
  if (time <= keys[0].t) {
    return extractKeyframeVec(channel[keys[0].raw], false, ctx);
  }
  const last = keys[keys.length - 1];
  if (time >= last.t) {
    return extractKeyframeVec(channel[last.raw], true, ctx);
  }

  // Find surrounding keyframes
  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (time >= k0.t && time <= k1.t) {
      const span = k1.t - k0.t;
      const alpha = span > 1e-6 ? (time - k0.t) / span : 0;
      const v0 = extractKeyframeVec(channel[k0.raw], false, ctx);
      const v1 = extractKeyframeVec(channel[k1.raw], true, ctx);
      return [
        v0[0] + (v1[0] - v0[0]) * alpha,
        v0[1] + (v1[1] - v0[1]) * alpha,
        v0[2] + (v1[2] - v0[2]) * alpha,
      ];
    }
  }
  return fallback;
}

export function resetRigPose(rig: BuiltYsmRig, parentMap: Map<string, string | undefined>) {
  for (const [name, bone] of rig.bones.entries()) {
    const parentName = parentMap.get(name);
    const parent = parentName ? rig.bones.get(parentName) : undefined;
    if (parent) {
      bone.group.position.set(
        (bone.bindPivot[0] - parent.bindPivot[0]) * SCALE,
        (bone.bindPivot[1] - parent.bindPivot[1]) * SCALE,
        (bone.bindPivot[2] - parent.bindPivot[2]) * SCALE,
      );
    } else {
      bone.group.position.set(
        bone.bindPivot[0] * SCALE,
        bone.bindPivot[1] * SCALE,
        bone.bindPivot[2] * SCALE,
      );
    }
    bone.group.rotation.set(
      -bone.bindRotation[0] * DEG2RAD,
      -bone.bindRotation[1] * DEG2RAD,
      bone.bindRotation[2] * DEG2RAD,
    );
    bone.group.scale.set(1, 1, 1);
  }
}

export function applyBedrockAnimation(
  rig: BuiltYsmRig,
  parentMap: Map<string, string | undefined>,
  animation: BedrockAnimation | undefined,
  elapsedSec: number,
) {
  resetRigPose(rig, parentMap);
  if (!animation || !animation.bones) return;

  const length = animation.animation_length && animation.animation_length > 0 ? animation.animation_length : 2.0;
  const loop = animation.loop !== false;
  const animTime = loop ? elapsedSec % length : Math.min(elapsedSec, length);

  const ctx: MolangContext = {
    animTime,
    lifeTime: elapsedSec,
    groundSpeed: 1.0,
    headXRot: 0,
    headYRot: 0,
  };

  for (const [boneName, boneAnim] of Object.entries(animation.bones)) {
    const built = rig.bones.get(boneName);
    if (!built) continue;

    if (boneAnim.rotation) {
      const rot = evalChannel(boneAnim.rotation, animTime, ctx, [0, 0, 0]);
      built.group.rotation.x += -rot[0] * DEG2RAD;
      built.group.rotation.y += -rot[1] * DEG2RAD;
      built.group.rotation.z += rot[2] * DEG2RAD;
    }

    if (boneAnim.position) {
      const pos = evalChannel(boneAnim.position, animTime, ctx, [0, 0, 0]);
      built.group.position.x += pos[0] * SCALE;
      built.group.position.y += pos[1] * SCALE;
      built.group.position.z += pos[2] * SCALE;
    }

    if (boneAnim.scale) {
      const scl = evalChannel(boneAnim.scale, animTime, ctx, [1, 1, 1]);
      built.group.scale.set(scl[0], scl[1], scl[2]);
    }
  }
}
