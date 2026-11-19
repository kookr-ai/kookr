// Deterministic frame capture: steps film.seek(t) frame by frame in headless Chromium.
// usage: node render.mjs <page.html> <outDir> [fps=30] [from=0] [to=duration] [scale=1]
//        AT=0.9,2.1,22.05 node render.mjs <page.html> <outDir>   (stills at exact times, named t<seconds>.png)
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs'; import path from 'node:path';
const require = createRequire(import.meta.url);
// playwright-core: PLAYWRIGHT_CORE=/abs/path/to/playwright-core, or any copy resolvable from the
// current directory. Reuse an installed one; this script never installs a browser.
function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'playwright'].filter(Boolean);
  for (const id of tries) {
    try { return require(id); } catch { /* next */ }
    try { return createRequire(path.join(process.cwd(), 'x.js'))(id); } catch { /* next */ }
  }
  console.error('playwright-core not found. Set PLAYWRIGHT_CORE to the folder of an installed copy\n' +
    '(for example <some repo>/node_modules/playwright-core), or run from a project that has it.');
  process.exit(2);
}
const { chromium } = loadPlaywright();
const [page_, outDir, fps_ = '30', from_ = '0', to_, scale_ = '1'] = process.argv.slice(2);
const fps = +fps_;
// Headless Chromium: CHROME_BIN=/abs/path, or the newest headless shell in Playwright's cache
// (Linux and macOS locations), or whatever this playwright-core considers its default.
function findChromium() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const home = process.env.HOME || '';
  for (const cache of [path.join(home, '.cache/ms-playwright'), path.join(home, 'Library/Caches/ms-playwright')]) {
    if (!fs.existsSync(cache)) continue;
    const build = (d) => Number(d.split('-').pop()) || 0;
    const shells = fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => build(b) - build(a));
    for (const d of shells) {
      for (const sub of fs.readdirSync(path.join(cache, d))) {
        const bin = path.join(cache, d, sub, 'chrome-headless-shell');
        if (fs.existsSync(bin)) return bin;
      }
    }
  }
  return undefined;
}
const exe = findChromium();
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: +scale_ });
page.on('console', m => console.log('[page]', m.text())); page.on('pageerror', e => { console.error('[pageerror]', e.message); process.exitCode = 1; });
await page.goto(pathToFileURL(path.resolve(page_)).href + '?render=1');
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => window.film && window.film.duration > 0);
const dur = await page.evaluate(() => window.film.duration);
const from = +from_, to = to_ ? +to_ : dur;
const f0 = Math.round(from * fps), f1 = Math.round(to * fps);
const t0 = Date.now();
if (process.env.AT) {
  for (const t of process.env.AT.split(',').map(Number)) {
    await page.evaluate(t => { window.film.seek(t); }, t);
    await page.screenshot({ path: path.join(outDir, `t${t.toFixed(2).padStart(5, '0')}.png`), clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  }
  console.log(`rendered ${process.env.AT.split(',').length} stills (film duration ${dur}s)`);
  await browser.close(); process.exit(process.exitCode || 0);
}
for (let f = f0; f < f1; f++) {
  await page.evaluate(t => { window.film.seek(t); }, f / fps);
  await page.screenshot({ path: path.join(outDir, `f${String(f).padStart(5, '0')}.png`), clip: { x: 0, y: 0, width: 1920, height: 1080 } });
}
console.log(`rendered ${f1 - f0} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s (film duration ${dur}s)`);
await browser.close();
