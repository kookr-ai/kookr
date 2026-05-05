/**
 * Recording-time environment doctor.
 *
 * Verifies that the host has a color-emoji font installed and that Chromium
 * actually renders it as a colored glyph (not a tofu box). Two layers:
 *
 *   1. Fast OS-level check via fontconfig (Linux) or filesystem (macOS).
 *      Fails early with an actionable install hint.
 *   2. Authoritative Playwright runtime probe: render the trophy emoji,
 *      sample a pixel, assert it is non-white. Catches the case where the
 *      OS has the font but Chromium did not pick it up (e.g. fc-cache
 *      hasn't run since install).
 *
 * Called once at demo:record startup, before any TTS Docker / scenario
 * Playwright spawn. Throws on failure — the orchestrator should NOT swallow.
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const execFileAsync = promisify(execFile);

const APPLE_EMOJI_PATH = '/System/Library/Fonts/Apple Color Emoji.ttc';
const NOTO_EMOJI_PATTERN = /noto.*color.*emoji/i;
const TROPHY = '\u{1F3C6}';

export interface PreflightResult {
  ok: true;
}

export async function preflight(): Promise<PreflightResult> {
  await checkOsFont();
  await checkChromiumRender();
  return { ok: true };
}

async function checkOsFont(): Promise<void> {
  if (process.platform === 'darwin') {
    if (!existsSync(APPLE_EMOJI_PATH)) {
      throw new Error(
        `Apple Color Emoji font not found at ${APPLE_EMOJI_PATH}. ` +
          `It ships with macOS by default — if missing, restore it from a Time Machine backup ` +
          `or reinstall the Fonts package.`,
      );
    }
    return;
  }

  if (process.platform === 'linux') {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('fc-list', [':family'], { maxBuffer: 4 * 1024 * 1024 }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `fc-list not available (${msg}). Install fontconfig: ` +
          `sudo apt-get install fontconfig fonts-noto-color-emoji && fc-cache -fv`,
      );
    }
    if (!NOTO_EMOJI_PATTERN.test(stdout)) {
      throw new Error(
        `fonts-noto-color-emoji not found. Install: ` +
          `sudo apt-get install fonts-noto-color-emoji && fc-cache -fv`,
      );
    }
    return;
  }

  throw new Error(
    `Unsupported platform '${process.platform}' for demo recording. Linux and macOS only.`,
  );
}

async function checkChromiumRender(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:#ffffff">` +
        `<div id="probe" style="font-size:128px;line-height:1;display:inline-block">${TROPHY}</div>` +
        `</body></html>`,
    );
    const sample = await page.evaluate(async () => {
      // Color-emoji fonts can lazy-load on first use; without this await the
      // canvas paint can race the font and produce a grayscale false-positive.
      await document.fonts.ready;
      const el = document.getElementById('probe') as HTMLDivElement;
      const rect = el.getBoundingClientRect();
      const w = Math.ceil(rect.width);
      const h = Math.ceil(rect.height);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      const computed = getComputedStyle(el);
      ctx.font = `${computed.fontSize} ${computed.fontFamily}`;
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#000000';
      ctx.fillText(el.textContent ?? '', 0, 0);
      const cx = Math.floor(w / 2);
      const cy = Math.floor(h / 2);
      const pixel = ctx.getImageData(cx, cy, 1, 1).data;
      return { r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3], w, h };
    });

    if (!sample) {
      throw new Error('Preflight: 2D canvas unavailable in headless Chromium.');
    }

    const { r, g, b } = sample;
    // Tofu boxes render as black-on-white outlines; un-rendered glyphs leave the
    // canvas white. Either way the center pixel is in the grayscale range. A
    // real color-emoji glyph paints colored pixels (gold for the trophy cup).
    // Tolerance of 8/255 (~3%) absorbs JPEG-style anti-aliasing noise without
    // letting a muted-color glyph slip through as "grayscale enough."
    const isGrayscale = Math.abs(r - g) <= 8 && Math.abs(g - b) <= 8 && Math.abs(r - b) <= 8;
    if (isGrayscale) {
      const hint =
        process.platform === 'linux'
          ? `Try: fc-cache -fv (refreshes the fontconfig cache after install). ` +
            `If you already ran fc-cache, restart any long-running shells / IDEs that may have cached the old fontconfig state.`
          : `This is unexpected on macOS. Verify Apple Color Emoji is enabled in Font Book, then retry.`;
      throw new Error(
        `Preflight: Chromium rendered the trophy emoji as a non-color glyph ` +
          `(rgb=${r},${g},${b}). The font is installed at the OS level but ` +
          `Chromium did not pick it up. ${hint}`,
      );
    }
  } finally {
    await browser.close();
  }
}
