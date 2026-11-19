// Hitting an obstacle costs stamina and knocks it flying.
module.exports = {
  title: 'obstacles fly away when hit',
  async run(t) {
    const p = await t.open({ viewport: { width: 1280, height: 720 } });
    for (const kind of ['barrier', 'jogger', 'car']) {
      const r = await p.evaluate((kind) => {
        const e = window.__fitrun; e.start(); e.ents.clear(); e.nextRow = 1e9; e.simulate(0.3);
        const s0 = e.stamina; e.ents.spawnObstacle(kind, e.player.lane, kind === 'car' ? -8.4 : -6);
        const o = e.ents.obstacles[0]; let time = 0;
        while (!o.hit && time < 2) { e.simulate(1 / 30, 1 / 30); time += 1 / 30; }
        e.simulate(0.28, 1 / 30);
        e.pause(true); window.__fitrunHud.set({ pops: [], hint: '' });
        return { lost: Math.round(s0 - e.stamina), flying: !!o.fly, height: +o.obj.position.y.toFixed(2) };
      }, kind);
      // 34 for the crash plus a little normal running drain during the test
      t.check(`${kind}: hit costs 34 stamina and it flies away`, r.lost >= 34 && r.lost <= 38 && r.flying, r);
      await t.shot(p, kind);
    }
  },
};
