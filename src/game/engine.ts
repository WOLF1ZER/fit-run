import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { World, SUN_DIR, LANES } from './world';
import { Player } from './player';
import { Entities, type ItemKind, type ObstacleKind } from './entities';
import { growthForLevel, BEAST_K } from './growth';
import { hud, loadProfile, saveProfile, type Pop } from './store';
import { sfx, unlockAudio } from './audio';
import { ASSET } from './materials';

// ---- tuning ----
const BEAST_TIME = 8;
const SECOND_WIND_TIME = 3.2;
const SECOND_WIND_TAPS = 12;
const xpForLevel = (lvl: number) => 3 + lvl; // shakes needed to go from lvl to lvl+1
const COMBO_LABELS: [number, string][] = [[35, 'INSANE!'], [20, 'PERFECT'], [10, 'GREAT'], [5, 'NICE']];

export class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(52, 1, 0.1, 900);
  private clock = new THREE.Clock();
  private world = new World();
  private player = new Player();
  private ents = new Entities();
  private sun!: THREE.DirectionalLight;
  private raf = 0;
  private disposed = false;
  private quality: 'high' | 'low';
  private dpr: number;
  private maxDpr: number;
  private fpsAcc = { t: 0, n: 0 };

  // run state
  private t = 0;
  private distance = 0;
  private speed = 0;
  private stamina = 100;
  private hydration = 100;
  private level = 1;
  private xp = 0;
  private shakes = 0;
  private shakeStreak = 0;
  private combo = 0;
  private beast = 0;
  private heavy = 0;
  private bonus = 0;
  private nextRow = 30;
  private shakeCam = 0;
  private inShade = true;
  private secondWindUsed = false;
  private swTime = 0;
  private swTaps = 0;
  private pops: Pop[] = [];
  private popId = 0;
  private hudTimer = 0;
  private beatTimer = 0;
  private profile = loadProfile();
  private startLevel = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const mobile = matchMedia('(pointer: coarse)').matches;
    this.quality = mobile ? 'low' : 'high';
    // pixel budget: rendering at 2x on a laptop/phone costs 4x the work for little visible gain
    this.maxDpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5);
    this.dpr = this.maxDpr;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.dpr < 1.5, powerPreference: 'high-performance', stencil: false });
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 0.88;
    this.resize();
    window.addEventListener('resize', this.resize);
    hud.set({ quality: this.quality, best: this.profile.best });
  }

  // ------------------------------------------------------------------ setup
  async load() {
    const step = (p: number, label: string) => hud.set({ loadProgress: p, loadLabel: label });
    step(0.02, 'Lighting the city');
    const pm = new THREE.PMREMGenerator(this.renderer);
    const exr = await new EXRLoader().loadAsync(`${ASSET}/sunset.exr`);
    this.scene.environment = pm.fromEquirectangular(exr).texture;
    this.scene.environmentIntensity = 0.85;
    const sky = new Sky();
    sky.scale.setScalar(4000);
    const u = sky.material.uniforms;
    u.turbidity.value = 6; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.008; u.mieDirectionalG.value = 0.9;
    u.sunPosition.value.copy(SUN_DIR);
    this.scene.add(sky);
    this.scene.fog = new THREE.FogExp2('#e9c3a0', 0.0045);
    this.sun = new THREE.DirectionalLight('#ffcf9a', 5);
    this.sun.position.copy(SUN_DIR).multiplyScalar(80);
    this.sun.target.position.set(0, 0, -20);
    this.sun.castShadow = true;
    const sm = this.quality === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    Object.assign(this.sun.shadow.camera, { left: -28, right: 28, top: 40, bottom: -40, near: 1, far: 220 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new THREE.HemisphereLight('#bcd4ff', '#5a4030', 0.45));

    await this.world.init((f, l) => step(0.05 + f * 0.45, l));
    this.scene.add(this.world.group, this.world.backdrop);
    step(0.55, 'Loading your athlete');
    await this.player.load((f) => step(0.55 + f * 0.3, 'Loading your athlete'));
    this.scene.add(this.player.root);
    step(0.88, 'Joggers & snacks');
    await this.ents.init(this.world.mats);
    this.scene.add(this.ents.group);
    // warm-up: put one of every pickup/obstacle in view and render once, so all shaders and
    // textures are on the GPU before the run (no mid-run stalls when joggers first appear)
    step(0.95, 'Warming up');
    const kinds = ['shake', 'water', 'banana', 'burger', 'soda'] as const;
    kinds.forEach((k, i) => this.ents.spawnItem(k, i % 3, -6 - i * 2));
    (['car', 'barrier', 'banner', 'jogger', 'jogger', 'jogger', 'jogger'] as const).forEach((k, i) => this.ents.spawnObstacle(k, i % 3, -14 - i * 4));
    this.camera.position.set(0, 2.3, 3.3);
    this.camera.lookAt(0, 1.2, -9);
    this.renderer.compile(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
    this.ents.clear();
    step(1, 'Ready');
    this.toMenu();
    this.clock.start();
    this.loop();
  }

  private resize = () => {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 64 : 52; // portrait phones need a wider view
    this.camera.updateProjectionMatrix();
  };

  // ------------------------------------------------------------------ phases
  toMenu() {
    this.ents.clear();
    this.player.reset();
    this.player.heading = 0; // face the camera on the start screen, city behind
    hud.set({ phase: 'menu', stats: null, best: this.profile.best });
  }

  start() {
    unlockAudio();
    const today = new Date().toISOString().slice(0, 10);
    // a little permanent fitness: every 40 shakes ever collected = +1 starting level (max 4)
    this.startLevel = 1 + Math.min(3, Math.floor(this.profile.totalShakes / 40));
    Object.assign(this, {
      t: 0, distance: 0, speed: 9, stamina: 100, hydration: 100, level: this.startLevel, xp: 0, shakes: 0, shakeStreak: 0, combo: 0,
      beast: 0, heavy: 0, bonus: 0, nextRow: 28, secondWindUsed: false, pops: [],
    });
    this.ents.clear();
    this.player.reset();
    this.player.setGrowth(growthForLevel(this.level), true);
    this.player.startRunning();
    if (this.profile.lastDay !== today) {
      const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
      this.profile.streak = this.profile.lastDay === y ? this.profile.streak + 1 : 1;
      this.profile.lastDay = today;
    }
    hud.set({ phase: 'running', hint: 'Swipe ← → to change lanes · ↑ jump · ↓ slide', levelUp: 0 });
    setTimeout(() => hud.set({ hint: '' }), 4500);
  }

  private gameOver() {
    sfx.over();
    this.player.idle();
    const dist = Math.round(this.distance);
    const newBest = dist > this.profile.best;
    this.profile.best = Math.max(this.profile.best, dist);
    this.profile.totalShakes += this.shakes;
    this.profile.runs += 1;
    saveProfile(this.profile);
    hud.set({
      phase: 'over',
      best: this.profile.best,
      stats: { distance: dist, shakes: this.shakes, kcal: Math.round(this.distance * 0.07 + this.shakes * 2), level: this.level, best: this.profile.best, newBest, timeSec: Math.round(this.t) },
    });
  }

  // ------------------------------------------------------------------ input
  input(action: 'left' | 'right' | 'jump' | 'slide' | 'tap') {
    const phase = hud.get().phase;
    if (phase === 'secondwind') {
      if (action === 'tap' || action === 'jump') {
        this.swTaps++;
        sfx.tap();
        if (this.swTaps >= SECOND_WIND_TAPS) {
          this.stamina = 35;
          this.secondWindUsed = true;
          this.player.startRunning();
          this.popup('SECOND WIND!', '#7dffb5', true);
          hud.set({ phase: 'running', secondWindUsed: true });
        }
      }
      return;
    }
    if (phase !== 'running') return;
    if (action === 'left') this.player.move(-1, this.t);
    if (action === 'right') this.player.move(1, this.t);
    if (action === 'jump' && this.player.jump()) sfx.jump();
    if (action === 'slide') { this.player.slide(); sfx.slide(); }
  }

  pause(p: boolean) {
    const phase = hud.get().phase;
    if (p && phase === 'running') hud.set({ phase: 'paused' });
    if (!p && phase === 'paused') { this.clock.getDelta(); hud.set({ phase: 'running' }); }
  }

  // ------------------------------------------------------------------ game rules
  private popup(text: string, color: string, big = false, x = 0.5, y = 0.42) {
    this.pops.push({ id: ++this.popId, text, color, x: x + (Math.random() - 0.5) * 0.06, y: y + (Math.random() - 0.5) * 0.04, big });
    if (this.pops.length > 6) this.pops.shift();
    hud.set({ pops: [...this.pops] });
    const id = this.popId;
    setTimeout(() => { this.pops = this.pops.filter((p) => p.id !== id); hud.set({ pops: [...this.pops] }); }, big ? 1400 : 900);
  }

  private comboLabel() {
    for (const [n, l] of COMBO_LABELS) if (this.combo >= n) return l;
    return '';
  }

  private collect(kind: ItemKind) {
    if (kind === 'burger' || kind === 'soda') {
      sfx.junk();
      this.heavy = kind === 'burger' ? 5 : 4;
      if (kind === 'burger') this.stamina = Math.min(100, this.stamina + 6); else this.hydration = Math.min(100, this.hydration + 4);
      this.combo = 0;
      this.shakeStreak = 0;
      this.popup(kind === 'burger' ? 'JUNK FOOD · HEAVY' : 'SUGAR CRASH', '#ff5a5a');
      return;
    }
    this.combo++;
    this.bonus += 10 * Math.max(1, Math.floor(this.combo / 5));
    sfx.pickup(this.combo);
    if (kind === 'shake') {
      this.shakes++;
      this.shakeStreak++;
      this.xp++;
      this.popup('+1 💪', '#ff8a5a');
      if (this.xp >= xpForLevel(this.level)) {
        this.xp = 0;
        this.level++;
        sfx.levelUp();
        this.player.setGrowth(this.beast > 0 ? BEAST_K : growthForLevel(this.level));
        this.popup(`LEVEL ${this.level}`, '#ffd23f', true, 0.5, 0.3);
        hud.set({ levelUp: performance.now() });
      }
      if (this.shakeStreak >= 3 && this.beast <= 0) {
        this.shakeStreak = 0;
        this.beast = BEAST_TIME;
        this.player.setGrowth(BEAST_K);
        sfx.beast();
        this.popup('BEAST MODE', '#ffb21a', true, 0.5, 0.3);
      }
    } else if (kind === 'water') {
      this.hydration = Math.min(100, this.hydration + 35);
      this.popup('+35 💧', '#7cc8ff');
    } else {
      this.stamina = Math.min(100, this.stamina + 22);
      this.popup('+22 ⚡', '#7dffb5');
    }
    const label = this.comboLabel();
    if (label && (this.combo === 5 || this.combo === 10 || this.combo === 20 || this.combo % 35 === 0)) this.popup(`×${this.combo} ${label}`, '#ffd84a', true, 0.5, 0.24);
  }

  private spawnRow(zWorld: number) {
    const d = this.distance;
    const r = Math.random;
    // which obstacles are unlocked so far
    const pool: ObstacleKind[] = ['barrier', 'car'];
    if (d > 150) pool.push('banner');
    if (d > 300) pool.push('jogger');
    const nObs = d < 200 ? 1 : r() < Math.min(0.55, d / 3000) ? 2 : 1;
    const lanes = [0, 1, 2].sort(() => r() - 0.5);
    const blocked: number[] = [];
    for (let i = 0; i < nObs; i++) {
      const lane = lanes[i];
      let kind = pool[Math.floor(r() * pool.length)];
      // two blockers: at least one must be passable by jumping or sliding
      if (i === 1 && (kind === 'car' || kind === 'jogger')) kind = r() < 0.5 ? 'barrier' : 'banner';
      this.ents.spawnObstacle(kind, lane, zWorld - (kind === 'car' ? 2.4 : 0));
      blocked.push(lane);
    }
    // pickups in a free lane, as a short line
    const free = [0, 1, 2].filter((l) => !blocked.includes(l));
    if (free.length && r() < 0.9) {
      const lane = free[Math.floor(r() * free.length)];
      const roll = r();
      const needWater = this.hydration < 45, needFood = this.stamina < 45;
      let kind: ItemKind = roll < 0.42 ? 'shake' : roll < 0.62 ? 'water' : roll < 0.8 ? 'banana' : roll < 0.9 ? 'burger' : 'soda';
      if (needWater && r() < 0.4) kind = 'water';
      if (needFood && r() < 0.4) kind = 'banana';
      const n = kind === 'shake' ? 3 : 1;
      for (let k = 0; k < n; k++) this.ents.spawnItem(kind, lane, zWorld + 6 + k * 2.6);
    }
  }

  private step(dt: number) {
    const phase = hud.get().phase;
    const running = phase === 'running';
    if (phase === 'secondwind') {
      this.swTime -= dt;
      if (this.swTime <= 0) { hud.set({ phase: 'over' }); this.gameOver(); }
      hud.set({ secondWindTaps: this.swTaps, secondWindTime: Math.max(0, this.swTime) });
    }
    if (!running) {
      // start screen: slow orbit around the idling athlete
      this.player.update(dt, 0, false);
      if (phase === 'menu' || phase === 'loading') {
        // start screen: a slow swing in front of the athlete, the street and skyline behind him
        const a = Math.sin(this.t * 0.22) * 0.9;
        this.camera.position.set(Math.sin(a) * 3.2, 1.45, Math.cos(a) * 3.2);
        this.camera.lookAt(0, 1.0, 0);
      }
      this.t += dt;
      return;
    }
    this.t += dt;
    // speed
    const base = 9 + 7 * (1 - Math.exp(-this.distance / 1500)) + this.level * 0.25;
    const target = base * (this.heavy > 0 ? 0.82 : 1) * (this.player.stumble > 0 ? 0.55 : 1) * (this.beast > 0 ? 1.45 : 1);
    this.speed += (target - this.speed) * Math.min(1, dt * 2.5);
    const dz = this.speed * dt;
    this.distance += dz;
    this.world.update(dz);
    this.ents.update(dt, dz, this.t);
    this.player.update(dt, this.speed, true);

    // timers
    this.heavy = Math.max(0, this.heavy - dt);
    if (this.beast > 0) {
      this.beast -= dt;
      if (this.beast <= 0) { this.beast = 0; this.player.setGrowth(growthForLevel(this.level)); }
    }

    // sun & shade
    this.inShade = this.world.isInShade(this.player.x, 1.2);
    this.hydration = Math.max(0, this.hydration - (this.inShade ? 0.25 : 3.2) * dt);
    const drain = (1.1 + this.distance / 4000) * (this.hydration < 25 ? 2 : 1) * Math.max(0.6, 1 - 0.025 * this.level);
    this.stamina = Math.max(0, this.stamina - drain * dt);

    // spawning ahead
    while (this.nextRow < this.distance + 140) {
      this.spawnRow(-(this.nextRow - this.distance));
      const gap = Math.max(11, 22 - this.distance / 400);
      this.nextRow += gap + Math.random() * 6;
    }

    // collisions
    const pb = this.player.bounds();
    for (const it of this.ents.items) {
      if (!it.active || Math.abs(it.z) > 0.9) continue;
      if (Math.abs(LANES[it.lane] - pb.x) < 1.0 && pb.y0 < it.y + 0.6) { it.active = false; this.collect(it.kind); }
    }
    for (const o of this.ents.obstacles) {
      if (!o.active) continue;
      const half = o.len / 2 + 0.35;
      if (!o.passed && o.z > half) {
        o.passed = true;
        // near miss: passed right next to it just after a lane change
        if (!o.hit && Math.abs(LANES[o.lane] - pb.x) < 3 && this.t - this.player.laneChangedAt < 0.45 && Math.abs(LANES[o.lane] - LANES[this.player.lane]) > 1) {
          this.bonus += 250; sfx.close(); this.popup('+250 CLOSE!', '#ff8a3d', false, 0.62, 0.5);
        }
      }
      if (o.hit || Math.abs(o.z) > half || Math.abs(LANES[o.lane] - pb.x) > 1.05) continue;
      let blocks = true;
      if (o.kind === 'barrier') blocks = pb.y0 < 0.85; // jump over it
      if (o.kind === 'banner') blocks = pb.y1 > 1.25; // slide under it
      if (!blocks) continue;
      o.hit = true;
      if (this.beast > 0) {
        o.fly = new THREE.Vector3((Math.random() - 0.5) * 6, 9, -14);
        o.spinFly = 6;
        this.bonus += 150; sfx.smash(); this.popup('SMASH +150', '#ffb21a');
        this.shakeCam = 0.25;
        continue;
      }
      this.stamina = Math.max(0, this.stamina - 25);
      this.combo = 0; this.shakeStreak = 0;
      this.player.hit(); sfx.hit();
      this.shakeCam = 0.45;
      this.popup('OUCH −25 ⚡', '#ff4d4d');
    }

    // heartbeat when low
    if (this.stamina < 25) {
      this.beatTimer -= dt;
      if (this.beatTimer <= 0) { sfx.heartbeat(); this.beatTimer = 0.55 + this.stamina / 50; }
    }

    // out of stamina → Second Wind once, then game over
    if (this.stamina <= 0) {
      if (!this.secondWindUsed) {
        this.swTime = SECOND_WIND_TIME; this.swTaps = 0;
        this.player.idle();
        hud.set({ phase: 'secondwind', secondWindNeed: SECOND_WIND_TAPS, secondWindTaps: 0, secondWindTime: SECOND_WIND_TIME });
      } else this.gameOver();
    }

    // camera follows from behind and above, wider at speed
    const cx = this.player.x * 0.65 + 0.25, shake = this.shakeCam > 0 ? (Math.random() - 0.5) * this.shakeCam : 0;
    this.shakeCam = Math.max(0, this.shakeCam - dt);
    this.camera.position.set(cx + shake, 2.3 + this.player.y * 0.3 + shake * 0.5, 3.3);
    this.camera.lookAt(this.player.x * 0.65 - 0.4, 1.25 + this.player.y * 0.4, -9);
    const baseFov = this.camera.aspect < 1 ? 64 : 52;
    this.camera.fov += (baseFov + (this.speed - 9) * 0.55 + (this.beast > 0 ? 6 : 0) - this.camera.fov) * Math.min(1, dt * 3);
    this.camera.updateProjectionMatrix();

    // HUD at ~15 Hz
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 1 / 15;
      hud.set({
        speedKmh: Math.round(10 + this.speed * 1.1),
        distance: this.distance,
        stamina: this.stamina, hydration: this.hydration, level: this.level, xp: this.xp / xpForLevel(this.level), shakes: this.shakes,
        bpm: Math.round(120 + this.speed * 2 + (100 - this.stamina) * 0.3 + (this.beast > 0 ? 20 : 0)),
        combo: this.combo, comboLabel: this.comboLabel(), beast: this.beast, heavy: this.heavy, inShade: this.inShade, lowWater: this.hydration < 25,
      });
    }
  }

  private adaptQuality(dt: number) {
    this.fpsAcc.t += dt; this.fpsAcc.n++;
    if (this.fpsAcc.t < 2) return;
    const fps = this.fpsAcc.n / this.fpsAcc.t;
    this.fpsAcc = { t: 0, n: 0 };
    if (fps < 50 && this.dpr > 0.6) { this.dpr = Math.max(0.6, this.dpr - 0.2); this.renderer.setPixelRatio(this.dpr); this.resize(); }
    else if (fps > 58 && this.dpr < this.maxDpr) { this.dpr = Math.min(this.maxDpr, this.dpr + 0.1); this.renderer.setPixelRatio(this.dpr); this.resize(); }
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    if (hud.get().phase !== 'paused') this.step(dt);
    this.adaptQuality(dt);
    this.renderer.render(this.scene, this.camera);
  };

  /** For automated tests: advance the game by `seconds` of fixed steps without rendering. */
  simulate(seconds: number) {
    const dt = 1 / 30;
    for (let t = 0; t < seconds; t += dt) if (hud.get().phase !== 'paused') this.step(dt);
    this.renderer.render(this.scene, this.camera);
    return this.debugState();
  }

  /** For automated tests: run the simulation without user timing. */
  debugState() {
    const i = this.renderer.info.render;
    return { tris: i.triangles, calls: i.calls, dpr: this.dpr, distance: this.distance, stamina: this.stamina, hydration: this.hydration, level: this.level, items: this.ents.items.length, obstacles: this.ents.obstacles.length, inShade: this.inShade, speed: this.speed };
  }

  private onContextLost = (e: Event) => {
    // the browser took the GPU away (driver reset / out of graphics memory): stop and offer a reload
    e.preventDefault();
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    hud.set({ phase: 'error', loadLabel: 'The browser reset the graphics. Tap to reload.' });
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    // free every GPU resource, then release the WebGL context itself (dev reloads otherwise pile up contexts)
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v && (v as THREE.Texture).isTexture) textures.add(v as THREE.Texture);
        mat.dispose();
      }
    });
    textures.forEach((t) => t.dispose());
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

}
