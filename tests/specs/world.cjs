// Locations and time of day along a 4.4 km run: order of districts, no on-the-spot building, memory stays flat.
module.exports = {
  title: 'districts, time of day, memory over 4.4 km',
  async run(t) {
    const p = await t.open({ viewport: { width: 1280, height: 720 } });
    // stop at each place; tod = which time of day to show there (0 morning, 1 noon, 2 sunset, 3 night)
    const stops = [['boulevard', 400, 0, 'MORNING'], ['beach', 1350, 1, 'NOON'], ['downtown', 2350, 2, 'SUNSET'], ['downtown_night', 2600, 3, 'NIGHT'], ['beach_night', 4350, 3, 'NIGHT']];
    await p.evaluate(() => { const e = window.__fitrun; e.start(); e.tod0 = 0; window.__seen = [e.world.district]; });
    const res = {};
    for (const [name, metres, tod] of stops) {
      const r = await p.evaluate(([metres, tod]) => {
        const e = window.__fitrun;
        let worst = 0;
        while (e.distance < metres) {
          e.stamina = 100; e.hydration = 100; e.player.invuln = 99;
          for (let k = 0; k < 15; k++) {
            const t0 = performance.now(); e.step(1 / 30); e.world.runJobs(5); worst = Math.max(worst, performance.now() - t0);
            if (window.__seen[window.__seen.length - 1] !== e.world.district) window.__seen.push(e.world.district);
          }
        }
        e.tod0 = tod - e.distance / 1200 + 0.3; e.simulate(0.05);
        e.ents.clear(); e.ents.spawnItem('shake', 1, -8); e.ents.spawnItem('shake', 1, -10.4); e.ents.spawnObstacle('barrier', 2, -16); e.ents.update(0.001, 0, e.t);
        e.player.invuln = 0; e.simulate(0.02); e.pause(true); window.__fitrunHud.set({ pops: [], hint: '' });
        e.renderer.shadowMap.needsUpdate = true; e.renderer.render(e.scene, e.camera);
        const i = e.renderer.info;
        return { district: e.world.district, time: e.atmo.name, km: +(e.distance / 1000).toFixed(2), syncBuilds: e.world.syncBuilds, drawCalls: i.render.calls, geometries: i.memory.geometries, textures: i.memory.textures, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null, worstStepMs: Math.round(worst) };
      }, [metres, tod]);
      res[name] = r;
      t.info(name, r);
      await t.shot(p, name);
      await p.evaluate(() => window.__fitrun.pause(false));
    }
    for (const [name, , , time] of stops) t.check(`${name}: shows ${time}`, res[name].time === time, res[name].time);
    const seen = await p.evaluate(() => window.__seen);
    t.check('districts come in order: boulevard → beach → downtown → boulevard → beach', seen.join(',') === 'boulevard,beach,downtown,boulevard,beach', seen.join(' → '));
    t.check('the next district is always ready in time (no on-the-spot building)', res.beach_night.syncBuilds === 0, res.beach_night.syncBuilds);
    t.check('GPU memory stays flat (geometries at 4.35 km ≤ 1.3 × at 1.35 km)', res.beach_night.geometries <= res.beach.geometries * 1.3, `${res.beach.geometries} → ${res.beach_night.geometries}`);
    t.check('draw calls stay low (≤ 200)', Object.values(res).every((r) => r.drawCalls <= 200), Object.values(res).map((r) => r.drawCalls).join(', '));
  },
};
