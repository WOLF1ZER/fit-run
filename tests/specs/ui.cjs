// Menu bar, pause menu, settings, fixed HUD layout and the "Get the app" panel, on phone and desktop.
module.exports = {
  title: 'pause menu, settings, HUD layout, install panel',
  async run(t) {
    for (const [tag, opts] of [['phone', { phone: true }], ['desktop', { viewport: { width: 1280, height: 720 } }]]) {
      const p = await t.open(opts);
      await p.evaluate(() => { const e = window.__fitrun; e.start(); e.simulate(3); window.__fitrunHud.set({ hint: '' }); });
      await t.shot(p, `${tag}_run`, { keepUi: true });
      await p.click('.pause-btn');
      await p.waitForSelector('.sheet');
      t.check(`${tag}: pause button pauses the game`, (await p.evaluate(() => window.__fitrunHud.get().phase)) === 'paused');
      await t.shot(p, `${tag}_pause`, { keepUi: true });
      await p.click('.menu-item >> nth=0');
      await p.click('.toggle >> nth=2'); // vibration off
      const saved = JSON.parse((await p.evaluate(() => localStorage.getItem('fitrun.settings.v1'))) || '{}');
      t.check(`${tag}: settings are saved`, saved.vibration === false, saved);
      await t.shot(p, `${tag}_settings`, { keepUi: true });

      // the bars must not jump around when numbers change length (sun/shade, 5 m → 11 km, …)
      const pos = [];
      for (const v of [{ inShade: true, speedKmh: 9, distance: 5, shakes: 0, bpm: 99, level: 1 }, { inShade: false, speedKmh: 41, distance: 11360, shakes: 548, bpm: 227, level: 30 }, { inShade: true, speedKmh: 120, distance: 99999, shakes: 9999, bpm: 99, level: 9 }]) {
        await p.evaluate((v) => window.__fitrunHud.set({ ...v, phase: 'running' }), v);
        pos.push(await p.evaluate(() => [...document.querySelectorAll('.menubar .bar, .pause-btn')].map((el) => { const r = el.getBoundingClientRect(); return Math.round(r.x) + ',' + Math.round(r.width); }).join(' ')));
      }
      t.check(`${tag}: HUD bars keep a fixed position`, new Set(pos).size === 1, pos[0]);
    }

    // "Get the app": steps on iPhone, the browser's install button on desktop
    const ip = await t.open({ phone: true });
    await ip.click('text=Get the app');
    await ip.waitForSelector('.sheet');
    t.check('iPhone: install steps are shown', await ip.isVisible('.steps'));
    await t.shot(ip, 'install_iphone', { keepUi: true });
    const dp = await t.open({ viewport: { width: 1280, height: 720 } });
    await dp.evaluate(() => { window.__installPrompt = { prompt() { window.__prompted = true; }, userChoice: Promise.resolve({ outcome: 'accepted' }) }; window.dispatchEvent(new Event('fitrun-installable')); });
    await dp.waitForTimeout(300); // let the menu notice the browser can install
    await dp.click('text=Get the app');
    await dp.waitForSelector('.install-btn', { timeout: 10000 });
    await dp.click('.install-btn');
    t.check('desktop: INSTALL APP opens the browser install prompt', await dp.evaluate(() => !!window.__prompted));
  },
};
