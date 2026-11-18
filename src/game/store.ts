// Tiny external store: the engine writes HUD state, React reads it with useSyncExternalStore.

export type Phase = 'loading' | 'menu' | 'running' | 'secondwind' | 'over' | 'paused';

export interface Pop {
  id: number;
  text: string;
  color: string;
  x: number; // 0..1 screen position
  y: number;
  big?: boolean;
}

export interface RunStats {
  distance: number; // metres
  shakes: number;
  kcal: number;
  level: number;
  best: number;
  newBest: boolean;
  timeSec: number;
}

export interface HudState {
  phase: Phase;
  loadProgress: number; // 0..1
  loadLabel: string;
  speedKmh: number;
  distance: number;
  best: number;
  stamina: number; // 0..100
  hydration: number; // 0..100
  level: number;
  xp: number; // 0..1 progress inside the level
  shakes: number;
  bpm: number;
  combo: number;
  comboLabel: string;
  beast: number; // seconds left, 0 when off
  heavy: number; // seconds left of junk-food slowdown
  inShade: boolean;
  lowWater: boolean;
  pops: Pop[];
  secondWindTaps: number;
  secondWindNeed: number;
  secondWindTime: number;
  secondWindUsed: boolean;
  hint: string;
  stats: RunStats | null;
  levelUp: number; // timestamp of last level-up, for the banner
  quality: 'high' | 'low';
}

const initial: HudState = {
  phase: 'loading',
  loadProgress: 0,
  loadLabel: 'Loading',
  speedKmh: 0,
  distance: 0,
  best: 0,
  stamina: 100,
  hydration: 100,
  level: 1,
  xp: 0,
  shakes: 0,
  bpm: 72,
  combo: 0,
  comboLabel: '',
  beast: 0,
  heavy: 0,
  inShade: true,
  lowWater: false,
  pops: [],
  secondWindTaps: 0,
  secondWindNeed: 12,
  secondWindTime: 0,
  secondWindUsed: false,
  hint: '',
  stats: null,
  levelUp: 0,
  quality: 'high',
};

let state: HudState = initial;
const listeners = new Set<() => void>();

export const hud = {
  get: () => state,
  set(patch: Partial<HudState>) {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

// Persistent profile (survives between runs, works offline).
export interface Profile {
  best: number;
  totalShakes: number;
  runs: number;
  lastDay: string;
  streak: number;
}

const KEY = 'fitrun.profile.v1';

export function loadProfile(): Profile {
  const empty: Profile = { best: 0, totalShakes: 0, runs: 0, lastDay: '', streak: 0 };
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty, ...JSON.parse(raw) } : empty;
  } catch {
    return empty;
  }
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode: progress just isn't kept */
  }
}
