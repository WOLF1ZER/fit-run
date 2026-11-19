# FIT RUN tests

Browser tests that open the real game in Chromium (via Playwright) and check that it still behaves as designed. They print `PASS` / `FAIL` for every check and save screenshots to `tests/output/`.

## One-time setup

You need [Node.js](https://nodejs.org) 20 or newer.

In the project folder (once, and after pulling changes):

```bash
npm install
```

In the `tests` folder:

```bash
cd tests
```

```bash
npm install
```

```bash
npx playwright install chromium
```

## Run

Build the game first (in the project folder), because the tests run the real build, the same one Vercel serves:

```bash
npm run build
```

Then, in the `tests` folder:

```bash
npm test
```

That runs the quick set; a local server for the build starts and stops automatically. Other ways to run:

| Command | What it does |
|---|---|
| `npm test` | Every test except the slow 4 km run |
| `npm run test:all` | Everything, including `longrun` |
| `node run.cjs rules ui` | Only the tests you name |
| `HEADED=1 node run.cjs knock` | Shows the browser window while it runs |
| `SOFTWARE_GL=1 npm test` | Software rendering, for machines without a graphics card (much slower) |
| `BASE_URL=https://fit-run-bice.vercel.app/ node run.cjs offline` | Tests the live site instead of your local build |

On Windows PowerShell, set a variable like this: `$env:HEADED=1; node run.cjs knock`

The command ends with exit code 0 when everything passes and 1 when something fails.

## What is tested

| Test | Checks |
|---|---|
| `rules` | Shake +5 stamina, banana +22, water +35 hydration, burger −12 and soda −8 (and slow you down). A crash costs 34; three crashes from full end the run. Barriers are hit even at 12 fps; cars are hit during a lane change. Over a 300 s run no row blocks all three lanes and joggers never come in pairs. Level 40 is the max, the HUD shows MAX, top speed is capped. |
| `knock` | Barrier, jogger and car each cost 34 stamina when hit and fly away. |
| `ui` | Phone and desktop: pause button, settings saved, HUD bars never shift when numbers change. "Get the app": steps on iPhone, the install prompt on desktop. |
| `offline` | After one visit the game reloads and plays with the internet switched off. |
| `world` | A 4.4 km run: districts come in order (boulevard → beach → downtown → …), each stop shows the right time of day, the next district is ready in time, GPU memory stays flat, draw calls stay low. Screenshots of every stop. |
| `shaders` | 700 frames starting at noon, at sunset turning into night, and at night turning into morning: no graphics code is compiled mid-run (that was the ~50 ms night freeze). |
| `power` | Menus draw at most ~30 times a second, nothing is redrawn while paused, rotating while paused redraws once, gameplay runs every frame. |
| `music` | The background music renders and isn't silent or clipping; saved as `output/music_preview.wav` to listen to. |
| `longrun` (slow) | 4 km at top speed through all districts and times of day: no shader compiles, no late building. |

Lines marked `info` are measurements (frame times, memory, draw calls). They depend on your computer, so they don't pass or fail.

## Notes

- The tests use the game's debug hooks (`window.__fitrun`, `window.__fitrunHud`, `window.__fitrunAudio`). If those are renamed, the tests need the same change.
- Each spec is one file in `specs/`; `lib.cjs` has the shared helpers (open the game, `check`, `info`, screenshots).
- With a graphics card the quick set takes a few minutes. With software rendering it can take much longer.
