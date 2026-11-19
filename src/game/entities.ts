import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ASSET, canvasTex, labelTexture } from './materials';
import { buildCarParts, LANES } from './world';

export type ItemKind = 'shake' | 'water' | 'banana' | 'burger' | 'soda';
export type ObstacleKind = 'car' | 'barrier' | 'banner' | 'jogger';

export interface Item { kind: ItemKind; obj: THREE.Object3D; body: THREE.Object3D; lane: number; z: number; prevZ: number; y: number; active: boolean; spin: number }
export interface Obstacle {
  kind: ObstacleKind; obj: THREE.Object3D; lane: number; z: number; prevZ: number; len: number; halfW: number; active: boolean; hit: boolean; passed: boolean;
  mixer?: THREE.AnimationMixer; vz: number; fly?: THREE.Vector3; spinFly?: number;
}

const P = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
const CAP = 48; // max instances per variant on screen at once

// Shared vertex-coloured materials: every plain-coloured part of every pickup/obstacle uses one of these,
// so whole objects collapse into very few draw calls.
const vcMatte = P({ vertexColors: true, roughness: 0.55, metalness: 0 });
const vcMetal = P({ vertexColors: true, roughness: 0.3, metalness: 0.6 });
const vcGlow = new THREE.MeshBasicMaterial({ vertexColors: true });

type Part = { geo: THREE.BufferGeometry; mat: THREE.Material };

/** Bakes a hand-built group into one geometry per material (in group space); plain colours become vertex colours. */
function bakeParts(root: THREE.Object3D, keep: Set<THREE.Material> = new Set()): Part[] {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const by = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    let geo = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    geo = geo.index ? geo.toNonIndexed() : geo;
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    let mat: THREE.Material = src;
    const plain = !keep.has(src) && !src.map && !src.transparent && (src as any).isMeshStandardMaterial;
    if (plain) {
      const glow = src.emissive && src.emissiveIntensity > 0.5 && src.emissive.getHex() !== 0;
      mat = glow ? vcGlow : src.metalness >= 0.5 ? vcMetal : vcMatte;
      const c = (glow ? src.emissive : src.color).clone(), n = geo.attributes.position.count, col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    if (!by.has(mat)) by.set(mat, []);
    by.get(mat)!.push(geo);
  });
  return [...by].map(([mat, geos]) => {
    // vertex-coloured and plain geometries can't be merged: give the plain ones white colours if mixed
    const hasColor = geos.some((g) => g.attributes.color);
    if (hasColor) for (const g of geos) if (!g.attributes.color) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
    return { mat, geo: mergeGeometries(geos) };
  });
}

/** One InstancedMesh per material for a prototype; instance matrices are rewritten from handle objects every frame. */
class Variant {
  meshes: THREE.InstancedMesh[] = [];
  src: { obj: THREE.Object3D; color?: THREE.Color }[] = [];
  constructor(parent: THREE.Object3D, parts: Part[], shadow: boolean, private local?: THREE.Matrix4) {
    for (const { geo, mat } of parts) {
      const im = new THREE.InstancedMesh(geo, mat, CAP);
      im.count = 0;
      im.frustumCulled = false; // instances move every frame; the per-geometry bound would be wrong
      im.castShadow = shadow;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      parent.add(im);
      this.meshes.push(im);
    }
  }
  add(obj: THREE.Object3D, color?: THREE.Color) { this.src.push({ obj, color }); }
  remove(obj: THREE.Object3D) { const i = this.src.findIndex((s) => s.obj === obj); if (i >= 0) this.src.splice(i, 1); }
  private m = new THREE.Matrix4();
  sync() {
    const n = Math.min(CAP, this.src.length);
    for (const im of this.meshes) {
      for (let i = 0; i < n; i++) {
        const s = this.src[i];
        this.m.copy(s.obj.matrixWorld);
        if (this.local) this.m.multiply(this.local);
        im.setMatrixAt(i, this.m);
        if (s.color) im.setColorAt(i, s.color);
      }
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }
}

/** Re-textures a jogger onto one texture sheet so it draws in 2 calls (opaque + alpha-masked) instead of ~17. */
/** Copies just the vertices a primitive actually uses (glTF parts often share one big vertex buffer). */
function compact(src: THREE.BufferGeometry) {
  const keep = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight'];
  const idx = src.index!.array, remap = new Map<number, number>(), order: number[] = [];
  const newIdx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    let n = remap.get(idx[i]);
    if (n === undefined) { n = order.length; remap.set(idx[i], n); order.push(idx[i]); }
    newIdx[i] = n;
  }
  const g = new THREE.BufferGeometry();
  for (const k of keep) {
    const a = src.attributes[k] as THREE.BufferAttribute | undefined;
    if (!a) continue;
    const T = (a.array as any).constructor;
    const na = new THREE.BufferAttribute(new T(order.length * a.itemSize), a.itemSize, a.normalized);
    // get/setComponent both (de)normalize, so packed skin weights survive the copy exactly
    for (let i = 0; i < order.length; i++) for (let c = 0; c < a.itemSize; c++) na.setComponent(i, c, a.getComponent(order[i], c));
    g.setAttribute(k, na);
  }
  g.setIndex(new THREE.BufferAttribute(newIdx, 1));
  return g;
}

export function atlasJogger(scene: THREE.Object3D) {
  const parts: THREE.SkinnedMesh[] = [];
  const drop: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (!(o as THREE.SkinnedMesh).isSkinnedMesh) return;
    // the semi-transparent skin-detail overlay can't be merged cleanly and isn't visible at jogger size
    if (((o as THREE.Mesh).material as THREE.Material).name === 'Skin details') drop.push(o);
    else parts.push(o as THREE.SkinnedMesh);
  });
  drop.forEach((o) => o.parent?.remove(o));
  if (parts.length < 2) return;
  const G = Math.ceil(Math.sqrt(parts.length)), C = 256, S = G * C;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const opaque: THREE.BufferGeometry[] = [], masked: THREE.BufferGeometry[] = [];
  parts.forEach((m, i) => {
    const mat = m.material as THREE.MeshStandardMaterial, cx = i % G, cy = Math.floor(i / G);
    const geo = compact(m.geometry); // only this part's own vertices (all parts share one vertex buffer)
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    let inRange = !!mat.map && !!uv;
    if (inRange) for (let k = 0; k < uv.count; k++) { const u = uv.getX(k), v = uv.getY(k); if (u < -0.01 || u > 1.01 || v < -0.01 || v > 1.01) { inRange = false; break; } }
    const img = mat.map?.image as CanvasImageSource | undefined;
    // compose the cell on its own canvas: texture (or its average colour) × material colour, alpha kept
    const cell = document.createElement('canvas'); cell.width = cell.height = C;
    const cg = cell.getContext('2d')!;
    const pad = 0.04, ip = pad * C, is = C * (1 - 2 * pad); // texture goes into the inner area the UVs point to
    if (inRange && img) { cg.drawImage(img, 0, 0, C, C); cg.drawImage(img, ip, ip, is, is); } // full-cell copy first = margin colour
    else if (img) { // tiled pattern (fabric, soles): its average colour is all that shows at this size
      const t = document.createElement('canvas'); t.width = t.height = 1;
      t.getContext('2d')!.drawImage(img, 0, 0, 1, 1);
      cg.drawImage(t, 0, 0, C, C);
    } else { cg.fillStyle = '#ffffff'; cg.fillRect(0, 0, C, C); }
    cg.globalCompositeOperation = 'multiply';
    cg.fillStyle = '#' + mat.color.getHexString(); cg.fillRect(0, 0, C, C);
    if (inRange && img) { cg.globalCompositeOperation = 'destination-in'; cg.drawImage(img, ip, ip, is, is); } // restore the alpha (hair, lashes)
    g.drawImage(cell, cx * C, cy * C);
    if (uv) for (let k = 0; k < uv.count; k++) {
      const u = inRange ? THREE.MathUtils.clamp(uv.getX(k), 0, 1) : 0.5, v = inRange ? THREE.MathUtils.clamp(uv.getY(k), 0, 1) : 0.5;
      uv.setXY(k, (cx + pad + u * (1 - 2 * pad)) / G, (cy + pad + v * (1 - 2 * pad)) / G);
    }
    (mat.transparent || mat.alphaTest > 0 ? masked : opaque).push(geo);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const first = parts[0], parent = first.parent!;
  const make = (geos: THREE.BufferGeometry[], m: THREE.Material) => {
    if (!geos.length) return;
    const sm = new THREE.SkinnedMesh(mergeGeometries(geos), m);
    sm.position.copy(first.position); sm.quaternion.copy(first.quaternion); sm.scale.copy(first.scale);
    sm.bind(first.skeleton, first.bindMatrix);
    parent.add(sm);
  };
  make(opaque, P({ map: tex, roughness: 0.75 }));
  make(masked, P({ map: tex, roughness: 0.8, alphaTest: 0.5, side: THREE.DoubleSide }));
  for (const m of parts) m.parent?.remove(m);
}

const INSTANCED: (ItemKind | ObstacleKind)[] = ['shake', 'water', 'banana', 'burger', 'soda', 'car', 'barrier', 'banner'];

export class Entities {
  group = new THREE.Group();
  items: Item[] = [];
  obstacles: Obstacle[] = [];
  private variants = new Map<string, Variant>();
  private halo!: Variant;
  private haloColor: Record<ItemKind, THREE.Color> = {} as any;
  private shakeIdx = 0;
  private carIdx = 0;
  private carColors: THREE.Color[] = [];
  private joggers: GLTF[] = [];
  private jogIdx = 0;

  async init(worldMats: Record<string, any>) {
    const V = (key: string, root: THREE.Object3D, shadow: boolean, keep?: Set<THREE.Material>) =>
      this.variants.set(key, new Variant(this.group, bakeParts(root, keep), shadow));

    // ---- pickups (no shadows)
    const flav = ['#6b3e26', '#e9c9a8', '#c47aa8'], caps = ['#e53935', '#1e5bd8', '#7b2cbf'];
    const shell = P({ color: '#ffffff', transparent: true, opacity: 0.35, roughness: 0.15, depthWrite: false, side: THREE.DoubleSide });
    for (let k = 0; k < 3; k++) {
      const gr = new THREE.Group();
      gr.add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.15, 0.5, 20, 1, true), shell));
      const liq = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.14, 0.36, 20), P({ color: flav[k], roughness: 0.35 })); liq.position.y = -0.06; gr.add(liq);
      const lab = new THREE.Mesh(new THREE.CylinderGeometry(0.172, 0.162, 0.16, 20, 1, true), P({ map: labelTexture(caps[k], 'WHEY'), roughness: 0.5 })); lab.position.y = -0.02; gr.add(lab);
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 20), P({ color: caps[k], roughness: 0.3 })); lid.position.y = 0.3; gr.add(lid);
      gr.scale.setScalar(1.25);
      const w = new THREE.Group(); w.add(gr); V('shake' + k, w, false);
    }
    {
      const waterMat = P({ color: '#cfeeff', transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.1 });
      const gr = new THREE.Group();
      gr.add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.42, 18), waterMat));
      const n = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.11, 0.1, 18), waterMat); n.position.y = 0.26; gr.add(n);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.06, 12), P({ color: '#1e7bff', roughness: 0.3 })); c.position.y = 0.34; gr.add(c);
      gr.add(new THREE.Mesh(new THREE.CylinderGeometry(0.112, 0.112, 0.12, 18, 1, true), P({ color: '#2a8cff', roughness: 0.5 })));
      gr.scale.setScalar(1.4);
      const w = new THREE.Group(); w.add(gr); V('water', w, false);
    }
    {
      const bananas = (await new GLTFLoader().loadAsync(`${ASSET}/models/bananas/bananas.gltf`)).scene;
      bananas.scale.setScalar(2.4); bananas.position.y = -0.15;
      const w = new THREE.Group(); w.add(bananas); V('banana', w, false);
    }
    {
      const gr = new THREE.Group();
      for (const [r, h, c, y] of [[0.24, 0.08, '#c98a3a', 0], [0.25, 0.05, '#4a2a18', 0.08], [0.26, 0.02, '#f2c12e', 0.12], [0.25, 0.03, '#5aa02a', 0.15], [0.24, 0.16, '#d6913f', 0.24]] as const) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * (y > 0.2 ? 1 : 0.98), h, 18), P({ color: c, roughness: 0.6 })); m.position.y = y; gr.add(m);
      }
      gr.scale.setScalar(1.6);
      const w = new THREE.Group(); w.add(gr); V('burger', w, false);
    }
    {
      const sodaTex = canvasTex(256, 128, (gx, w, h) => { gx.fillStyle = '#c4161c'; gx.fillRect(0, 0, w, h); gx.fillStyle = '#fff'; gx.font = '900 46px Arial Black, Arial'; gx.textAlign = 'center'; gx.textBaseline = 'middle'; gx.fillText('SUGAR', w / 2, h / 2); });
      const gr = new THREE.Group(); gr.add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.36, 18), P({ map: sodaTex, metalness: 0.6, roughness: 0.3 })));
      gr.scale.setScalar(1.5);
      const w = new THREE.Group(); w.add(gr); V('soda', w, false);
    }
    // one shared halo ring for every pickup, coloured per instance
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.42, 32), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6 }));
    const haloLocal = new THREE.Matrix4().compose(new THREE.Vector3(0, 0.03, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), new THREE.Vector3(1, 1, 1));
    this.halo = new Variant(this.group, [{ geo: ring.geometry, mat: ring.material }], false, haloLocal);
    Object.assign(this.haloColor, { water: new THREE.Color('#3aa0ff'), banana: new THREE.Color('#ffd23f'), burger: new THREE.Color('#ff2a2a'), soda: new THREE.Color('#ff2a2a') });
    this.shakeHalo = caps.map((c) => new THREE.Color(c));

    // ---- obstacles (cast shadows)
    const M = worldMats;
    const carPaint = P({ color: '#ffffff', metalness: 0.6, roughness: 0.28 }); // tinted per car via instance colour
    for (const suv of [false, true]) {
      const gr = new THREE.Group();
      for (const { geo, mat } of buildCarParts(M, carPaint, suv)) gr.add(new THREE.Mesh(geo, mat));
      gr.rotation.y = Math.PI / 2; // nose towards the player
      const w = new THREE.Group(); w.add(gr);
      const parts = bakeParts(w, new Set([carPaint, M.glass]));
      this.variants.set(suv ? 'car1' : 'car0', new Variant(this.group, parts, true));
    }
    this.carColors = ['#101418', '#e8e8e6', '#7a0f14', '#1f3a5f', '#9aa0a4', '#0d0d0d', '#c9b38a', '#2f4a3a', '#c7c9cc'].map((c) => new THREE.Color(c));
    const white = P({ color: '#f4f4f4', roughness: 0.5 }), orange = P({ color: '#ff6a00', roughness: 0.5 }), iron = P({ color: '#2a2b2e', metalness: 0.7, roughness: 0.4 });
    {
      const gr = new THREE.Group();
      for (const dx of [-0.95, 0.95]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.95, 0.55), iron); leg.position.set(dx, 0.47, 0); gr.add(leg); }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.28, 0.08), white); bar.position.y = 0.8; gr.add(bar);
      for (let k = -0.9; k <= 0.91; k += 0.45) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.28, 0.085), orange); s.position.set(k, 0.8, 0); gr.add(s); }
      V('barrier', gr, true);
    }
    {
      const bannerTex = canvasTex(1024, 256, (gx, w, h) => {
        gx.fillStyle = '#0b0b0b'; gx.fillRect(0, 0, w, h); gx.fillStyle = '#9dff3a'; gx.font = '900 120px Arial Black, Arial'; gx.textAlign = 'center'; gx.textBaseline = 'middle'; gx.fillText('RUN CLUB', w / 2, h / 2 + 6);
        gx.strokeStyle = '#9dff3a'; gx.lineWidth = 10; gx.strokeRect(14, 14, w - 28, h - 28);
      });
      const bannerMat = P({ map: bannerTex, emissiveMap: bannerTex, emissive: '#fff', emissiveIntensity: 0.15, roughness: 0.7, side: THREE.DoubleSide });
      const gr = new THREE.Group();
      for (const dx of [-1.15, 1.15]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.6, 0.1), iron); p.position.set(dx, 1.3, 0); gr.add(p); }
      const b = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 0.06), bannerMat); b.position.y = 1.75; gr.add(b);
      V('banner', gr, true);
    }
    // joggers: real skinned characters, re-textured onto one sheet each
    const gl = new GLTFLoader();
    this.joggers = await Promise.all([1, 2, 3, 4].map((i) => gl.loadAsync(`${ASSET}/characters/jogger${i}.glb`)));
    for (const j of this.joggers) atlasJogger(j.scene);
  }
  private shakeHalo: THREE.Color[] = [];

  // ---------- handles + pooling ----------
  private pool = new Map<string, THREE.Object3D[]>();
  private newHandle(kind: ItemKind | ObstacleKind) {
    if (kind === 'jogger') {
      const src = this.joggers[this.jogIdx++ % this.joggers.length];
      const o = SkeletonUtils.clone(src.scene);
      o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.frustumCulled = false; } });
      (o as any).__clips = src.animations;
      return o;
    }
    const o = new THREE.Object3D();
    const body = new THREE.Object3D(); body.name = 'body'; o.add(body);
    return o;
  }
  private take(kind: ItemKind | ObstacleKind) {
    const l = this.pool.get(kind);
    const o = l && l.length ? l.pop()! : this.newHandle(kind);
    o.visible = true;
    o.rotation.set(0, 0, 0);
    o.position.y = 0;
    this.group.add(o);
    return o;
  }
  private give(kind: string, o: THREE.Object3D) {
    const v = (o as any).__variant as string | undefined;
    if (v) this.variants.get(v)!.remove(v.startsWith('car') || v === 'barrier' || v === 'banner' ? o : o.getObjectByName('body')!);
    if (INSTANCED.includes(kind as any) && kind !== 'car' && kind !== 'barrier' && kind !== 'banner') this.halo.remove(o);
    (o as any).__variant = undefined;
    o.visible = false;
    this.group.remove(o);
    if (!this.pool.has(kind)) this.pool.set(kind, []);
    this.pool.get(kind)!.push(o);
  }

  spawnItem(kind: ItemKind, lane: number, z: number, y = 0.95) {
    const obj = this.take(kind);
    obj.position.set(LANES[lane], 0, z);
    const body = obj.getObjectByName('body')!;
    body.position.y = y;
    const k = kind === 'shake' ? this.shakeIdx++ % 3 : 0;
    const vkey = kind === 'shake' ? 'shake' + k : kind;
    (obj as any).__variant = vkey;
    this.variants.get(vkey)!.add(body);
    this.halo.add(obj, kind === 'shake' ? this.shakeHalo[k] : this.haloColor[kind]);
    this.items.push({ kind, obj, body, lane, z, prevZ: z, y, active: true, spin: Math.random() * 6 });
  }

  spawnObstacle(kind: ObstacleKind, lane: number, z: number) {
    const obj = this.take(kind);
    obj.position.set(LANES[lane], 0, z);
    const o: Obstacle = { kind, obj, lane, z, active: true, hit: false, passed: false, vz: 0,
      prevZ: z, len: kind === 'car' ? 4.8 : kind === 'jogger' ? 0.6 : 0.4,
      halfW: kind === 'car' ? 0.95 : kind === 'jogger' ? 0.35 : kind === 'barrier' ? 1.1 : 1.2 };
    if (kind === 'jogger') {
      const clips = (obj as any).__clips as THREE.AnimationClip[];
      o.mixer = new THREE.AnimationMixer(obj);
      const run = clips.find((c) => /run/i.test(c.name)) ?? clips[0];
      if (run) o.mixer.clipAction(run).play();
      o.mixer.update(Math.random());
    } else {
      const i = this.carIdx++;
      const vkey = kind === 'car' ? (i % 3 === 0 ? 'car1' : 'car0') : kind;
      (obj as any).__variant = vkey;
      this.variants.get(vkey)!.add(obj, kind === 'car' ? this.carColors[i % this.carColors.length] : undefined);
    }
    this.obstacles.push(o);
  }

  /** Writes every instance matrix from its handle (call after moving handles, before rendering). */
  sync() {
    this.group.updateMatrixWorld(true);
    for (const v of this.variants.values()) v.sync();
    this.halo.sync();
  }

  update(dt: number, dz: number, t: number) {
    for (const it of this.items) {
      it.prevZ = it.z;
      it.z += dz;
      it.obj.position.z = it.z;
      const body = it.body;
      body.rotation.y = t * 2.4 + it.spin;
      body.position.y = it.y + Math.sin(t * 3 + it.spin) * 0.08;
    }
    for (const o of this.obstacles) {
      o.prevZ = o.z;
      o.z += dz + o.vz * dt;
      o.obj.position.z = o.z;
      if (o.mixer) o.mixer.update(dt);
      if (o.fly) { // smashed by Beast Mode
        o.obj.position.addScaledVector(o.fly, dt);
        o.fly.y -= 18 * dt;
        o.obj.rotation.x += (o.spinFly ?? 4) * dt;
      }
    }
    // recycle what fell behind the camera
    this.items = this.items.filter((it) => { if (it.z > 8 || !it.active) { this.give(it.kind, it.obj); return false; } return true; });
    this.obstacles = this.obstacles.filter((o) => { if (o.z > 12 || o.obj.position.y < -6) { o.fly = undefined; this.give(o.kind, o.obj); return false; } return true; });
    this.sync();
  }

  clear() {
    for (const it of this.items) this.give(it.kind, it.obj);
    for (const o of this.obstacles) { o.fly = undefined; this.give(o.kind, o.obj); }
    this.items = [];
    this.obstacles = [];
    this.sync();
  }
}
