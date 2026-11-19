// SLOW: 4 km at top speed through every district and time of day, checking for shader compiles and late builds.
// Not part of the quick set; run with `node run.cjs all` or `node run.cjs longrun`.
module.exports = {
  title: '4 km at top speed (slow)',
  slow: true,
  async run(t) {
    const p = await t.open({ hour: 18, viewport: { width: 320, height: 180 } });
    await p.evaluate(() => {
      const e = window.__fitrun; e.pause = () => {}; e.start(); e.tod0 = 2.6;
      window.__L = { start: e.renderer.info.programs.length, frames: [], places: new Set([e.world.district]), times: new Set([e.atmo.name]) };
    });
    for (let batch = 0; batch < 8; batch++) {
      await p.evaluate(() => {
        const e = window.__fitrun, R = e.renderer, L = window.__L;
        for (let k = 0; k < 250; k++) {
          e.stamina = 100; e.hydration = 100; e.player.invuln = 0.0001; e.speed = 34;
          const t0 = performance.now();
          e.step(1 / 15); e.world.runJobs(4);
          if (k % 2 === 0) R.shadowMap.needsUpdate = true;
          R.render(e.scene, e.camera);
          L.frames.push(performance.now() - t0);
          L.places.add(e.world.district); L.times.add(e.atmo.name);
        }
      });
      t.info(`batch ${batch + 1}/8`, `${await p.evaluate(() => Math.round(window.__fitrun.distance))} m`);
    }
    const r = await p.evaluate(() => {
      const e = window.__fitrun, L = window.__L, f = L.frames.slice().sort((a, b) => b - a);
      return { start: L.start, end: e.renderer.info.programs.length, km: +(e.distance / 1000).toFixed(2), syncBuilds: e.world.syncBuilds, places: [...L.places], times: [...L.times], medianMs: Math.round(f[f.length >> 1]), worstMs: f.slice(0, 5).map(Math.round) };
    });
    t.info('result', r);
    t.check('ran 4 km through all 3 districts and 4 times of day', r.km >= 4 && r.places.length === 3 && r.times.length === 4, r);
    t.check('no shader compiled during the run', r.end === r.start, `${r.start} → ${r.end}`);
    t.check('no on-the-spot building at top speed', r.syncBuilds === 0, r.syncBuilds);
  },
};
