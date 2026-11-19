'use client';

import { useEffect, useState } from 'react';
import type { HudState } from '@/game/store';

const fmtKm = (m: number) => (m / 1000).toFixed(2);

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

export function Hud({ state: s, onStart, onResume }: { state: HudState; onStart: () => void; onResume: () => void }) {
  const [install, setInstall] = useState<any>(null);
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); setInstall(e); };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  const stop = (e: React.PointerEvent) => e.stopPropagation();

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
        <h1 className="logo">FIT<span>RUN</span></h1>
        <p className="tagline">Run the city. Grab the shakes. Grow.</p>
        <button className="cta" onPointerDown={stop} onClick={onStart}>TAP TO RUN</button>
        {s.best > 0 && <p className="muted">Best: {fmtKm(s.best)} km</p>}
        <ul className="howto">
          <li><b>←  →</b> change lane</li>
          <li><b>↑</b> jump · <b>↓</b> slide</li>
          <li>🥤 shakes grow you · 💧 water · 🍌 energy · 🍔 slows you</li>
          <li>☀ sun dries you out — run in the shade</li>
        </ul>
        {install && <button className="ghost" onPointerDown={stop} onClick={() => install.prompt()}>Install app</button>}
      </div>
    );
  }

  const st = s.stats;
  return (
    <>
      <div className="hud">
        <div className="tl">
          <b>{s.speedKmh} km/h</b>
          <span>{fmtKm(s.distance)} km · PR {fmtKm(s.best)} km</span>
        </div>
        <div className="bars">
          <Bar label="⚡ STAMINA" value={s.stamina} kind="stamina" warn={s.stamina < 25} />
          <Bar label="💧 HYDRATION" value={s.hydration} kind="water" warn={s.lowWater} />
          <Bar label={`💪 FITNESS LV ${s.level}`} value={s.xp * 100} kind="fit" />
        </div>
        <div className="tr">
          <b>🥤 {s.shakes}</b>
          <span>❤ {s.bpm} BPM</span>
          <span className={s.inShade ? 'shade' : 'sun'}>{s.inShade ? '🌴 SHADE' : '☀ SUN'}</span>
        </div>
        {s.beast > 0 && <div className="beast">BEAST MODE <small>{s.beast.toFixed(1)}s · SMASH EVERYTHING</small></div>}
        {s.heavy > 0 && <div className="heavy">🍔 HEAVY {s.heavy.toFixed(1)}s</div>}
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
        <div className="overlay">
          <h2>PAUSED</h2>
          <button className="cta" onPointerDown={stop} onClick={onResume}>RESUME</button>
        </div>
      )}

      {s.phase === 'over' && st && (
        <div className="overlay over">
          <h2>{st.newBest ? 'NEW PERSONAL RECORD!' : 'EXHAUSTED'}</h2>
          <div className="stats">
            <div><b>{fmtKm(st.distance)}</b><span>km</span></div>
            <div><b>{st.shakes}</b><span>shakes</span></div>
            <div><b>LV {st.level}</b><span>fitness</span></div>
            <div><b>{st.kcal}</b><span>kcal</span></div>
          </div>
          <p className="muted">PR {fmtKm(st.best)} km</p>
          <button className="cta" onPointerDown={stop} onClick={onStart}>RUN AGAIN</button>
        </div>
      )}
    </>
  );
}
