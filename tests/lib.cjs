// Shared helpers for the FIT RUN browser tests.
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const OUT = path.join(__dirname, 'output');
const LOAD_TIMEOUT = 300000; // the game loads in a few seconds on a real GPU, minutes with software rendering

// Default: use the computer's graphics card when the browser allows it, software rendering otherwise.
// SOFTWARE_GL=1 forces software rendering (SwiftShader), e.g. on servers without a GPU.
const GL_ARGS = process.env.SOFTWARE_GL === '1'
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

let browser;
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: process.env.HEADED !== '1',
      args: [...GL_ARGS, '--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'],
    });
  }
  return browser;
}
async function closeBrowser() { if (browser) await browser.close(); browser = undefined; }

const PHONE = { ...devices['iPhone 13'], deviceScaleFactor: 1 };

/** Test context handed to each spec: open pages, record checks, save screenshots. */
class T {
  constructor(name, baseUrl) {
    this.name = name;
    this.baseUrl = baseUrl;
    this.results = [];
    this.errors = [];
    this.contexts = [];
  }

  /**
   * Opens the game and waits for the start menu.
   * opts: phone (iPhone-sized), viewport, hour (fakes the clock, which picks the starting time of day),
   *       init (function run in the page before the game loads), query (e.g. '?debug'), contextOptions.
   */
  async open(opts = {}) {
    const b = await getBrowser();
    const ctxOpts = opts.phone ? { ...PHONE } : { viewport: opts.viewport || { width: 960, height: 540 }, deviceScaleFactor: 1 };
    const ctx = await b.newContext({ ...ctxOpts, ...(opts.contextOptions || {}) });
    this.contexts.push(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => this.errors.push(e.message));
    if (opts.hour !== undefined) await page.addInitScript((h) => { Date.prototype.getHours = function () { return h; }; }, opts.hour);
    if (opts.init) await page.addInitScript(opts.init);
    await page.goto(this.baseUrl + (opts.query || ''));
    await this.waitForMenu(page);
    return page;
  }

  async waitForMenu(page) {
    await page.waitForFunction(() => document.querySelector('.cta') && window.__fitrun, null, { timeout: LOAD_TIMEOUT });
  }

  /** Records a pass/fail check. */
  check(label, ok, detail = '') {
    this.results.push({ label, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  }

  /** Prints a measurement without passing judgement (frame times depend on the computer). */
  info(label, value) { console.log(`  info  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`); }

  /** Saves a screenshot to tests/output/<spec>_<name>.png with the pause sheet hidden. */
  async shot(page, name, opts = {}) {
    fs.mkdirSync(OUT, { recursive: true });
    if (!opts.keepUi) await page.evaluate(() => document.querySelectorAll('.sheet-backdrop').forEach((o) => (o.style.display = 'none')));
    const file = path.join(OUT, `${this.name}_${name}.png`);
    await page.screenshot({ path: file, timeout: LOAD_TIMEOUT, ...(opts.clip ? { clip: opts.clip } : {}) });
    if (!opts.keepUi) await page.evaluate(() => document.querySelectorAll('.sheet-backdrop').forEach((o) => (o.style.display = '')));
    return file;
  }

  outFile(name) { fs.mkdirSync(OUT, { recursive: true }); return path.join(OUT, `${this.name}_${name}`); }

  async finish() {
    this.check('no JavaScript errors in the page', this.errors.length === 0, this.errors.slice(0, 3).join(' | '));
    for (const c of this.contexts) await c.close().catch(() => {});
    this.contexts = [];
  }
}

module.exports = { T, getBrowser, closeBrowser, PHONE, OUT, LOAD_TIMEOUT };
