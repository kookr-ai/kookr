import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resetServer } from './reset-server.js';
import { AVATAR_PANEL_KEY } from '../src/frontend/store/avatar-panel-prefs.js';
import type { OperatorAskView } from '../src/shared/contracts/asks.js';
import type { LucyLaunchProposalView } from '../src/shared/contracts/lucy-launch.js';

/**
 * The avatar panel is an optional feature. These tests pin the two promises
 * that make it safe to ship to everyone: it costs nothing until switched on
 * (no 3D renderer, no avatar file is requested), and once switched on it can
 * be minimised and reopened and remembers its state across reloads.
 *
 * The 3D view itself is not asserted here: the tests that open the panel
 * switch WebGL off (`withoutWebGL`), so it shows the short message a browser
 * without WebGL gets instead of the character. The column, its controls and
 * the downloads are what matter.
 *
 * The second half is about the column's layout, which only a real browser can
 * measure (happy-dom does no layout): with fifteen questions and a launch card
 * waiting, at 1440 x 900, everything the operator must reach is on screen, and
 * the dashboard ends where the column starts. The column is a chat: the
 * "Waiting on you" strip is one line until it is unfolded, the conversation
 * always keeps 45% of the column, the launch card is the last thing in the
 * conversation, and at most two areas in the column scroll.
 */

const AVATAR_ASSET = /vendor-three|AvatarDock|\.glb(\?|$)/;

function trackAvatarRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (AVATAR_ASSET.test(request.url())) seen.push(request.url());
  });
  return seen;
}

/**
 * Make WebGL unavailable to the page, so the panel shows its no-WebGL message
 * instead of the 3D view. Headless Chromium renders WebGL in software, and
 * building the scene blocks the page for several seconds on every load, which
 * pushed tests about the window, not the 3D view, past their timeout (#3662).
 */
async function withoutWebGL(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (/webgl/i.test(type)) return null;
      return (getContext as (...args: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof getContext;
  });
}

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.getByTestId('command-palette-input').fill('settings');
  await page.locator('[data-testid="command-palette-action"][data-action-id="settings"]').click();
  await expect(page.locator('.settings-dialog-body')).toBeVisible();
}

test.describe('avatar panel (optional)', () => {
  test('is off by default and downloads nothing', async ({ page }) => {
    const requests = trackAvatarRequests(page);
    await page.goto('/');
    await expect(page.locator('.app')).toBeVisible();
    // Give lazy chunks a chance to load if they were going to.
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('avatar-dock')).toHaveCount(0);
    await expect(page.getByTestId('avatar-bubble')).toHaveCount(0);
    expect(requests, 'no avatar code or model may be requested while the panel is off').toEqual([]);
    expect(await page.evaluate((key) => localStorage.getItem(key), AVATAR_PANEL_KEY)).toBeNull();
  });

  test('switching it on in Settings shows the column and only then downloads it', async ({ page }) => {
    // The 3D renderer chunk is still fetched without WebGL; only drawing is skipped.
    await withoutWebGL(page);
    const requests = trackAvatarRequests(page);
    await page.goto('/');
    await expect(page.locator('.app')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(requests).toEqual([]);

    await openSettings(page);
    const toggle = page.getByRole('button', { name: 'Toggle avatar panel' });
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const dock = page.getByTestId('avatar-dock');
    await expect(dock).toBeVisible();
    await expect(dock).toHaveAttribute('data-avatar-state', 'idle');
    // An empty conversation starts with her welcome and three things to ask.
    await expect(page.getByTestId('avatar-hint')).toContainText('Hi, I’m Lucy.');
    await expect(page.getByTestId('avatar-chip')).toHaveText(['Brief me', 'What needs me right now?', 'What can you do?']);
    expect(requests.some((url) => /AvatarDock/.test(url)), 'the panel code is fetched on demand').toBe(true);
    // Positive control for the "downloads nothing" checks above: the 3D renderer really does live in a chunk
    // of its own with this name. If it were folded into a shared chunk, those checks would pass while every
    // operator paid for it.
    await expect
      .poll(() => requests.some((url) => /vendor-three/.test(url)), { message: 'the 3D renderer is fetched on demand' })
      .toBe(true);

    // Switching it off again removes the column, and the room it took.
    await toggle.click();
    await expect(page.getByTestId('avatar-dock')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--lucy-column-width'))).toBe('');
  });

  test('minimises to a bubble, reopens, and remembers both across a reload', async ({ page }) => {
    await withoutWebGL(page);
    await page.addInitScript((key) => {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, JSON.stringify({ enabled: true, minimized: false }));
      }
    }, AVATAR_PANEL_KEY);
    await page.goto('/');
    const dock = page.getByTestId('avatar-dock');
    await expect(dock).toBeVisible();

    // In the default 1280 x 720 window there is no room to take from the page: the column floats over it, at the
    // right edge, from below the 38 px top bar to the bottom of the window.
    await expect(dock).toHaveAttribute('data-column-mode', 'overlay');
    const box = await dock.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport).toBeTruthy();
    expect(Math.round(box!.x + box!.width)).toBe(viewport!.width);
    expect(Math.round(box!.y)).toBe(38);
    expect(Math.round(box!.y + box!.height)).toBe(viewport!.height);
    expect(Math.round(box!.width)).toBe(380);

    await page.getByRole('button', { name: 'Minimise Lucy' }).click();
    const bubble = page.getByTestId('avatar-bubble');
    await expect(bubble).toBeVisible();
    // Keyboard focus follows from the Minimise button to the bubble that replaced the column.
    await expect(bubble).toBeFocused();
    await expect(dock).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('avatar-bubble')).toBeVisible();
    await expect(page.getByTestId('avatar-dock')).toHaveCount(0);

    await page.getByTestId('avatar-bubble').click();
    await expect(page.getByTestId('avatar-dock')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Minimise Lucy' })).toBeFocused();

    await page.reload();
    await expect(page.getByTestId('avatar-dock')).toBeVisible();
  });

  test('a long live notice and a typed reply both fit in the thread, and the typed form is not clipped (#4012)', async ({ page }) => {
    await withoutWebGL(page);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, JSON.stringify({ enabled: true, minimized: false }));
      // Sound on, so the Talk button gives the server's reason rather than "Sound is off".
      window.localStorage.setItem('kookr-sound-enabled', 'true');
    }, AVATAR_PANEL_KEY);
    // The server says hands-free talk is unavailable, with a reason long enough to fill the live text area.
    const reason = 'Hands-free talk is not available on this server: the speech recogniser, the helper model and the '
      + 'speech service must all be configured. Ask the operator to set them up in Settings, then try again.';
    await page.route('**/api/lucy-live/status', (route) => route.fulfill({ json: { available: false, reason } }));
    // A typed request gets a reply long enough to reach the reply's height cap.
    const reply = Array.from({ length: 8 }, (_, n) => `Line ${n + 1} of a long answer from Lucy.`).join('\n');
    await page.route('**/api/lucy/turn', (route) => route.fulfill({
      contentType: 'application/x-ndjson',
      body: [
        { type: 'text', delta: reply },
        { type: 'done', end: 'answered', firstTextMs: 1, totalMs: 2, steps: 1, inputTokens: 1, outputTokens: 1, costUsd: null },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n',
    }));

    await page.goto('/');
    const dock = page.getByTestId('avatar-dock');
    await expect(dock).toBeVisible();

    // Talk is a labelled button beside the text box. Unavailable, it says so in four words; the long reason is its tooltip.
    const talk = page.getByTestId('avatar-talk');
    await expect(talk).toHaveText('Talk is not set up');
    await expect(talk).toHaveAttribute('title', reason);
    await expect(talk).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('avatar-thread')).not.toContainText(reason);
    expect((await talk.boundingBox())!.height).toBeGreaterThanOrEqual(28);
    // It is aria-disabled but still answers a press with the reason, so force the click.
    await talk.click({ force: true });
    await expect(page.getByTestId('avatar-live-notice')).toHaveText(reason);
    await page.getByLabel('Type a request to Lucy').fill('What is running?');
    await page.getByTestId('avatar-typed-send').click();
    await expect(page.getByTestId('avatar-typed-reply')).toContainText('Line 8 of a long answer');

    // The dock clips what overflows it: the whole composer must lie inside the column.
    const dockBox = (await dock.boundingBox())!;
    const typed = (await page.getByTestId('avatar-composer').boundingBox())!;
    expect(Math.round(typed.y + typed.height)).toBeLessThanOrEqual(Math.round(dockBox.y + dockBox.height));
    // The 3D view is a fixed 120 px, and the notice and the reply are both entries of the one thread.
    expect(Math.round((await page.locator('.avatar-dock-view').boundingBox())!.height)).toBe(120);
    const thread = page.getByTestId('avatar-thread');
    await expect(thread.getByTestId('avatar-live-notice')).toHaveText(reason);
    await expect(thread.getByTestId('avatar-typed-you')).toContainText('What is running?');
  });
});

test.describe('avatar panel: hearing a message again', () => {
  const CLIP_TEXT = 'Two tasks need you. The build is red.';

  /** A silent 0.4 s mono WAV: small, and a real file the browser can decode. */
  function silentWavBase64(): string {
    const sampleRate = 8000;
    const samples = 3200;
    const data = Buffer.alloc(samples * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]).toString('base64');
  }

  type TelemetryEvent = Record<string, unknown> & { type: string; clipId?: string };

  /**
   * Sets up the page the way both tests need it: the panel on, a controllable "is the tab visible" switch,
   * a speech service advertised so the speaker buttons appear, a canned clip for the speak request, and a
   * record of the telemetry events the page sends over the websocket.
   */
  async function prepareSpeechPage(page: Page, options: { asks?: OperatorAskView[] } = {}): Promise<{
    telemetry: TelemetryEvent[];
    speakRequests: () => number;
    setTabHidden: (hidden: boolean) => Promise<void>;
  }> {
    await withoutWebGL(page);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, JSON.stringify({ enabled: true, minimized: false }));
      // Lets a test put the tab "in the background" (simulated: only what the page reads is changed, the real tab
      // stays in front). A clip that plays then is not counted as heard.
      (window as unknown as { __tabHidden: boolean }).__tabHidden = false;
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => ((window as unknown as { __tabHidden: boolean }).__tabHidden ? 'hidden' : 'visible'),
      });
    }, AVATAR_PANEL_KEY);
    const setTabHidden = (hidden: boolean) =>
      page.evaluate((value) => {
        (window as unknown as { __tabHidden: boolean }).__tabHidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);

    const telemetry: TelemetryEvent[] = [];
    // The test server has no speech service; advertise one so the speaker buttons appear, and answer their request.
    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        if (typeof message === 'string') {
          try {
            const parsed = JSON.parse(message) as { type?: string; events?: TelemetryEvent[] };
            if (parsed.type === 'telemetry' && Array.isArray(parsed.events)) telemetry.push(...parsed.events);
          } catch {
            // not JSON: pass it through
          }
        }
        server.send(message);
      });
      server.onMessage((message) => {
        if (typeof message === 'string') {
          try {
            const parsed = JSON.parse(message) as { type?: string };
            // With questions to show, the server's own (empty) list must not wipe them.
            if (parsed.type === 'operatorAsks' && options.asks) return;
            if (parsed.type === 'snapshot') {
              ws.send(JSON.stringify({ ...parsed, ttsUrl: 'http://127.0.0.1:1/tts' }));
              if (options.asks) ws.send(JSON.stringify({ type: 'operatorAsks', asks: options.asks, serverNow: Date.now() }));
              return;
            }
          } catch {
            // not JSON: pass it through
          }
        }
        ws.send(message);
      });
    });
    let speakRequests = 0;
    await page.route('**/api/tasks/*/speak-summary', async (route) => {
      speakRequests += 1;
      // The first answer is the plain one the original tests rely on; later ones are told apart by id, text and task title.
      const n = speakRequests;
      await route.fulfill({
        json: {
          text: n === 1 ? CLIP_TEXT : `${CLIP_TEXT} (${n})`,
          subject: `Task ${n}`,
          audioBase64: silentWavBase64(),
          mimeType: 'audio/wav',
          durationMs: 400,
          usedFallback: false,
          fallbackReason: null,
          llmMs: 0,
          ttsMs: 0,
          cached: false,
          resolvedMode: 'activity',
          effectiveVerbosity: 'medium',
          requestId: 'req-e2e',
          cacheKey: 'k',
          clipId: `e2e-clip-${n}`,
        },
      });
    });
    return { telemetry, speakRequests: () => speakRequests, setTabHidden };
  }

  /** Telemetry is sent in batches every couple of seconds, so wait for the event rather than reading it at once. */
  const telemetryOf = (telemetry: TelemetryEvent[], type: string) => () =>
    telemetry.filter((event) => event.type === type);

  test('a message that played while the tab was (simulated as) in the background shows a dot, can be replayed from the panel, and the dot goes away', async ({ page, request }) => {
    test.setTimeout(45_000);
    await resetServer(request);
    const { telemetry, speakRequests, setTabHidden } = await prepareSpeechPage(page);

    await page.goto('/');
    await expect(page.getByTestId('avatar-dock')).toBeVisible();
    const replay = page.getByRole('button', { name: 'Replay last message' });
    const newestMessage = page.getByTestId('avatar-message').first();
    await expect(replay).toHaveAttribute('aria-disabled', 'true');

    await test.step('launch a task with a finding card', async () => {
      await launchTaskWithCard(page, request);
    }, { timeout: 25_000 });

    await test.step('she speaks while the tab is in the background', async () => {
      await setTabHidden(true);
      await page.getByTestId('speak-button').first().click();
      await expect(newestMessage.locator('.avatar-msg-text')).toHaveText(CLIP_TEXT);
      await expect(newestMessage.locator('.avatar-msg-subject')).toHaveText('Task 1');
      await expect(newestMessage.getByTestId('avatar-msg-unheard')).toHaveText('unheard');
      await expect(page.getByTestId('avatar-dock')).toHaveAttribute('data-avatar-state', 'idle');
      expect(speakRequests()).toBe(1);

      // Nobody heard it: the panel's replay button carries a dot, and so does the bubble once minimised.
      await expect(replay).not.toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByTestId('avatar-unheard-dot')).toHaveCount(1);
      await page.getByRole('button', { name: 'Minimise Lucy' }).click();
      await expect(page.getByTestId('avatar-bubble')).toHaveAttribute('aria-label', /unheard message/);
      await expect(page.getByTestId('avatar-unheard-dot')).toBeVisible();
    }, { timeout: 15_000 });

    await test.step('hovering or focusing the bubble explains its badge and dot, and Escape closes the explanation', async () => {
      const bubble = page.getByTestId('avatar-bubble');
      const card = page.getByTestId('avatar-bubble-card');
      await expect(bubble).toHaveAttribute('aria-label', 'Open Lucy. 1 finding needs your attention. 1 unheard message.');
      await expect(card).toHaveCount(0);

      // Hovering is retried: when two headed browsers share one X display, the other one's pointer movements reach this
      // page as stray moves and end the hover (the card closes), which says nothing about the card.
      await expect(async () => {
        await bubble.hover();
        await expect(card).toBeVisible({ timeout: 2000 });
        await expect(card).toContainText('1 finding needs you', { timeout: 2000 });
        await expect(card).toContainText('1 unheard message', { timeout: 2000 });
        await expect(card).toContainText('Click to open Lucy', { timeout: 2000 });
        // It is a visual duplicate of the label: hidden from assistive technology and never in the way of the pointer.
        await expect(card).toHaveAttribute('aria-hidden', 'true', { timeout: 2000 });
      }).toPass({ timeout: 10_000 });
      const box = (await card.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual((await bubble.boundingBox())!.y);

      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);

      await page.mouse.move(5, 5);
      // A key press first, so the browser treats the next focus as keyboard focus (it draws a focus ring).
      await page.keyboard.press('Shift');
      await bubble.focus();
      await expect(card).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
      await bubble.blur();
    }, { timeout: 15_000 });

    await test.step('back in front of the screen, she plays it again', async () => {
      const bubble = page.getByTestId('avatar-bubble');
      await setTabHidden(false);
      await bubble.click();
      await expect(page.getByTestId('avatar-dock')).toBeVisible();
      // The list still has the last message.
      await expect(newestMessage.locator('.avatar-msg-text')).toHaveText(CLIP_TEXT);
      await expect(page.getByTestId('avatar-unheard-dot')).toHaveCount(1);
      await replay.click();
      await expect(page.getByTestId('avatar-unheard-dot')).toHaveCount(0);
      await expect(replay).toBeFocused();
      expect(speakRequests(), 'replay plays the stored audio and asks the server for nothing').toBe(1);

      // Heard now: minimising shows no dot.
      await page.getByRole('button', { name: 'Minimise Lucy' }).click();
      await expect(bubble).toHaveAttribute('aria-label', /^Open Lucy(?!.*unheard)/);
    }, { timeout: 15_000 });

    await test.step('the page told the server what happened, clip by clip', async () => {
      await expect.poll(() => telemetryOf(telemetry, 'lucy_clip_ended')().length).toBe(2);
      const started = telemetryOf(telemetry, 'lucy_clip_started')();
      expect(started.map((event) => [event.clipId, event.trigger, event.tabVisible])).toEqual([
        ['e2e-clip-1', 'click', false],
        ['e2e-clip-1', 'replay', true],
      ]);
      expect(telemetryOf(telemetry, 'lucy_panel_action')().map((event) => [event.action, event.clipId])).toContainEqual([
        'replay',
        'e2e-clip-1',
      ]);
    }, { timeout: 15_000 });
  });

  test('criterion 7: a spoken message is visible in the thread while questions are pending (the old list was hidden then)', async ({ page, request }) => {
    test.setTimeout(45_000);
    await resetServer(request);
    const { speakRequests } = await prepareSpeechPage(page, { asks: fifteenQuestions() });
    await page.goto('/');
    await expect(page.getByTestId('avatar-tray')).toBeVisible();
    await launchTaskWithCard(page, request);
    await page.getByTestId('speak-button').first().click();
    await expect.poll(() => speakRequests()).toBe(1);
    const message = page.getByTestId('avatar-thread').getByTestId('avatar-message');
    await expect(message).toHaveCount(1);
    await expect(message.locator('.avatar-msg-text')).toHaveText(CLIP_TEXT);
    // Visible: inside the window and not cut off by the thread's own scroll box.
    const seen = await message.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const box = el.closest('[role="log"]')!.getBoundingClientRect();
      return { shown: rect.height > 0 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1, inWindow: rect.bottom <= window.innerHeight };
    });
    expect(seen).toEqual({ shown: true, inWindow: true });
    if (process.env.KOOKR_AVATAR_SHOTS) {
      mkdirSync(process.env.KOOKR_AVATAR_SHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.KOOKR_AVATAR_SHOTS, 'after-spoken-message-with-questions.png') });
    }
  });

  test('a message played in a visible tab is heard at once: no dot, and the server is told so', async ({ page, request }) => {
    test.setTimeout(45_000);
    await resetServer(request);
    const { telemetry } = await prepareSpeechPage(page);

    await page.goto('/');
    await expect(page.getByTestId('avatar-dock')).toBeVisible();
    await test.step('launch a task with a finding card', async () => {
      await launchTaskWithCard(page, request);
    }, { timeout: 25_000 });

    await test.step('she speaks in front of the operator', async () => {
      await page.getByTestId('speak-button').first().click();
      await expect(page.getByTestId('avatar-message').first().locator('.avatar-msg-text')).toHaveText(CLIP_TEXT);
      await expect(page.getByTestId('avatar-dock')).toHaveAttribute('data-avatar-state', 'idle');
      await expect(page.getByRole('button', { name: 'Replay last message' })).not.toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByTestId('avatar-unheard-dot')).toHaveCount(0);
    }, { timeout: 15_000 });

    await test.step('the page reported it as played to the end, and never as unheard', async () => {
      await expect.poll(() => telemetryOf(telemetry, 'lucy_clip_ended')().length).toBe(1);
      expect(telemetryOf(telemetry, 'lucy_clip_started')()[0]).toMatchObject({ clipId: 'e2e-clip-1', trigger: 'click', tabVisible: true });
      expect(telemetryOf(telemetry, 'lucy_clip_ended')()[0]).toMatchObject({ clipId: 'e2e-clip-1', endedBy: 'finished' });
      expect(telemetryOf(telemetry, 'lucy_clip_unheard')()).toEqual([]);
    }, { timeout: 15_000 });
  });

  test('the thread lists every spoken message oldest first, keeps the text of the ones whose audio was dropped, and a message\'s own Replay button marks only that message heard', async ({ page, request }) => {
    test.setTimeout(60_000);
    await resetServer(request);
    const { telemetry, speakRequests, setTabHidden } = await prepareSpeechPage(page);

    await page.goto('/');
    await expect(page.getByTestId('avatar-dock')).toBeVisible();
    await expect(page.getByTestId('avatar-hint')).toBeVisible();
    await test.step('launch a task with a finding card', async () => {
      await launchTaskWithCard(page, request);
    }, { timeout: 25_000 });

    const items = page.getByTestId('avatar-message');
    await test.step('four messages are spoken in the background; all four are in the thread, oldest first, and only the last three can be replayed', async () => {
      await setTabHidden(true);
      for (let n = 1; n <= 4; n += 1) {
        await page.getByTestId('speak-button').first().click();
        await expect.poll(() => speakRequests()).toBe(n);
        await expect(items.last().locator('.avatar-msg-subject')).toHaveText(`Task ${n}`);
        await expect(page.getByTestId('avatar-dock')).toHaveAttribute('data-avatar-state', 'idle');
      }
      await expect(page.getByTestId('avatar-hint')).toHaveCount(0);
      await expect(page.getByRole('log', { name: 'Conversation with Lucy' })).toBeVisible();
      await expect(items).toHaveCount(4);
      await expect(items.locator('.avatar-msg-subject')).toHaveText(['Task 1', 'Task 2', 'Task 3', 'Task 4']);
      await expect(items.last().locator('.avatar-msg-text')).toHaveText(`${CLIP_TEXT} (4)`);
      // The oldest kept its text but lost its audio: no Replay button and no unheard marker.
      await expect(items.first().getByTestId('avatar-msg-replay')).toHaveCount(0);
      await expect(items.first().getByTestId('avatar-msg-unheard')).toHaveCount(0);
      await expect(page.getByTestId('avatar-msg-unheard')).toHaveCount(3);
      await expect(items.last().locator('.avatar-msg-time')).toHaveText('just now');
      await expect(items.last().getByTestId('avatar-msg-aloud')).toHaveText('said aloud');
    }, { timeout: 40_000 });

    await test.step('the 3D view keeps its height next to the thread, and the column fills the window', async () => {
      const view = (await page.locator('.avatar-dock-view').boundingBox())!;
      expect(Math.round(view.height)).toBe(120);
      const dock = (await page.getByTestId('avatar-dock').boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(Math.round(dock.y + dock.height)).toBe(viewport.height);
    });

    await test.step('replaying the oldest replayable message marks only that one heard', async () => {
      await setTabHidden(false);
      const oldest = items.nth(1).getByTestId('avatar-msg-replay');
      await expect(oldest).toHaveAttribute('aria-label', 'Replay message about Task 2, just now');
      await oldest.click();
      await expect(items.nth(1).getByTestId('avatar-msg-unheard')).toHaveCount(0);
      await expect(items.nth(2).getByTestId('avatar-msg-unheard')).toHaveCount(1);
      await expect(items.nth(3).getByTestId('avatar-msg-unheard')).toHaveCount(1);
      await expect(oldest).toBeFocused();
      // The header dot follows the newest message, which is still unheard.
      await expect(page.getByTestId('avatar-unheard-dot')).toHaveCount(1);
      expect(speakRequests(), 'replay asks the server for nothing').toBe(4);
    }, { timeout: 15_000 });

    await test.step('the page named the replayed message in its telemetry', async () => {
      await expect
        .poll(() => telemetryOf(telemetry, 'lucy_clip_started')().filter((event) => event.trigger === 'replay').map((event) => event.clipId))
        .toEqual(['e2e-clip-2']);
      expect(telemetryOf(telemetry, 'lucy_panel_action')().filter((event) => event.action === 'replay').map((event) => event.clipId)).toEqual([
        'e2e-clip-2',
      ]);
    }, { timeout: 15_000 });
  });
});

/** Launches a task through the dashboard and makes it signal a finding, so a finding card is on screen. */
async function launchTaskWithCard(page: Page, request: APIRequestContext): Promise<void> {
  const prompt = 'Avatar replay task';
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill('/test/project');
  await page.locator('.dialog .btn-primary').click();
  await expect(page.locator('.dialog')).not.toBeVisible();

  let tmuxName: string | undefined;
  await expect
    .poll(async () => {
      const tasks = (await (await request.get('/api/tasks')).json()) as Array<{
        prompt: string;
        status: string;
        sessions: Array<{ tmuxSession: string }>;
      }>;
      const task = [...tasks].reverse().find((t) => t.prompt === prompt && t.status === 'inProgress');
      tmuxName = task?.sessions.at(-1)?.tmuxSession;
      return tmuxName ?? null;
    })
    .not.toBeNull();
  const inject = (event: Record<string, unknown>) =>
    request.post('/api/test/inject-event', {
      data: {
        tmuxName,
        event: { session_id: 'sess-avatar', transcript_path: '/tmp/transcript.jsonl', cwd: '/test/project', ...event },
      },
    });
  await inject({ hook_event_name: 'SessionStart' });
  await inject({ hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'I need your help.' });
  await expect(page.locator('.finding-card')).toBeVisible();
}

const MIN = 60_000;

/** One live question and fourteen opinion requests, deliberately not in the order they close. */
function fifteenQuestions(): OperatorAskView[] {
  const at = Date.now();
  const view = (n: number, over: Partial<OperatorAskView>): OperatorAskView => ({
    id: `a${String(n).padStart(11, '0')}`,
    taskId: `task-${n}`,
    taskName: `Billing migration step ${n}`,
    question: `Question ${n}: the migration renames two billing tables. Run it on production now, or wait for the quiet window tonight?`,
    options: ['Run it now', 'Run it tonight', 'Do not run it'],
    allowText: true,
    state: 'pending',
    createdAt: at - 5 * MIN,
    expiresAt: at + 60 * MIN,
    ...over,
  });
  const live = view(0, {
    taskEnded: false,
    taskName: 'Billing migration',
    context: 'Staging ran clean in 40 seconds. Production has about 3 million rows, so expect a short write lock on invoices.',
    links: [{ url: 'https://example.com/plan', label: 'Open the plan' }],
    expiresAt: at + 9 * MIN,
  });
  const opinions = [7, 3, 12, 1, 14, 5, 9, 2, 11, 6, 13, 4, 10, 8].map((n) => view(n, { taskEnded: true, expiresAt: at + (3 + n) * 60 * MIN }));
  return [live, ...opinions];
}

/** Three questions tasks are waiting on and three opinion requests: the state the usability review looked at. */
function threeQuestions(): OperatorAskView[] {
  const at = Date.now();
  const view = (n: number, over: Partial<OperatorAskView>): OperatorAskView => ({
    id: `q${String(n).padStart(11, '0')}`,
    taskId: `task-q${n}`,
    taskName: `Task ${n}`,
    question: `Question ${n}?`,
    options: ['Yes', 'No'],
    allowText: true,
    state: 'pending',
    createdAt: at - 5 * MIN,
    expiresAt: at + (20 + n) * MIN,
    ...over,
  });
  return [
    // The tallest card the review saw: background, Open task, three choices and a text box.
    view(1, {
      taskName: 'Billing migration',
      question: 'The migration renames two billing tables. Run it on production now?',
      context: 'Staging ran clean in 40 seconds.',
      options: ['Run it now', 'Run it tonight (recommended)', 'Do not run it'],
    }),
    view(2, { taskName: 'Invoice export bug', question: 'The export drops the last row because of an off-by-one in the pager. Fix the pager, or switch the export to streaming?', options: ['A: fix the pager (recommended)', 'B: switch to streaming'] }),
    view(3, { taskName: 'Docs link audit', question: '41 broken links found. One issue per page or a single checklist issue?' }),
    view(4, { taskEnded: true, taskName: 'Quota pill layout' }),
    view(5, { taskEnded: true, taskName: 'Changelog cleanup' }),
    view(6, { taskEnded: true, taskName: 'Search index rebuild' }),
  ];
}

/**
 * Lucy's operator column, measured in a real browser at 1440 x 900 (issue #3632).
 *
 * The state is the one that broke the old floating window: fifteen `kookr ask` questions pending (fourteen of them
 * from tasks that have already ended, so only opinions), and a launch proposal waiting for a Go. The test server has
 * no ask service to seed that, so the dashboard socket is rewritten in the page: the server's own `operatorAsks`
 * messages are replaced by the list below, and a `lucy_launch` proposal is added after the first snapshot.
 *
 * Set KOOKR_AVATAR_SHOTS to a folder to also write screenshots of the column there.
 */
test.describe('avatar panel: Lucy\'s operator column', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const SHOTS = process.env.KOOKR_AVATAR_SHOTS;
  const OLD_FLOATING_WINDOW_PREFS = '{"enabled":true,"minimized":false,"position":{"x":1945,"y":804}}';

  interface Seed {
    asks: OperatorAskView[];
    launch?: LucyLaunchProposalView;
  }

  function launchProposal(description = 'Find out why issue tasks stop chaining after the third task.\nReport findings only and open no pull request.'): LucyLaunchProposalView {
    return {
      id: 'p-e2e',
      kind: 'investigation',
      project: 'kookr',
      description,
      agentType: 'claude-code',
      asked: 'investigate why the issue tasks stop chaining',
      readBack: 'I will launch an investigation.',
      expiresAt: Date.now() + 30 * MIN,
      level: 'balanced',
    };
  }

  /** Opens the dashboard with the column on (from the OLD floating-window prefs) and the seed shown in it. */
  async function openColumn(page: Page, seed: Seed, prefs = OLD_FLOATING_WINDOW_PREFS): Promise<{ send: (message: object) => void }> {
    await withoutWebGL(page);
    let toPage: ((message: string) => void) | null = null;
    await page.addInitScript(([key, value]) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    }, [AVATAR_PANEL_KEY, prefs] as const);
    // Talk is available, so its button is on screen.
    await page.route('**/api/lucy-live/status', (route) => route.fulfill({ json: { available: true } }));
    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      const server = ws.connectToServer();
      toPage = (message) => ws.send(message);
      ws.onMessage((message) => server.send(message));
      server.onMessage((message) => {
        if (typeof message === 'string') {
          let parsed: { type?: string } = {};
          try { parsed = JSON.parse(message) as { type?: string }; } catch { /* pass it through */ }
          // The server has no ask service here: its (empty) list must not wipe the seeded one.
          if (parsed.type === 'operatorAsks') return;
          if (parsed.type === 'snapshot') {
            ws.send(message);
            ws.send(JSON.stringify({ type: 'operatorAsks', asks: seed.asks, serverNow: Date.now() }));
            if (seed.launch) ws.send(JSON.stringify({ type: 'lucy_launch', conversationId: 'typed-e2e', proposal: seed.launch }));
            return;
          }
        }
        ws.send(message);
      });
    });
    await page.goto('/');
    await expect(page.getByTestId('avatar-dock')).toBeVisible();
    if (seed.asks.length > 0) await expect(page.getByTestId('avatar-tray')).toBeVisible();
    if (seed.launch) await expect(page.getByTestId('avatar-launch-card')).toBeVisible();
    return { send: (message) => toPage?.(JSON.stringify(message)) };
  }

  async function shot(page: Page, name: string): Promise<void> {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `after-${name}.png`) });
  }

  interface Visibility { rect: { x: number; y: number; width: number; height: number } | null; inViewport: boolean; clippedBy: string | null }

  /**
   * Whether an element can really be seen: inside the window and inside every ancestor that clips or scrolls it
   * (a button 40 px below the fold of a scroll box is "in the window" but not visible).
   */
  async function visibility(locator: Locator): Promise<Visibility> {
    return locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const slack = 1;
      const inViewport = rect.top >= -slack && rect.left >= -slack && rect.bottom <= window.innerHeight + slack && rect.right <= window.innerWidth + slack;
      let clippedBy: string | null = null;
      for (let parent = element.parentElement; parent && !clippedBy; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const box = parent.getBoundingClientRect();
        if (rect.top < box.top - slack || rect.bottom > box.bottom + slack || rect.left < box.left - slack || rect.right > box.right + slack) {
          clippedBy = `${parent.tagName.toLowerCase()}.${parent.className}`;
        }
      }
      return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, inViewport, clippedBy };
    });
  }

  async function expectVisible(locator: Locator, what: string): Promise<void> {
    await expect(locator, `${what} exists`).toHaveCount(1);
    const seen = await visibility(locator);
    expect(seen.inViewport, `${what} is inside the window: ${JSON.stringify(seen.rect)}`).toBe(true);
    expect(seen.clippedBy, `${what} is not cut off by a scroll box or clip`).toBeNull();
  }

  const columnLeft = async (page: Page): Promise<number> => (await page.getByTestId('avatar-dock').boundingBox())!.x;

  /** Heights the column's layout rules are about, in CSS pixels. */
  const columnHeights = (page: Page) => page.evaluate(() => {
    const height = (selector: string): number => document.querySelector(selector)?.getBoundingClientRect().height ?? 0;
    return {
      dock: height('[data-testid="avatar-dock"]'),
      view: height('.avatar-dock-view'),
      tray: height('[data-testid="avatar-tray"]'),
      thread: height('[data-testid="avatar-thread-wrap"]'),
    };
  });

  /**
   * The areas inside the column that scroll right now: an element whose own overflow lets it scroll and whose
   * content is taller than it. (The text box only scrolls past five lines; it is listed too if it does.)
   */
  const scrollAreas = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="avatar-dock"] *')]
    .filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
    .map((el) => el.dataset.testid ?? el.className));
  /** Every element in the column that is allowed to scroll, whether or not its content is long enough yet. */
  const scrollableBoxes = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="avatar-dock"] *')]
    .filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY))
    .map((el) => el.dataset.testid ?? el.className));

  /** Unfold the "Waiting on you" strip and wait for the list's height to settle (it changes over 150 ms). */
  async function unfoldTray(page: Page): Promise<void> {
    const strip = page.getByTestId('avatar-tray-toggle');
    await expect(strip).toHaveAttribute('aria-expanded', 'false');
    await strip.click();
    await expect(strip).toHaveAttribute('aria-expanded', 'true');
    await traySettled(page);
  }
  /**
   * The tray list has stopped changing: three looks, a moment apart, agree on its height and on whether it scrolls
   * (it is given its scrollbar a moment after its height settles).
   */
  async function traySettled(page: Page): Promise<void> {
    const body = page.locator('.avatar-tray-body');
    const seen: string[] = [];
    await expect.poll(async () => {
      seen.push(`${(await body.boundingBox())?.height ?? 0}/${await body.getAttribute('data-scrolls')}`);
      return seen.length >= 3 && seen.slice(-3).every((look) => look === seen[seen.length - 1]);
    }, { intervals: [120], timeout: 5_000 }).toBe(true);
  }

  /** At most two areas of the column may scroll, and they are the conversation and the unfolded list. */
  async function expectAtMostTheTwoScrollAreas(page: Page): Promise<void> {
    const boxes = await scrollableBoxes(page);
    expect(boxes.filter((box) => box !== 'avatar-thread' && box !== 'avatar-tray-body'), `areas that can scroll: ${boxes.join(', ')}`).toEqual([]);
    expect(boxes.length).toBeLessThanOrEqual(2);
    expect(boxes).toContain('avatar-thread');
  }

  test('with fifteen questions and a launch card waiting, the composer, Talk, the strip and Go / Cancel are all on screen, an opened question is whole, and the dashboard ends where the column starts', async ({ page }) => {
    await openColumn(page, { asks: fifteenQuestions(), launch: launchProposal() });
    const dock = page.getByTestId('avatar-dock');
    const viewport = page.viewportSize()!;

    await test.step('criterion 8: prefs saved by the old floating window open the column without error', async () => {
      expect(await page.evaluate((key) => localStorage.getItem(key), AVATAR_PANEL_KEY)).toBe(OLD_FLOATING_WINDOW_PREFS);
      const box = (await dock.boundingBox())!;
      expect(Math.round(box.width)).toBe(380);
      expect(Math.round(box.x + box.width)).toBe(viewport.width);
      expect(Math.round(box.height)).toBe(viewport.height);
    });

    await test.step('the "Waiting on you" strip is folded to one line by default: it counts what waits, and no row or card is open', async () => {
      const strip = page.getByTestId('avatar-tray-toggle');
      await expect(strip).toHaveAttribute('aria-expanded', 'false');
      await expect(strip).toHaveText('1 waiting on you · 14 opinions wanted');
      await expectVisible(strip, 'the strip');
      await expect(page.getByTestId('avatar-ask-row')).toHaveCount(0);
      await expect(page.getByTestId('avatar-ask')).toHaveCount(0);
      // One line: fifteen questions cost about thirty pixels, and the 3D view keeps its 120.
      const heights = await columnHeights(page);
      expect(heights.tray).toBeLessThanOrEqual(36);
      expect(Math.round(heights.view)).toBe(120);
      // Something is waiting, so the strip has its amber wash.
      await expect(page.getByTestId('avatar-tray')).toHaveClass(/avatar-tray-waiting/);
    });

    await test.step('criterion 1: the composer\'s text box and the Talk button are in the window and need no scrolling', async () => {
      await expectVisible(page.getByTestId('avatar-typed-input'), 'the composer text box');
      await expectVisible(page.getByTestId('avatar-typed-send'), 'Send');
      const talk = page.getByTestId('avatar-talk');
      await expectVisible(talk, 'the Talk button');
      // A labelled button of normal size beside the text box, not a 22 px icon in the header.
      await expect(talk).toHaveText('Talk');
      const talkBox = (await talk.boundingBox())!;
      const inputBox = (await page.getByTestId('avatar-typed-input').boundingBox())!;
      expect(talkBox.height).toBeGreaterThanOrEqual(28);
      expect(talkBox.x + talkBox.width).toBeLessThanOrEqual(inputBox.x);
      expect(Math.abs(talkBox.y + talkBox.height - (inputBox.y + inputBox.height))).toBeLessThanOrEqual(1);
      expect(await page.locator('.avatar-dock-header').getByTestId('avatar-talk').count()).toBe(0);
      // The header keeps Replay and Minimise, as targets of at least 28 px.
      for (const name of ['Replay last message', 'Minimise Lucy']) {
        const button = page.getByRole('button', { name });
        await expectVisible(button, name);
        const box = (await button.boundingBox())!;
        expect(box.width, `${name} width`).toBeGreaterThanOrEqual(28);
        expect(box.height, `${name} height`).toBeGreaterThanOrEqual(28);
      }
      // Nothing in the dashboard page scrolls to reach them either.
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight)).toBe(true);
    });

    await test.step('criterion 4: the launch card is the last thing in the conversation; Go and Cancel are whole, in the window and not clipped', async () => {
      const thread = page.getByTestId('avatar-thread');
      await expect(thread.getByTestId('avatar-launch-card')).toHaveCount(1);
      const go = page.getByTestId('avatar-launch-go');
      const cancel = page.getByTestId('avatar-launch-cancel');
      await expectVisible(go, 'Go');
      await expectVisible(cancel, 'Cancel');
      const goBox = (await go.boundingBox())!;
      const cancelBox = (await cancel.boundingBox())!;
      // Natural height: a 12 px line (17 px with the font's own leading) plus 5 px of padding above and below and a border.
      expect(goBox.height).toBeGreaterThanOrEqual(24);
      expect(Math.round(goBox.height)).toBe(Math.round(cancelBox.height));
      // Nothing sits between the thread and the composer any more.
      const threadBox = (await page.getByTestId('avatar-thread-wrap').boundingBox())!;
      const composer = (await page.getByTestId('avatar-composer').boundingBox())!;
      expect(Math.abs(threadBox.y + threadBox.height - composer.y)).toBeLessThanOrEqual(1);
      await shot(page, 'column-open-15-questions');
    });

    await test.step('criterion 2: unfolded, with the question opened, every control of its card lies inside the list\'s visible box, and the conversation keeps 45% of the column', async () => {
      await unfoldTray(page);
      // Unfolding opens nothing by itself.
      await expect(page.getByTestId('avatar-ask')).toHaveCount(0);
      await page.getByTestId('avatar-ask-row').first().click();
      const card = page.locator('[data-testid="avatar-ask"][data-ask-state="pending"]');
      await expect(card).toHaveCount(1);
      await traySettled(page);
      const tray = (await page.locator('.avatar-tray-body').boundingBox())!;
      const controls = card.locator('a, button, input');
      // The plan link, Open task, three options, the text box, Send and the button that folds the card: at least six.
      expect(await controls.count()).toBeGreaterThanOrEqual(6);
      for (let i = 0; i < await controls.count(); i += 1) {
        const control = controls.nth(i);
        const seen = await visibility(control);
        const name = await control.evaluate((el) => `${el.tagName} ${(el.textContent ?? '').trim().slice(0, 30) || el.getAttribute('aria-label') || ''}`);
        expect(seen.clippedBy, `${name} is not cut off`).toBeNull();
        expect(seen.rect!.y, `${name} starts inside the tray`).toBeGreaterThanOrEqual(tray.y - 1);
        expect(seen.rect!.y + seen.rect!.height, `${name} ends inside the tray`).toBeLessThanOrEqual(tray.y + tray.height + 1);
      }
      const heights = await columnHeights(page);
      expect(heights.thread).toBeGreaterThanOrEqual(heights.dock * 0.45 - 0.5);
      // Go and Cancel are still on screen: the conversation stayed on its newest entry while it got shorter.
      await expectVisible(page.getByTestId('avatar-launch-go'), 'Go');
      await expectVisible(page.getByTestId('avatar-launch-cancel'), 'Cancel');
      await expectVisible(page.getByTestId('avatar-typed-input'), 'the composer text box');
      // Two areas scroll in the column, never more: the unfolded list and the conversation.
      await expectAtMostTheTwoScrollAreas(page);
      await shot(page, 'column-question-open');
    });

    await test.step('criterion 6: .main ends at or left of the column, and spans the window again once Lucy is minimised', async () => {
      const left = await columnLeft(page);
      const main = (await page.locator('.main').boundingBox())!;
      expect(main.x + main.width).toBeLessThanOrEqual(left + 0.5);
      const topbar = (await page.locator('.topbar').first().boundingBox())!;
      expect(topbar.x + topbar.width).toBeLessThanOrEqual(left + 0.5);
      expect(await page.locator('.app').evaluate((el) => getComputedStyle(el).paddingRight)).toBe('380px');

      await page.getByRole('button', { name: 'Minimise Lucy' }).click();
      await expect(page.getByTestId('avatar-bubble')).toBeVisible();
      const after = (await page.locator('.main').boundingBox())!;
      expect(Math.round(after.x + after.width)).toBe(viewport.width);
      expect(await page.locator('.app').evaluate((el) => getComputedStyle(el).paddingRight)).toBe('0px');
      const bubble = (await page.getByTestId('avatar-bubble').boundingBox())!;
      expect(Math.round(bubble.x + bubble.width)).toBe(viewport.width - 16);
      expect(Math.round(bubble.y + bubble.height)).toBe(viewport.height - 44);
      await shot(page, 'minimised');
    });
  });

  test('criterion 3: the opinions fold into one row, and unfolded they run from the question closing soonest to the one closing last; an opinion opens as a full card inside the tray', async ({ page }) => {
    const asks = fifteenQuestions();
    await openColumn(page, { asks, launch: launchProposal() });
    await unfoldTray(page);
    const toggle = page.getByTestId('avatar-opinions-toggle');
    await expect(toggle).toContainText('14 opinions wanted by finished tasks');
    await expect(toggle).toContainText('first closes in 4 h');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('avatar-opinion-list')).toHaveCount(0);
    // Fifteen questions, unfolded, cost the strip and two rows, not fifteen cards.
    const trayBefore = (await page.getByTestId('avatar-tray').boundingBox())!;
    expect(trayBefore.height).toBeLessThan(140);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const rows = page.locator('[data-testid="avatar-opinion-list"] > [data-ask-id]');
    await expect(rows).toHaveCount(14);
    const ids = await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.askId!));
    const expectedOrder = asks.filter((a) => a.taskEnded === true).sort((a, b) => a.expiresAt - b.expiresAt).map((a) => a.id);
    expect(ids).toEqual(expectedOrder);
    expect(ids[0]).toBe(asks.filter((a) => a.taskEnded === true).reduce((soonest, a) => (a.expiresAt < soonest.expiresAt ? a : soonest)).id);
    await shot(page, 'opinions-unfolded');

    // Pressing a row opens that question's whole card, brought into view inside the tray, and folds the other.
    await traySettled(page);
    await rows.nth(5).getByTestId('avatar-ask-row').click();
    const card = page.locator('[data-testid="avatar-ask"]');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-ask-id', ids[5]);
    await traySettled(page);
    // The conversation kept its 45% while the list took the rest and scrolls inside itself.
    const heights = await columnHeights(page);
    expect(heights.thread).toBeGreaterThanOrEqual(heights.dock * 0.45 - 0.5);
    expect(await scrollAreas(page)).toContain('avatar-tray-body');
    const tray = (await page.locator('.avatar-tray-body').boundingBox())!;
    for (const testId of ['avatar-ask-option', 'avatar-ask-input', 'avatar-ask-send']) {
      const controls = card.getByTestId(testId);
      for (let i = 0; i < await controls.count(); i += 1) {
        const seen = await visibility(controls.nth(i));
        expect(seen.clippedBy, `${testId} is not cut off`).toBeNull();
        expect(seen.rect!.y).toBeGreaterThanOrEqual(tray.y - 1);
        expect(seen.rect!.y + seen.rect!.height).toBeLessThanOrEqual(tray.y + tray.height + 1);
      }
    }
    await expectVisible(page.getByTestId('avatar-typed-input'), 'the composer text box');
    await expectVisible(page.getByTestId('avatar-launch-go'), 'Go');
  });

  test('a long launch description makes the card taller and the conversation scrolls: the card has no scroll box of its own, and Go / Cancel are at its foot, on screen', async ({ page }) => {
    const long = Array.from({ length: 80 }, (_, n) => `Step ${n + 1}: read the logs of the chained tasks and write down what the third one received.`).join('\n');
    await openColumn(page, { asks: fifteenQuestions(), launch: launchProposal(long) });
    const thread = page.getByTestId('avatar-thread');
    await expect(thread.getByTestId('avatar-launch-card')).toHaveCount(1);
    // The whole description is laid out: nothing inside the card clips or scrolls it.
    const body = page.locator('.avatar-launch-body');
    expect(await body.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    expect(await body.evaluate((el) => getComputedStyle(el).overflowY)).toBe('visible');
    // The card is taller than the room there is, so it is the conversation that scrolls; it opened on the card's foot.
    expect(await scrollAreas(page)).toEqual(['avatar-thread']);
    await expectVisible(page.getByTestId('avatar-launch-go'), 'Go');
    await expectVisible(page.getByTestId('avatar-launch-cancel'), 'Cancel');
    await expectVisible(page.getByTestId('avatar-typed-input'), 'the composer text box');
    await expectVisible(page.getByTestId('avatar-talk'), 'the Talk button');
    // The keyboard can reach the conversation to read the description from its start.
    await thread.focus();
    await expect(thread).toBeFocused();
    await page.keyboard.press('Home');
    await expect.poll(() => thread.evaluate((el) => el.scrollTop)).toBe(0);
    // With the list unfolded too, there are two scrolling areas at most, and the page itself never scrolls.
    await unfoldTray(page);
    await page.getByTestId('avatar-opinions-toggle').click();
    await traySettled(page);
    expect((await scrollAreas(page)).sort()).toEqual(['avatar-thread', 'avatar-tray-body']);
    await expectAtMostTheTwoScrollAreas(page);
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight)).toBe(true);
    await shot(page, 'launch-card-long-description');
  });

  test('what became of a proposal, and her report of the task, are entries of the conversation that stay; nothing needs Dismiss', async ({ page }) => {
    const { send } = await openColumn(page, { asks: fifteenQuestions(), launch: launchProposal() });
    const thread = page.getByTestId('avatar-thread');

    // The proposal ends ("Started"): the card goes and one line in the conversation says what happened.
    send({ type: 'lucy_launch', conversationId: 'typed-e2e', outcome: { outcome: 'launched', proposalId: 'p-e2e', taskId: 't-new', project: 'kookr' } });
    const started = thread.getByTestId('avatar-launch-result');
    await expect(started).toHaveText('Started kookr task·Open task');
    await expect(page.getByTestId('avatar-launch-card')).toHaveCount(0);
    await expectVisible(started.getByTestId('avatar-launch-open'), 'Started: Open task');

    // Her report of that task is a message of hers, with a button to open the task.
    send({ type: 'lucy_launch', conversationId: 'typed-e2e', report: { taskId: 't-new', conversationId: 'typed-e2e', kind: 'finished', text: 'The investigation finished: the third task never got the plan.' } });
    const report = thread.getByTestId('avatar-launch-report');
    await expect(report).toContainText('The investigation finished: the third task never got the plan.');
    await expect(report).toHaveClass(/avatar-entry-lucy/);
    await expectVisible(report.getByTestId('avatar-launch-report-open'), 'the report\'s Open task');
    await expect(report.getByTestId('avatar-entry-time')).toHaveText(/^\d\d:\d\d$/);
    await expect(page.getByRole('button', { name: /Dismiss/ })).toHaveCount(0);
    // In the order they happened, and both still there after a reload: they are part of the record.
    await expect(thread.locator('.avatar-thread-list > li')).toHaveCount(2);
    expect(await thread.locator('.avatar-thread-list > li').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.testid))).toEqual(['avatar-launch-result', 'avatar-launch-report']);
    await expectVisible(page.getByTestId('avatar-typed-input'), 'the composer text box');
    await shot(page, 'launch-outcome-and-report');
    await page.reload();
    await expect(page.getByTestId('avatar-launch-result')).toHaveText('Started kookr task·Open task');
    await expect(page.getByTestId('avatar-launch-report')).toHaveCount(1);
  });

  const DONE = { type: 'done', end: 'answered', firstTextMs: 1, totalMs: 2, steps: 1, inputTokens: 1, outputTokens: 1, costUsd: null };
  const turnBody = (...events: object[]): string => [...events, DONE].map((event) => JSON.stringify(event)).join('\n') + '\n';

  test('criterion 5: after two typed turns, both sentences and both replies are in the thread, in order, as chat bubbles with a time; a new tab shows the same conversation', async ({ page }) => {
    let turn = 0;
    const replies = ['Five tasks are running, all in kookr.', 'Two of them are pushing.'];
    await page.route('**/api/lucy/turn', (route) => route.fulfill({
      contentType: 'application/x-ndjson',
      body: turnBody({ type: 'text', delta: replies[turn++] ?? 'Done.' }),
    }));
    await openColumn(page, { asks: [] });
    const input = page.getByTestId('avatar-typed-input');
    await input.fill('Give me a status of every running task.');
    await page.getByTestId('avatar-typed-send').click();
    await expect(page.getByTestId('avatar-typed-reply').locator('.avatar-entry-bubble')).toHaveText('Lucy Five tasks are running, all in kookr.');
    // Sending clears the box and keeps the cursor in it.
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await input.fill('Which of them are pushing?');
    await input.press('Enter');
    await expect(page.getByTestId('avatar-typed-reply')).toHaveCount(2);

    const thread = page.getByTestId('avatar-thread');
    const entries = thread.locator('.avatar-thread-list > li');
    await expect(entries.locator('.avatar-entry-bubble')).toHaveText([
      /^You\s+Give me a status of every running task\.$/,
      /^Lucy\s+Five tasks are running, all in kookr\.$/,
      /^You\s+Which of them are pushing\?$/,
      /^Lucy\s+Two of them are pushing\.$/,
    ]);

    await test.step('her bubbles are on the left, the operator\'s on the right with a teal wash, 13 px text, and a time under them', async () => {
      const boxes = await entries.evaluateAll((els) => els.map((el) => {
        const bubble = el.querySelector('.avatar-entry-bubble')!;
        const list = el.parentElement!.getBoundingClientRect();
        const rect = bubble.getBoundingClientRect();
        const style = getComputedStyle(bubble);
        return { left: Math.round(rect.left - list.left), right: Math.round(list.right - rect.right), background: style.backgroundColor, fontSize: style.fontSize };
      }));
      const [you, lucy] = boxes;
      // Hers starts at the left edge and stops short of the right; the operator's is the mirror image.
      expect(lucy.left).toBe(0);
      expect(lucy.right).toBeGreaterThan(20);
      expect(you.right).toBe(0);
      expect(you.left).toBeGreaterThan(20);
      expect(you.background).toBe('rgba(45, 212, 191, 0.1)');
      expect(lucy.background).not.toBe(you.background);
      expect(boxes.map((box) => box.fontSize)).toEqual(['13px', '13px', '13px', '13px']);
      // No monospace "You" / "Lucy" label is on screen: who speaks is told to a screen reader only.
      await expect(thread.locator('.avatar-live-who')).toHaveCount(0);
      const label = thread.locator('.avatar-entry-bubble > .sr-only').first();
      await expect(label).toHaveText('You');
      expect((await label.boundingBox())!.width).toBeLessThanOrEqual(1);
      // A time under the bubbles; the two turns happened within a minute, so each speaker shows one.
      const times = thread.getByTestId('avatar-entry-time');
      await expect(times.first()).toHaveText(/^\d\d:\d\d$/);
      const now = await page.evaluate(() => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; });
      const shown = await times.allTextContents();
      expect(shown.length).toBeGreaterThanOrEqual(2);
      // Local time: the minute it is now, or the one before if the minute turned during the test.
      const [h, m] = now.split(':').map(Number);
      const before = `${String((h + (m === 0 ? 23 : 0)) % 24).padStart(2, '0')}:${String((m + 59) % 60).padStart(2, '0')}`;
      for (const time of shown) expect([now, before]).toContain(time);
    });
    await shot(page, 'two-typed-turns');

    // A reload in the same tab keeps the thread, scrolled to its newest entry.
    await page.reload();
    await expect(page.getByTestId('avatar-typed-you')).toHaveCount(2);
    await expect(page.getByTestId('avatar-typed-reply')).toHaveCount(2);

    await test.step('a new tab shows the same conversation, continues it under the same id, and each tab sees what the other adds', async () => {
      const second = await page.context().newPage();
      await withoutWebGL(second);
      const secondBodies: Array<{ conversationId: string }> = [];
      await second.route('**/api/lucy/turn', (route) => {
        secondBodies.push(route.request().postDataJSON() as { conversationId: string });
        return route.fulfill({ contentType: 'application/x-ndjson', body: turnBody({ type: 'text', delta: 'Answered in the second tab.' }) });
      });
      await second.goto('/');
      const secondEntries = second.getByTestId('avatar-thread').locator('.avatar-thread-list > li');
      await expect(secondEntries).toHaveCount(4);
      await expect(secondEntries.last().locator('.avatar-entry-bubble')).toHaveText(/Two of them are pushing\./);
      // Not sessionStorage any more: that is what made a new tab start empty.
      expect(await second.evaluate(() => [sessionStorage.getItem('kookr:lucyConversation'), sessionStorage.getItem('kookr:lucyTypedConversationId')])).toEqual([null, null]);
      const firstId = await page.evaluate(() => localStorage.getItem('kookr:lucyTypedConversationId'));
      expect(firstId).toMatch(/^typed-/);

      await second.getByTestId('avatar-typed-input').fill('And from here?');
      await second.getByTestId('avatar-typed-input').press('Enter');
      await expect(secondEntries).toHaveCount(6);
      expect(secondBodies.map((body) => body.conversationId)).toEqual([firstId]);
      // The first tab, still open, picks the two new entries up without a reload.
      await expect(entries).toHaveCount(6);
      await expect(entries.last().locator('.avatar-entry-bubble')).toHaveText(/Answered in the second tab\./);
      // One copy of each: the tabs did not echo each other's entries back.
      await expect(page.getByTestId('avatar-typed-you')).toHaveCount(3);
      await expect(second.getByTestId('avatar-typed-you')).toHaveCount(3);
      await second.close();
    });
  });

  test('a typed turn says what she is doing while it runs, then her reply, with a short list shown as a list', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let sent = '';
    await page.route('**/api/lucy/turn', async (route) => {
      sent = (route.request().postDataJSON() as { text: string }).text;
      // The answer is held back so the line that says she is thinking can be seen.
      await held;
      await route.fulfill({
        contentType: 'application/x-ndjson',
        body: turnBody(
          { type: 'tool_call', id: 'call_9f3a', name: 'read_board', args: {} },
          { type: 'tool_result', id: 'call_9f3a', name: 'read_board', ok: true, summary: '6 tasks' },
          { type: 'tool_call', id: 'call_77b1', name: 'read_task_output', args: { task: 'kookr-t-4411' } },
          { type: 'tool_result', id: 'call_77b1', name: 'read_task_output', ok: true, summary: 'screen of kookr-t-4411' },
          { type: 'tool_call', id: 'call_c0de', name: 'read_questions', args: {} },
          { type: 'tool_result', id: 'call_c0de', name: 'read_questions', ok: true, summary: '3 questions' },
          { type: 'text', delta: 'Three tasks are stopped on a question:\n- Billing migration: I would run it tonight\n- Invoice export bug: fix the pager\n• Docs link audit: one checklist issue\nNothing else is running. <b>not bold</b>' },
        ),
      });
    });
    await openColumn(page, { asks: [] });
    // The welcome's first button sends its own text as a typed turn.
    await page.getByTestId('avatar-chip').filter({ hasText: 'Brief me' }).click();
    const doing = page.getByTestId('avatar-typed-doing');
    await expect(doing).toHaveText('Lucy Thinking…');
    expect(sent).toBe('Brief me');
    await expect(page.getByTestId('avatar-hint')).toHaveCount(0);
    await expect(page.getByTestId('avatar-typed-you').locator('.avatar-entry-bubble')).toHaveText('You Brief me');
    // Under the operator's message, where her reply will be.
    const youBox = (await page.getByTestId('avatar-typed-you').boundingBox())!;
    expect((await doing.boundingBox())!.y).toBeGreaterThanOrEqual(youBox.y + youBox.height);
    // While she is answering, the next request waits.
    await expect(page.getByTestId('avatar-typed-send')).toHaveAttribute('aria-disabled', 'true');

    release();
    const reply = page.getByTestId('avatar-typed-reply');
    await expect(doing).toHaveText('Looked at 3 things');
    const bubble = reply.locator('.avatar-entry-bubble');
    await expect(bubble.locator('ul > li')).toHaveText(['Billing migration: I would run it tonight', 'Invoice export bug: fix the pager', 'Docs link audit: one checklist issue']);
    await expect(bubble.locator('p')).toHaveText(['Three tasks are stopped on a question:', 'Nothing else is running. <b>not bold</b>']);
    // The list is drawn as one: bullets, not dashes typed out. And markup in her words is text, not elements.
    expect(await bubble.locator('ul').evaluate((el) => getComputedStyle(el).listStyleType)).toBe('disc');
    await expect(bubble).not.toContainText('- Billing');
    await expect(bubble.locator('b')).toHaveCount(0);
    // Never an id, a handle or an argument.
    for (const hidden of ['call_9f3a', 'kookr-t-4411', 'read_board', '6 tasks']) await expect(page.getByTestId('avatar-thread')).not.toContainText(hidden);
    await expect(page.getByTestId('avatar-typed-send')).not.toHaveAttribute('aria-disabled', 'true');
    await shot(page, 'typed-turn-activity-and-list');
  });

  test('the composer grows from one line to five and no further; Enter sends, Shift+Enter makes a new line', async ({ page }) => {
    const sent: string[] = [];
    await page.route('**/api/lucy/turn', (route) => {
      sent.push((route.request().postDataJSON() as { text: string }).text);
      return route.fulfill({ contentType: 'application/x-ndjson', body: turnBody({ type: 'text', delta: 'Noted.' }) });
    });
    await openColumn(page, { asks: [] });
    const input = page.getByTestId('avatar-typed-input');
    await expect(input).toHaveAttribute('placeholder', 'Ask Lucy, or tell her what to do');
    expect(await input.evaluate((el) => el.tagName)).toBe('TEXTAREA');
    const height = async (): Promise<number> => Math.round((await input.boundingBox())!.height);
    const oneLine = await height();
    const lineHeight = await input.evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight));
    expect(lineHeight).toBe(19);

    await input.click();
    await page.keyboard.type('line 1');
    expect(await height()).toBe(oneLine);
    const heights: number[] = [oneLine];
    for (let line = 2; line <= 7; line += 1) {
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type(`line ${line}`);
      heights.push(await height());
    }
    // One line more for each of lines 2 to 5, then no taller: lines 6 and 7 scroll inside the box.
    expect(heights.slice(0, 5)).toEqual([0, 1, 2, 3, 4].map((extra) => oneLine + extra * lineHeight));
    expect(heights.slice(5)).toEqual([heights[4], heights[4]]);
    expect(sent).toEqual([]);
    // The composer grew with it and is still whole inside the column, with the conversation above it.
    await expectVisible(input, 'the text box at five lines');
    await expectVisible(page.getByTestId('avatar-typed-send'), 'Send');
    const heightsNow = await columnHeights(page);
    expect(heightsNow.thread).toBeGreaterThanOrEqual(heightsNow.dock * 0.45 - 0.5);

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('avatar-typed-you').locator('.avatar-entry-bubble')).toHaveText(/line 1\s*line 2[\s\S]*line 7/);
    expect(sent).toEqual(['line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7']);
    // Sent: the box is one line again, and still has the cursor.
    await expect(input).toHaveValue('');
    await expect.poll(height).toBe(oneLine);
    await expect(input).toBeFocused();
  });

  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    test(`with three questions waiting at ${size.width} x ${size.height}: the conversation keeps 45% of the column, and an opened card is whole without scrolling inside it`, async ({ page }) => {
      await page.setViewportSize(size);
      await openColumn(page, { asks: threeQuestions() });
      const strip = page.getByTestId('avatar-tray-toggle');
      await expect(strip).toHaveText('3 waiting on you · 3 opinions wanted');
      const minimum = async (): Promise<void> => {
        const heights = await columnHeights(page);
        expect(heights.thread, `thread ${heights.thread} of column ${heights.dock}`).toBeGreaterThanOrEqual(heights.dock * 0.45 - 0.5);
      };

      // Folded (the default): the conversation has nearly all of the column.
      await minimum();
      expect(Math.round((await columnHeights(page)).view)).toBe(120);

      // Unfolded: three rows and the opinions row; still no card, and the 3D view has not had to give anything up.
      await unfoldTray(page);
      await expect(page.getByTestId('avatar-ask-row')).toHaveCount(3);
      await expect(page.getByTestId('avatar-ask')).toHaveCount(0);
      await minimum();
      expect(Math.round((await columnHeights(page)).view)).toBe(120);

      // The tallest card opened: whole inside the list's visible box, with no scroll box of its own.
      await page.locator('[data-ask-id="q00000000001"]').getByTestId('avatar-ask-row').click();
      const card = page.locator('[data-testid="avatar-ask"][data-ask-state="pending"]');
      await expect(card).toHaveAttribute('data-ask-id', 'q00000000001');
      await traySettled(page);
      await minimum();
      const seen = await visibility(card);
      const body = (await page.locator('.avatar-tray-body').boundingBox())!;
      expect(seen.inViewport, `the card is inside the window: ${JSON.stringify(seen.rect)}`).toBe(true);
      expect(seen.clippedBy, 'the card is not cut off by the list or the column').toBeNull();
      expect(seen.rect!.y).toBeGreaterThanOrEqual(body.y - 1);
      expect(seen.rect!.y + seen.rect!.height).toBeLessThanOrEqual(body.y + body.height + 1);
      // Nothing inside the card scrolls: the list scrolls as one area, the card never does.
      expect(await card.evaluate((el) => [el, ...el.querySelectorAll('*')].filter((node) => /auto|scroll/.test(getComputedStyle(node).overflowY)).length)).toBe(0);
      expect(await card.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      // The column never has more than two areas that can scroll.
      await expectAtMostTheTwoScrollAreas(page);
      await expectVisible(page.getByTestId('avatar-typed-input'), 'the composer text box');
      await shot(page, `three-questions-card-open-${size.width}x${size.height}`);

      // Opening the other cards keeps the rule; the third has two choices and a longer question.
      for (const id of ['q00000000002', 'q00000000003']) {
        await page.locator(`[data-ask-id="${id}"]`).getByTestId('avatar-ask-row').click();
        await expect(card).toHaveAttribute('data-ask-id', id);
        await traySettled(page);
        await minimum();
        const other = await visibility(card);
        expect(other.clippedBy, `card ${id} is not cut off`).toBeNull();
      }

      // The choice is remembered for the tab: after a reload the strip is still unfolded, and no card opened itself.
      await page.reload();
      await expect(strip).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('avatar-ask-row')).toHaveCount(3);
      await expect(page.getByTestId('avatar-ask')).toHaveCount(0);
      await strip.click();
      await expect(strip).toHaveAttribute('aria-expanded', 'false');
      await page.reload();
      await expect(strip).toHaveAttribute('aria-expanded', 'false');
    });
  }

  test('the column\'s left edge resizes it: the page follows, the width is remembered, and the keyboard can do it too', async ({ page }) => {
    await openColumn(page, { asks: [] });
    const dock = page.getByTestId('avatar-dock');
    const handle = page.getByTestId('avatar-column-resizer');
    await expect(handle).toHaveAttribute('role', 'separator');
    // A 1440 px window: the page keeps 1000 px, so the column is at most 440 px.
    await expect(handle).toHaveAttribute('aria-valuemax', '440');

    // The pointer drag is sent as page events (pointerdown on the separator, moves and release on the window), not
    // through Playwright's mouse: when two headed browsers share one X display, the other one's pointer movements
    // reach this page as stray `pointermove` events with no button held, which end a drag by design.
    const grip = (await handle.boundingBox())!;
    await page.evaluate(async ({ x, toX }) => {
      const handleEl = document.querySelector('[data-testid="avatar-column-resizer"]')!;
      const fire = (target: EventTarget, type: string, clientX: number, buttons: number): void => {
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, isPrimary: true, button: 0, buttons, clientX, clientY: 400 }));
      };
      fire(handleEl, 'pointerdown', x, 1);
      for (let step = 1; step <= 8; step += 1) fire(window, 'pointermove', x + ((toX - x) * step) / 8, 1);
      fire(window, 'pointerup', toX, 0);
    }, { x: grip.x + 2, toX: grip.x - 48 });
    await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(430);
    const main = (await page.locator('.main').boundingBox())!;
    expect(Math.round(main.x + main.width)).toBe(1440 - 430);
    expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), AVATAR_PANEL_KEY))!)).toMatchObject({ enabled: true, width: 430 });

    // The limits: End stops where the page would drop below 1000 px.
    await handle.focus();
    await page.keyboard.press('End');
    await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(440);
    await page.keyboard.press('ArrowLeft'); // already the widest
    await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(440);
    expect(Math.round((await page.locator('.main').boundingBox())!.width)).toBe(1000);
    await page.keyboard.press('Home');
    await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(320);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(336);

    // Remembered across a reload; the page still ends where the column starts.
    await page.reload();
    await expect(dock).toBeVisible();
    expect(Math.round((await dock.boundingBox())!.width)).toBe(336);
    const reloaded = (await page.locator('.main').boundingBox())!;
    expect(Math.round(reloaded.x + reloaded.width)).toBe(1440 - 336);
    await shot(page, 'resized-narrow');
  });

  test('in a wide window the column can reach the full 560 px', async ({ page }) => {
    await page.setViewportSize({ width: 2000, height: 900 });
    await openColumn(page, { asks: [] });
    const handle = page.getByTestId('avatar-column-resizer');
    await expect(handle).toHaveAttribute('aria-valuemax', '560');
    await handle.focus();
    await page.keyboard.press('End');
    await expect.poll(async () => Math.round((await page.getByTestId('avatar-dock').boundingBox())!.width)).toBe(560);
    expect(Math.round((await page.locator('.main').boundingBox())!.width)).toBe(2000 - 560);
  });

  test('a saved width of 560 in a 1440 px window is shown as 440, so the page keeps 1000 px, and the saved width is not overwritten', async ({ page }) => {
    await openColumn(page, { asks: [] }, '{"enabled":true,"minimized":false,"width":560}');
    const dock = page.getByTestId('avatar-dock');
    await expect(dock).toHaveAttribute('data-column-mode', 'docked');
    expect(Math.round((await dock.boundingBox())!.width)).toBe(440);
    const main = (await page.locator('.main').boundingBox())!;
    expect(Math.round(main.x + main.width)).toBe(1000);
    expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), AVATAR_PANEL_KEY))!)).toMatchObject({ width: 560 });
    await page.setViewportSize({ width: 2000, height: 900 });
    await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(560);
  });

  test('in a 1280 x 720 window with a task selected the column floats over the page: the page keeps its width and the top bar does not collide', async ({ page, request }) => {
    test.setTimeout(60_000);
    await resetServer(request);
    await page.setViewportSize({ width: 1280, height: 720 });
    await openColumn(page, { asks: [] });
    await launchTaskWithCard(page, request);
    await page.locator('.finding-card').first().click();
    // The reading pane opens beside the findings list.
    await expect(page.getByRole('button', { name: 'Details' })).toBeVisible();

    const dock = page.getByTestId('avatar-dock');
    await expect(dock).toHaveAttribute('data-column-mode', 'overlay');
    expect(Math.round((await dock.boundingBox())!.width)).toBe(380);
    // It starts below the top bar, so + Launch and the search stay reachable.
    expect(Math.round((await dock.boundingBox())!.y)).toBe(38);
    await expectVisible(page.locator('.btn-launch'), '+ Launch');
    expect(await page.evaluate(() => { const b = document.querySelector('.btn-launch')!.getBoundingClientRect(); return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('.btn-launch') !== null; })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--lucy-column-width'))).toBe('');
    const main = (await page.locator('.main').boundingBox())!;
    expect(Math.round(main.x + main.width)).toBe(1280);
    expect(await page.locator('.app').evaluate((el) => getComputedStyle(el).paddingRight)).toBe('0px');

    // No two things in the top bar overlap along x: compare every visible leaf element pairwise.
    const boxes = await page.evaluate(() => {
      const leaves = [...document.querySelectorAll('.topbar *')].filter((el) => el.children.length === 0 && !el.classList.contains('sr-only'));
      return leaves.map((el) => {
        const r = el.getBoundingClientRect();
        return { name: `${el.tagName.toLowerCase()}.${String(el.className)}`.slice(0, 50) + ` "${(el.textContent ?? '').trim().slice(0, 20)}"`, left: r.left, right: r.right, width: r.width, height: r.height };
      }).filter((b) => b.width > 0 && b.height > 0);
    });
    expect(boxes.length).toBeGreaterThan(8);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const overlap = Math.min(boxes[i].right, boxes[j].right) - Math.max(boxes[i].left, boxes[j].left);
        expect(overlap, `${boxes[i].name} and ${boxes[j].name} overlap by ${overlap}px`).toBeLessThanOrEqual(1);
      }
    }
    await shot(page, 'task-selected-1280x720-overlay');

    // Minimising brings the page back as it was, with the bubble in the corner.
    await page.getByRole('button', { name: 'Minimise Lucy' }).click();
    await expect(page.getByTestId('avatar-bubble')).toBeVisible();
    const after = (await page.locator('.main').boundingBox())!;
    expect(Math.round(after.x + after.width)).toBe(1280);
  });

  test('a task selected at 1440 x 900 with a 560 px saved width: the column is 440 px and the page keeps 1000', async ({ page, request }) => {
    test.setTimeout(60_000);
    await resetServer(request);
    await openColumn(page, { asks: [] }, '{"enabled":true,"minimized":false,"width":560}');
    await launchTaskWithCard(page, request);
    await page.locator('.finding-card').first().click();
    const main = (await page.locator('.main').boundingBox())!;
    expect(Math.round(main.x + main.width)).toBe(1000);
    await shot(page, 'task-selected-1440x900-col440');
  });

  test('the column has no structural accessibility violations with a conversation, questions, opinions and a launch card showing', async ({ page }) => {
    await page.route('**/api/lucy/turn', (route) => route.fulfill({
      contentType: 'application/x-ndjson',
      body: turnBody(
        { type: 'tool_call', id: '1', name: 'read_board', args: {} },
        { type: 'tool_result', id: '1', name: 'read_board', ok: true, summary: 'ok' },
        { type: 'text', delta: 'Two things:\n- one\n- two' },
      ),
    }));
    const { send } = await openColumn(page, { asks: fifteenQuestions(), launch: launchProposal() });
    // A conversation with every kind of entry: a typed turn with a list, an outcome, a report, then a new card.
    await page.getByTestId('avatar-typed-input').fill('Brief me');
    await page.getByTestId('avatar-typed-input').press('Enter');
    await expect(page.getByTestId('avatar-typed-doing')).toHaveText('Looked at 1 thing');
    send({ type: 'lucy_launch', conversationId: 'typed-e2e', outcome: { outcome: 'launched', proposalId: 'p-e2e', taskId: 't-new', project: 'kookr' } });
    send({ type: 'lucy_launch', conversationId: 'typed-e2e', report: { taskId: 't-new', conversationId: 'typed-e2e', kind: 'finished', text: 'The task I started has finished.' } });
    await expect(page.getByTestId('avatar-launch-report')).toHaveCount(1);
    send({ type: 'lucy_launch', conversationId: 'typed-e2e', proposal: { ...launchProposal(), id: 'p-e2e-2' } });
    await expect(page.getByTestId('avatar-launch-card')).toBeVisible();
    // The strip unfolded, the opinions unfolded, and a question's card open.
    await unfoldTray(page);
    await page.getByTestId('avatar-opinions-toggle').click();
    await page.getByTestId('avatar-ask-row').first().click();
    await expect(page.locator('[data-testid="avatar-ask"][data-ask-state="pending"]')).toHaveCount(1);
    await traySettled(page);
    const results = await new AxeBuilder({ page })
      .include('[data-testid="avatar-dock"]')
      .withTags(['wcag2a', 'wcag2aa'])
      // Same scope as accessibility-smoke.spec.ts: structure, not the theme's contrast debt.
      .disableRules(['color-contrast'])
      .analyze();
    expect(results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(' ')) }))).toEqual([]);
  });

  test('the overlays at the right edge move left by the column\'s width, and come back when it is minimised', async ({ page }) => {
    await openColumn(page, { asks: [] });
    const rightEdges = () => page.evaluate(() => {
      const classes = ['toasts', 'achievement-toasts', 'hermes-lane-root', 'debug-timeline-panel', 'scheduled-tasks-hint'];
      return Object.fromEntries(classes.map((name) => {
        const el = document.createElement('div');
        el.className = name;
        el.style.width = '40px';
        el.style.height = '10px';
        document.body.appendChild(el);
        const right = el.getBoundingClientRect().right;
        el.remove();
        return [name, Math.round(right)];
      }));
    });
    const left = Math.round(await columnLeft(page));
    for (const [name, right] of Object.entries(await rightEdges())) {
      // The overlay's own right margin is 14 to 24 px: it ends at the column's edge minus that margin, never past it.
      expect(right, `${name} stays left of the column`).toBeLessThanOrEqual(left);
    }
    await page.getByRole('button', { name: 'Minimise Lucy' }).click();
    await expect(page.getByTestId('avatar-bubble')).toBeVisible();
    for (const [name, right] of Object.entries(await rightEdges())) {
      expect(right, `${name} is back at the window's edge`).toBeGreaterThan(1440 - 40);
    }
  });

  test('at 768 px the column is a full-width sheet over the page, and minimising brings the page back', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await openColumn(page, { asks: fifteenQuestions(), launch: launchProposal() });
    const dock = page.getByTestId('avatar-dock');
    const box = (await dock.boundingBox())!;
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(768);
    expect(Math.round(box.height)).toBe(900);
    await expect(page.getByTestId('avatar-column-resizer')).toHaveCount(0);
    // The page keeps its full width under the sheet: no padding is taken away from it.
    expect(await page.locator('.app').evaluate((el) => getComputedStyle(el).paddingRight)).toBe('0px');
    await expectVisible(page.getByTestId('avatar-typed-input'), 'the composer text box');
    await expectVisible(page.getByTestId('avatar-launch-go'), 'Go');
    await shot(page, 'sheet-768');

    await page.getByRole('button', { name: 'Minimise Lucy' }).click();
    await expect(dock).toHaveCount(0);
    await expect(page.getByTestId('avatar-bubble')).toBeVisible();
    await expect(page.locator('.app')).toBeVisible();
  });
});
