// Game rules: pickups, crashes, fair obstacle rows, max level and top speed.
module.exports = {
  title: 'pickups, crashes, fair rows, max level',
  async run(t) {
    const p = await t.open();

    const food = await p.evaluate(() => {
      const e = window.__fitrun, r = {};
      e.start();
      const eat = (kind) => { e.stamina = 50; e.hydration = 50; e.collect(kind); return { stamina: Math.round(e.stamina), hydration: Math.round(e.hydration), heavy: e.heavy > 0 }; };
      for (const k of ['shake', 'banana', 'water', 'burger', 'soda']) r[k] = eat(k);
      return r;
    });
    t.check('protein shake heals a little (+5 stamina)', food.shake.stamina === 55, food.shake);
    t.check('banana heals more (+22 stamina)', food.banana.stamina === 72, food.banana);
    t.check('water refills hydration (+35)', food.water.hydration === 85, food.water);
    t.check('burger costs stamina (−12) and slows you down', food.burger.stamina === 38 && food.burger.heavy, food.burger);
    t.check('soda costs stamina (−8) and slows you down', food.soda.stamina === 42 && food.soda.heavy, food.soda);

    const crash = await p.evaluate(() => {
      const e = window.__fitrun, out = {};
      const fresh = () => { e.start(); e.ents.clear(); e.nextRow = 1e9; e.level = 30; e.distance = 6000; e.speed = 26; e.simulate(0.05, 1 / 60); e.ents.clear(); };
      // a thin barrier at top speed with only 12 frames a second (~2 m per frame) must still hit
      let missed = 0;
      for (let k = 0; k < 20; k++) { fresh(); const s0 = e.stamina; e.ents.spawnObstacle('barrier', e.player.lane, -8 - Math.random() * 3); e.simulate(1, 1 / 12); if (e.stamina > s0 - 30) missed++; }
      out.barrierLowFps = missed;
      // a car in the lane you are moving into, while half-way between lanes
      missed = 0;
      for (let k = 0; k < 20; k++) { fresh(); e.player.lane = 1; e.player.x = 0; const s0 = e.stamina; e.ents.spawnObstacle('car', 2, -12.4); e.simulate(0.36, 1 / 30); e.input('right'); e.simulate(1.2, 1 / 30); if (e.stamina > s0 - 30) missed++; }
      out.carMidLaneChange = missed;
      // one crash costs 34 stamina; three from full end the run (Second Wind is offered)
      fresh(); const s0 = e.stamina; e.ents.spawnObstacle('car', e.player.lane, -10.4); e.simulate(1, 1 / 30); out.oneCrash = Math.round(s0 - e.stamina);
      for (let k = 0; k < 2; k++) { e.ents.spawnObstacle('car', e.player.lane, -10.4); e.simulate(1, 1 / 30); }
      e.simulate(0.1);
      out.phaseAfter3 = window.__fitrunHud.get().phase;
      return out;
    });
    t.check('barrier is never missed at low frame rate', crash.barrierLowFps === 0, `${crash.barrierLowFps}/20 missed`);
    t.check('car is hit during a lane change into it', crash.carMidLaneChange === 0, `${crash.carMidLaneChange}/20 missed`);
    t.check('one crash costs 34 stamina (+ a little running drain)', crash.oneCrash >= 34 && crash.oneCrash <= 38, `${crash.oneCrash}`);
    t.check('three crashes from full stamina end the run (Second Wind)', crash.phaseAfter3 === 'secondwind' || crash.phaseAfter3 === 'over', crash.phaseAfter3);

    const fair = await p.evaluate(() => {
      const e = window.__fitrun, rows = new Map(), orig = e.ents.spawnObstacle.bind(e.ents);
      e.ents.spawnObstacle = (kind, lane, z) => { const key = Math.round((z + (kind === 'car' ? 2.4 : 0) + e.distance) / 2); if (!rows.has(key)) rows.set(key, []); rows.get(key).push([kind, lane]); return orig(kind, lane, z); };
      e.start();
      for (let i = 0; i < 300; i++) { e.stamina = 100; e.hydration = 100; e.player.invuln = 99; e.simulate(1); }
      e.ents.spawnObstacle = orig;
      let allSolid = 0, obs = 0, joggerPairs = 0;
      for (const [, v] of rows) {
        const solid = new Set(v.filter(([k]) => k === 'car' || k === 'jogger').map(([, l]) => l));
        if (solid.size >= 3) allSolid++;
        if (v.filter(([k]) => k === 'jogger').length > 1) joggerPairs++;
        obs += v.length;
      }
      return { km: +(e.distance / 1000).toFixed(1), rows: rows.size, allSolid, joggerPairs, per100m: +(obs / (e.distance / 100)).toFixed(1) };
    });
    t.info('long run', fair);
    t.check('no row ever blocks all three lanes', fair.allSolid === 0, `${fair.allSolid} of ${fair.rows} rows`);
    t.check('never two joggers in one row', fair.joggerPairs === 0, `${fair.joggerPairs}`);

    const max = await p.evaluate(() => {
      const e = window.__fitrun, out = {};
      e.start(); e.level = 39; e.xp = 41;
      e.collect('shake'); out.level = e.level;
      const b0 = e.bonus; e.collect('shake'); out.levelAfter = e.level; out.bonus = e.bonus - b0;
      e.distance = 50000; e.beast = 99; e.ents.clear(); e.nextRow = 1e12;
      for (let i = 0; i < 60; i++) { e.stamina = 100; e.hydration = 100; e.player.invuln = 999; e.simulate(0.5); }
      out.topKmh = Math.round(10 + e.speed * 1.1);
      out.maxed = window.__fitrunHud.get().maxed;
      e.pause(true);
      return out;
    });
    t.check('level 40 is the max and stays there', max.level === 40 && max.levelAfter === 40, max);
    t.check('shakes at max level give bonus points', max.bonus >= 50, `+${max.bonus}`);
    t.check('HUD shows MAX', max.maxed === true);
    t.check('top speed is capped (≤ 48 km/h, Beast Mode included)', max.topKmh <= 48, `${max.topKmh} km/h`);
    await t.shot(p, 'max_level');
  },
};
