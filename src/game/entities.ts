import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ASSET, canvasTex, labelTexture } from './materials';
import { buildCarParts, LANES } from './world';

export type ItemKind = 'shake' | 'water' | 'banana' | 'burger' | 'soda';
export type ObstacleKind = 'car' | 'barrier' | 'banner' | 'jogger';

export interface Item { kind: ItemKind; obj: THREE.Object3D; lane: number; z: number; y: number; active: boolean; spin: number }
export interface Obstacle {
  kind: ObstacleKind; obj: THREE.Object3D; lane: number; z: number; len: number; active: boolean; hit: boolean; passed: boolean;
  mixer?: THREE.AnimationMixer; vz: number; fly?: THREE.Vector3; spinFly?: number;
}

const P = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
const PP = (o: THREE.MeshPhysicalMaterialParameters) => new THREE.MeshPhysicalMaterial(o);

function mergeGroup(g: THREE.Group) {
  // collapse a hand-built group into one mesh per material (fewer draw calls)
  g.updateMatrixWorld(true);
  const by = new Map<THREE.Material, THREE.BufferGeometry[]>();
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    let geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
    geo = geo.index ? geo.toNonIndexed() : geo;
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    const mat = m.material as THREE.Material;
    if (!by.has(mat)) by.set(mat, []);
    by.get(mat)!.push(geo);
  });
  const out = new THREE.Group();
  for (const [mat, geos] of by) {
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    mesh.castShadow = true;
    out.add(mesh);
  }
  return out;
}

export class Entities {
  group = new THREE.Group();
  items: Item[] = [];
  obstacles: Obstacle[] = [];
  private proto: Partial<Record<ItemKind | ObstacleKind, () => THREE.Object3D>> = {};
  private joggers: GLTF[] = [];
  private haloGeo = new THREE.RingGeometry(0.34, 0.42, 40);

  async init(worldMats: Record<string, any>) {
    // ---- pickups
    const shakeLabel = [labelTexture('#e53935', 'WHEY'), labelTexture('#1e5bd8', 'WHEY'), labelTexture('#7b2cbf', 'WHEY')];
    const flav = ['#6b3e26', '#e9c9a8', '#c47aa8'];
    const caps = ['#e53935', '#1e5bd8', '#7b2cbf'];
    const shell = PP({ color: '#ffffff', transmission: 0.85, roughness: 0.12, thickness: 0.2, ior: 1.45, side: THREE.DoubleSide });
    let si = 0;
    this.proto.shake = () => {
      const k = si++ % 3, g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.15, 0.5, 24, 1, true), shell));
      const liq = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.14, 0.36, 24), P({ color: flav[k], roughness: 0.35 }));
      liq.position.y = -0.06; g.add(liq);
      const lab = new THREE.Mesh(new THREE.CylinderGeometry(0.172, 0.162, 0.16, 24, 1, true), P({ map: shakeLabel[k], roughness: 0.5 }));
      lab.position.y = -0.02; g.add(lab);
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 24), P({ color: caps[k], roughness: 0.3 }));
      lid.position.y = 0.3; g.add(lid);
      g.scale.setScalar(1.25);
      return this.withHalo(g, caps[k]);
    };
    const waterMat = PP({ color: '#dff4ff', transmission: 0.95, roughness: 0.05, thickness: 0.3, ior: 1.33 });
    this.proto.water = () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.42, 20), waterMat));
      const n = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.11, 0.1, 20), waterMat); n.position.y = 0.26; g.add(n);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.06, 14), P({ color: '#1e7bff', roughness: 0.3 })); c.position.y = 0.34; g.add(c);
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.112, 0.112, 0.12, 20, 1, true), P({ color: '#2a8cff', roughness: 0.5 })));
      g.scale.setScalar(1.4);
      return this.withHalo(g, '#3aa0ff');
    };
    const bananas = (await new GLTFLoader().loadAsync(`${ASSET}/models/bananas/bananas.gltf`)).scene;
    this.proto.banana = () => { const g = new THREE.Group(); const b = bananas.clone(); b.scale.setScalar(2.4); b.position.y = -0.15; g.add(b); return this.withHalo(g, '#ffd23f'); };
    this.proto.burger = () => {
      const g = new THREE.Group();
      for (const [r, h, c, y] of [[0.24, 0.08, '#c98a3a', 0], [0.25, 0.05, '#4a2a18', 0.08], [0.26, 0.02, '#f2c12e', 0.12], [0.25, 0.03, '#5aa02a', 0.15], [0.24, 0.16, '#d6913f', 0.24]] as const) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * (y > 0.2 ? 1 : 0.98), h, 20), P({ color: c, roughness: 0.6 }));
        m.position.y = y; g.add(m);
      }
      g.scale.setScalar(1.6);
      return this.withHalo(g, '#ff2a2a');
    };
    const sodaTex = canvasTex(256, 128, (gx, w, h) => { gx.fillStyle = '#c4161c'; gx.fillRect(0, 0, w, h); gx.fillStyle = '#fff'; gx.font = '900 46px Arial Black, Arial'; gx.textAlign = 'center'; gx.textBaseline = 'middle'; gx.fillText('SUGAR', w / 2, h / 2); });
    this.proto.soda = () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.36, 20), P({ map: sodaTex, metalness: 0.6, roughness: 0.3 })));
      g.scale.setScalar(1.5);
      return this.withHalo(g, '#ff2a2a');
    };

    // ---- obstacles
    const M = worldMats;
    let ci = 0;
    this.proto.car = () => {
      const g = new THREE.Group();
      const suv = ci % 3 === 0;
      for (const { geo, mat } of buildCarParts(M, M.paints[ci++ % M.paints.length], suv)) g.add(new THREE.Mesh(geo, mat));
      g.rotation.y = Math.PI / 2; // nose towards the player
      const wrap = new THREE.Group(); wrap.add(g);
      return mergeGroup(wrap);
    };
    const white = P({ color: '#f4f4f4', roughness: 0.5 }), orange = P({ color: '#ff6a00', roughness: 0.5 }), iron = P({ color: '#2a2b2e', metalness: 0.7, roughness: 0.4 });
    this.proto.barrier = () => {
      const g = new THREE.Group();
      for (const dx of [-0.95, 0.95]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.95, 0.55), iron); leg.position.set(dx, 0.47, 0); g.add(leg); }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.28, 0.08), white); bar.position.y = 0.8; g.add(bar);
      for (let k = -0.9; k <= 0.91; k += 0.45) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.28, 0.085), orange); s.position.set(k, 0.8, 0); g.add(s); }
      return mergeGroup(g);
    };
    const bannerTex = canvasTex(1024, 256, (gx, w, h) => {
      gx.fillStyle = '#0b0b0b'; gx.fillRect(0, 0, w, h); gx.fillStyle = '#9dff3a'; gx.font = '900 120px Arial Black, Arial'; gx.textAlign = 'center'; gx.textBaseline = 'middle'; gx.fillText('RUN CLUB', w / 2, h / 2 + 6);
      gx.strokeStyle = '#9dff3a'; gx.lineWidth = 10; gx.strokeRect(14, 14, w - 28, h - 28);
    });
    const bannerMat = P({ map: bannerTex, emissiveMap: bannerTex, emissive: '#fff', emissiveIntensity: 0.15, roughness: 0.7, side: THREE.DoubleSide });
    this.proto.banner = () => {
      // overhead finish-line style banner: slide under it
      const g = new THREE.Group();
      for (const dx of [-1.15, 1.15]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.6, 0.1), iron); p.position.set(dx, 1.3, 0); g.add(p); }
      const b = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 0.06), bannerMat); b.position.y = 1.75; g.add(b);
      return mergeGroup(g);
    };
    const gl = new GLTFLoader();
    this.joggers = await Promise.all([1, 2, 3, 4].map((i) => gl.loadAsync(`${ASSET}/characters/jogger${i}.glb`)));
    let ji = 0;
    this.proto.jogger = () => {
      const src = this.joggers[ji++ % this.joggers.length];
      const o = SkeletonUtils.clone(src.scene);
      o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; } });
      (o as any).__clips = src.animations;
      return o;
    };
  }

  private withHalo(g: THREE.Group, color: string) {
    const wrap = new THREE.Group();
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    g.name = 'body';
    wrap.add(g);
    const halo = new THREE.Mesh(this.haloGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 }));
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.03;
    wrap.add(halo);
    return wrap;
  }

  // ---------- pooling ----------
  private pool = new Map<string, THREE.Object3D[]>();
  private take(kind: ItemKind | ObstacleKind) {
    const l = this.pool.get(kind);
    const o = l && l.length ? l.pop()! : this.proto[kind]!();
    o.visible = true;
    o.rotation.set(0, 0, 0);
    this.group.add(o);
    return o;
  }
  private give(kind: string, o: THREE.Object3D) {
    o.visible = false;
    this.group.remove(o);
    if (!this.pool.has(kind)) this.pool.set(kind, []);
    this.pool.get(kind)!.push(o);
  }

  spawnItem(kind: ItemKind, lane: number, z: number, y = 0.95) {
    const obj = this.take(kind);
    obj.position.set(LANES[lane], 0, z);
    obj.getObjectByName('body')!.position.y = y;
    this.items.push({ kind, obj, lane, z, y, active: true, spin: Math.random() * 6 });
  }
  spawnObstacle(kind: ObstacleKind, lane: number, z: number) {
    const obj = this.take(kind);
    obj.position.set(LANES[lane], 0, z);
    const o: Obstacle = { kind, obj, lane, z, active: true, hit: false, passed: false, vz: 0,
      len: kind === 'car' ? 4.8 : kind === 'jogger' ? 0.6 : 0.4 };
    if (kind === 'jogger') {
      o.vz = 3.2; // runs towards you
      const clips = (obj as any).__clips as THREE.AnimationClip[];
      o.mixer = new THREE.AnimationMixer(obj);
      const run = clips.find((c) => /run/i.test(c.name)) ?? clips[0];
      if (run) o.mixer.clipAction(run).play();
      o.mixer.update(Math.random());
    }
    this.obstacles.push(o);
  }

  update(dt: number, dz: number, t: number) {
    for (const it of this.items) {
      it.z += dz;
      it.obj.position.z = it.z;
      const body = it.obj.getObjectByName('body')!;
      body.rotation.y = t * 2.4 + it.spin;
      body.position.y = it.y + Math.sin(t * 3 + it.spin) * 0.08;
    }
    for (const o of this.obstacles) {
      o.z += dz + o.vz * dt;
      o.obj.position.z = o.z;
      if (o.mixer) o.mixer.update(dt);
      if (o.fly) { // smashed by Beast Mode
        o.obj.position.add(o.fly.clone().multiplyScalar(dt));
        o.fly.y -= 18 * dt;
        o.obj.rotation.x += (o.spinFly ?? 4) * dt;
      }
    }
    // recycle what fell behind the camera
    this.items = this.items.filter((it) => { if (it.z > 8 || !it.active) { this.give(it.kind, it.obj); return false; } return true; });
    this.obstacles = this.obstacles.filter((o) => { if (o.z > 12 || o.obj.position.y < -6) { o.obj.position.y = 0; o.fly = undefined; this.give(o.kind, o.obj); return false; } return true; });
  }

  clear() {
    for (const it of this.items) this.give(it.kind, it.obj);
    for (const o of this.obstacles) { o.obj.position.y = 0; o.fly = undefined; this.give(o.kind, o.obj); }
    this.items = [];
    this.obstacles = [];
  }
}
