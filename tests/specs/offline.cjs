// The game is cached for offline play and still runs with no internet.
module.exports = {
  title: 'works offline after the first visit',
  async run(t) {
    const p = await t.open();
    await p.waitForSelector('.offline-ok', { timeout: 300000 }).catch(() => {});
    t.check('"ready to play offline" badge appears', await p.isVisible('.offline-ok'));
    await p.context().setOffline(true);
    const t0 = Date.now();
    await p.reload();
    await t.waitForMenu(p);
    t.info('offline reload to menu', ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    const st = await p.evaluate(() => { const e = window.__fitrun; e.start(); const s = e.simulate(5); return { distance: Math.round(s.distance), items: s.items, obstacles: s.obstacles, phase: window.__fitrunHud.get().phase }; });
    t.check('a run works offline', st.distance > 20 && st.phase === 'running' && st.items + st.obstacles > 0, st);
    await p.evaluate(() => window.__fitrun.pause(true));
    await t.shot(p, 'offline_run');
  },
};
