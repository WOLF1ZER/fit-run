'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Engine } from '@/game/engine';
import { hud } from '@/game/store';
import { music, setAppVisible, unlockAudio } from '@/game/audio';
import { Hud } from './Hud';

export default function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const state = useSyncExternalStore(hud.subscribe, hud.get, hud.get);

  useEffect(() => {
    const engine = new Engine(canvasRef.current!);
    engineRef.current = engine;
    (window as any).__fitrun = engine; // handy for debugging / automated tests
    (window as any).__fitrunHud = hud;
    (window as any).__fitrunAudio = { music, unlockAudio, setAppVisible };
    engine.load().catch((e) => {
      console.error(e);
      hud.set({ loadLabel: 'Could not load the game. Please reload.' });
    });

    // keyboard
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      unlockAudio();
      const phase = hud.get().phase;
      if ((phase === 'menu' || phase === 'over') && (k === 'enter' || k === ' ')) { engine.start(); e.preventDefault(); return; }
      if (k === 'arrowleft' || k === 'a') engine.input('left');
      else if (k === 'arrowright' || k === 'd') engine.input('right');
      else if (k === 'arrowup' || k === 'w' || k === ' ') engine.input('jump');
      else if (k === 'arrowdown' || k === 's') engine.input('slide');
      else if (k === 'p' || k === 'escape') engine.pause(hud.get().phase === 'running');
      else return;
      e.preventDefault();
    };
    // swipes + taps
    let sx = 0, sy = 0, st = 0, fired = false;
    const down = (e: PointerEvent) => { unlockAudio(); sx = e.clientX; sy = e.clientY; st = performance.now(); fired = false; };
    const move = (e: PointerEvent) => {
      if (fired || !st) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 28) return;
      fired = true;
      if (Math.abs(dx) > Math.abs(dy)) engine.input(dx > 0 ? 'right' : 'left');
      else engine.input(dy < 0 ? 'jump' : 'slide');
    };
    const up = () => { if (!fired && st && performance.now() - st < 300) engine.input('tap'); st = 0; };
    // leaving the app pauses the run and freezes all sound; coming back resumes the music
    const vis = () => { engine.pause(document.hidden); setAppVisible(!document.hidden); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pagehide', () => setAppVisible(false));
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.removeEventListener('visibilitychange', vis);
      engine.dispose();
    };
  }, []);

  return (
    <main className="game">
      <canvas ref={canvasRef} className="canvas" />
      <Hud state={state} actions={{
        start: () => engineRef.current?.start(),
        pause: () => engineRef.current?.pause(true),
        resume: () => engineRef.current?.pause(false),
        menu: () => engineRef.current?.toMenu(),
      }} />
    </main>
  );
}
