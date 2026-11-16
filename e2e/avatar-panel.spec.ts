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
 * the dashboard ends where the column starts.
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
    await expect(page.getByTestId('avatar-hint')).toContainText('speaker button');
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

    // The column is docked to the right edge and as tall as the window.
    const box = await dock.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport).toBeTruthy();
    expect(Math.round(box!.x + box!.width)).toBe(viewport!.width);
    expect(Math.round(box!.y)).toBe(0);
    expect(Math.round(box!.height)).toBe(viewport!.height);
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

    // The unavailable Talk button is aria-disabled but still answers a press with the reason, so force the click.
    await page.getByRole('button', { name: 'Talk to Lucy hands-free' }).click({ force: true });
    await expect(page.getByTestId('avatar-live-notice')).toHaveText(reason);
    await page.getByLabel('Type a request to Lucy').fill('What is running?');
    await page.getByTestId('avatar-typed-send').click();
    await expect(page.getByTestId('avatar-typed-reply')).toContainText('Line 8 of a long answer');

    // The dock clips what overflows it: the whole typed form must lie inside the column.
    const dockBox = (await dock.boundingBox())!;
    const typed = (await page.getByTestId('avatar-typed').boundingBox())!;
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

      await bubble.hover();
      await expect(card).toBeVisible();
      await expect(card).toContainText('1 finding needs you');
      await expect(card).toContainText('1 unheard message');
      await expect(card).toContainText('Click to open Lucy');
      // It is a visual duplicate of the label: hidden from assistive technology and never in the way of the pointer.
      await expect(card).toHaveAttribute('aria-hidden', 'true');
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

  test('with fifteen questions and a launch card waiting, the composer, Talk, the open question and Go / Cancel are all on screen, and the dashboard ends where the column starts', async ({ page }) => {
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

    await test.step('criterion 1: the composer\'s text box and the Talk button are in the window and need no scrolling', async () => {
      await expectVisible(page.getByTestId('avatar-typed-input'), 'the composer text box');
      await expectVisible(page.getByTestId('avatar-typed-send'), 'Send');
      await expectVisible(page.getByTestId('avatar-talk'), 'the Talk button');
      await expectVisible(page.getByRole('button', { name: 'Minimise Lucy' }), 'Minimise');
      // Nothing in the dashboard page scrolls to reach them either.
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight)).toBe(true);
    });

    await test.step('criterion 2: every control of the open question lies inside the tray\'s visible box', async () => {
      const tray = (await page.locator('.avatar-tray-body').boundingBox())!;
      const card = page.locator('[data-testid="avatar-ask"][data-ask-state="pending"]');
      await expect(card).toHaveCount(1);
      const controls = card.locator('a, button, input');
      // The plan link, Open task is absent (no onOpenTask in this build? it is present), 3 options, the text box, Send, the fold button.
      expect(await controls.count()).toBeGreaterThanOrEqual(6);
      for (let i = 0; i < await controls.count(); i += 1) {
        const control = controls.nth(i);
        const seen = await visibility(control);
        const name = await control.evaluate((el) => `${el.tagName} ${(el.textContent ?? '').trim().slice(0, 30) || el.getAttribute('aria-label') || ''}`);
        expect(seen.clippedBy, `${name} is not cut off`).toBeNull();
        expect(seen.rect!.y, `${name} starts inside the tray`).toBeGreaterThanOrEqual(tray.y - 1);
        expect(seen.rect!.y + seen.rect!.height, `${name} ends inside the tray`).toBeLessThanOrEqual(tray.y + tray.height + 1);
      }
      // The tray never takes more than half of the column.
      const trayBox = (await page.getByTestId('avatar-tray').boundingBox())!;
      expect(trayBox.height).toBeLessThanOrEqual(viewport.height / 2 + 1);
    });

    await test.step('criterion 4: Go and Cancel are whole, inside the window and not clipped', async () => {
      const go = page.getByTestId('avatar-launch-go');
      const cancel = page.getByTestId('avatar-launch-cancel');
      await expectVisible(go, 'Go');
      await expectVisible(cancel, 'Cancel');
      const goBox = (await go.boundingBox())!;
      const cancelBox = (await cancel.boundingBox())!;
      // Natural height: a 12 px line (17 px with the font's own leading) plus 5 px of padding above and below and a border.
      expect(goBox.height).toBeGreaterThanOrEqual(24);
      expect(Math.round(goBox.height)).toBe(Math.round(cancelBox.height));
      // Nothing inside the launch card is cut off: its content is not taller than the box that shows it.
      expect(await page.getByTestId('avatar-launch').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      // And it sits directly above the composer.
      const launch = (await page.getByTestId('avatar-launch').boundingBox())!;
      const typed = (await page.getByTestId('avatar-typed').boundingBox())!;
      expect(Math.abs(launch.y + launch.height - typed.y)).toBeLessThanOrEqual(2);
    });

    await test.step('criterion 6: .main ends at or left of the column, and spans the window again once Lucy is minimised', async () => {
      const left = await columnLeft(page);
      const main = (await page.locator('.main').boundingBox())!;
      expect(main.x + main.width).toBeLessThanOrEqual(left + 0.5);
      const topbar = (await page.locator('.topbar').first().boundingBox())!;
      expect(topbar.x + topbar.width).toBeLessThanOrEqual(left + 0.5);
      expect(await page.locator('.app').evaluate((el) => getComputedStyle(el).paddingRight)).toBe('380px');
      await shot(page, 'column-open-15-questions');

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
    const toggle = page.getByTestId('avatar-opinions-toggle');
    await expect(toggle).toContainText('14 opinions wanted by finished tasks');
    await expect(toggle).toContainText('first closes in 4 h');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('avatar-opinion-list')).toHaveCount(0);
    // Fifteen questions cost one open card and one row, not fifteen cards.
    const trayBefore = (await page.getByTestId('avatar-tray').boundingBox())!;
    expect(trayBefore.height).toBeLessThan(450);

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
    await rows.nth(5).getByTestId('avatar-ask-row').click();
    const card = page.locator('[data-testid="avatar-ask"]');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-ask-id', ids[5]);
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

  test('a long launch description scrolls inside the card: the card stays under 40% of the column and Go / Cancel stay whole', async ({ page }) => {
    const long = Array.from({ length: 80 }, (_, n) => `Step ${n + 1}: read the logs of the chained tasks and write down what the third one received.`).join('\n');
    await openColumn(page, { asks: fifteenQuestions(), launch: launchProposal(long) });
    const dock = (await page.getByTestId('avatar-dock').boundingBox())!;
    const launch = (await page.getByTestId('avatar-launch').boundingBox())!;
    expect(launch.height).toBeLessThanOrEqual(dock.height * 0.4 + 1);
    await expectVisible(page.getByTestId('avatar-launch-go'), 'Go');
    await expectVisible(page.getByTestId('avatar-launch-cancel'), 'Cancel');
    await expectVisible(page.getByTestId('avatar-typed-input'), 'the composer text box');
    await expectVisible(page.getByTestId('avatar-talk'), 'the Talk button');
    // The description scrolls (it is taller than the room it has) and the keyboard can reach it.
    const body = page.locator('.avatar-launch-body');
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await body.focus();
    await expect(body).toBeFocused();
    // The tray gave way to the card but stays usable: it keeps room for a few rows and scrolls inside itself, so the
    // open question is reached by scrolling the tray, never by scrolling the page.
    const trayBody = page.locator('.avatar-tray-body');
    expect((await trayBody.boundingBox())!.height).toBeGreaterThanOrEqual(150);
    expect(await trayBody.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.getByTestId('avatar-ask-send').scrollIntoViewIfNeeded();
    const send = await visibility(page.locator('[data-testid="avatar-ask"] [data-testid="avatar-ask-send"]'));
    expect(send.clippedBy).toBeNull();
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight)).toBe(true);
    await shot(page, 'launch-card-long-description');
  });

  test('the report row and the "Started" row keep their full height with the launch card up: never shrinkable', async ({ page }) => {
    const long = Array.from({ length: 60 }, (_, n) => `Step ${n + 1}: look at what the third task received.`).join('\n');
    const { send } = await openColumn(page, { asks: fifteenQuestions(), launch: launchProposal(long) });
    send({ type: 'lucy_launch', conversationId: 'typed-e2e', report: { taskId: 't-report', conversationId: 'typed-e2e', kind: 'finished', text: 'The investigation finished: the third task never got the plan.' } });
    const report = page.getByTestId('avatar-launch-report');
    await expect(report).toBeVisible();
    await expectVisible(report.getByTestId('avatar-launch-report-open'), 'the report\'s Open task');
    await expectVisible(report.getByRole('button', { name: 'Dismiss report' }), 'the report\'s Dismiss');
    await expectVisible(page.getByTestId('avatar-launch-go'), 'Go');
    await expectVisible(page.getByTestId('avatar-launch-cancel'), 'Cancel');
    await expectVisible(page.getByTestId('avatar-typed-input'), 'the composer text box');
    // Its text is whole: the row is as tall as its content.
    expect(await report.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await shot(page, 'launch-card-and-report');

    // The proposal ends ("Started"): that row is whole too.
    send({ type: 'lucy_launch', conversationId: 'typed-e2e', outcome: { outcome: 'launched', proposalId: 'p-e2e', taskId: 't-new', project: 'kookr' } });
    const started = page.getByTestId('avatar-launch-result');
    await expect(started).toBeVisible();
    await expectVisible(started.getByTestId('avatar-launch-open'), 'Started: Open task');
    await expectVisible(started.getByRole('button', { name: 'Dismiss', exact: true }), 'Started: Dismiss');
    await expectVisible(page.getByTestId('avatar-typed-input'), 'the composer text box');
  });

  test('criterion 5: after two typed turns, both sentences and both replies are in the thread, in order', async ({ page }) => {
    let turn = 0;
    const replies = ['Five tasks are running, all in kookr.', 'Two of them are pushing.'];
    await page.route('**/api/lucy/turn', (route) => route.fulfill({
      contentType: 'application/x-ndjson',
      body: [{ type: 'text', delta: replies[turn++] ?? 'Done.' }, { type: 'done', end: 'answered', firstTextMs: 1, totalMs: 2, steps: 1, inputTokens: 1, outputTokens: 1, costUsd: null }]
        .map((event) => JSON.stringify(event)).join('\n') + '\n',
    }));
    await openColumn(page, { asks: [] });
    const input = page.getByTestId('avatar-typed-input');
    await input.fill('Give me a status of every running task.');
    await page.getByTestId('avatar-typed-send').click();
    await expect(page.getByTestId('avatar-typed-reply')).toHaveText('Lucy Five tasks are running, all in kookr.');
    // Sending clears the box and keeps the cursor in it.
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await input.fill('Which of them are pushing?');
    await input.press('Enter');
    await expect(page.getByTestId('avatar-typed-reply')).toHaveCount(2);

    const thread = page.getByTestId('avatar-thread');
    const entries = thread.locator('li');
    await expect(entries).toHaveText([
      /You\s+Give me a status of every running task\./,
      /Lucy\s+Five tasks are running, all in kookr\./,
      /You\s+Which of them are pushing\?/,
      /Lucy\s+Two of them are pushing\./,
    ]);
    await shot(page, 'two-typed-turns');

    // A reload in the same tab keeps the thread.
    await page.reload();
    await expect(page.getByTestId('avatar-typed-you')).toHaveCount(2);
    await expect(page.getByTestId('avatar-typed-reply')).toHaveCount(2);
  });

  test('the column\'s left edge resizes it: the page follows, the width is remembered, and the keyboard can do it too', async ({ page }) => {
    await openColumn(page, { asks: [] });
    const dock = page.getByTestId('avatar-dock');
    const handle = page.getByTestId('avatar-column-resizer');
    await expect(handle).toHaveAttribute('role', 'separator');
    const grip = (await handle.boundingBox())!;

    // Drag 100 px to the left: 380 -> 480.
    await handle.hover({ position: { x: 2, y: 400 } });
    await page.mouse.down();
    await page.mouse.move(grip.x - 98, 400, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(480);
    const main = (await page.locator('.main').boundingBox())!;
    expect(Math.round(main.x + main.width)).toBe(1440 - 480);
    expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), AVATAR_PANEL_KEY))!)).toMatchObject({ enabled: true, width: 480 });

    // The limits.
    await handle.focus();
    await page.keyboard.press('End');
    await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(560);
    await page.keyboard.press('ArrowLeft'); // already the widest
    await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(560);
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

  test('the column has no structural accessibility violations with questions, opinions and a launch card showing', async ({ page }) => {
    await openColumn(page, { asks: fifteenQuestions(), launch: launchProposal() });
    await page.getByTestId('avatar-opinions-toggle').click();
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
