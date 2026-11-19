#!/usr/bin/env node
// FIT RUN test runner.
//   node run.cjs              quick set (everything except the slow ones)
//   node run.cjs all          everything, including the long 4 km run
//   node run.cjs rules ui     only the named specs
// Tests the local build in ../out (started automatically) unless BASE_URL is set, e.g.
//   BASE_URL=https://fit-run-bice.vercel.app/ node run.cjs offline
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { T, closeBrowser } = require('./lib.cjs');

const ROOT = path.resolve(__dirname, '..');
const SPECS = fs.readdirSync(path.join(__dirname, 'specs')).filter((f) => f.endsWith('.cjs')).sort()
  .map((f) => ({ name: f.replace(/\.cjs$/, ''), ...require(path.join(__dirname, 'specs', f)) }));

function waitForServer(url, ms = 15000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => http.get(url, (res) => { res.resume(); resolve(); }).on('error', () => {
      if (Date.now() - t0 > ms) reject(new Error('local server did not start: ' + url)); else setTimeout(tryOnce, 300);
    });
    tryOnce();
  });
}

(async () => {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== 'all' && !SPECS.some((s) => s.name === a));
  if (unknown.length) {
    console.log(`Unknown test: ${unknown.join(', ')}\nAvailable: ${SPECS.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }
  const chosen = args.length === 0 ? SPECS.filter((s) => !s.slow) : args.includes('all') ? SPECS : SPECS.filter((s) => args.includes(s.name));

  let baseUrl = process.env.BASE_URL, server;
  if (!baseUrl) {
    if (!fs.existsSync(path.join(ROOT, 'out', 'index.html'))) {
      console.log('No build found. In the project folder run:  npm run build   then run the tests again.');
      process.exit(2);
    }
    const port = process.env.TEST_PORT || '3123';
    server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: port }, stdio: 'ignore' });
    baseUrl = `http://localhost:${port}/`;
    await waitForServer(baseUrl);
  }
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  console.log(`FIT RUN tests on ${baseUrl}  (${process.env.SOFTWARE_GL === '1' ? 'software rendering' : 'GPU if available'})\n`);

  const summary = [];
  for (const spec of chosen) {
    console.log(`▶ ${spec.name}: ${spec.title}`);
    const t = new T(spec.name, baseUrl), t0 = Date.now();
    try { await spec.run(t); } catch (e) { t.check('test ran to the end', false, String(e && e.message || e).split('\n')[0]); }
    await t.finish();
    const failed = t.results.filter((r) => !r.ok).length;
    summary.push({ name: spec.name, failed, total: t.results.length, secs: Math.round((Date.now() - t0) / 1000) });
    console.log('');
  }
  await closeBrowser();
  if (server) server.kill();

  console.log('Summary');
  for (const s of summary) console.log(`  ${s.failed ? 'FAIL' : 'ok  '}  ${s.name.padEnd(10)} ${s.total - s.failed}/${s.total} checks  ${s.secs}s`);
  const bad = summary.filter((s) => s.failed).length;
  console.log(bad ? `\n${bad} test file(s) failed. Screenshots are in tests/output/` : '\nAll passed. Screenshots are in tests/output/');
  process.exit(bad ? 1 : 0);
})();
