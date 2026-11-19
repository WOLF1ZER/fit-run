import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  ASSET, adTexture, awningTexture, canvasTex, frondTexture, graffitiTexture, grimeTexture, heatify, makeRng, pbr, plateTexture, signTexture, stableShadow,
} from './materials';

export const LANES = [-2.5, 0, 2.5];
export const CHUNK = 60; // metres of street per recycled block
const BEHIND = 30; // metres of street kept behind the player
const NUM_CHUNKS = 5; // 300 m of street exists at any time (the haze hides the rest)
const SUN_SIDE = 1; // the sun is on the +x side, alleys there let light cut across the road

export const SUN_DIR = new THREE.Vector3()
  .setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 24), THREE.MathUtils.degToRad(100))
  .normalize();

type Batch = Map<THREE.Material, THREE.BufferGeometry[]>;

interface Chunk {
  group: THREE.Group;
  boxes: THREE.Box3[]; // shade casters in chunk-local space
  district: District;
}

const KEEP = ['position', 'normal', 'uv', 'color'];
function clean(g: THREE.BufferGeometry) {
  const n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (!KEEP.includes(k)) n.deleteAttribute(k);
  if (!n.attributes.uv) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((n.attributes.position.count) * 2), 2));
  return n;
}

/** Stacks same-width canvas textures into one texture; returns per-entry UV v-ranges (flipY: v=1 is the top). */
function atlas(textures: THREE.Texture[]) {
  const imgs = textures.map((t) => t.image as HTMLCanvasElement);
  const w = imgs[0].width, h = imgs.reduce((a, i) => a + i.height, 0);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const regions: [number, number][] = [];
  let y = 0;
  for (const im of imgs) {
    g.drawImage(im, 0, y, w, im.height);
    regions.push([1 - (y + im.height - 1) / h, 1 - (y + 1) / h]); // 1px inset against bleeding
    y += im.height;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, regions };
}
const remapV = (g: THREE.BufferGeometry, r?: [number, number]) => {
  if (!r) return g;
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, r[0] + uv.getY(i) * (r[1] - r[0]));
  return g;
};

const WHITE = new THREE.Color('#ffffff');
function setColor(g: THREE.BufferGeometry, c: THREE.Color) {
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
}

export type District = 'boulevard' | 'beach' | 'downtown';
export const DISTRICTS: District[] = ['boulevard', 'beach', 'downtown'];
export const DISTRICT_NAMES: Record<District, string> = { boulevard: 'PALM BOULEVARD', beach: 'BEACH PROMENADE', downtown: 'DOWNTOWN' };
export const DISTRICT_LEN = 1000; // metres per location
export const districtAt = (d: number): District => DISTRICTS[Math.floor(Math.max(0, d) / DISTRICT_LEN) % DISTRICTS.length];

type Add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number) => void;

export class World {
  group = new THREE.Group();
  private chunks: Chunk[] = []; // the 5 blocks on screen
  private spares: Chunk[] = []; // built ahead for the next location, not on screen
  private jobs: { district: District; gen: Generator<void, Chunk, void> }[] = [];
  private seed = 1000;
  travelled = 0;
  syncBuilds = 0;
  mats!: Record<string, any>;
  private noShadow = new Set<THREE.Material>();
  private keepMat = new Set<THREE.Material>(); // plain materials that must stay separate (custom shaders)
  private vcMatte = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 });
  private vcMetal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.65 });
  /** lamps, lit shopfronts, car lights: brightness scaled by the time of day */
  vcGlow = new THREE.MeshBasicMaterial({ vertexColors: true });
  private props: Record<string, THREE.Object3D> = {};
  private ray = new THREE.Ray();
  private tmpBox = new THREE.Box3();
  private tmpOff = new THREE.Vector3();
  ocean = new THREE.Group();
  backdrop = new THREE.Group(); // static: hills far away, doesn't scroll

  async init(onProgress: (f: number, label: string) => void) {
    onProgress(0.05, 'Photo-scanned textures');
    const P = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
    const rnd = makeRng(99);
    const [asp, pav, curb, brick, stA, stB, stC] = await Promise.all([
      pbr('asphalt_02', 1, { color: '#b8b8b8', normalScale: new THREE.Vector2(1.2, 1.2) }),
      pbr('concrete_pavement_02', 1, { color: '#e6e2da' }),
      pbr('concrete', 1),
      pbr('red_brick_03', 1),
      pbr('beige_wall_001', 1),
      pbr('white_stucco_02', 1, { color: '#f3e6d2' }),
      pbr('painted_plaster_wall', 1),
    ]);
    for (const m of [asp, pav, curb]) heatify(m);
    const stuccoTints = ['#ffffff', '#f2c9b8', '#e8d2a8', '#cfe0e2', '#f6efe2'];
    // 3 wall materials; the tinted variants reuse them with a per-vertex tint (no extra draw calls)
    const baseWalls = [stA, stB, stC];
    for (const m of baseWalls) { (m as any).userData.tint = m.color.clone(); m.color.set('#ffffff'); m.vertexColors = true; }
    const walls = [...baseWalls.map((m) => ({ mat: m, tint: (m as any).userData.tint as THREE.Color })),
      ...stuccoTints.map((c, i) => ({ mat: baseWalls[i % 3], tint: new THREE.Color(c) }))];
    const pastel = ['#ffd6c9', '#c9f0e8', '#fff1b8', '#d7e3ff', '#ffe1f0', '#e4ffd2'].map((c, i) => ({ mat: baseWalls[1 + (i % 2)], tint: new THREE.Color(c) }));
    onProgress(0.3, 'Building the street');

    // glass towers: daytime facade + a separate "lit windows" map that only shows at night
    const towerDay = canvasTex(512, 512, (g) => {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) {
        const t = 0.85 + rnd() * 0.3;
        g.fillStyle = `rgb(${(30 * t) | 0},${(48 * t) | 0},${(62 * t) | 0})`;
        g.fillRect(x * 64, y * 32, 64, 32);
      }
      g.fillStyle = '#8a9096';
      for (let x = 0; x <= 8; x++) g.fillRect(x * 64 - 2, 0, 4, 512);
      for (let y = 0; y <= 16; y++) g.fillRect(0, y * 32 - 3, 512, 6);
    });
    const towerNight = canvasTex(512, 512, (g) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) if (rnd() < 0.38) {
        g.fillStyle = rnd() < 0.8 ? `rgb(255,${(200 + rnd() * 40) | 0},${(130 + rnd() * 60) | 0})` : '#cfe6ff';
        g.fillRect(x * 64 + 4, y * 32 + 5, 56, 22);
      }
    });
    for (const t of [towerDay, towerNight]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // generated sand, boardwalk planks and ocean waves
    const sandTex = canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#e2c99a'; g.fillRect(0, 0, w, h);
      for (let k = 0; k < 9000; k++) { const v = rnd(); g.fillStyle = `rgba(${v < 0.5 ? '120,95,60' : '255,248,230'},${0.12 + rnd() * 0.18})`; g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 1.5, 1 + rnd() * 1.5); }
    });
    const woodTex = canvasTex(256, 256, (g, w, h) => {
      for (let i = 0; i < 8; i++) {
        const c = 120 + rnd() * 40; g.fillStyle = `rgb(${c | 0},${(c * 0.72) | 0},${(c * 0.5) | 0})`; g.fillRect(0, i * 32, w, 32);
        for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(60,35,20,${rnd() * 0.25})`; g.fillRect(rnd() * w, i * 32 + rnd() * 30, 20 + rnd() * 60, 1); }
        g.fillStyle = 'rgba(30,18,10,.8)'; g.fillRect(0, i * 32 + 30, w, 2);
      }
    });
    const waveTex = canvasTex(256, 256, (g, w, h) => {
      const d = g.createImageData(w, h), H = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) H[y * w + x] = Math.sin((x / w) * Math.PI * 8 + Math.sin((y / h) * Math.PI * 6) * 1.2) * 0.5 + Math.sin((y / h) * Math.PI * 10 + (x / w) * Math.PI * 4) * 0.5;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const nx = H[y * w + ((x + 1) % w)] - H[y * w + ((x - 1 + w) % w)], ny = H[((y + 1) % h) * w + x] - H[((y - 1 + h) % h) * w + x], i = (y * w + x) * 4;
        d.data[i] = (0.5 - nx * 0.6) * 255; d.data[i + 1] = (0.5 - ny * 0.6) * 255; d.data[i + 2] = 255; d.data[i + 3] = 255;
      }
      g.putImageData(d, 0, 0);
    }, false);
    for (const t of [sandTex, woodTex, waveTex]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    const poolTex = canvasTex(128, 128, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      gr.addColorStop(0, 'rgba(255,200,130,1)'); gr.addColorStop(0.45, 'rgba(255,170,90,.45)'); gr.addColorStop(1, 'rgba(255,150,70,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });

    const decal = (map: THREE.Texture, extra: THREE.MeshStandardMaterialParameters = {}) =>
      P({ map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.9, ...extra });

    this.mats = {
      asp, pav, curb, brick, walls, pastel,
      paintW: heatify(P({ color: '#e8e6df', roughness: 0.6 })),
      glass: P({ color: '#10161c', metalness: 0.3, roughness: 0.04, envMapIntensity: 1.8 }),
      glassT: P({ map: towerDay, emissiveMap: towerNight, emissive: '#ffffff', emissiveIntensity: 0, metalness: 0.9, roughness: 0.08, envMapIntensity: 1.5 }),
      frame: P({ color: '#d8d2c6', roughness: 0.6 }),
      dark: P({ color: '#1b1c1e', metalness: 0.5, roughness: 0.5 }),
      iron: P({ color: '#1e1f22', metalness: 0.8, roughness: 0.45 }),
      pole: P({ color: '#6f6c66', metalness: 0.7, roughness: 0.5 }),
      ac: P({ color: '#b9b6ae', metalness: 0.4, roughness: 0.5 }),
      tank: P({ color: '#7a5a3a', roughness: 0.9 }),
      shop: P({ color: '#2a2018', emissive: '#ffcf90', emissiveIntensity: 0.35, roughness: 0.6 }),
      lamp: P({ color: '#fff', emissive: '#ffd9a0', emissiveIntensity: 0.5 }),
      chrome: P({ color: '#e8e8e8', metalness: 1, roughness: 0.12 }),
      tire: P({ color: '#141414', roughness: 0.9 }),
      rim: P({ color: '#c8c8c8', metalness: 1, roughness: 0.25 }),
      head: P({ color: '#fff', emissive: '#fff6e0', emissiveIntensity: 1.2 }),
      tail: P({ color: '#a00', emissive: '#ff1a0a', emissiveIntensity: 0.8 }),
      plate: P({ map: plateTexture(512), roughness: 0.4 }),
      trunk: P({ color: '#7a6650', roughness: 1 }),
      skirt: P({ color: '#6b5a3c', roughness: 1 }),
      leaf: P({ color: '#4f7a35', roughness: 0.9 }),
      white: P({ color: '#f2f0ea', roughness: 0.6 }),
      lifeguard: P({ color: '#d93a2b', roughness: 0.6 }),
      frond: P({ map: frondTexture(rnd), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8 }),
      sand: P({ map: sandTex, roughness: 1 }),
      wetSand: P({ map: sandTex, color: '#9c8566', roughness: 0.35 }),
      wood: P({ map: woodTex, roughness: 0.85 }),
      pool: new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
      paint: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.28 }),
      paints: ['#101418', '#e8e8e6', '#7a0f14', '#1f3a5f', '#9aa0a4', '#0d0d0d', '#c9b38a', '#2f4a3a', '#c7c9cc'].map((c) =>
        new THREE.MeshStandardMaterial({ color: c, metalness: 0.6, roughness: 0.28 })), // obstacle cars
      paintColors: ['#101418', '#e8e8e6', '#7a0f14', '#1f3a5f', '#9aa0a4', '#0d0d0d', '#c9b38a', '#2f4a3a', '#c7c9cc'].map((c) => new THREE.Color(c)),
      beachColors: ['#e8e8e6', '#5fb0c9', '#f2c94c', '#d95d39', '#c7c9cc', '#2f6f8f'].map((c) => new THREE.Color(c)),
      taxiColors: ['#f2b705', '#f2b705', '#f2b705', '#101418', '#e8e8e6', '#0d0d0d'].map((c) => new THREE.Color(c)),
      grime: decal(grimeTexture()),
    };
    // one texture sheet per decal family: ~30 materials become 4 per street block
    const mk = (texs: THREE.Texture[], mat: (t: THREE.Texture) => THREE.Material) => { const a = atlas(texs); return { mat: mat(a.tex), regions: a.regions }; };
    this.mats.signs = mk(Array.from({ length: 14 }, (_, i) => signTexture(i, rnd)), (t) => P({ map: t, emissiveMap: t, emissive: '#fff', emissiveIntensity: 0.06, roughness: 0.6 }));
    this.mats.ads = mk(Array.from({ length: 4 }, (_, i) => adTexture(i, rnd)), (t) => P({ map: t, emissiveMap: t, emissive: '#fff', emissiveIntensity: 0.08, roughness: 0.5 }));
    this.mats.signs.mat.userData = { dayGlow: 0.06, nightGlow: 1.3 };
    this.mats.ads.mat.userData = { dayGlow: 0.08, nightGlow: 1.0 };
    this.mats.awnings = mk(Array.from({ length: 4 }, (_, i) => awningTexture(i)), (t) => P({ map: t, side: THREE.DoubleSide, roughness: 0.85 }));
    this.mats.graffiti = mk(Array.from({ length: 8 }, (_, i) => graffitiTexture(i, rnd)), (t) => decal(t));
    this.keepMat = new Set<THREE.Material>([this.mats.paintW, this.mats.glass, this.mats.lifeguard, this.mats.white]);
    // materials that never need to cast shadows (ground, paint, decals, glass)
    this.noShadow = new Set<THREE.Material>([asp, pav, curb, this.mats.paintW, this.mats.grime, this.mats.signs.mat, this.mats.ads.mat, this.mats.graffiti.mat,
      this.mats.glass, this.mats.shop, this.mats.frame, this.mats.lamp, this.mats.sand, this.mats.wetSand, this.mats.wood]);

    // the ocean beside the beach promenade: one big static plane, shown while beach blocks are on screen
    const water = P({ color: '#1d5170', roughness: 0.12, metalness: 0.15, normalMap: waveTex, normalScale: new THREE.Vector2(0.6, 0.6), envMapIntensity: 1.3 });
    waveTex.repeat.set(220, 220);
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), water);
    sea.rotation.x = -Math.PI / 2; sea.position.set(-2066, -0.28, -1200);
    this.ocean.add(sea); this.ocean.visible = false;
    this.waveTex = waveTex;

    onProgress(0.45, 'Street furniture');
    const gl = new GLTFLoader();
    const ids = ['fire_hydrant', 'metal_trash_can', 'planter_box_01', 'potted_plant_02', 'water_manhole_cover'];
    await Promise.all(ids.map(async (id) => {
      const g = await gl.loadAsync(`${ASSET}/models/${id}/${id}.gltf`);
      // these Poly Haven models ship clean + aged/rusty copies side by side: keep the clean one, centred
      const drop: THREE.Object3D[] = [];
      g.scene.traverse((o) => { if (/_aged|_rust/.test(o.name)) drop.push(o); });
      drop.forEach((o) => o.parent?.remove(o));
      const box = new THREE.Box3().setFromObject(g.scene), c = box.getCenter(new THREE.Vector3());
      g.scene.position.x -= c.x; g.scene.position.z -= c.z;
      const wrap = new THREE.Group(); wrap.add(g.scene);
      wrap.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) this.noShadow.add(m.material as THREE.Material); });
      this.props[id] = wrap;
    }));

    onProgress(0.6, 'Palms & buildings');
    for (let i = 0; i < NUM_CHUNKS; i++) {
      const c = this.buildNow('boulevard');
      c.group.position.z = BEHIND - i * CHUNK; // the first block starts behind the player, so the start screen never sees the street end
      this.group.add(c.group);
      this.chunks.push(c);
    }
    // one block of each other location, so their materials are compiled during loading
    onProgress(0.7, 'Beach & downtown');
    this.spares.push(this.buildNow('beach'), this.buildNow('downtown'));
    this.buildBackdrop();
  }
  private waveTex!: THREE.Texture;
  private carCache: { geo: THREE.BufferGeometry; mat: THREE.Material }[][] = [];

  /** Shows the pre-built spare blocks in view for one warm-up render (shader compile), or hides them again. */
  warmup(show: boolean) {
    this.spares.forEach((c, i) => {
      if (show) { c.group.position.set(i ? 40 : -40, 0, -20); this.group.add(c.group); } else this.group.remove(c.group);
    });
    this.ocean.visible = show;
  }

  /** Moves the street toward the player; recycles blocks that fell behind; swaps in the next location's blocks. */
  update(dz: number, dt = 0) {
    this.travelled += dz;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      c.group.position.z += dz;
      if (c.group.position.z <= CHUNK + BEHIND) continue; // always ≥ BEHIND metres of street behind the player
      const z = c.group.position.z - NUM_CHUNKS * CHUNK;
      const want = districtAt(this.travelled - z + CHUNK / 2);
      if (want === c.district) { c.group.position.z = z; continue; }
      const spare = this.takeSpare(want);
      if (!spare) this.syncBuilds++; // fallback: built on the spot (would hitch); should stay 0 in normal play
      const next = spare ?? this.buildNow(want);
      this.dispose(c);
      next.group.position.set(0, 0, z);
      this.group.add(next.group);
      this.chunks[i] = next;
    }
    this.ocean.visible = this.chunks.some((c) => c.district === 'beach');
    if (Math.floor(this.travelled / 50) !== Math.floor((this.travelled - dz) / 50)) this.trimSpares();
    this.waveTex.offset.x += dt * 0.004; this.waveTex.offset.y += dt * 0.0025;
    // start building the next location in the background ~600 m before it begins
    const boundary = Math.ceil((this.travelled + 1) / DISTRICT_LEN) * DISTRICT_LEN;
    if (boundary - this.travelled < 600) {
      const nd = districtAt(boundary + 1);
      // blocks already on the street count too, or spares would be ordered again while they're being swapped in
      const have = this.chunks.filter((c) => c.district === nd).length + this.spares.filter((s) => s.district === nd).length + this.jobs.filter((j) => j.district === nd).length;
      for (let k = have; k < NUM_CHUNKS; k++) this.jobs.push({ district: nd, gen: this.steps(this.seed++, nd) });
    }
  }

  /** Runs background block-building for up to `budgetMs` this frame (keeps the frame rate smooth). */
  runJobs(budgetMs = 4) {
    const t0 = performance.now();
    while (this.jobs.length && performance.now() - t0 < budgetMs) {
      const j = this.jobs[0], r = j.gen.next();
      if (r.done) { this.jobs.shift(); this.spares.push(r.value); this.trimSpares(); }
    }
  }

  /** New run: back to the boulevard at the start line. */
  reset() {
    this.travelled = 0;
    this.jobs = [];
    this.chunks.forEach((c, i) => {
      if (c.district !== 'boulevard') {
        this.dispose(c);
        c = this.takeSpare('boulevard') ?? this.buildNow('boulevard');
        this.group.add(c.group);
        this.chunks[i] = c;
      }
      c.group.position.set(0, 0, BEHIND - i * CHUNK);
    });
    this.ocean.visible = false;
  }

  /** z of the street lamp nearest the runner (lamps every 20 m in every location). */
  lampZ() {
    const m = ((((this.chunks[0].group.position.z - 6) % 20) + 20) % 20);
    return m > 10 ? m - 20 : m;
  }

  get district(): District { return districtAt(this.travelled); }

  private takeSpare(d: District) {
    const i = this.spares.findIndex((s) => s.district === d);
    return i >= 0 ? this.spares.splice(i, 1)[0] : undefined;
  }
  /** Spares for any location other than the one coming next are freed (keeps memory flat on long runs). */
  private trimSpares() {
    const boundary = Math.ceil((this.travelled + 1) / DISTRICT_LEN) * DISTRICT_LEN, nd = districtAt(boundary + 1);
    this.spares = this.spares.filter((c) => {
      const far = districtAt(this.travelled + NUM_CHUNKS * CHUNK); // the location new blocks are being placed in
      const keep = c.district === nd || c.district === far || (this.travelled < 10 && c.district !== 'boulevard'); // keep the load-time warm-up blocks until a run starts moving
      if (!keep) this.dispose(c);
      return keep;
    });
  }
  private dispose(c: Chunk) {
    this.group.remove(c.group);
    c.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
  }
  private buildNow(d: District): Chunk {
    const g = this.steps(this.seed++, d);
    for (;;) { const r = g.next(); if (r.done) return r.value; }
  }

  /** True if a building blocks the light coming from `dir` for a point at (x, y, 0). */
  isInShade(x: number, y: number, dir: THREE.Vector3) {
    this.ray.origin.set(x, y, 0);
    this.ray.direction.copy(dir);
    for (const c of this.chunks) {
      const z = c.group.position.z;
      if (z < -2 * CHUNK || z > 2 * CHUNK) continue;
      for (const b of c.boxes) {
        this.tmpOff.set(0, 0, z);
        this.tmpBox.copy(b).translate(this.tmpOff);
        if (this.ray.intersectsBox(this.tmpBox)) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------
  /** Builds one block step by step (yields often so it can run in the background). */
  private *steps(seed: number, district: District): Generator<void, Chunk, void> {
    const rnd = makeRng(seed);
    const M = this.mats;
    const batch: Batch = new Map();
    const group = new THREE.Group();
    const boxes: THREE.Box3[] = [];

    const add: Add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      geo.rotateX(rx); geo.rotateY(ry); geo.rotateZ(rz); geo.translate(x, y, z);
      if (!batch.has(mat)) batch.set(mat, []);
      batch.get(mat)!.push(clean(geo));
    };
    // box with world-scale UVs (ts = texture size in metres)
    const wbox = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, ts = 2, tint?: THREE.Color) => {
      const g = new THREE.BoxGeometry(w, h, d);
      const uv = g.attributes.uv, p = g.attributes.position, n = g.attributes.normal;
      for (let i = 0; i < uv.count; i++) {
        const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
        const X = p.getX(i) + x, Y = p.getY(i) + y, Z = p.getZ(i) + z;
        if (ax > 0.5) uv.setXY(i, Z / ts, Y / ts); else if (ay > 0.5) uv.setXY(i, X / ts, Z / ts); else uv.setXY(i, X / ts, Y / ts);
      }
      if (tint) setColor(g, tint);
      add(g, mat, x, y, z);
    };
    const facePlane = (w: number, h: number, mat: THREE.Material, x: number, y: number, z: number, s: number, region?: [number, number]) =>
      add(remapV(new THREE.PlaneGeometry(w, h), region), mat, x, y, z, 0, -s * Math.PI / 2);
    const put = (id: string, x: number, y: number, z: number, ry: number) => {
      const root = this.props[id];
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(1, 1, 1));
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld).applyMatrix4(m);
        const mat = mesh.material as THREE.Material;
        if (!batch.has(mat)) batch.set(mat, []);
        batch.get(mat)!.push(clean(g));
      });
    };
    const ctx = { rnd, add, wbox, facePlane, put, boxes };

    const Lz = -CHUNK / 2; // block spans z in [-CHUNK, 0]
    const beach = district === 'beach', downtown = district === 'downtown';
    // road, lane paint, curbs
    wbox(16, 0.3, CHUNK, M.asp, 0, -0.15, Lz, 3);
    for (let z = -4; z > -CHUNK; z -= 9) for (const x of [-1.25, 1.25]) wbox(0.14, 0.012, 3, M.paintW, x, 0.005, z, 1);
    for (const x of [-3.9, 3.9]) wbox(0.14, 0.012, CHUNK, M.paintW, x, 0.005, Lz, 1);
    for (const s of [-1, 1]) wbox(0.3, 0.32, CHUNK, M.curb, s * 8.1, 0, Lz, 1.5);
    wbox(5, 0.3, CHUNK, M.pav, 10.5, 0, Lz, 2);
    if (beach) {
      // boardwalk, rail, then sand down to the water
      wbox(5, 0.3, CHUNK, M.wood, -10.5, 0, Lz, 2);
      for (let z = -1; z > -CHUNK; z -= 3) wbox(0.1, 1.0, 0.1, M.white, -12.9, 0.6, z, 1);
      wbox(0.08, 0.08, CHUNK, M.white, -12.9, 1.1, Lz, 1);
      wbox(62, 0.3, CHUNK, M.sand, -44, -0.2, Lz, 4);
      wbox(10, 0.3, CHUNK, M.wetSand, -72, -0.24, Lz, 4);
    } else wbox(5, 0.3, CHUNK, M.pav, -10.5, 0, Lz, 2);
    yield;

    // buildings
    if (district === 'boulevard') for (const s of [-1, 1]) yield* this.buildingRow(ctx, s, { floors: [2, 4], brick: 0.3, palette: M.walls, towers: true });
    if (beach) {
      yield* this.buildingRow(ctx, 1, { floors: [1, 2], brick: 0, palette: M.pastel, towers: false });
      yield* this.beachSide(ctx);
    }
    if (downtown) for (const s of [-1, 1]) yield* this.towerRow(ctx, s);

    // street lamps (same 20 m rhythm everywhere) + their light pools on the road at night
    for (let z = -6; z > -CHUNK; z -= 20) for (const s of [-1, 1]) {
      wbox(0.22, 8.5, 0.22, M.pole, s * 8.6, 4.25, z, 1);
      wbox(2.2, 0.15, 0.15, M.pole, s * 7.6, 8.4, z, 1);
      wbox(0.7, 0.15, 0.35, M.lamp, s * 6.5, 8.27, z, 1);
      add(new THREE.PlaneGeometry(10, 10), M.pool, s * 5.2, 0.03, z, -Math.PI / 2);
    }
    yield;
    // trees
    if (!downtown) for (let z = -2; z > -CHUNK; z -= beach ? 10 : 12) for (const s of [-1, 1]) this.palm(add, s * 9.0, z - (s > 0 ? 6 : 0), 14 + rnd() * 8, rnd);
    if (downtown) for (let z = -8; z > -CHUNK; z -= 14) for (const s of [-1, 1]) this.tree(add, s * 9.2, z - (s > 0 ? 7 : 0), rnd);
    yield;
    // parked cars
    const colors: THREE.Color[] = downtown ? M.taxiColors : beach ? M.beachColors : M.paintColors;
    for (let z = -4; z > -CHUNK + 3; z -= 6.5) {
      for (const s of beach ? [1] : [-1, 1]) if (rnd() < 0.75) this.car(add, s * 6.1, z - rnd() * 1.2, s > 0 ? -Math.PI / 2 : Math.PI / 2, colors[Math.floor(rnd() * colors.length)], rnd() < 0.3);
      yield;
    }
    // real props (Poly Haven, simplified): baked into the block's batches so they cost no extra draw calls
    for (let z = -6; z > -CHUNK; z -= 17) {
      const s = rnd() < 0.5 ? -1 : 1;
      put('metal_trash_can', (beach ? 1 : s) * 8.85, 0.15, z, rnd() * 6);
      if (!beach) put('fire_hydrant', -s * 8.55, 0.15, z - 5, rnd() * 6);
      if (rnd() < 0.7 && !downtown) put(rnd() < 0.5 ? 'potted_plant_02' : 'planter_box_01', (beach ? 1 : s) * 12.3, 0.15, z - 3, rnd() * 6);
    }
    for (let z = -8; z > -CHUNK; z -= 23) put('water_manhole_cover', (rnd() - 0.5) * 5, 0.004, z, rnd() * 6);
    yield;

    // plain single-colour materials (frames, poles, tyres, AC units, lamps…) collapse into 3 shared
    // vertex-coloured ones: far fewer draw calls per street block, same look
    const merged = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const [mat, geos] of batch) {
      const m = mat as THREE.MeshStandardMaterial;
      const plain = m.isMeshStandardMaterial && !m.map && !m.transparent && !m.vertexColors && !this.keepMat.has(m);
      let target: THREE.Material = mat;
      if (plain) {
        const glow = m.emissiveIntensity > 0.3 && m.emissive.getHex() !== 0;
        target = glow ? this.vcGlow : m.metalness >= 0.5 ? this.vcMetal : this.vcMatte;
        for (const g of geos) setColor(g, glow ? m.emissive.clone().lerp(m.color, 0.3) : m.color);
      } else if ((mat as THREE.MeshStandardMaterial).vertexColors) {
        for (const g of geos) if (!g.attributes.color) setColor(g, WHITE);
      }
      if (!merged.has(target)) merged.set(target, []);
      merged.get(target)!.push(...geos);
    }
    yield;
    for (const [mat, geos] of merged) {
      const geo = mergeGeometries(geos, false);
      geo.computeBoundingSphere();
      // the GPU keeps its copy; drop the CPU-side arrays once uploaded (saves several MB per block)
      for (const a of Object.values(geo.attributes)) (a as THREE.BufferAttribute).onUpload(function (this: any) { this.array = null; });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = !this.noShadow.has(mat) && !(mat as THREE.MeshStandardMaterial).transparent;
      mesh.receiveShadow = true;
      stableShadow(mesh);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      yield;
    }
    return { group, boxes, district };
  }

  /** A row of shop buildings along one side (the boulevard; low pastel houses at the beach). */
  private *buildingRow(c: any, s: number, o: { floors: [number, number]; brick: number; palette: { mat: THREE.Material; tint: THREE.Color }[]; towers: boolean }): Generator<void, void, void> {
    const { rnd, add, wbox, facePlane, boxes } = c, M = this.mats;
    let z = 0;
    while (z > -CHUNK + 4) {
      const w = Math.min(10 + Math.floor(rnd() * 3) * 4, z + CHUNK);
      if (w < 6) break;
      const floors = o.floors[0] + Math.floor(rnd() * (o.floors[1] - o.floors[0] + 1)), h = floors * 3.4 + 0.8, d = 14, x = s * (13 + d / 2);
      const isBrick = rnd() < o.brick;
      const wallPick = o.palette[Math.floor(rnd() * o.palette.length)];
      const wall: THREE.Material = isBrick ? M.brick : wallPick.mat;
      wbox(d, h, w, wall, x, h / 2, z - w / 2, isBrick ? 2.4 : 3, isBrick ? undefined : wallPick.tint);
      if (s === SUN_SIDE) boxes.push(new THREE.Box3(new THREE.Vector3(x - d / 2, 0, z - w), new THREE.Vector3(x + d / 2, h + 0.5, z)));
      const fx = s * 13;
      // shopfront
      wbox(0.15, 3.0, w - 1.5, M.glass, fx + s * 0.02, 1.7, z - w / 2, 1);
      wbox(0.2, 3.05, w - 1.4, M.shop, fx + s * 0.04, 1.7, z - w / 2, 1);
      for (let q = -(w - 1.5) / 2; q <= (w - 1.5) / 2 + 0.01; q += 1.6) wbox(0.14, 3.0, 0.08, M.dark, fx - s * 0.02, 1.7, z - w / 2 + q, 1);
      wbox(0.12, 0.2, w - 1.3, M.frame, fx - s * 0.02, 3.25, z - w / 2, 1);
      // sign + backing
      const sw = Math.min(w - 2, 8);
      facePlane(sw, 1.5, M.signs.mat, fx - s * 0.18, 4.25, z - w / 2, s, M.signs.regions[Math.floor(rnd() * 14)]);
      wbox(0.25, 1.7, sw + 0.2, M.dark, fx - s * 0.06, 4.25, z - w / 2, 1);
      if (rnd() < 0.7) {
        const ag = new THREE.PlaneGeometry(Math.min(w - 1.5, 9), 1.6);
        ag.rotateX(-0.55); ag.rotateY(-s * Math.PI / 2);
        add(remapV(ag, M.awnings.regions[Math.floor(rnd() * 4)]), M.awnings.mat, fx - s * 0.7, 3.35, z - w / 2);
      }
      facePlane(w, 3.2, M.grime, fx - s * 0.01, 1.6, z - w / 2, s);
      if (o.towers && rnd() < 0.45) { const gw = 3 + rnd() * 2; facePlane(gw, gw * 0.5, M.graffiti.mat, fx - s * 0.025, 1.3, z - 0.5 - gw / 2 - rnd() * Math.max(0.1, w - gw - 1), s, M.graffiti.regions[Math.floor(rnd() * 8)]); }
      for (let f = 1; f < floors; f++) for (let k = 0; k < Math.floor(w / 3); k++) {
        const wz = z - 1.6 - k * 3, wy = f * 3.4 + 2.0;
        wbox(0.1, 1.5, 1.4, M.glass, fx - s * 0.04, wy, wz, 1);
        wbox(0.14, 0.1, 1.6, M.frame, fx - s * 0.05, wy + 0.8, wz, 1);
        wbox(0.2, 0.1, 1.6, M.frame, fx - s * 0.08, wy - 0.8, wz, 1);
        if (rnd() < 0.3) wbox(0.55, 0.4, 0.7, M.ac, fx - s * 0.3, wy - 0.6, wz + 0.2, 1);
      }
      wbox(0.5, 0.5, w, M.walls[0].mat, fx - s * 0.1, h + 0.2, z - w / 2, 1, M.walls[0].tint);
      if (isBrick) for (let f = 1; f < floors; f++) {
        const fy = f * 3.4 + 1.0, ez = z - w * 0.35;
        wbox(1.1, 0.06, 3.2, M.iron, fx - s * 0.55, fy, ez, 1);
        for (let q = -1.55; q <= 1.56; q += 0.26) wbox(0.03, 0.9, 0.03, M.iron, fx - s * 1.08, fy + 0.45, ez + q, 1);
        wbox(0.04, 0.04, 3.2, M.iron, fx - s * 1.08, fy + 0.9, ez, 1);
        for (const r of [-0.22, 0.22]) { const rail = new THREE.BoxGeometry(0.04, 3.9, 0.04); add(rail, M.iron, fx - s * 0.55 + r, fy + 1.7, ez, 0.85 * s); }
      }
      if (rnd() < 0.45 && o.towers) {
        const tx = x + s * rnd() * 3, tz = z - w * (0.3 + rnd() * 0.4);
        add(new THREE.CylinderGeometry(1.2, 1.2, 2.2, 16), M.tank, tx, h + 2.1, tz);
        add(new THREE.ConeGeometry(1.3, 0.8, 16), M.tank, tx, h + 3.6, tz);
        for (const [lx, lz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) wbox(0.1, 1.0, 0.1, M.iron, tx + lx, h + 0.5, tz + lz, 1);
      }
      if (rnd() < 0.6) wbox(1.1, 0.8, 0.9, M.ac, x + (rnd() - 0.5) * 6, h + 0.4, z - 1.5 - rnd() * Math.max(0.1, w - 3), 1);
      if (rnd() < 0.3 && h < 11) {
        const bw = Math.min(w - 1, 9);
        facePlane(bw, bw * 0.42, M.ads.mat, fx + s * 1.0, h + 1.2 + bw * 0.21, z - w / 2, s, M.ads.regions[Math.floor(rnd() * 4)]);
        wbox(0.3, bw * 0.42 + 0.3, bw + 0.3, M.dark, fx + s * 1.15, h + 1.2 + bw * 0.21, z - w / 2, 1);
        for (const q of [-bw / 3, bw / 3]) wbox(0.2, 1.3, 0.2, M.iron, fx + s * 1.3, h + 0.6, z - w / 2 + q, 1);
      }
      if (o.towers && rnd() < 0.5) { const th = 30 + rnd() * 60, tw = 14 + rnd() * 10; wbox(tw, th, tw, M.glassT, s * (36 + rnd() * 20), th / 2, z - w / 2 - rnd() * 10, 24); }
      const gap = s === SUN_SIDE && rnd() < 0.8 ? 4 + rnd() * 5 : 0.2;
      z -= w + gap;
      yield;
    }
  }

  /** Beach side of the promenade: lifeguard tower, parasols, loungers. */
  private *beachSide(c: any): Generator<void, void, void> {
    const { rnd, add, wbox } = c, M = this.mats;
    // lifeguard tower on the sand
    const tz = -15 - rnd() * 30, tx = -30 - rnd() * 14;
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) wbox(0.16, 2.6, 0.16, M.white, tx + dx * 1.1, 1.1, tz + dz * 1.1, 1);
    wbox(2.6, 0.12, 2.6, M.white, tx, 2.4, tz, 1);
    wbox(2.4, 1.6, 2.4, M.lifeguard, tx, 3.25, tz, 1);
    wbox(2.5, 0.5, 0.06, M.glass, tx, 3.5, tz + 1.23, 1);
    add(new THREE.ConeGeometry(2.3, 0.9, 4), M.white, tx, 4.5, tz, 0, Math.PI / 4);
    for (let k = 0; k < 7; k++) { const st = new THREE.BoxGeometry(2.0, 0.08, 0.3); add(st, M.white, tx + 2.3, 0.3 + k * 0.33, tz, 0, 0, -0.55); }
    yield;
    // parasols + loungers
    for (let i = 0; i < 6; i++) {
      const x = -18 - rnd() * 40, z = -2 - rnd() * (CHUNK - 4);
      add(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6), M.white, x, 1.0, z);
      const cone = new THREE.ConeGeometry(1.4, 0.55, 16, 1, true);
      add(remapV(cone, M.awnings.regions[Math.floor(rnd() * 4)]), M.awnings.mat, x, 2.25, z);
      wbox(0.7, 0.12, 1.9, M.white, x + 0.9, 0.05, z + 0.4, 1);
    }
    yield;
  }

  /** Downtown: glass towers straight off the sidewalk, lobbies, canopies, bus stops. */
  private *towerRow(c: any, s: number): Generator<void, void, void> {
    const { rnd, wbox, facePlane, boxes } = c, M = this.mats;
    let z = 0;
    while (z > -CHUNK + 6) {
      const w = Math.min(16 + Math.floor(rnd() * 3) * 4, z + CHUNK);
      if (w < 8) break;
      const h = 34 + rnd() * 50, d = 18, x = s * (13 + d / 2);
      wbox(d, h - 5, w, M.glassT, x, 5 + (h - 5) / 2, z - w / 2, 16);
      wbox(d - 1, 5, w - 1, M.dark, x + s * 0.5, 2.5, z - w / 2, 2);
      if (s === SUN_SIDE) boxes.push(new THREE.Box3(new THREE.Vector3(x - d / 2, 0, z - w), new THREE.Vector3(x + d / 2, h, z)));
      const fx = s * 13;
      // lobby: lit glass with mullions, a canopy and a sign
      wbox(0.15, 4.2, w - 1.5, M.glass, fx + s * 0.02, 2.3, z - w / 2, 1);
      wbox(0.2, 0.18, w - 1.6, M.shop, fx + s * 0.05, 4.25, z - w / 2, 1); // lit lobby ceiling strip
      for (let q = -(w - 1.5) / 2; q <= (w - 1.5) / 2 + 0.01; q += 2.2) wbox(0.14, 4.2, 0.1, M.chrome, fx - s * 0.02, 2.3, z - w / 2 + q, 1);
      wbox(2.4, 0.25, w - 2, M.dark, fx - s * 1.2, 4.6, z - w / 2, 1);
      if (rnd() < 0.6) facePlane(Math.min(w - 4, 8), 1.4, M.signs.mat, fx - s * 2.42, 5.3, z - w / 2, s, M.signs.regions[Math.floor(rnd() * 14)]);
      // bus stop on the sidewalk
      if (rnd() < 0.5) {
        const bz = z - w / 2, bx = s * 11.6;
        wbox(1.6, 0.12, 4, M.dark, bx, 2.6, bz, 1);
        wbox(0.06, 2.4, 4, M.glass, bx + s * 0.75, 1.3, bz, 1);
        facePlane(1.6, 2.2, M.ads.mat, bx + s * 0.72, 1.4, bz + 1.4, s, M.ads.regions[Math.floor(rnd() * 4)]);
        for (const q of [-1.9, 1.9]) wbox(0.08, 2.6, 0.08, M.chrome, bx + s * 0.75, 1.3, bz + q, 1);
        wbox(0.4, 0.45, 2.6, M.wood, bx + s * 0.4, 0.45, bz, 1);
      }
      z -= w + 0.4;
      yield;
    }
  }

  private tree(add: Add, x: number, z: number, rnd: () => number) {
    const M = this.mats, h = 3 + rnd() * 1.5;
    add(new THREE.CylinderGeometry(0.1, 0.16, h, 6), M.trunk, x, h / 2, z);
    for (let k = 0; k < 3; k++) {
      const r = 1.1 + rnd() * 0.6, g = new THREE.IcosahedronGeometry(r, 1);
      add(g, M.leaf, x + (rnd() - 0.5) * 0.8, h + 0.4 + k * 0.5, z + (rnd() - 0.5) * 0.8);
    }
    add(new THREE.BoxGeometry(1.4, 0.12, 1.4), M.iron, x, 0.2, z);
  }

  private palm(add: Add, x: number, z: number, h: number, rnd: () => number) {
    const M = this.mats;
    const tg = new THREE.CylinderGeometry(0.18, 0.32, h, 8, 16);
    const p = tg.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i), ring = 1 + 0.06 * Math.abs(Math.sin(y * 9));
      p.setX(i, p.getX(i) * ring + Math.sin(((y + h / 2) / h) * 1.6) * 0.25);
      p.setZ(i, p.getZ(i) * ring);
    }
    tg.computeVertexNormals();
    add(tg, M.trunk, x, h / 2, z);
    for (let k = 0; k < 14; k++) {
      const f = new THREE.PlaneGeometry(2.2, 4.8, 1, 8);
      const fp = f.attributes.position;
      for (let i = 0; i < fp.count; i++) { const yy = fp.getY(i) + 2.4; fp.setZ(i, -yy * yy * 0.11); fp.setY(i, yy); }
      f.computeVertexNormals();
      add(f, M.frond, x + 0.25, h, z, -0.25 - rnd() * 0.4, (k / 14) * Math.PI * 2 + rnd() * 0.2);
    }
    add(new THREE.CylinderGeometry(0.55, 0.35, 1.4, 10), M.skirt, x + 0.25, h - 0.7, z);
  }

  private car(add: Add,
    x: number, z: number, ry: number, color: THREE.Color, suv: boolean) {
    const M = this.mats;
    // the car shape is built once per type and copied (building it from scratch is slow)
    const key = suv ? 1 : 0;
    this.carCache[key] ??= buildCarParts(M, M.paint, suv).map(({ geo, mat }) => ({ geo: geo.index ? geo.toNonIndexed() : geo, mat }));
    for (const { geo: proto, mat } of this.carCache[key]) {
      const geo = proto.clone();
      if (mat === M.paint) { // shared paint material: colour per vertex
        const g = geo.index ? geo.toNonIndexed() : geo, n = g.attributes.position.count, c = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
        g.setAttribute('color', new THREE.BufferAttribute(c, 3));
        g.rotateY(ry); add(g, mat, x, 0, z); continue;
      }
      geo.rotateY(ry); add(geo, mat, x, 0, z);
    }
  }

  private buildBackdrop() {
    const hill = new THREE.MeshStandardMaterial({ color: '#8a7a5a', roughness: 1 });
    const rnd = makeRng(5);
    const geos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 14; i++) {
      const g = new THREE.SphereGeometry(60 + rnd() * 50, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
      g.scale(1.6, 0.35 + rnd() * 0.25, 1);
      g.translate(-300 + i * 48, -4, -420 - rnd() * 80);
      geos.push(clean(g));
    }
    const m = new THREE.Mesh(mergeGeometries(geos), hill);
    this.backdrop.add(m);
  }
}

/** A car built from rounded parts; returned as (geometry, material) pairs in car-local space (length along x). */
export function buildCarParts(M: Record<string, any>, paint: THREE.Material, suv: boolean) {
  const out: { geo: THREE.BufferGeometry; mat: THREE.Material }[] = [];
  const push = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    geo.rotateX(rx); geo.rotateY(ry); geo.rotateZ(rz); geo.translate(x, y, z); out.push({ geo, mat });
  };
  const len = suv ? 4.8 : 4.7, hb = suv ? 0.85 : 0.6, wid = 1.86, ch = suv ? 0.78 : 0.6, cl = suv ? 3.1 : 2.7;
  push(new RoundedBoxGeometry(len, hb, wid, 2, 0.22), paint, 0, 0.38 + hb / 2, 0);
  const cx0 = suv ? -0.35 : -0.25, cy0 = 0.38 + hb - 0.04, fr = suv ? 0.35 : 0.55, rr = suv ? 0.15 : 0.4;
  const gs = new THREE.Shape();
  gs.moveTo(-cl / 2 - 0.05, 0); gs.lineTo(cl / 2 + 0.1, 0); gs.lineTo(cl / 2 - fr, ch); gs.lineTo(-cl / 2 + rr, ch); gs.lineTo(-cl / 2 - 0.05, 0);
  const gg = new THREE.ExtrudeGeometry(gs, { depth: wid - 0.26, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2 });
  gg.translate(0, 0, -(wid - 0.26) / 2);
  push(gg, M.glass, cx0, cy0, 0);
  push(new RoundedBoxGeometry(cl - fr - rr + 0.12, 0.07, wid - 0.16, 2, 0.03), paint, cx0 + (rr - fr) / 2, cy0 + ch + 0.03, 0);
  for (const sz of [-1, 1]) {
    push(new THREE.BoxGeometry(0.1, ch, 0.03), paint, cx0 + (rr - fr) / 2 - 0.05, cy0 + ch / 2, sz * (wid / 2 - 0.06));
    push(new THREE.BoxGeometry(len * 0.86, 0.025, 0.012), M.chrome, 0, cy0 + 0.02, sz * (wid / 2 + 0.003));
    push(new RoundedBoxGeometry(0.16, 0.11, 0.12, 2, 0.03), paint, cx0 + cl / 2 - 0.15, cy0 + 0.12, sz * (wid / 2 + 0.08));
    for (const wx of [-len * 0.31, len * 0.31]) {
      push(new THREE.CylinderGeometry(0.37, 0.37, 0.27, 12), M.tire, wx, 0.37, sz * 0.86, Math.PI / 2);
      push(new THREE.CylinderGeometry(0.24, 0.24, 0.29, 10), M.rim, wx, 0.37, sz * 0.86, Math.PI / 2);
    }
  }
  push(new THREE.BoxGeometry(0.03, 0.2, 1.0), M.dark, len / 2 + 0.005, 0.38 + hb * 0.45, 0);
  for (const sx of [-1, 1]) push(new RoundedBoxGeometry(0.2, 0.28, wid + 0.02, 2, 0.08), M.dark, sx * len / 2, 0.5, 0);
  for (const wz of [-0.62, 0.62]) {
    push(new THREE.BoxGeometry(0.06, 0.13, 0.42), M.head, len / 2 + 0.01, 0.38 + hb * 0.7, wz);
    push(new THREE.BoxGeometry(0.06, 0.15, 0.45), M.tail, -len / 2 - 0.01, 0.38 + hb * 0.72, wz);
  }
  push(new THREE.BoxGeometry(0.02, 0.12, 0.42), M.plate, -len / 2 - 0.12, 0.52, 0);
  return out;
}
