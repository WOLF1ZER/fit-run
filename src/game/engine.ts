import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { World, LANES, DISTRICT_NAMES, type District } from './world';
import { Atmosphere, todFromClock, type TimeName } from './atmosphere';
import { Player } from './player';
import { Entities, type ItemKind, type ObstacleKind, type Obstacle } from './entities';
import { growthForLevel, BEAST_K } from './growth';
import { hud, loadProfile, saveProfile, type Pop } from './store';
import { sfx, unlockAudio, music } from './audio';
import { ASSET } from './materials';

// ---- tuning ----
const BEAST_TIME = 8;
const CRASH_COST = 34; // three crashes from full stamina end the run
const INVULN_TIME = 0.5; // only merges hits from one moment (e.g. squeezing between two cars) into one crash
const BEAST_STREAK = 9; // shakes in a row without a crash or junk food
const LANE_CHANGE_TIME = 0.38; // seconds a player needs to see and dodge into the next lane
const SECOND_WIND_TIME = 3.2;
const SECOND_WIND_TAPS = 12;
const xpForLevel = (lvl: number) => 3 + lvl; // shakes needed to go from lvl to lvl+1
export const MAX_LEVEL = 40; // fitness tops out here: the bar shows MAX
const LEVEL_SPEED_CAP = 20; // levels above this add no more speed
const MAX_SPEED = 34; // absolute top speed (≈ 47 km/h on the HUD), Beast Mode included
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
  private atmo!: Atmosphere;
  private tod0 = 2;
  private lastTime: TimeName | '' = '';
  private lastDistrict: District | '' = '';
  static PHASE_LEN = 1200; // metres per time-of-day phase
  private raf = 0;
  private disposed = false;
  private quality: 'high' | 'low';
  private dpr: number;
  private maxDpr: number;
  private fpsAcc = { t: 0, n: 0 };
  private frame = 0;
  private ro: ResizeObserver;

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
  private safeLane = 1;
  private lastGap = 20;
  private rowsSinceJogger = 0;
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
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // refreshed every other frame in loop()
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
    await this.world.init((f, l) => step(0.05 + f * 0.45, l));
    this.scene.add(this.world.group, this.world.backdrop, this.world.ocean);
    const M = this.world.mats;
    this.atmo = new Atmosphere(this.scene, this.renderer, this.quality === 'high' ? 2048 : 1024,
      { lamp: this.world.vcGlow.color, signs: [M.signs.mat, M.ads.mat], towers: [M.glassT], pools: [M.pool] });
    this.sun = this.atmo.sun;
    this.tod0 = todFromClock();
    this.atmo.set(this.tod0);
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
    this.ents.spawnObstacle('car', 1, -40); // both car shapes
    this.ents.sync();
    this.camera.position.set(0, 2.3, 3.3);
    this.camera.lookAt(0, 1.2, -9);
    this.world.warmup(true); // the other locations' blocks + ocean, so their shaders compile now too
    this.renderer.compile(this.scene, this.camera);
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    this.world.warmup(false);
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
    this.clock.getDelta();
    this.ents.clear();
    this.player.reset();
    this.player.heading = 0; // face the camera on the start screen, city behind
    this.world.reset();
    this.tod0 = todFromClock();
    this.atmo?.set(this.tod0);
    music.setIntensity(0);
    hud.set({ phase: 'menu', stats: null, best: this.profile.best });
  }

  start() {
    unlockAudio();
    const today = new Date().toISOString().slice(0, 10);
    // a little permanent fitness: every 40 shakes ever collected = +1 starting level (max 4)
    this.startLevel = 1 + Math.min(3, Math.floor(this.profile.totalShakes / 40));
    Object.assign(this, {
      t: 0, distance: 0, speed: 9, stamina: 100, hydration: 100, level: this.startLevel, xp: 0, shakes: 0, shakeStreak: 0, combo: 0,
      beast: 0, heavy: 0, bonus: 0, nextRow: 28, secondWindUsed: false, pops: [], safeLane: 1, lastGap: 20, rowsSinceJogger: 0,
    });
    this.ents.clear();
    this.world.reset();
    this.tod0 = todFromClock(); // the run starts at your real time of day
    this.atmo.set(this.tod0);
    this.lastTime = this.atmo.name; this.lastDistrict = 'boulevard';
    this.player.reset();
    this.player.setGrowth(growthForLevel(this.level), true);
    this.player.startRunning();
    music.setIntensity(1);
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
    music.setIntensity(0);
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
          this.stamina = Math.max(this.stamina, 35);
          this.player.invuln = INVULN_TIME;
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
      // junk food costs energy and makes you heavy for a few seconds
      const loss = kind === 'burger' ? 12 : 8;
      this.heavy = kind === 'burger' ? 5 : 4;
      this.stamina = Math.max(0, this.stamina - loss);
      this.combo = 0;
      this.shakeStreak = 0;
      this.popup(kind === 'burger' ? `JUNK FOOD −${loss} ⚡` : `SUGAR CRASH −${loss} ⚡`, '#ff5a5a');
      return;
    }
    this.combo++;
    this.bonus += 10 * Math.max(1, Math.floor(this.combo / 5));
    sfx.pickup(this.combo);
    if (kind === 'shake') {
      this.shakes++;
      this.shakeStreak++;
      this.stamina = Math.min(100, this.stamina + 5);
      if (this.level >= MAX_LEVEL) {
        // maxed out: shakes still heal a little and give points instead of XP
        this.bonus += 50;
        this.popup('MAX +50 +5 ⚡', '#ffd23f');
      } else {
        this.xp++;
        this.popup('+1 💪 +5 ⚡', '#ff8a5a');
      }
      if (this.level < MAX_LEVEL && this.xp >= xpForLevel(this.level)) {
        this.xp = 0;
        this.level++;
        sfx.levelUp();
        this.player.setGrowth(this.beast > 0 ? BEAST_K : growthForLevel(this.level));
        this.popup(this.level >= MAX_LEVEL ? 'MAX FITNESS!' : `LEVEL ${this.level}`, '#ffd23f', true, 0.5, 0.3);
        hud.set({ levelUp: performance.now() });
      }
      if (this.shakeStreak >= BEAST_STREAK && this.beast <= 0) {
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

  /**
   * One row of obstacles. Fairness rules:
   *  - there is always a "safe lane" that is empty or passable by jumping/sliding,
   *  - the safe lane moves at most one lane per row, and only if the gap gives enough time to switch,
   *  - never three solid blockers; joggers jog on the spot so they never drift into another row.
   */
  private spawnRow(zWorld: number, gap: number) {
    const d = this.distance, r = Math.random;
    const canShift = gap / Math.max(this.speed, 8) >= LANE_CHANGE_TIME;
    if (canShift && r() < 0.6) this.safeLane = Math.max(0, Math.min(2, this.safeLane + (r() < 0.5 ? -1 : 1)));
    // joggers: never in pairs, at most one per row, and at least one jogger-free row in between
    const joggerOk = d > 200 && this.rowsSinceJogger >= 2;
    let joggerUsed = false;
    const solid: ObstacleKind[] = ['car'];
    const passable: ObstacleKind[] = d > 80 ? ['barrier', 'banner'] : ['barrier'];
    const difficulty = Math.min(1, d / 1500);
    for (let lane = 0; lane < 3; lane++) {
      if (lane === this.safeLane) {
        // the safe lane often needs a jump or a slide (never a solid blocker)
        if (d > 120 && r() < 0.25 + 0.35 * difficulty) this.ents.spawnObstacle(passable[Math.floor(r() * passable.length)], lane, zWorld);
        continue;
      }
      if (r() > 0.6 + 0.35 * difficulty) continue; // leave this lane open too
      let kind: ObstacleKind = r() < 0.6 + 0.2 * difficulty ? solid[Math.floor(r() * solid.length)] : passable[Math.floor(r() * passable.length)];
      if (kind === 'car' && joggerOk && !joggerUsed && r() < 0.3) kind = 'jogger';
      if (kind === 'jogger') joggerUsed = true;
      this.ents.spawnObstacle(kind, lane, zWorld - (kind === 'car' ? 2.4 : 0));
    }
    this.rowsSinceJogger = joggerUsed ? 0 : this.rowsSinceJogger + 1;
    // pickups follow the safe lane, just past the row (so collecting them never forces a crash)
    if (r() < 0.85) {
      const roll = r();
      const needWater = this.hydration < 45, needFood = this.stamina < 45;
      let kind: ItemKind = roll < 0.45 ? 'shake' : roll < 0.63 ? 'water' : roll < 0.8 ? 'banana' : roll < 0.91 ? 'burger' : 'soda';
      if (needWater && r() < 0.4) kind = 'water';
      if (needFood && r() < 0.4) kind = 'banana';
      const n = kind === 'shake' ? 3 : 1, room = Math.max(1, Math.floor((gap - 6) / 2.4));
      for (let k = 0; k < Math.min(n, room); k++) this.ents.spawnItem(kind, this.safeLane, zWorld - 2.5 - k * 2.4);
    }
  }

/** Sends an obstacle flying: away from the runner, sideways off his line, spinning. Heavier things fly less. */
  private knock(o: Obstacle, px: number, power: number) {
    const mass = o.kind === 'car' ? 2.6 : o.kind === 'jogger' ? 1.3 : o.kind === 'banner' ? 1.2 : 1;
    const side = Math.sign(LANES[o.lane] - px) || (Math.random() < 0.5 ? -1 : 1);
    const p = power / mass, r = Math.random;
    if (o.kind === 'car') {
      // a car doesn't flip from a runner: it lurches forward with a small hop and slews sideways
      o.fly = new THREE.Vector3(side * (1.5 + r()) * power, 1.6 * power, -(this.speed * 0.6 + 8) * power);
      o.spinFly = -0.4 * power; o.spinSide = 0; o.spinYaw = side * (1.2 + r()) * power;
    } else {
      o.fly = new THREE.Vector3(side * (3 + r() * 3) * p, (6 + r() * 3) * p, -(this.speed * 0.45 + 6) * p);
      o.spinFly = -(4 + r() * 4) * p;
      o.spinSide = -side * (1.5 + r() * 2.5) * p;
      o.spinYaw = 0;
    }
    if (o.mixer) o.mixer.timeScale = 0.25; // the jogger stops running mid-air
  }

  private crash() {
    this.stamina = Math.max(0, this.stamina - CRASH_COST);
    this.combo = 0; this.shakeStreak = 0;
    this.player.hit(); this.player.invuln = INVULN_TIME;
    sfx.hit();
    this.shakeCam = 0.45;
    this.popup(`CRASH −${CRASH_COST} ⚡`, '#ff4d4d', this.stamina < CRASH_COST);
  }

  private fail() {
    if (!this.secondWindUsed) {
      this.swTime = SECOND_WIND_TIME; this.swTaps = 0;
      this.player.idle();
      hud.set({ phase: 'secondwind', secondWindNeed: SECOND_WIND_TAPS, secondWindTaps: 0, secondWindTime: SECOND_WIND_TIME });
    } else this.gameOver();
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
      this.atmo?.followLamps(this.world.lampZ(), this.player.x);
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
    const base = 9.5 + 8.5 * (1 - Math.exp(-this.distance / 1200)) + Math.min(this.level, LEVEL_SPEED_CAP) * 0.25;
    const target = Math.min(MAX_SPEED, base * (this.heavy > 0 ? 0.82 : 1) * (this.player.stumble > 0 ? 0.55 : 1) * (this.beast > 0 ? 1.45 : 1));
    this.speed += (target - this.speed) * Math.min(1, dt * 2.5);
    const dz = this.speed * dt;
    this.distance += dz;
    this.world.update(dz, dt);
    this.ents.update(dt, dz, this.t);
    // time of day moves on with the distance; new location every km
    this.atmo.set(this.tod0 + this.distance / Engine.PHASE_LEN);
    this.atmo.followLamps(this.world.lampZ(), this.player.x);
    if (this.atmo.name !== this.lastTime) {
      this.lastTime = this.atmo.name;
      const msg = { MORNING: '🌅 SUNRISE', NOON: '☀ HIGH NOON · DRINK MORE', SUNSET: '🌇 SUNSET', NIGHT: '🌙 NIGHT RUN' }[this.lastTime];
      this.popup(msg, '#ffe2a8', true, 0.5, 0.3);
    }
    if (this.world.district !== this.lastDistrict) {
      this.lastDistrict = this.world.district;
      this.popup('📍 ' + DISTRICT_NAMES[this.lastDistrict], '#9fe8ff', true, 0.5, 0.36);
    }
    this.player.update(dt, this.speed, true);

    // timers
    music.setIntensity(this.beast > 0 ? 2 : 1);
    this.heavy = Math.max(0, this.heavy - dt);
    if (this.beast > 0) {
      this.beast -= dt;
      if (this.beast <= 0) { this.beast = 0; this.player.setGrowth(growthForLevel(this.level)); }
    }

    // sun & shade
    // sun & shade: the sun's position follows the time of day; at night nothing dries you out
    this.inShade = this.atmo.night > 0.5 || this.world.isInShade(this.player.x, 1.2, this.atmo.dir);
    this.hydration = Math.max(0, this.hydration - (this.inShade ? 0.25 : 3.2 * this.atmo.burn) * dt);
    const drain = (1.1 + this.distance / 4000) * (this.hydration < 25 ? 2 : 1) * Math.max(0.6, 1 - 0.025 * this.level);
    this.stamina = Math.max(0, this.stamina - drain * dt);

    // spawning ahead
    while (this.nextRow < this.distance + 140) {
      this.spawnRow(-(this.nextRow - this.distance), this.lastGap);
      // gaps shrink with distance but never below what the current speed needs to react and switch lanes
      const minGap = Math.max(8.5, this.speed * (LANE_CHANGE_TIME + 0.28) + 4.8);
      this.lastGap = Math.max(minGap, 20 - this.distance / 220) + Math.random() * 4;
      this.nextRow += this.lastGap;
    }

    // collisions
    const pb = this.player.bounds();
    for (const it of this.ents.items) {
      // swept test: did it pass the player's plane since last frame? (no tunnelling at high speed / low FPS)
      if (!it.active || it.prevZ > 0.9 || it.z < -0.9) continue;
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
      // swept along z and using real widths (so a crash mid lane-change counts too)
      if (o.hit || o.prevZ > half || o.z < -half || Math.abs(LANES[o.lane] - pb.x) > o.halfW + 0.32) continue;
      let blocks = true;
      if (o.kind === 'barrier') blocks = pb.y0 < 0.85; // jump over it
      if (o.kind === 'banner') blocks = pb.y1 > 1.25; // slide under it
      if (!blocks) continue;
      o.hit = true;
      // every touch knocks the object away; Beast Mode just hits much harder
      this.knock(o, pb.x, this.beast > 0 ? 1.6 : 1);
      if (this.player.invuln > 0) continue;
      if (this.beast > 0) {
        this.bonus += 150; sfx.smash(); this.popup('SMASH +150', '#ffb21a');
        this.shakeCam = 0.25;
        continue;
      }
      this.crash();
    }

    // heartbeat when low
    if (this.stamina < 25) {
      this.beatTimer -= dt;
      if (this.beatTimer <= 0) { sfx.heartbeat(); this.beatTimer = 0.55 + this.stamina / 50; }
    }

    // out of stamina (3 crashes, junk food, exhaustion) → Second Wind once, then game over
    if (this.stamina <= 0) this.fail();

    // camera follows from behind and above, wider at speed
    // portrait phones see a narrow slice of the road: follow the runner fully sideways and pull back a little,
    // so he stays whole and centred in every lane; wide screens keep the offset over-the-shoulder view
    const portrait = this.camera.aspect < 1;
    const follow = portrait ? 1 : 0.85, side = portrait ? 0 : 0.15, back = portrait ? 3.3 : 3.0, up = portrait ? 2.25 : 2.3;
    const shake = this.shakeCam > 0 ? (Math.random() - 0.5) * this.shakeCam : 0;
    this.shakeCam = Math.max(0, this.shakeCam - dt);
    this.camera.position.set(this.player.x * follow + side + shake, up + this.player.y * 0.3 + shake * 0.5, back);
    this.camera.lookAt(this.player.x * follow - (portrait ? 0 : 0.2), (portrait ? 1.3 : -0.7) + this.player.y * 0.4, -9);
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
        stamina: this.stamina, hydration: this.hydration, level: this.level, maxed: this.level >= MAX_LEVEL, xp: this.level >= MAX_LEVEL ? 1 : this.xp / xpForLevel(this.level), shakes: this.shakes,
        bpm: Math.round(120 + this.speed * 2 + (100 - this.stamina) * 0.3 + (this.beast > 0 ? 20 : 0)),
        combo: this.combo, comboLabel: this.comboLabel(), beast: this.beast, heavy: this.heavy, inShade: this.inShade, night: this.atmo.night > 0.5, lowWater: this.hydration < 25,
        place: DISTRICT_NAMES[this.world.district], timeName: this.atmo.name,
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
    this.world.runJobs(this.quality === 'high' ? 5 : 3); // build the next location in small slices
    this.adaptQuality(dt);
    // shadows at half the frame rate: one less full scene pass every other frame
    if ((++this.frame & 1) === 0) this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  };

  /** For automated tests: advance the game by `seconds` of fixed steps without rendering. */
  simulate(seconds: number, dt = 1 / 30) {
    for (let t = 0; t < seconds; t += dt) { if (hud.get().phase !== 'paused') this.step(dt); this.world.runJobs(5); }
    this.renderer.shadowMap.needsUpdate = true;
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
    this.ro.disconnect();
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
