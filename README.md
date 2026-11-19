# FIT RUN

An endless 3D fitness runner built with **Next.js + three.js**, installable as an offline PWA.

You sprint forever through a sunny city. Protein shakes make your character visibly grow
(Runner → Athlete → Strong), water keeps you hydrated (sunlight drains it, shade saves it),
bananas refill stamina and junk food slows you down. Three shakes in a row trigger Beast Mode.
The run ends when stamina hits zero (one Second Wind per run).

The run starts at your real time of day and moves on every 1.2 km (morning → noon → sunset → night),
and the location changes every km: Palm Boulevard → Beach Promenade → Downtown.

> Work in progress: the playable prototype is being built on this branch.

## Assets
- Photo-scanned textures and street props: [Poly Haven](https://polyhaven.com) (CC0)
- Player: the owner's own rigged character model (Mixamo rig with Idle/Run/Jump/Walk), textures
  re-encoded to 2K JPEG and the mesh simplified with meshoptimizer (36 MB → 8.6 MB)
- Joggers: built with [ara3d](https://www.npmjs.com/package/ara3d) from MakeHuman data (CC0);
  running animations from the CMU Graphics Lab Motion Capture Database
  ("The data used in this project was obtained from mocap.cs.cmu.edu.
  The database was created with funding from NSF EIA-0196217.")
- Sunset HDRI: [@pmndrs/assets](https://github.com/pmndrs/assets)

## Develop
```bash
npm install
npm run dev
```

## Test
Browser tests (Playwright) live in [`tests/`](tests/README.md): game rules, crashes, UI, offline play, districts, freezes, battery use and music.
```bash
npm run build
cd tests && npm install && npx playwright install chromium
npm test
```
