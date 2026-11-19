'use client';

import { useEffect, useState } from 'react';
import type { HudState } from '@/game/store';
import { MAX_LEVEL } from '@/game/engine';
import { CloseIcon, HomeIcon, MusicIcon, PauseIcon, PlayIcon, RestartIcon, SettingsIcon, SoundIcon, VibrateIcon } from './Icons';
import { settings as initialSettings, updateSettings, unlockAudio, type SoundSettings } from '@/game/audio';

const fmtKm = (m: number) => (m / 1000).toFixed(2);
const stop = (e: React.PointerEvent) => e.stopPropagation();

export interface HudActions {
  start: () => void;
  pause: () => void;
  resume: () => void;
  menu: () => void;
}

function Bar({ label, value, kind, warn }: { label: string; value: number; kind: string; warn?: boolean }) {
  return (
    <div className={`row ${warn ? 'warn' : ''}`}>
      <span className="row-label">{label}</span>
      <div className="bar">
        <i className={kind} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function Toggle({ label, icon, on, onChange }: { label: string; icon: React.ReactNode; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} onPointerDown={stop} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="with-icon">{icon}{label}</span>
      <i><b /></i>
    </button>
  );
}

function Slider({ value, disabled, onChange, label }: { value: number; disabled: boolean; onChange: (v: number) => void; label: string }) {
  return (
    <input className="slider" type="range" min={0} max={100} value={Math.round(value * 100)} disabled={disabled} aria-label={label}
      onPointerDown={stop} onChange={(e) => onChange(Number(e.target.value) / 100)} />
  );
}

/** Sound & feel settings, used in the pause menu and from the start screen. */
function Settings() {
  const [s, setS] = useState<SoundSettings>({ ...initialSettings });
  const set = (patch: Partial<SoundSettings>) => { unlockAudio(); updateSettings(patch); setS((o) => ({ ...o, ...patch })); };
  return (
    <div className="settings">
      <div className="set-row">
        <Toggle label="Music" icon={<MusicIcon />} on={s.music} onChange={(v) => set({ music: v })} />
        <Slider label="Music volume" value={s.musicVol} disabled={!s.music} onChange={(v) => set({ musicVol: v })} />
      </div>
      <div className="set-row">
        <Toggle label="Sound effects" icon={<SoundIcon />} on={s.sfx} onChange={(v) => set({ sfx: v })} />
        <Slider label="Effects volume" value={s.sfxVol} disabled={!s.sfx} onChange={(v) => set({ sfxVol: v })} />
      </div>
      <div className="set-row">
        <Toggle label="Vibration" icon={<VibrateIcon />} on={s.vibration} onChange={(v) => set({ vibration: v })} />
      </div>
    </div>
  );
}

function Sheet({ title, children, onClose }: { title: string; children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="sheet-backdrop" onPointerDown={stop}>
      <div className="sheet" role="dialog" aria-label={title}>
        <div className="sheet-head">
          <h3>{title}</h3>
          {onClose && <button className="icon-btn" aria-label="Close" onPointerDown={stop} onClick={onClose}><CloseIcon /></button>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Hud({ state: s, actions }: { state: HudState; actions: HudActions }) {
  const [install, setInstall] = useState<any>(null);
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); setInstall(e); };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  useEffect(() => { if (s.phase !== 'paused' && s.phase !== 'menu') setShowSettings(false); }, [s.phase]);

  if (s.phase === 'error') {
    return (
      <div className="overlay loading">
        <h1 className="logo">FIT<span>RUN</span></h1>
        <p className="muted">{s.loadLabel}</p>
        <button className="cta" onPointerDown={stop} onClick={() => location.reload()}>RELOAD</button>
      </div>
    );
  }

  if (s.phase === 'loading') {
    return (
      <div className="overlay loading">
        <h1 className="logo">FIT<span>RUN</span></h1>
        <div className="load-bar"><i style={{ width: `${Math.round(s.loadProgress * 100)}%` }} /></div>
        <p className="muted">{s.loadLabel}…</p>
      </div>
    );
  }

  if (s.phase === 'menu') {
    return (
      <div className="overlay menu">
        <button className="icon-btn corner" aria-label="Settings" onPointerDown={stop} onClick={() => setShowSettings(true)}><SettingsIcon size={22} /></button>
        <h1 className="logo">FIT<span>RUN</span></h1>
        <p className="tagline">Run the city. Grab the shakes. Grow.</p>
        <button className="cta" onPointerDown={stop} onClick={actions.start}>TAP TO RUN</button>
        {s.best > 0 && <p className="muted">Best: {fmtKm(s.best)} km</p>}
        <ul className="howto">
          <li><b>←  →</b> change lane · <b>↑</b> jump · <b>↓</b> slide</li>
          <li>🥤 shakes grow you · 💧 water · 🍌 energy · 🍔🥤 junk drains you</li>
          <li>☀ sun dries you out — run in the shade</li>
          <li>💥 a crash costs ⅓ of your stamina · 9 shakes in a row = BEAST</li>
        </ul>
        {install && <button className="ghost" onPointerDown={stop} onClick={() => install.prompt()}>Install app</button>}
        {showSettings && <Sheet title="Settings" onClose={() => setShowSettings(false)}><Settings /></Sheet>}
      </div>
    );
  }

  const st = s.stats;
  const playing = s.phase === 'running';
  return (
    <>
      <div className="hud">
        {/* menu bar across the top (below the status bar / notch on phones) */}
        <div className="menubar">
          <div className="mb-stats">
            <b>{s.speedKmh}<small> km/h</small></b>
            <span>{fmtKm(s.distance)} km · PR {fmtKm(s.best)}</span>
          </div>
          <div className="bars">
            <Bar label="⚡ STAMINA" value={s.stamina} kind="stamina" warn={s.stamina < 25} />
            <Bar label="💧 HYDRATION" value={s.hydration} kind="water" warn={s.lowWater} />
            <Bar label={s.maxed ? '💪 FITNESS MAX' : `💪 FITNESS LV ${s.level}`} value={s.xp * 100} kind={s.maxed ? 'fit max' : 'fit'} />
          </div>
          <div className="mb-right">
            <b>🥤 {s.shakes}</b>
            <span>❤ {s.bpm} · <em className={s.inShade ? 'shade' : 'sun'}>{s.inShade ? 'SHADE' : 'SUN'}</em></span>
          </div>
          <button className="icon-btn pause-btn" aria-label="Pause" disabled={!playing} onPointerDown={stop} onClick={actions.pause}><PauseIcon /></button>
        </div>

        {playing && s.beast > 0 && <div className="beast">BEAST MODE <small>{s.beast.toFixed(1)}s · SMASH EVERYTHING</small></div>}
        {playing && s.heavy > 0 && <div className="heavy">🍔 HEAVY {s.heavy.toFixed(1)}s</div>}
        {s.hint && <div className="hint">{s.hint}</div>}
        {s.pops.map((p) => (
          <div key={p.id} className={`pop ${p.big ? 'big' : ''}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, color: p.color }}>{p.text}</div>
        ))}
        {s.lowWater && <div className="vignette" />}
      </div>

      {s.phase === 'secondwind' && (
        <div className="overlay sw">
          <h2>SECOND WIND!</h2>
          <p>TAP FAST to get back up</p>
          <div className="load-bar big"><i style={{ width: `${(s.secondWindTaps / s.secondWindNeed) * 100}%` }} /></div>
          <p className="muted">{s.secondWindTime.toFixed(1)}s</p>
        </div>
      )}

      {s.phase === 'paused' && (
        <Sheet title={showSettings ? 'Settings' : 'Paused'} onClose={showSettings ? () => setShowSettings(false) : undefined}>
          {showSettings ? <Settings /> : (
            <div className="pause-menu">
              <div className="pause-stats">
                <div><b>{fmtKm(s.distance)}</b><span>km</span></div>
                <div><b>{s.shakes}</b><span>shakes</span></div>
                <div><b>{s.maxed ? 'MAX' : `LV ${s.level}`}</b><span>fitness</span></div>
              </div>
              <button className="cta" onPointerDown={stop} onClick={actions.resume}><span className="with-icon"><PlayIcon />RESUME</span></button>
              <button className="menu-item" onPointerDown={stop} onClick={() => setShowSettings(true)}><SettingsIcon />Settings</button>
              <button className="menu-item" onPointerDown={stop} onClick={actions.start}><RestartIcon />Restart run</button>
              <button className="menu-item" onPointerDown={stop} onClick={actions.menu}><HomeIcon />Main menu</button>
            </div>
          )}
        </Sheet>
      )}

      {s.phase === 'over' && st && (
        <div className="overlay over">
          <h2>{st.newBest ? 'NEW PERSONAL RECORD!' : 'EXHAUSTED'}</h2>
          <div className="stats">
            <div><b>{fmtKm(st.distance)}</b><span>km</span></div>
            <div><b>{st.shakes}</b><span>shakes</span></div>
            <div><b>{st.level >= MAX_LEVEL ? 'MAX' : `LV ${st.level}`}</b><span>fitness</span></div>
            <div><b>{st.kcal}</b><span>kcal</span></div>
          </div>
          <p className="muted">PR {fmtKm(st.best)} km</p>
          <button className="cta" onPointerDown={stop} onClick={actions.start}>RUN AGAIN</button>
          <button className="ghost with-icon" onPointerDown={stop} onClick={actions.menu}><HomeIcon size={18} />Main menu</button>
        </div>
      )}
    </>
  );
}
