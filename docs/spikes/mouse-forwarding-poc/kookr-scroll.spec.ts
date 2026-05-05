/**
 * Drive the actual running Kookr instance (localhost:4800) and measure what
 * a REAL user-like mouse wheel does on the terminal panel — not a synthetic
 * JS WheelEvent, but `page.mouse.wheel()` which goes through Chromium's
 * input pipeline the same way a real mousewheel does.
 *
 * This reproduces the exact "scrolling is broken" pain the user reports.
 *
 * Also tests click-drag selection and copy.
 */
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const KOOKR_URL = process.env.KOOKR_URL ?? 'http://localhost:4800/';
const OUT = '/tmp/kookr-scroll-results';

async function readScreen(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Find the first visible xterm terminal on the page. Kookr mounts
    // xterm.js with class xterm inside the terminal panel.
    const el = document.querySelector('.xterm') as HTMLElement | null;
    if (!el) return '[no xterm found]';
    // xterm.js exposes terminal via an internal ref. Not all versions expose
    // it globally. Instead, read DOM rows directly.
    const rows = el.querySelectorAll('.xterm-rows > div');
    return Array.from(rows).map(r => (r as HTMLElement).innerText).join('\n');
  });
}

test.use({ viewport: { width: 1600, height: 1000 } });

test('kookr terminal — wheel scroll behavior', async ({ page }, testInfo) => {
  await page.goto(KOOKR_URL);
  await sleep(1500);
  await page.screenshot({ path: `${OUT}-01-initial.png`, fullPage: false });

  // Find a task with an open terminal. Kookr shows tasks in a sidebar.
  // Click the first in-progress task if visible.
  const taskButtons = await page.locator('[class*="task"][class*="card"], .task-item, button').all();
  console.log(`[probe] found ${taskButtons.length} task-like buttons`);

  // Find the xterm container
  const xterm = page.locator('.xterm').first();
  const count = await page.locator('.xterm').count();
  console.log(`[probe] xterm elements on page: ${count}`);
  if (count === 0) {
    await page.screenshot({ path: `${OUT}-02-no-terminal.png`, fullPage: true });
    test.fail(true, 'No .xterm element on the page — user may need to select an agent first');
    return;
  }

  await xterm.waitFor({ state: 'visible', timeout: 5000 });
  const box = await xterm.boundingBox();
  if (!box) throw new Error('xterm has no bounding box');
  console.log(`[probe] xterm bbox: ${JSON.stringify(box)}`);

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Capture initial screen
  const before = await readScreen(page);
  writeFileSync(`${OUT}-screen-before.txt`, before);
  await page.screenshot({ path: `${OUT}-03-before-wheel.png` });

  // REAL wheel — this is what a user does. Move mouse into terminal first.
  await page.mouse.move(cx, cy);
  await sleep(100);

  // Dispatch 10 wheel-up events (scroll back into history)
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -120);
    await sleep(80);
  }
  await sleep(500);
  const afterWheelUp = await readScreen(page);
  writeFileSync(`${OUT}-screen-after-wheel-up.txt`, afterWheelUp);
  await page.screenshot({ path: `${OUT}-04-after-wheel-up.png` });

  // Dispatch 5 wheel-down events
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 120);
    await sleep(80);
  }
  await sleep(500);
  const afterWheelDown = await readScreen(page);
  writeFileSync(`${OUT}-screen-after-wheel-down.txt`, afterWheelDown);
  await page.screenshot({ path: `${OUT}-05-after-wheel-down.png` });

  // Click-drag selection
  await page.mouse.move(cx - 100, cy - 50);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy + 50, { steps: 10 });
  await page.mouse.up();
  await sleep(200);
  await page.screenshot({ path: `${OUT}-06-selection.png` });

  // Try copy via keyboard (Ctrl+C on terminal is SIGINT; Ctrl+Shift+C is copy in most terminals)
  // On xterm.js, selection is usually copied automatically or via Ctrl+Shift+C.
  // Try the context menu (right-click)
  await page.mouse.click(cx, cy, { button: 'right' });
  await sleep(400);
  await page.screenshot({ path: `${OUT}-07-context-menu.png` });

  // Summary
  const scrollChanged = before !== afterWheelUp;
  console.log(`[probe] before !== afterWheelUp: ${scrollChanged}`);
  console.log(`[probe] scroll direction works (downward return): ${afterWheelDown !== afterWheelUp}`);

  // Attach screens for post-mortem
  testInfo.attachments.push({
    name: 'screen-transitions',
    contentType: 'text/plain',
    body: Buffer.from(
      `BEFORE (first 5 lines):\n${before.split('\n').slice(0, 5).join('\n')}\n\n` +
      `AFTER WHEEL UP (first 5 lines):\n${afterWheelUp.split('\n').slice(0, 5).join('\n')}\n\n` +
      `AFTER WHEEL DOWN (first 5 lines):\n${afterWheelDown.split('\n').slice(0, 5).join('\n')}\n\n` +
      `scrollChanged=${scrollChanged}`,
      'utf-8',
    ),
  });
});
