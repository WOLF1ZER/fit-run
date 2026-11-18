import type * as THREE from 'three';

/**
 * Visible muscle growth for the Mixamo-rigged player (public/assets/characters/player.glb).
 * k = 0 → Runner (as modelled), 0.35 → Athlete, 0.65 → Strong, 1 → Beast Mode.
 * Bones get thicker (local x/z) but keep their length (local y); children are counter-scaled
 * so hands, head and feet keep their size.
 */
export const GROWTH_STAGES = [
  { level: 1, k: 0, name: 'Runner' },
  { level: 5, k: 0.35, name: 'Athlete' },
  { level: 10, k: 0.65, name: 'Strong' },
] as const;
export const BEAST_K = 1;

export function growthForLevel(level: number) {
  // smooth growth between the named stages
  const s = GROWTH_STAGES;
  if (level <= s[0].level) return s[0].k;
  for (let i = 1; i < s.length; i++) {
    if (level <= s[i].level) {
      const t = (level - s[i - 1].level) / (s[i].level - s[i - 1].level);
      return s[i - 1].k + (s[i].k - s[i - 1].k) * t;
    }
  }
  return s[s.length - 1].k;
}

export function applyGrowth(root: THREE.Object3D, k: number) {
  const bone = (n: string) => root.getObjectByName('mixamorig' + n) ?? root.getObjectByName('mixamorig:' + n);
  const set = (n: string, x: number, y: number, z: number) => bone(n)?.scale.set(x, y, z);
  const chest = 1 + 0.32 * k, arm = 1 + 0.6 * k, fore = 1 + 0.35 * k, leg = 1 + 0.32 * k, calf = 1 + 0.2 * k;
  const s1x = 1 + 0.1 * k, s1z = 1 + 0.12 * k, neck = 1 + 0.2 * k, sh = 1 + 0.25 * k;
  set('Spine1', s1x, 1, s1z);
  set('Spine2', chest / s1x, 1 + 0.03 * k, chest / s1z);
  set('Neck', neck / chest, 1 / (1 + 0.03 * k), neck / chest);
  set('Head', 1 / neck, 1, 1 / neck);
  for (const side of ['Left', 'Right']) {
    set(side + 'Shoulder', sh / chest, 1, sh / chest);
    set(side + 'Arm', arm / sh, 1, arm / sh);
    set(side + 'ForeArm', fore / arm, 1, fore / arm);
    set(side + 'Hand', 1 / fore, 1, 1 / fore);
    set(side + 'UpLeg', leg, 1, leg);
    set(side + 'Leg', calf / leg, 1, calf / leg);
    set(side + 'Foot', 1 / calf, 1, 1 / calf);
  }
}
