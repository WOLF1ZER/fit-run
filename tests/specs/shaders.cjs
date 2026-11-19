// No graphics code (shader) is prepared in the middle of a run: that caused ~50 ms freezes.
// Runs 700 frames from three starting times: noon, sunset turning into night, night turning into morning.
module.exports = {
  title: 'no mid-run freezes from shader compiles',
  async run(t) {
    for (const [label, hour, tod0] of [['noon', 12, 1.0], ['sunset → night', 18, 2.8], ['night → morning', 23, 3.8]]) {
      const p = await t.open({ hour, viewport: { width: 320, height: 180 } });
      await p.evaluate((tod0) => {
        const e = window.__fitrun; e.pause = () => {}; e.start(); e.tod0 = tod0;
        window.__L = { start: e.renderer.info.programs.length, frames: [], events: [], name: e.atmo.name };
      }, tod0);
      for (let batch = 0; batch < 7; batch++) {
        await p.evaluate(() => {
          const e = window.__fitrun, R = e.renderer, L = window.__L;
          for (let k = 0; k < 100; k++) {
            e.stamina = 100; e.hydration = 100; e.player.invuln = 0.0001;
            const t0 = performance.now();
            e.step(1 / 30); e.world.runJobs(4);
            if (k % 2 === 0) R.shadowMap.needsUpdate = true;
            R.render(e.scene, e.camera);
            L.frames.push(performance.now() - t0);
            if (e.atmo.name !== L.name) { L.events.push(e.atmo.name); L.name = e.atmo.name; }
          }
        });
      }
      const r = await p.evaluate(() => {
        const e = window.__fitrun, L = window.__L, f = L.frames.slice().sort((a, b) => b - a);
        return { start: L.start, end: e.renderer.info.programs.length, times: L.events, metres: Math.round(e.distance), medianMs: Math.round(f[f.length >> 1]), worstMs: f.slice(0, 3).map(Math.round) };
      });
      t.info(label, r);
      t.check(`${label}: no shader compiled during the run`, r.end === r.start, `${r.start} → ${r.end} programs`);
      await p.context().close();
    }
  },
};
