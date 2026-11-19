import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { HEAT } from './materials';

export type TimeName = 'MORNING' | 'NOON' | 'SUNSET' | 'NIGHT';
export const TIME_NAMES: TimeName[] = ['MORNING', 'NOON', 'SUNSET', 'NIGHT'];

interface Key {
  elev: number; azim: number; // sun (or moon) direction, degrees; azimuth keeps the light on the +x side (shade boxes)
  sun: string; sunI: number;
  sky: string; ground: string; hemiI: number;
  fog: string; fogD: number;
  env: number; exposure: number;
  turb: number; ray: number; mie: number;
  heat: number; // glowing hot asphalt in sunlit stripes
  burn: number; // how hard the sun dries you out (gameplay)
  night: number; // 0..1: dark dome, stars, glowing city
}

// keyframes: index 0 morning, 1 noon, 2 sunset, 3 night
const K: Key[] = [
  { elev: 10, azim: 62, sun: '#ffcf9e', sunI: 5.2, sky: '#d6c8ff', ground: '#5a4a52', hemiI: 0.45, fog: '#efd3c4', fogD: 0.0042, env: 0.65, exposure: 0.9, turb: 4, ray: 3, mie: 0.006, heat: 0.15, burn: 0.7, night: 0 },
  { elev: 66, azim: 120, sun: '#fff4e6', sunI: 4.6, sky: '#bfdcff', ground: '#8a7f70', hemiI: 0.7, fog: '#cfe2f2', fogD: 0.0028, env: 1.0, exposure: 0.8, turb: 2, ray: 0.8, mie: 0.003, heat: 0.18, burn: 1.6, night: 0 },
  { elev: 24, azim: 100, sun: '#ffcf9a', sunI: 5.0, sky: '#bcd4ff', ground: '#5a4030', hemiI: 0.45, fog: '#e9c3a0', fogD: 0.0045, env: 0.85, exposure: 0.88, turb: 6, ray: 1.6, mie: 0.008, heat: 1, burn: 1, night: 0 },
  { elev: 55, azim: 70, sun: '#8aa4ff', sunI: 0.35, sky: '#24305c', ground: '#06060a', hemiI: 0.16, fog: '#0a1022', fogD: 0.006, env: 0.06, exposure: 1.05, turb: 1, ray: 0.2, mie: 0.001, heat: 0, burn: 0, night: 1 },
];

/** Time from the player's clock: the run starts at the real time of day. */
export function todFromClock(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= 5 && h < 10.5) return 0;
  if (h >= 10.5 && h < 16) return 1;
  if (h >= 16 && h < 20) return 2;
  return 3;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

export class Atmosphere {
  sky = new Sky();
  sun: THREE.DirectionalLight;
  hemi = new THREE.HemisphereLight('#bcd4ff', '#5a4030', 0.45);
  /** follows the street lamps the runner passes: warm light on the character at night */
  lampLight = new THREE.PointLight('#ffc27a', 0, 12, 2);
  /** cool moon outline on the runner at night */
  rim = new THREE.DirectionalLight('#6f8cff', 0);
  dir = new THREE.Vector3();
  burn = 1;
  night = 0;
  tod = 2;
  private dome: THREE.Mesh;
  private stars: THREE.Points;
  private ca = new THREE.Color(); private cb = new THREE.Color();

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer, shadowSize: number,
    private glow: { lamp: THREE.Color; signs: THREE.MeshStandardMaterial[]; towers: THREE.MeshStandardMaterial[]; pools: THREE.MeshBasicMaterial[] }) {
    this.sky.scale.setScalar(4000);
    scene.add(this.sky);
    // night sky: a dark dome over the day sky + stars, both faded in by `night`
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(3500, 24, 12), new THREE.MeshBasicMaterial({ color: '#05070f', side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.dome.renderOrder = -1;
    const pts: number[] = [];
    for (let i = 0; i < 1400; i++) {
      const u = Math.random(), v = Math.random() * 0.9 + 0.08, th = u * Math.PI * 2, ph = Math.acos(v);
      pts.push(Math.sin(ph) * Math.cos(th) * 3000, Math.cos(ph) * 3000, Math.sin(ph) * Math.sin(th) * 3000);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    scene.add(this.dome, this.stars);
    scene.fog = new THREE.FogExp2('#e9c3a0', 0.0045);
    this.sun = new THREE.DirectionalLight('#ffcf9a', 5);
    this.sun.target.position.set(0, 0, -20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    Object.assign(this.sun.shadow.camera, { left: -28, right: 28, top: 40, bottom: -40, near: 1, far: 220 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.rim.position.set(4, 3, -8);
    // all lights always exist (intensity 0 when unused): a changing light count would recompile every shader
    scene.add(this.sun, this.sun.target, this.hemi, this.lampLight, this.rim);
    this.set(2);
  }

  /** tod: 0 morning … 3 night, fractional values blend into the next phase (late in each phase). */
  set(tod: number) {
    this.tod = ((tod % 4) + 4) % 4;
    const i = Math.floor(this.tod), f = smooth(0.7, 1, this.tod - i);
    const a = K[i], b = K[(i + 1) % 4];
    const n = (k: keyof Key) => mix(a[k] as number, b[k] as number, f);
    const c = (k: keyof Key, out: THREE.Color) => out.set(a[k] as string).lerp(this.cb.set(b[k] as string), f);
    // direction: blend elevation/azimuth
    this.dir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - n('elev')), THREE.MathUtils.degToRad(n('azim'))).normalize();
    this.sun.position.copy(this.dir).multiplyScalar(80);
    c('sun', this.sun.color); this.sun.intensity = n('sunI');
    c('sky', this.hemi.color); c('ground', this.hemi.groundColor); this.hemi.intensity = n('hemiI');
    const fog = this.scene.fog as THREE.FogExp2;
    c('fog', fog.color); fog.density = n('fogD');
    this.scene.environmentIntensity = n('env');
    this.renderer.toneMappingExposure = n('exposure');
    const u = this.sky.material.uniforms;
    u.turbidity.value = n('turb'); u.rayleigh.value = n('ray'); u.mieCoefficient.value = n('mie'); u.mieDirectionalG.value = 0.9;
    this.night = n('night');
    // the day sky's sun sinks below the horizon as night falls
    u.sunPosition.value.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - mix(n('elev'), -10, this.night)), THREE.MathUtils.degToRad(n('azim')));
    HEAT.value = n('heat');
    this.burn = n('burn');
    // night: dark dome + stars, the city lights up
    (this.dome.material as THREE.MeshBasicMaterial).opacity = this.night;
    (this.stars.material as THREE.PointsMaterial).opacity = this.night;
    this.dome.visible = this.stars.visible = this.night > 0.01;
    this.sky.visible = this.night < 0.99;
    this.glow.lamp.setScalar(1 + 2.2 * this.night);
    for (const m of this.glow.signs) m.emissiveIntensity = mix(m.userData.dayGlow ?? 0.06, m.userData.nightGlow ?? 1.2, this.night);
    for (const m of this.glow.towers) m.emissiveIntensity = 0.9 * this.night;
    for (const m of this.glow.pools) m.opacity = 0.85 * this.night;
    this.rim.intensity = 0.9 * this.night;
  }

  /** Moves the warm lamp light to the street lamp nearest the runner (lamps every 20 m on both sides). */
  followLamps(lampZ: number, px: number) {
    if (this.night < 0.01) { this.lampLight.intensity = 0; return; }
    const side = px >= 0 ? 1 : -1;
    this.lampLight.position.set(side * 4.9, 6.4, lampZ);
    this.lampLight.intensity = 260 * this.night * smooth(14, 4, Math.abs(lampZ));
  }

  get name(): TimeName { return TIME_NAMES[Math.floor(this.tod + 0.15) % 4]; }
}
