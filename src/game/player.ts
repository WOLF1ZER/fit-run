import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET } from './materials';
import { LANES } from './world';
import { applyGrowth } from './growth';

const JUMP_V = 8.2;
const GRAVITY = 24;
const SLIDE_TIME = 0.75;

export class Player {
  root = new THREE.Group(); // moves between lanes / jumps
  model!: THREE.Object3D;
  private mixer!: THREE.AnimationMixer;
  private actions: Record<string, THREE.AnimationAction> = {};
  lane = 1;
  x = 0;
  y = 0;
  vy = 0;
  sliding = 0;
  stumble = 0;
  laneChangedAt = -10;
  heading = Math.PI; // π = running away from the camera; 0 = facing it (start screen)
  private tilt = 0;
  private growth = 0;
  private growthTarget = 0;
  private current = '';

  async load(onProgress: (f: number) => void) {
    const gltf = await new GLTFLoader().loadAsync(`${ASSET}/characters/player.glb`, (e) => {
      if (e.total) onProgress(e.loaded / e.total);
    });
    this.model = gltf.scene;
    this.model.rotation.y = Math.PI; // run away from the camera (towards -z)
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = false;
        m.frustumCulled = false;
      }
    });
    this.root.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      // growth owns bone scale, so drop scale tracks; only the hips keep a position track,
      // and the jump is driven by game physics, so its hip motion goes too
      clip.tracks = clip.tracks.filter((t) => !t.name.endsWith('.scale') && (!t.name.endsWith('.position') || /Hips\.position/.test(t.name)));
      if (clip.name === 'Jump') clip.tracks = clip.tracks.filter((t) => !/Hips\.position/.test(t.name));
      const a = this.mixer.clipAction(clip);
      this.actions[clip.name] = a;
    }
    if (this.actions.Jump) {
      this.actions.Jump.setLoop(THREE.LoopOnce, 1);
      this.actions.Jump.clampWhenFinished = true;
    }
    this.play('Idle', 0);
    // rest-pose height of each foot joint above the soles: used to keep the feet on the road
    this.model.updateMatrixWorld(true);
    for (const n of ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase']) {
      const b = this.model.getObjectByName('mixamorig' + n) ?? this.model.getObjectByName('mixamorig:' + n);
      if (b) this.feet.push({ bone: b, rest: b.getWorldPosition(this.tmp).y });
    }
  }

  private feet: { bone: THREE.Object3D; rest: number }[] = [];
  private tmp = new THREE.Vector3();
  private lift = 0;
  invuln = 0;

  /** Lifts the model just enough that no foot joint dips below its resting height above the road. */
  private keepFeetOnRoad(dt: number) {
    if (!this.feet.length) return;
    this.model.position.y -= this.lift; // measure without last frame's lift
    if (this.sliding > 0) {
      // the slide keeps its original lean-back pose: no lifting while sliding
      this.lift = Math.max(0, this.lift - dt * 4);
      this.model.position.y += this.lift;
      return;
    }
    this.root.updateMatrixWorld(true);
    let below = 0;
    for (const f of this.feet) below = Math.max(below, f.rest - (f.bone.getWorldPosition(this.tmp).y - this.root.position.y));
    // snap up immediately, ease back down
    this.lift = below > this.lift ? below : this.lift + (below - this.lift) * Math.min(1, dt * 10);
    this.model.position.y += this.lift;
  }

  private play(name: string, fade = 0.2, timeScale = 1) {
    const next = this.actions[name];
    if (!next || this.current === name) return;
    const prev = this.actions[this.current];
    next.reset();
    next.timeScale = timeScale;
    next.play();
    if (prev) prev.crossFadeTo(next, fade, false);
    this.current = name;
  }

  reset() {
    this.lane = 1;
    this.x = 0;
    this.y = 0;
    this.vy = 0;
    this.sliding = 0;
    this.stumble = 0;
    this.tilt = 0;
    this.lift = 0;
    this.invuln = 0;
    this.model.visible = true;
    this.heading = Math.PI;
    this.setGrowth(0, true);
    this.root.position.set(0, 0, 0);
    this.model.rotation.set(0, Math.PI, 0);
    this.play('Idle', 0.3);
  }

  startRunning() {
    this.play('Run', 0.25);
  }
  idle() {
    this.play('Idle', 0.4);
  }

  move(dir: -1 | 1, now: number) {
    const l = Math.max(0, Math.min(2, this.lane + dir));
    if (l !== this.lane) {
      this.lane = l;
      this.laneChangedAt = now;
    }
  }
  jump() {
    if (this.y > 0.02) return false;
    this.vy = JUMP_V;
    this.sliding = 0;
    this.play('Jump', 0.08, 1.4);
    return true;
  }
  slide() {
    if (this.y > 0.3) this.vy = -14; // fast drop when sliding mid-air
    this.sliding = SLIDE_TIME;
  }
  hit() {
    this.stumble = 1.1;
  }

  setGrowth(k: number, instant = false) {
    this.growthTarget = k;
    if (instant) {
      this.growth = k;
      applyGrowth(this.model, k);
    }
  }

  get airborne() {
    return this.y > 0.05;
  }

  update(dt: number, speed: number, running: boolean) {
    const tx = LANES[this.lane];
    const prevX = this.x;
    this.x += (tx - this.x) * Math.min(1, dt * 12);
    this.root.position.x = this.x;
    // physics
    if (this.vy !== 0 || this.y > 0) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        this.vy = 0;
        if (running) this.play('Run', 0.15);
      }
    }
    this.root.position.y = this.y;
    this.sliding = Math.max(0, this.sliding - dt);
    this.stumble = Math.max(0, this.stumble - dt);
    // procedural layers on top of the clips: lean into lane changes, slide, stumble
    const vx = (this.x - prevX) / Math.max(dt, 1e-4);
    this.tilt += (-vx * 0.035 - this.tilt) * Math.min(1, dt * 10);
    const slideK = this.sliding > 0 ? Math.min(1, this.sliding / 0.15, (SLIDE_TIME - this.sliding + 0.05) / 0.12) : 0;
    const stumbleK = this.stumble > 0 ? Math.sin((1 - this.stumble / 1.1) * Math.PI) : 0;
    // slide: lean back pivoting on the feet (head drops to ~0.9 m), never below the road surface
    this.model.rotation.set(-slideK * 1.0 + stumbleK * 0.35, this.heading, this.tilt);
    this.model.position.set(0, 0.04 * slideK, 0);
    const run = this.actions.Run;
    if (run) run.timeScale = 0.75 + speed * 0.035;
    this.mixer.update(dt);
    // growth eases in (applied after the animation so nothing overrides it)
    if (Math.abs(this.growth - this.growthTarget) > 0.001) this.growth += (this.growthTarget - this.growth) * Math.min(1, dt * 3);
    applyGrowth(this.model, this.growth);
    this.keepFeetOnRoad(dt);
    // blink while invulnerable after a crash
    this.invuln = Math.max(0, this.invuln - dt);
    this.model.visible = this.invuln <= 0 || Math.floor(this.invuln * 12) % 2 === 0;
  }

  /** Simple hit volume: lane x, vertical span. */
  bounds() {
    const h = this.sliding > 0 ? 0.9 : 1.75;
    return { x: this.x, y0: this.y, y1: this.y + h };
  }
}
