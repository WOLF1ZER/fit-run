// Heat/battery: menus draw at 30 fps, nothing is redrawn while paused, gameplay runs at full rate.
// Drawing is swapped for a counter so this measures the game's loop, not the computer's graphics speed.
module.exports = {
  title: 'menus at 30 fps, no redraws while paused',
  async run(t) {
    const p = await t.open({ viewport: { width: 200, height: 360 } });
    const rate = (ms) => p.evaluate((ms) => new Promise((res) => {
      const R = window.__fitrun.renderer, real = R.render; let n = 0, ticks = 0; const t0 = performance.now();
      R.render = () => { n++; };
      const tick = () => { ticks++; if (performance.now() - t0 < ms) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      setTimeout(() => { R.render = real; res({ draws: Math.round(n / (ms / 1000)), screenHz: Math.round(ticks / (ms / 1000)) }); }, ms);
    }), ms);
    const menu = await rate(3000);
    await p.evaluate(() => window.__fitrun.start());
    const running = await rate(3000);
    await p.evaluate(() => window.__fitrun.pause(true));
    await p.waitForTimeout(200);
    const paused = await rate(3000);
    const before = await p.evaluate(() => { const R = window.__fitrun.renderer, real = R.render; window.__n = 0; R.render = function (...a) { window.__n++; return real.apply(this, a); }; return 0; });
    await p.setViewportSize({ width: 360, height: 200 }); // rotate the phone while paused
    await p.waitForTimeout(800);
    const afterRotate = await p.evaluate(() => window.__n) - before;
    await p.evaluate(() => window.__fitrun.pause(false));
    const resumed = await rate(2000);
    t.info('draws per second', { menu, running, paused, resumed });
    t.check('menu draws at most ~30 times a second', menu.draws <= 32 && menu.draws >= Math.min(20, menu.screenHz * 0.4), menu);
    t.check('gameplay draws every frame', running.draws >= running.screenHz * 0.9, running);
    t.check('nothing is redrawn while paused', paused.draws === 0, paused);
    t.check('rotating while paused redraws once', afterRotate >= 1 && afterRotate <= 3, `${afterRotate} draws`);
    t.check('the game continues after resuming', resumed.draws >= resumed.screenHz * 0.9 && (await p.evaluate(() => window.__fitrunHud.get().phase)) === 'running', resumed);
  },
};
