/**
 * Dropping or pasting an image onto the dashboard terminal, in a real browser.
 *
 * The browser only ever has the image's bytes (never a path the agent could
 * read), so the dashboard uploads them, the server saves a file on the host,
 * and the dashboard pastes that file's path into the agent's prompt. These
 * specs cover the parts unit tests cannot: real `DragEvent`/`DataTransfer`
 * objects, the real upload request, and the bytes the agent's terminal receives.
 */
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';
import {
  getTmuxNameForPrompt,
  launchViaUI,
  resetServer,
} from './battle-helpers.js';
import type { APIRequestContext, Page } from '@playwright/test';

test.use({ promptBracketedPaste: true });

interface WrittenChunk { text: string; hex: string }

/** A minimal but genuine PNG header followed by filler — enough for the server's format check. */
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 56 }, (_, i) => i)];
/** `ESC [ 200 ~ <host path><space> ESC [ 201 ~` — one bracketed paste holding exactly one image path. */
const PASTED_IMAGE = /\x1b\[200~(\/\S*\/terminal-images\/kookr-image-\d{8}-\d{6}-[0-9a-f]{8}\.png) \x1b\[201~/g;

async function writtenChunks(request: APIRequestContext, tmuxName: string): Promise<WrittenChunk[]> {
  const res = await request.get(`/api/test/written-chunks/${encodeURIComponent(tmuxName)}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { chunks: WrittenChunk[] }).chunks;
}

async function pastedImagePaths(request: APIRequestContext, tmuxName: string): Promise<string[]> {
  const text = (await writtenChunks(request, tmuxName)).map((chunk) => chunk.text).join('');
  return [...text.matchAll(PASTED_IMAGE)].map((match) => match[1]);
}

async function openTerminal(page: Page): Promise<void> {
  await page.locator('.healthy-row').first().click();
  const restore = page.getByRole('button', { name: 'Show terminal/diff pane' });
  if (await restore.isVisible()) await restore.click();
  const terminalTab = page.locator('.detail-split-right').getByRole('button', { name: 'Terminal', exact: true });
  if (await terminalTab.isVisible()) await terminalTab.click();
  await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible({ timeout: 10_000 });
  await page.locator('.terminal-xterm .xterm-screen').click();
}

/**
 * Fire real drag events carrying `files`, as dragging from a file manager does.
 * `selector` is the element under the pointer (the terminal by default).
 * Returns, per event, whether a handler cancelled it.
 */
async function dragFilesOntoTerminal(
  page: Page,
  files: Array<{ name: string; type: string; bytes: number[] }>,
  events: Array<'dragenter' | 'dragover' | 'drop'>,
  selector = '.terminal-xterm',
): Promise<boolean[]> {
  return page.evaluate(({ files, events, selector }) => {
    const transfer = new DataTransfer();
    for (const f of files) transfer.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    const target = document.querySelector(selector)!;
    // dispatchEvent returns false when a handler called preventDefault().
    return events.map((type) => !target.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
    ));
  }, { files, events, selector });
}

/** Put a genuine picture on the system clipboard, as taking a screenshot does. */
async function copyImageToClipboard(page: Page): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    canvas.getContext('2d')!.fillRect(0, 0, 8, 8);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  });
}

test.describe('Terminal image drag & drop', () => {
  let tmuxName: string;

  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    const prompt = `Image drop target ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await launchViaUI(page, prompt, '/test/image-drop');
    tmuxName = await getTmuxNameForPrompt(request, prompt);
    await openTerminal(page);
  });

  test('saves a dropped image on the host and pastes its path — without submitting — into the agent', async ({ page, request }) => {
    const before = (await writtenChunks(request, tmuxName)).length;

    const prevented = await dragFilesOntoTerminal(
      page, [{ name: 'Screenshot 2026-11-10 (1).png', type: 'image/png', bytes: PNG_BYTES }], ['dragenter', 'dragover', 'drop'],
    );
    // All three are cancelled; otherwise Chrome would navigate the dashboard to the file.
    expect(prevented).toEqual([true, true, true]);

    await expect.poll(() => pastedImagePaths(request, tmuxName), { timeout: 5_000 }).toHaveLength(1);
    const [savedPath] = await pastedImagePaths(request, tmuxName);

    // The server and this test share a host: the pasted path is a real file holding the dropped bytes.
    expect([...readFileSync(savedPath)]).toEqual(PNG_BYTES);
    // The user's original file name (spaces, parentheses) never reaches the prompt.
    expect(savedPath).not.toContain('Screenshot');

    // Nothing after the paste submits the prompt: no carriage return reaches the agent.
    const after = (await writtenChunks(request, tmuxName)).slice(before);
    expect(after.map((chunk) => chunk.text).join('')).not.toContain('\r');
    expect(after.filter((chunk) => chunk.text.includes('\x1b[200~'))).toHaveLength(1);
    await expect(page.getByTestId('terminal-drop-overlay')).toHaveCount(0);
    // The "Uploading…" notice is gone once the image is attached.
    await expect(page.getByTestId('terminal-image-notice')).toHaveCount(0);
  });

  test('pastes two dropped images as two separate pastes, in order', async ({ page, request }) => {
    const second = [...PNG_BYTES.slice(0, 8), ...Array.from({ length: 24 }, () => 0xab)];
    await dragFilesOntoTerminal(page, [
      { name: 'first.png', type: 'image/png', bytes: PNG_BYTES },
      { name: 'second.png', type: 'image/png', bytes: second },
    ], ['dragover', 'drop']);

    await expect.poll(() => pastedImagePaths(request, tmuxName), { timeout: 5_000 }).toHaveLength(2);
    const [pathA, pathB] = await pastedImagePaths(request, tmuxName);
    expect([...readFileSync(pathA)]).toEqual(PNG_BYTES);
    expect([...readFileSync(pathB)]).toEqual(second);
  });

  test('shows a drop target while a file is dragged over the terminal', async ({ page }) => {
    await dragFilesOntoTerminal(page, [{ name: 'a.png', type: 'image/png', bytes: PNG_BYTES }], ['dragenter', 'dragover']);
    await expect(page.getByTestId('terminal-drop-overlay')).toBeVisible();
    await expect(page.getByTestId('terminal-drop-overlay')).toHaveText('Drop image to attach it to this agent');
    // The overlay must not swallow the drag events meant for the panel beneath it.
    await expect(page.getByTestId('terminal-drop-overlay')).toHaveCSS('pointer-events', 'none');
  });

  test('refuses a non-image with an explanation and sends the agent nothing', async ({ page, request }) => {
    const before = (await writtenChunks(request, tmuxName)).length;

    const prevented = await dragFilesOntoTerminal(
      page, [{ name: 'notes.pdf', type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }], ['dragover', 'drop'],
    );
    expect(prevented).toEqual([true, true]);

    await expect(page.getByTestId('terminal-image-notice'))
      .toContainText('notes.pdf: not a PNG, JPEG, GIF or WebP image');
    expect(await writtenChunks(request, tmuxName)).toHaveLength(before);

    // The notice now covers part of the terminal. A drop that lands on it is
    // still claimed (not left to the browser, which would open the file) and attaches.
    const onNotice = await dragFilesOntoTerminal(
      page, [{ name: 'shot.png', type: 'image/png', bytes: PNG_BYTES }], ['dragover', 'drop'],
      '[data-testid="terminal-image-notice"]',
    );
    expect(onNotice).toEqual([true, true]);
    await expect.poll(() => pastedImagePaths(request, tmuxName), { timeout: 5_000 }).toHaveLength(1);
  });

  // A refusal notice has no timer, so a real pointer click must be able to dismiss it
  // (it sits above xterm, whose pending-state chrome is click-through).
  test('a refusal notice is dismissed by a real click on its close button', async ({ page }) => {
    await dragFilesOntoTerminal(
      page, [{ name: 'notes.pdf', type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }], ['dragover', 'drop'],
    );
    await expect(page.getByTestId('terminal-image-notice')).toBeVisible();

    await page.getByRole('button', { name: 'Dismiss image notice' }).click();

    await expect(page.getByTestId('terminal-image-notice')).toHaveCount(0);
  });

  test('rejects a file that only claims to be a PNG (server checks the real bytes)', async ({ page, request }) => {
    const before = (await writtenChunks(request, tmuxName)).length;

    await dragFilesOntoTerminal(
      page, [{ name: 'fake.png', type: 'image/png', bytes: [...'#!/bin/sh\necho hi\n'].map((c) => c.charCodeAt(0)) }], ['dragover', 'drop'],
    );

    await expect(page.getByTestId('terminal-image-notice'))
      .toContainText('fake.png: not a PNG, JPEG, GIF or WebP image');
    expect(await writtenChunks(request, tmuxName)).toHaveLength(before);
  });

  // A browser `paste` event carrying a file: macOS Cmd+V, Shift+Insert, Edit ▸ Paste.
  test('attaches an image delivered by a browser paste event', async ({ page, request }) => {
    await page.evaluate((bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
      document.querySelector('.terminal-xterm')!.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
    }, PNG_BYTES);

    await expect.poll(() => pastedImagePaths(request, tmuxName), { timeout: 5_000 }).toHaveLength(1);
    const [savedPath] = await pastedImagePaths(request, tmuxName);
    expect([...readFileSync(savedPath)]).toEqual(PNG_BYTES);
  });

  test('right-click ▸ Paste attaches a real clipboard image', async ({ page, request }) => {
    await copyImageToClipboard(page);

    await page.locator('.terminal-xterm').click({ button: 'right' });
    await page.getByRole('button', { name: 'Paste', exact: true }).click();

    await expect.poll(() => pastedImagePaths(request, tmuxName), { timeout: 5_000 }).toHaveLength(1);
    const [savedPath] = await pastedImagePaths(request, tmuxName);
    // The browser re-encodes clipboard pictures, so check the format rather than exact bytes.
    expect([...readFileSync(savedPath).subarray(0, 8)]).toEqual(PNG_BYTES.slice(0, 8));
  });

  // Plain Ctrl+V is the agent's own key: the terminal forwards it as ^V (0x16) and
  // Claude Code / Codex paste an image from the host clipboard themselves. The
  // dashboard must not also upload it, or the screenshot would be attached twice.
  test('pressing Ctrl+V with an image on the clipboard forwards ^V and uploads nothing', async ({ page, request }) => {
    await copyImageToClipboard(page);
    const before = (await writtenChunks(request, tmuxName)).length;

    await page.locator('.terminal-xterm .xterm-screen').click();
    await page.keyboard.press('Control+V');

    await expect.poll(async () => (await writtenChunks(request, tmuxName)).slice(before).map((c) => c.hex))
      .toContain('16');
    // Give a mistaken upload time to land before asserting it did not happen.
    await page.waitForTimeout(750);
    expect(await pastedImagePaths(request, tmuxName)).toEqual([]);
    await expect(page.getByTestId('terminal-image-notice')).toHaveCount(0);
  });
});
