import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  ASSET, adTexture, awningTexture, canvasTex, frondTexture, graffitiTexture, grimeTexture, heatify, makeRng, pbr, plateTexture, signTexture,
} from './materials';

export const LANES = [-2.5, 0, 2.5];
export const CHUNK = 60; // metres of street per recycled block
const NUM_CHUNKS = 5; // 300 m of street exists at any time (the haze hides the rest)
const SUN_SIDE = 1; // the sun is on the +x side, alleys there let light cut across the road

export const SUN_DIR = new THREE.Vector3()
  .setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 24), THREE.MathUtils.degToRad(100))
  .normalize();

type Batch = Map<THREE.Material, THREE.BufferGeometry[]>;

interface Chunk {
  group: THREE.Group;
  boxes: THREE.Box3[]; // shade casters in chunk-local space
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

export class World {
  group = new THREE.Group();
  private chunks: Chunk[] = [];
  mats!: Record<string, any>;
  private noShadow = new Set<THREE.Material>();
  private props: Record<string, THREE.Object3D> = {};
  private ray = new THREE.Ray();
  private tmpBox = new THREE.Box3();
  private tmpOff = new THREE.Vector3();

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
    const walls = [stA, stB, stC, ...stuccoTints.map((c, i) => { const m = [stA, stB, stC][i % 3].clone(); m.color.set(c); return m; })];
    onProgress(0.3, 'Building the street');

    const glassTowerTex = canvasTex(512, 512, (g) => {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) {
        const t = 0.85 + rnd() * 0.3;
        g.fillStyle = `rgb(${(30 * t) | 0},${(48 * t) | 0},${(62 * t) | 0})`;
        g.fillRect(x * 64, y * 32, 64, 32);
      }
      g.fillStyle = '#8a9096';
      for (let x = 0; x <= 8; x++) g.fillRect(x * 64 - 2, 0, 4, 512);
      for (let y = 0; y <= 16; y++) g.fillRect(0, y * 32 - 3, 512, 6);
    });
    glassTowerTex.wrapS = glassTowerTex.wrapT = THREE.RepeatWrapping;

    const decal = (map: THREE.Texture, extra: THREE.MeshStandardMaterialParameters = {}) =>
      P({ map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.9, ...extra });

    this.mats = {
      asp, pav, curb, brick, walls,
      paintW: heatify(P({ color: '#e8e6df', roughness: 0.6 })),
      glass: P({ color: '#10161c', metalness: 0.3, roughness: 0.04, envMapIntensity: 1.8 }),
      glassT: P({ map: glassTowerTex, metalness: 0.9, roughness: 0.08, envMapIntensity: 1.5 }),
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
      frond: P({ map: frondTexture(rnd), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.8 }),
      paint: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.28 }),
      paints: ['#101418', '#e8e8e6', '#7a0f14', '#1f3a5f', '#9aa0a4', '#0d0d0d', '#c9b38a', '#2f4a3a', '#c7c9cc'].map((c) =>
        new THREE.MeshStandardMaterial({ color: c, metalness: 0.6, roughness: 0.28 })), // obstacle cars
      paintColors: ['#101418', '#e8e8e6', '#7a0f14', '#1f3a5f', '#9aa0a4', '#0d0d0d', '#c9b38a', '#2f4a3a', '#c7c9cc'].map((c) => new THREE.Color(c)),
      grime: decal(grimeTexture()),
    };
    // one texture sheet per decal family: ~30 materials become 4 per street block
    const mk = (texs: THREE.Texture[], mat: (t: THREE.Texture) => THREE.Material) => { const a = atlas(texs); return { mat: mat(a.tex), regions: a.regions }; };
    this.mats.signs = mk(Array.from({ length: 14 }, (_, i) => signTexture(i, rnd)), (t) => P({ map: t, emissiveMap: t, emissive: '#fff', emissiveIntensity: 0.06, roughness: 0.6 }));
    this.mats.ads = mk(Array.from({ length: 4 }, (_, i) => adTexture(i, rnd)), (t) => P({ map: t, emissiveMap: t, emissive: '#fff', emissiveIntensity: 0.08, roughness: 0.5 }));
    this.mats.awnings = mk(Array.from({ length: 4 }, (_, i) => awningTexture(i)), (t) => P({ map: t, side: THREE.DoubleSide, roughness: 0.85 }));
    this.mats.graffiti = mk(Array.from({ length: 8 }, (_, i) => graffitiTexture(i, rnd)), (t) => decal(t));
    // materials that never need to cast shadows (ground, paint, decals, glass)
    this.noShadow = new Set<THREE.Material>([asp, pav, curb, this.mats.paintW, this.mats.grime, this.mats.signs.mat, this.mats.ads.mat, this.mats.graffiti.mat, this.mats.glass, this.mats.shop, this.mats.frame, this.mats.lamp]);

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
      const c = this.buildChunk(1000 + i * 77);
      c.group.position.z = -i * CHUNK;
      this.group.add(c.group);
      this.chunks.push(c);
    }
    this.buildBackdrop();
  }

  /** Moves the street toward the player; recycles blocks that fell behind the camera. */
  update(dz: number) {
    for (const c of this.chunks) {
      c.group.position.z += dz;
      if (c.group.position.z > CHUNK * 1.2) c.group.position.z -= NUM_CHUNKS * CHUNK;
    }
  }

  /** True if a building blocks the sun for a point at (x, y, 0). */
  isInShade(x: number, y: number) {
    this.ray.origin.set(x, y, 0);
    this.ray.direction.copy(SUN_DIR);
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
  private buildChunk(seed: number): Chunk {
    const rnd = makeRng(seed);
    const M = this.mats;
    const batch: Batch = new Map();
    const group = new THREE.Group();
    const boxes: THREE.Box3[] = [];

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
      geo.rotateX(rx); geo.rotateY(ry); geo.rotateZ(rz); geo.translate(x, y, z);
      if (!batch.has(mat)) batch.set(mat, []);
      batch.get(mat)!.push(clean(geo));
    };
    // box with world-scale UVs (ts = texture size in metres)
    const wbox = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, ts = 2) => {
      const g = new THREE.BoxGeometry(w, h, d);
      const uv = g.attributes.uv, p = g.attributes.position, n = g.attributes.normal;
      for (let i = 0; i < uv.count; i++) {
        const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
        const X = p.getX(i) + x, Y = p.getY(i) + y, Z = p.getZ(i) + z;
        if (ax > 0.5) uv.setXY(i, Z / ts, Y / ts); else if (ay > 0.5) uv.setXY(i, X / ts, Z / ts); else uv.setXY(i, X / ts, Y / ts);
      }
      add(g, mat, x, y, z);
    };
    const facePlane = (w: number, h: number, mat: THREE.Material, x: number, y: number, z: number, s: number, region?: [number, number]) =>
      add(remapV(new THREE.PlaneGeometry(w, h), region), mat, x, y, z, 0, -s * Math.PI / 2);

    const Lz = -CHUNK / 2; // chunk spans z in [-CHUNK, 0]
    // road, lane paint, sidewalks, curbs
    wbox(16, 0.3, CHUNK, M.asp, 0, -0.15, Lz, 3);
    for (let z = -4; z > -CHUNK; z -= 9) for (const x of [-1.25, 1.25]) wbox(0.14, 0.012, 3, M.paintW, x, 0.005, z, 1);
    for (const x of [-3.9, 3.9]) wbox(0.14, 0.012, CHUNK, M.paintW, x, 0.005, Lz, 1);
    for (const s of [-1, 1]) {
      wbox(5, 0.3, CHUNK, M.pav, s * 10.5, 0, Lz, 2);
      wbox(0.3, 0.32, CHUNK, M.curb, s * 8.1, 0, Lz, 1.5);
    }

    // buildings
    for (const s of [-1, 1]) {
      let z = 0;
      while (z > -CHUNK + 4) {
        const w = Math.min(10 + Math.floor(rnd() * 3) * 4, z + CHUNK);
        if (w < 6) break;
        const floors = 2 + Math.floor(rnd() * 3), h = floors * 3.4 + 0.8, d = 14, x = s * (13 + d / 2);
        const isBrick = rnd() < 0.3;
        const wall: THREE.Material = isBrick ? M.brick : M.walls[Math.floor(rnd() * M.walls.length)];
        wbox(d, h, w, wall, x, h / 2, z - w / 2, isBrick ? 2.4 : 3);
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
        // awning
        if (rnd() < 0.7) {
          const ag = new THREE.PlaneGeometry(Math.min(w - 1.5, 9), 1.6);
          ag.rotateX(-0.55); ag.rotateY(-s * Math.PI / 2);
          add(remapV(ag, M.awnings.regions[Math.floor(rnd() * 4)]), M.awnings.mat, fx - s * 0.7, 3.35, z - w / 2);
        }
        // grime + graffiti
        facePlane(w, 3.2, M.grime, fx - s * 0.01, 1.6, z - w / 2, s);
        if (rnd() < 0.45) { const gw = 3 + rnd() * 2; facePlane(gw, gw * 0.5, M.graffiti.mat, fx - s * 0.025, 1.3, z - 0.5 - gw / 2 - rnd() * Math.max(0.1, w - gw - 1), s, M.graffiti.regions[Math.floor(rnd() * 8)]); }
        // upper windows, sills, AC units
        for (let f = 1; f < floors; f++) for (let k = 0; k < Math.floor(w / 3); k++) {
          const wz = z - 1.6 - k * 3, wy = f * 3.4 + 2.0;
          wbox(0.1, 1.5, 1.4, M.glass, fx - s * 0.04, wy, wz, 1);
          wbox(0.14, 0.1, 1.6, M.frame, fx - s * 0.05, wy + 0.8, wz, 1);
          wbox(0.2, 0.1, 1.6, M.frame, fx - s * 0.08, wy - 0.8, wz, 1);
          if (rnd() < 0.3) wbox(0.55, 0.4, 0.7, M.ac, fx - s * 0.3, wy - 0.6, wz + 0.2, 1);
        }
        wbox(0.5, 0.5, w, M.walls[0], fx - s * 0.1, h + 0.2, z - w / 2, 1);
        // fire escape on brick
        if (isBrick) for (let f = 1; f < floors; f++) {
          const fy = f * 3.4 + 1.0, ez = z - w * 0.35;
          wbox(1.1, 0.06, 3.2, M.iron, fx - s * 0.55, fy, ez, 1);
          for (let q = -1.55; q <= 1.56; q += 0.26) wbox(0.03, 0.9, 0.03, M.iron, fx - s * 1.08, fy + 0.45, ez + q, 1);
          wbox(0.04, 0.04, 3.2, M.iron, fx - s * 1.08, fy + 0.9, ez, 1);
          for (const r of [-0.22, 0.22]) { const rail = new THREE.BoxGeometry(0.04, 3.9, 0.04); add(rail, M.iron, fx - s * 0.55 + r, fy + 1.7, ez, 0.85 * s); }
        }
        // rooftop
        if (rnd() < 0.45) {
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
        if (rnd() < 0.5) { const th = 30 + rnd() * 60, tw = 14 + rnd() * 10; wbox(tw, th, tw, M.glassT, s * (36 + rnd() * 20), th / 2, z - w / 2 - rnd() * 10, 24); }
        const gap = s === SUN_SIDE && rnd() < 0.8 ? 4 + rnd() * 5 : 0.2;
        z -= w + gap;
      }
    }

    // street lamps
    for (let z = -6; z > -CHUNK; z -= 20) for (const s of [-1, 1]) {
      wbox(0.22, 8.5, 0.22, M.pole, s * 8.6, 4.25, z, 1);
      wbox(2.2, 0.15, 0.15, M.pole, s * 7.6, 8.4, z, 1);
      wbox(0.7, 0.15, 0.35, M.lamp, s * 6.5, 8.27, z, 1);
    }
    // palms
    for (let z = -2; z > -CHUNK; z -= 12) for (const s of [-1, 1]) this.palm(add, s * 9.0, z - (s > 0 ? 6 : 0), 14 + rnd() * 8, rnd);
    // parked cars
    for (let z = -4; z > -CHUNK + 3; z -= 6.5) for (const s of [-1, 1]) if (rnd() < 0.75) this.car(add, s * 6.1, z - rnd() * 1.2, s > 0 ? -Math.PI / 2 : Math.PI / 2, M.paintColors[Math.floor(rnd() * M.paintColors.length)], rnd() < 0.3);

    // real props (Poly Haven, simplified): baked into the block's batches so they cost no extra draw calls
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
    for (let z = -6; z > -CHUNK; z -= 17) {
      const s = rnd() < 0.5 ? -1 : 1;
      put('metal_trash_can', s * 8.85, 0.15, z, rnd() * 6);
      put('fire_hydrant', -s * 8.55, 0.15, z - 5, rnd() * 6);
      if (rnd() < 0.7) put(rnd() < 0.5 ? 'potted_plant_02' : 'planter_box_01', s * 12.3, 0.15, z - 3, rnd() * 6);
    }
    for (let z = -8; z > -CHUNK; z -= 23) put('water_manhole_cover', (rnd() - 0.5) * 5, 0.004, z, rnd() * 6);

    for (const [mat, geos] of batch) {
      const mesh = new THREE.Mesh(mergeGeometries(geos, false), mat);
      mesh.castShadow = !this.noShadow.has(mat) && !(mat as THREE.MeshStandardMaterial).transparent;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }
    return { group, boxes };
  }

  private palm(add: (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number) => void, x: number, z: number, h: number, rnd: () => number) {
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

  private car(add: (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx?: number, ry?: number, rz?: number) => void,
    x: number, z: number, ry: number, color: THREE.Color, suv: boolean) {
    const M = this.mats;
    const parts = buildCarParts(M, M.paint, suv);
    for (const { geo, mat } of parts) {
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
  backdrop = new THREE.Group(); // static: hills far away, doesn't scroll
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
