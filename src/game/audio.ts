// Synthesized sound effects (Web Audio) — no files to download, works offline.
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
export let muted = false;

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}
export function setMuted(m: boolean) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.5;
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
const vib = (ms: number | number[]) => { try { navigator.vibrate?.(ms); } catch { /* not supported */ } };

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
