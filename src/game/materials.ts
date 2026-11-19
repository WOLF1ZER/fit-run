import * as THREE from 'three';

export const ASSET = '/assets';

// Seeded RNG so every street block is reproducible.
export function makeRng(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------- photo-scanned PBR sets (Poly Haven, CC0) ----------
const loader = new THREE.TextureLoader();
const texCache = new Map<string, Promise<THREE.Texture>>();
function loadTex(url: string, srgb: boolean) {
  const key = url + srgb;
  if (!texCache.has(key)) {
    texCache.set(
      key,
      loader.loadAsync(url).then((t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 8;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        return t;
      }),
    );
  }
  return texCache.get(key)!;
}

export async function pbr(id: string, repeat: number, extra: THREE.MeshStandardMaterialParameters = {}) {
  const [d, n, a] = await Promise.all([
    loadTex(`${ASSET}/tex/${id}/diff.jpg`, true),
    loadTex(`${ASSET}/tex/${id}/nor.jpg`, false),
    loadTex(`${ASSET}/tex/${id}/arm.jpg`, false),
  ]);
  // share the loaded textures (a clone would upload a second copy to the GPU)
  const set = [d, n, a];
  for (const t of set) t.repeat.set(repeat, repeat);
  return new THREE.MeshStandardMaterial({
    map: set[0],
    normalMap: set[1],
    aoMap: set[2],
    roughnessMap: set[2],
    metalnessMap: set[2],
    roughness: 1,
    metalness: 1,
    aoMapIntensity: 0.9,
    ...extra,
  });
}

// Sunlit ground glows hot; shade stays cool. The danger zones read at a glance.
/** How strongly sunlit ground glows hot (1 at sunset, lower at other times of day, 0 at night). */
const depthMats = new Map<string, THREE.MeshDepthMaterial>();
/**
 * Gives every shadow caster a depth material shared only with casters of the same kind.
 * three.js otherwise draws all casters with ONE depth material and copies each object's map/side onto it,
 * rebuilding its shader key only when instancing/skinning flips between consecutive draws, so which shader
 * variants exist depends on draw order: a new mix of objects in the shadow box compiled a new one mid-run
 * (a ~50 ms freeze). With one material per kind, each compiles once, during the loading warm-up.
 */
export function stableShadow(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.castShadow || Array.isArray(m.material)) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    // alpha-tested / displaced materials need their own textures in the depth pass, so they get their own
    const own = mat.alphaTest > 0 || (!!mat.displacementMap && mat.displacementScale !== 0);
    const key = [(m as THREE.InstancedMesh).isInstancedMesh ? 'i' : '', (m as THREE.SkinnedMesh).isSkinnedMesh ? 's' : '', mat.side, mat.shadowSide, mat.map ? 'm' : '', own ? mat.uuid : ''].join('|');
    let d = depthMats.get(key);
    if (!d) { d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }); depthMats.set(key, d); }
    m.customDepthMaterial = d;
  });
}

export const HEAT = { value: 1 };

export function heatify(m: THREE.Material, lo = 0.12, hi = 0.4) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uHeat = HEAT;
    sh.fragmentShader = 'uniform float uHeat;\n' + sh.fragmentShader.replace(
      '#include <aomap_fragment>',
      `
      float irr = dot(reflectedLight.directDiffuse, vec3(.3333)) / max(dot(diffuseColor.rgb, vec3(.3333)), .03);
      float heat = smoothstep(${lo.toFixed(3)}, ${hi.toFixed(3)}, irr) * uHeat;
      float lum = dot(diffuseColor.rgb, vec3(.3333));
      float vein = 1. - smoothstep(.012, .05, lum);
      reflectedLight.directDiffuse *= mix(vec3(1.), vec3(.55, .36, .28), heat);
      reflectedLight.indirectDiffuse *= mix(vec3(.8, .95, 1.3), vec3(1.), heat);
      totalEmissiveRadiance += vec3(1., .24, .03) * heat * (.16 + 2.4 * vein * vein);
      #include <aomap_fragment>`,
    );
  };
  m.customProgramCacheKey = () => 'heat' + lo + hi;
  return m;
}

// ---------- generated street graphics ----------
const SIGN_NAMES = ['DINER', 'LIQUOR', 'PHARMACY', 'TACOS', 'AUTO PARTS', 'DONUTS', 'LAUNDRY', 'PIZZA', 'GYM 24/7', 'JUICE BAR', 'MOTEL', 'BURGERS', 'TATTOO', 'SNEAKERS'];
const SIGN_COLORS = [['#c2271e', '#fff6e0'], ['#10233f', '#ffd23f'], ['#f4efe2', '#b01818'], ['#0e5a44', '#f6f1e0'], ['#1b1b1b', '#ff4fa3'], ['#ffd23f', '#1b1b1b'], ['#1d4f9a', '#ffffff']];

export function signTexture(i: number, rnd: () => number) {
  const [bg, fg] = SIGN_COLORS[i % SIGN_COLORS.length];
  const txt = SIGN_NAMES[i % SIGN_NAMES.length];
  return canvasTex(512, 96, (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,.25)';
    g.fillRect(0, h - 10, w, 10);
    g.font = '900 58px Arial Black, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = fg;
    g.fillText(txt, w / 2, h / 2 + 2, w - 30);
    for (let k = 0; k < 300; k++) {
      g.fillStyle = `rgba(0,0,0,${rnd() * 0.08})`;
      g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 6, 1 + rnd() * 3);
    }
  });
}

const ADS: [string, string, string, string][] = [
  ['#0b0b0b', '#9dff3a', 'RUN CLUB', 'EVERY MILE COUNTS'],
  ['#c4161c', '#ffffff', 'WHEY+', '30G PROTEIN · ZERO EXCUSES'],
  ['#0f4fd6', '#ffffff', 'HYDRATE', 'DRINK BEFORE YOU THIRST'],
  ['#ff7a00', '#111111', 'BEAST FUEL', 'ENERGY FOR THE LAST KM'],
];
export function adTexture(i: number, rnd: () => number) {
  const [bg, fg, t1, t2] = ADS[i % ADS.length];
  return canvasTex(1024, 430, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, bg);
    gr.addColorStop(1, '#000');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    g.textBaseline = 'middle';
    g.font = '900 170px Arial Black, Arial, sans-serif';
    g.fillText(t1, 50, h * 0.42, w - 100);
    g.font = '700 52px Arial, sans-serif';
    g.fillText(t2, 56, h * 0.78, w - 100);
    for (let k = 0; k < 1200; k++) {
      g.fillStyle = `rgba(255,255,255,${rnd() * 0.05})`;
      g.fillRect(rnd() * w, rnd() * h, 2, 2);
    }
  });
}

export function awningTexture(i: number) {
  const [a, b] = [['#b3261e', '#f4efe4'], ['#1d4f9a', '#f4efe4'], ['#0e6b4f', '#efe7d2'], ['#2b2b2b', '#d9c27a']][i % 4];
  return canvasTex(256, 128, (g, w, h) => {
    for (let k = 0; k < 8; k++) {
      g.fillStyle = k % 2 ? b : a;
      g.fillRect(k * 32, 0, 32, h);
    }
    g.fillStyle = 'rgba(0,0,0,.25)';
    g.fillRect(0, h - 14, w, 14);
  });
}

const TAGS = ['KR1ZE', 'SLAM', 'NOVA', 'RUSH', 'DZK', 'ZERO', 'OMEN', 'VEX'];
export function graffitiTexture(i: number, rnd: () => number) {
  const cols = ['#ff3d7f', '#2fd3ff', '#ffd400', '#7cff4f', '#ff7a1a', '#b36bff'];
  const c1 = cols[i % 6], c2 = cols[(i + 2) % 6], tag = TAGS[i % TAGS.length];
  return canvasTex(512, 256, (g, w, h) => {
    g.lineJoin = 'round';
    g.font = `900 ${110 + ((rnd() * 30) | 0)}px Arial Black, Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.save();
    g.translate(w / 2, h / 2);
    g.rotate((rnd() - 0.5) * 0.25);
    g.strokeStyle = '#111';
    g.lineWidth = 22;
    g.strokeText(tag, 0, 0, w - 40);
    const gr = g.createLinearGradient(0, -60, 0, 60);
    gr.addColorStop(0, c1);
    gr.addColorStop(1, c2);
    g.fillStyle = gr;
    g.fillText(tag, 0, 0, w - 40);
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    g.strokeText(tag, 0, 0, w - 40);
    g.restore();
  });
}

export const grimeTexture = () =>
  canvasTex(64, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, 'rgba(30,22,16,0)');
    gr.addColorStop(0.6, 'rgba(30,22,16,0.25)');
    gr.addColorStop(1, 'rgba(20,15,10,0.7)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });

export const plateTexture = (n: number) =>
  canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = '#f4f4f0';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#223';
    g.lineWidth = 6;
    g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = '#1a2a6a';
    g.font = '900 58px Arial';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('7FIT' + n, w / 2, h / 2 + 6);
  });

export const labelTexture = (bg: string, txt: string) =>
  canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = '900 44px Arial Black, Arial';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(txt, w / 2, h / 2 - 8);
    g.font = '700 20px Arial';
    g.fillText('30G PROTEIN', w / 2, h / 2 + 30);
  });

// Palm frond with alpha leaflets.
export const frondTexture = (rnd: () => number) =>
  canvasTex(128, 512, (g) => {
    g.strokeStyle = '#3a5a22';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(64, 0);
    g.lineTo(64, 512);
    g.stroke();
    for (let y = 20; y < 500; y += 7) {
      const l = 60 * Math.sin((y / 512) * Math.PI) + 8;
      g.strokeStyle = `rgb(${(70 + rnd() * 40) | 0},${(110 + rnd() * 40) | 0},45)`;
      g.lineWidth = 3;
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(64, y);
        g.quadraticCurveTo(64 + s * l * 0.6, y + 6, 64 + s * l, y + 24);
        g.stroke();
      }
    }
  });
