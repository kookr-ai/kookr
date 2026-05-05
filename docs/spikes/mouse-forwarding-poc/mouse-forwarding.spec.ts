/**
 * POC: verify mousewheel events survive each candidate backend end-to-end.
 *
 * For each backend, the test:
 *   1. Starts the harness (`harness.ts --backend=X`) as a child process.
 *   2. Opens the xterm.js page.
 *   3. Waits for "READY" to appear in the terminal — at that point the
 *      test-app has entered alt-screen and enabled mouse modes.
 *   4. Dispatches N mousewheel events over the xterm viewport.
 *   5. Reads the test-app's log file.
 *   6. Asserts the expected number of wheel_up/wheel_down events were
 *      received (or, for the regression case, NOT received).
 *
 * Ground truth for each event: the test-app parsed a CSI SGR mouse sequence
 * from its stdin. That is a byte-level assertion — no dependency on
 * heuristics, rendering, or visual diffs.
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HARNESS = join(__dirname, 'harness.ts');
const PORT = 9988;

type Backend = 'baseline' | 'tmux-on' | 'tmux-off' | 'dtach';

interface HarnessHandle {
  proc: ChildProcess;
  logPath: string;
  tmpDir: string;
}

async function startHarness(backend: Backend): Promise<HarnessHandle> {
  const tmpDir = mkdtempSync(join(tmpdir(), `poc-${backend}-`));
  const logPath = join(tmpDir, 'test-app.log');
  const proc = spawnChild(
    'node',
    ['--import', 'tsx', HARNESS, `--backend=${backend}`, `--port=${PORT}`, `--log=${logPath}`],
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: join(__dirname, '..', '..', '..') },
  );
  proc.stdout?.on('data', (d) => process.stderr.write(`[harness stdout] ${d}`));
  proc.stderr?.on('data', (d) => process.stderr.write(`[harness stderr] ${d}`));

  // Wait for /health to return 200.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return { proc, logPath, tmpDir };
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  proc.kill('SIGKILL');
  throw new Error(`harness did not come up for backend=${backend}`);
}

async function stopHarness(h: HarnessHandle): Promise<void> {
  h.proc.kill('SIGTERM');
  await sleep(300);
  if (!h.proc.killed) h.proc.kill('SIGKILL');
  try {
    rmSync(h.tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Wait for the text-app's READY marker to appear in the xterm buffer. */
async function waitForReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __readScreen?: () => string }).__readScreen;
      return typeof r === 'function' && r().includes('READY');
    },
    { timeout: 10_000, polling: 100 },
  );
}

async function dispatchWheelEvents(page: Page, count: number, deltaY: number): Promise<void> {
  // xterm.js renders screen lines inside `.xterm-viewport`. Target that.
  const viewport = page.locator('.xterm-viewport');
  await viewport.waitFor({ state: 'visible', timeout: 5_000 });
  const box = await viewport.boundingBox();
  if (!box) throw new Error('xterm viewport has no bounding box');
  // Move mouse into the viewport (otherwise wheel is dispatched at the wrong target).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < count; i++) {
    await page.mouse.wheel(0, deltaY);
    // Tiny gap so ordering is preserved and we don't starve the WS.
    await sleep(30);
  }
}

function readLog(path: string): string {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

function countMouseEvents(log: string, kind: 'wheel_up' | 'wheel_down' | string): number {
  const re = new RegExp(`^MOUSE\\s+${kind}\\b`, 'gm');
  return (log.match(re) ?? []).length;
}

async function runWheelTest(page: Page, backend: Backend) {
  const h = await startHarness(backend);
  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await waitForReady(page);
    // Give the test-app a beat to enter its read loop.
    await sleep(150);

    const N_UP = 5;
    const N_DOWN = 3;
    // deltaY < 0 → wheel up; deltaY > 0 → wheel down. Playwright wheel follows
    // this convention; xterm.js interprets accordingly.
    await dispatchWheelEvents(page, N_UP, -100);
    await dispatchWheelEvents(page, N_DOWN, 100);

    // Allow the PTY round-trip to complete.
    await sleep(400);

    const log = readLog(h.logPath);
    const ups = countMouseEvents(log, 'wheel_up');
    const downs = countMouseEvents(log, 'wheel_down');
    // Attach the log to the test output for post-mortem.
    test.info().attachments.push({
      name: `${backend}.log`,
      contentType: 'text/plain',
      body: Buffer.from(log, 'utf-8'),
    });
    return { ups, downs, log, expected: { ups: N_UP, downs: N_DOWN } };
  } finally {
    await stopHarness(h);
  }
}

test.describe('mouse-forwarding POC', () => {
  test('baseline (node-pty direct): wheel events reach test-app', async ({ page }) => {
    const { ups, downs, log } = await runWheelTest(page, 'baseline');
    expect.soft(log, 'test-app log should contain STARTED + READY').toMatch(/STARTED/);
    expect.soft(log).toMatch(/READY/);
    expect(ups, `expected ≥5 wheel_up events via baseline:\n${log}`).toBeGreaterThanOrEqual(5);
    expect(downs, `expected ≥3 wheel_down events via baseline:\n${log}`).toBeGreaterThanOrEqual(3);
  });

  test('tmux-on: empirical mouse-forwarding behavior on current tmux', async ({
    page,
  }) => {
    // The narrative that justified PR #320 — "tmux mouse=on eats wheel into
    // copy-mode, blocking the child" — turned out to be empirically false on
    // tmux 3.2a. With mouse=on, wheel events DO reach a child that enabled
    // DECSET 1006. Recording the observation instead of asserting zero.
    const { ups, downs, log, expected } = await runWheelTest(page, 'tmux-on');
    expect.soft(log, 'test-app log should contain STARTED').toMatch(/STARTED/);
    const arrived = ups + downs;
    const total = expected.ups + expected.downs;
    console.log(`[tmux-on] wheel events arrived at test-app: ${arrived}/${total}`);
    expect.soft(arrived, 'tmux-on mouse-forwarding result (informational)').toBe(total);
  });

  test('tmux-off: wheel events reach test-app iff xterm.js emits mouse CSI through tmux', async ({
    page,
  }) => {
    const { ups, downs, log, expected } = await runWheelTest(page, 'tmux-off');
    expect.soft(log).toMatch(/STARTED/);
    // This is the open question. We DO NOT assert — we just record.
    const arrived = ups + downs;
    const total = expected.ups + expected.downs;
    console.log(`[tmux-off] wheel events arrived at test-app: ${arrived}/${total}`);
    console.log(`[tmux-off] ups=${ups} expected=${expected.ups}`);
    console.log(`[tmux-off] downs=${downs} expected=${expected.downs}`);
    // Soft expect so the test fails-informatively when behavior changes,
    // but doesn't block the suite on an experiment.
    expect.soft(arrived, 'tmux-off mouse-forwarding result (informational)').toBe(total);
  });

  test('dtach: wheel events reach test-app', async ({ page }) => {
    const { ups, downs, log } = await runWheelTest(page, 'dtach');
    expect.soft(log).toMatch(/STARTED/);
    expect(ups, `expected ≥5 wheel_up events via dtach:\n${log}`).toBeGreaterThanOrEqual(5);
    expect(downs, `expected ≥3 wheel_down events via dtach:\n${log}`).toBeGreaterThanOrEqual(3);
  });
});
