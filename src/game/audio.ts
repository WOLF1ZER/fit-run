// Synthesized sound effects + a generated background track (Web Audio) — no files to download, works offline.
let ctx: AudioContext | null = null;
let master: GainNode | null = null; // sound effects
let musicBus: GainNode | null = null; // background track

// ---- player settings (saved on the device)
export interface SoundSettings { music: boolean; musicVol: number; sfx: boolean; sfxVol: number; vibration: boolean }
const SETTINGS_KEY = 'fitrun.settings.v1';
export const settings: SoundSettings = (() => {
  const d: SoundSettings = { music: true, musicVol: 0.6, sfx: true, sfxVol: 0.8, vibration: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return d; }
})();
const musicGain = () => (settings.music ? 0.5 * settings.musicVol : 0);
const sfxGain = () => (settings.sfx ? 0.6 * settings.sfxVol : 0);
export function updateSettings(patch: Partial<SoundSettings>) {
  Object.assign(settings, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  if (ctx && master && musicBus) {
    master.gain.setTargetAtTime(sfxGain(), ctx.currentTime, 0.05);
    musicBus.gain.setTargetAtTime(musicGain(), ctx.currentTime, 0.05);
  }
}

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    comp.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = sfxGain();
    master.connect(comp);
    musicBus = ctx.createGain();
    musicBus.gain.value = musicGain();
    musicBus.connect(comp);
    music.start();
  }
  if (ctx.state === 'suspended' && !document.hidden) ctx.resume();
}
/** Leaving the app/tab freezes all sound; coming back continues exactly where it was. */
export function setAppVisible(visible: boolean) {
  if (!ctx) return;
  if (visible) ctx.resume(); else ctx.suspend();
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.3, slideTo?: number, delay = 0) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}
function noise(dur: number, vol = 0.4, lp = 800) {
  if (!ctx || !master) return;
  const n = Math.floor(ctx.sampleRate * dur), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = buf; f.type = 'lowpass'; f.frequency.value = lp; g.gain.value = vol;
  s.connect(f).connect(g).connect(master);
  s.start();
}
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const vib = (ms: number | number[]) => { if (!settings.vibration) return; try { navigator.vibrate?.(ms); } catch { /* not supported */ } };

export const sfx = {
  /** pickup blip — climbs a pentatonic scale as the combo grows */
  pickup(combo: number) {
    const step = SCALE[Math.min(SCALE.length - 1, Math.floor(combo / 2))];
    tone(523.25 * Math.pow(2, step / 12), 0.14, 'triangle', 0.28);
    vib(12);
  },
  junk() { tone(220, 0.25, 'sawtooth', 0.18, 110); vib([20, 30, 20]); },
  hit() { noise(0.25, 0.6, 500); tone(110, 0.3, 'square', 0.2, 55); vib(80); },
  jump() { tone(330, 0.12, 'sine', 0.12, 660); },
  slide() { noise(0.2, 0.15, 2000); },
  close() { tone(880, 0.08, 'square', 0.12); tone(1320, 0.12, 'square', 0.1, undefined, 0.06); },
  levelUp() { [0, 4, 7, 12].forEach((s, i) => tone(392 * Math.pow(2, s / 12), 0.22, 'triangle', 0.25, undefined, i * 0.08)); vib([30, 40, 60]); },
  beast() { tone(110, 0.6, 'sawtooth', 0.25, 440); noise(0.5, 0.3, 1200); vib([60, 40, 120]); },
  smash() { noise(0.3, 0.7, 900); tone(80, 0.25, 'square', 0.25, 40); vib(40); },
  heartbeat() { tone(70, 0.09, 'sine', 0.35); tone(60, 0.1, 'sine', 0.3, undefined, 0.16); },
  tap() { tone(660 + Math.random() * 80, 0.06, 'square', 0.12); vib(8); },
  over() { tone(392, 0.3, 'triangle', 0.25, 196); tone(262, 0.5, 'triangle', 0.2, 131, 0.25); },
};

// ---------------------------------------------------------------- background music
// An original 4-bar loop in A minor (Am – F – C – G) at 124 BPM, sequenced in 16th notes.
// Intensity: 0 = start screen (pads + soft beat), 1 = running (full groove), 2 = Beast Mode (+ lead, brighter).
const BPM = 124, STEP = 60 / BPM / 4;
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // MIDI notes
const BASS = [45, 41, 36, 43];
const LEAD = [76, -1, 74, 72, -1, 72, 74, -1, 76, -1, 79, -1, 76, 74, 72, -1];
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
let noiseBuf: AudioBuffer | null = null;

export const music = {
  intensity: 0,
  step: 0,
  nextTime: 0,
  timer: 0 as any,
  setIntensity(i: number) { this.intensity = i; },
  start() {
    if (!ctx || this.timer) return;
    const n = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.nextTime = ctx.currentTime + 0.1;
    // look-ahead scheduler: robust against frame drops (runs on its own timer, not the render loop)
    this.timer = setInterval(() => this.schedule(), 25);
  },
  schedule() {
    if (!ctx || ctx.state !== 'running') return;
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.05; // after a long stall
    while (this.nextTime < ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step = (this.step + 1) % 64;
    }
  },
  playStep(st: number, t: number) {
    const bar = Math.floor(st / 16), s16 = st % 16, I = this.intensity;
    const chord = CHORDS[bar];
    // drums
    if (s16 % 4 === 0) kick(t, I === 0 ? 0.45 : 0.9);
    if (I >= 1 && (s16 === 4 || s16 === 12)) snare(t);
    if (I >= 1 && s16 % 2 === 1) hat(t, s16 % 4 === 3 ? 0.18 : 0.1);
    if (I === 0 && s16 % 4 === 2) hat(t, 0.05);
    // bass: offbeat octave pumps
    if (I >= 1 && s16 % 2 === 0) bass(t, mtof(BASS[bar] + (s16 % 4 === 2 ? 12 : 0)), I);
    // pad on every bar
    if (s16 === 0) pad(t, chord, I);
    // arpeggio
    if (s16 % 2 === 0 || I >= 1) {
      const note = chord[(s16 >> (I >= 1 ? 0 : 1)) % 3] + 12 + (s16 % 8 >= 4 && I >= 1 ? 12 : 0);
      arp(t, mtof(note), I);
    }
    // lead melody in Beast Mode
    if (I >= 2 && LEAD[s16] > 0) lead(t, mtof(LEAD[s16] + (bar === 3 ? -2 : 0)));
  },
};

function env(g: GainNode, t: number, a: number, peak: number, d: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function kick(t: number, v: number) {
  if (!ctx || !musicBus) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  env(g, t, 0.003, v, 0.28);
  o.connect(g).connect(musicBus); o.start(t); o.stop(t + 0.32);
}
function noiseHit(t: number, type: BiquadFilterType, freq: number, v: number, d: number) {
  if (!ctx || !musicBus || !noiseBuf) return;
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq;
  env(g, t, 0.002, v, d);
  s.connect(f).connect(g).connect(musicBus); s.start(t, Math.random() * 0.5); s.stop(t + d + 0.02);
}
const hat = (t: number, v: number) => noiseHit(t, 'highpass', 8000, v, 0.04);
function snare(t: number) {
  noiseHit(t, 'bandpass', 1800, 0.45, 0.16);
  if (!ctx || !musicBus) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'triangle'; o.frequency.setValueAtTime(190, t);
  env(g, t, 0.002, 0.25, 0.09);
  o.connect(g).connect(musicBus); o.start(t); o.stop(t + 0.12);
}
function bass(t: number, f: number, I: number) {
  if (!ctx || !musicBus) return;
  const o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
  o.type = 'sawtooth'; o.frequency.value = f;
  lp.type = 'lowpass'; lp.Q.value = 6;
  lp.frequency.setValueAtTime(I >= 2 ? 1400 : 700, t); lp.frequency.exponentialRampToValueAtTime(160, t + STEP * 1.8);
  env(g, t, 0.005, 0.34, STEP * 1.8);
  o.connect(lp).connect(g).connect(musicBus); o.start(t); o.stop(t + STEP * 2);
}
function pad(t: number, chord: number[], I: number) {
  if (!ctx || !musicBus) return;
  const len = STEP * 16, lp = ctx.createBiquadFilter(), g = ctx.createGain();
  lp.type = 'lowpass'; lp.frequency.value = I === 0 ? 900 : 1500;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(I === 0 ? 0.13 : 0.07, t + 0.4); g.gain.setValueAtTime(I === 0 ? 0.13 : 0.07, t + len - 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  lp.connect(g).connect(musicBus);
  for (const n of chord) for (const det of [-7, 7]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(n); o.detune.value = det;
    o.connect(lp); o.start(t); o.stop(t + len + 0.05);
  }
}
function arp(t: number, f: number, I: number) {
  if (!ctx || !musicBus) return;
  const o = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
  o.type = 'square'; o.frequency.value = f;
  lp.type = 'lowpass'; lp.frequency.value = I === 0 ? 1200 : I === 1 ? 2400 : 4200;
  env(g, t, 0.004, I === 0 ? 0.05 : 0.07, STEP * 0.9);
  o.connect(lp).connect(g).connect(musicBus); o.start(t); o.stop(t + STEP);
}
function lead(t: number, f: number) {
  if (!ctx || !musicBus) return;
  const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sawtooth'; o2.type = 'sawtooth'; o.frequency.value = f; o2.frequency.value = f; o2.detune.value = 12;
  env(g, t, 0.01, 0.07, STEP * 1.6);
  o.connect(g); o2.connect(g); g.connect(musicBus);
  o.start(t); o2.start(t); o.stop(t + STEP * 1.8); o2.stop(t + STEP * 1.8);
}
