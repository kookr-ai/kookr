import { test, expect } from './fixtures.js';
import type { APIRequestContext, Page } from '@playwright/test';
import { resetServer } from './reset-server.js';
import { AVATAR_PANEL_KEY } from '../src/frontend/store/avatar-panel-prefs.js';

/**
 * The avatar panel is an optional feature. These tests pin the two promises
 * that make it safe to ship to everyone: it costs nothing until switched on
 * (no 3D renderer, no avatar file is requested), and once switched on it can
 * be minimised and reopened and remembers its state across reloads.
 *
 * The 3D view itself is not asserted here: headless browsers may have no
 * WebGL, in which case the panel shows a short message instead of the
 * character. The window, its controls and the downloads are what matter.
 */

const AVATAR_ASSET = /vendor-three|AvatarDock|\.glb(\?|$)/;

function trackAvatarRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (AVATAR_ASSET.test(request.url())) seen.push(request.url());
  });
  return seen;
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

  test('switching it on in Settings shows the window and only then downloads it', async ({ page }) => {
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
    await expect(page.getByTestId('avatar-caption')).toContainText('speaker button');
    expect(requests.some((url) => /AvatarDock/.test(url)), 'the panel code is fetched on demand').toBe(true);
    // Positive control for the "downloads nothing" checks above: the 3D renderer really does live in a chunk
    // of its own with this name. If it were folded into a shared chunk, those checks would pass while every
    // operator paid for it.
    await expect
      .poll(() => requests.some((url) => /vendor-three/.test(url)), { message: 'the 3D renderer is fetched on demand' })
      .toBe(true);

    // Switching it off again removes the window.
    await toggle.click();
    await expect(page.getByTestId('avatar-dock')).toHaveCount(0);
  });

  test('minimises to a bubble, reopens, and remembers both across a reload', async ({ page }) => {
    await page.addInitScript((key) => {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, JSON.stringify({ enabled: true, minimized: false, position: null }));
      }
    }, AVATAR_PANEL_KEY);
    await page.goto('/');
    const dock = page.getByTestId('avatar-dock');
    await expect(dock).toBeVisible();

    // The window starts fully inside the viewport, in the bottom-right corner.
    const box = await dock.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport).toBeTruthy();
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
    expect(box!.x).toBeGreaterThan(viewport!.width / 2);

    await page.getByRole('button', { name: 'Minimise Lucy' }).click();
    const bubble = page.getByTestId('avatar-bubble');
    await expect(bubble).toBeVisible();
    // Keyboard focus follows from the Minimise button to the bubble that replaced the window.
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

  test('can be moved to another corner without dragging, and stays there after a reload', async ({ page }) => {
    await page.addInitScript((key) => {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, JSON.stringify({ enabled: true, minimized: false, position: null }));
      }
    }, AVATAR_PANEL_KEY);
    await page.goto('/');
    const dock = page.getByTestId('avatar-dock');
    await expect(dock).toBeVisible();
    const viewport = page.viewportSize();
    const before = await dock.boundingBox();
    expect(before!.x).toBeGreaterThan(viewport!.width / 2);

    await page.getByRole('button', { name: 'Move Lucy to the next corner' }).click();
    await expect.poll(async () => (await dock.boundingBox())!.x).toBeLessThan(viewport!.width / 2);

    await page.reload();
    await expect(dock).toBeVisible();
    expect((await dock.boundingBox())!.x).toBeLessThan(viewport!.width / 2);
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
  async function prepareSpeechPage(page: Page): Promise<{
    telemetry: TelemetryEvent[];
    speakRequests: () => number;
    setTabHidden: (hidden: boolean) => Promise<void>;
  }> {
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, JSON.stringify({ enabled: true, minimized: false, position: null }));
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
            if (parsed.type === 'snapshot') {
              ws.send(JSON.stringify({ ...parsed, ttsUrl: 'http://127.0.0.1:1/tts' }));
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
      await route.fulfill({
        json: {
          text: CLIP_TEXT,
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
          clipId: 'e2e-clip-1',
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
    await expect(replay).toHaveAttribute('aria-disabled', 'true');

    await test.step('launch a task with a finding card', async () => {
      await launchTaskWithCard(page, request);
    }, { timeout: 25_000 });

    await test.step('she speaks while the tab is in the background', async () => {
      await setTabHidden(true);
      await page.getByTestId('speak-button').first().click();
      await expect(page.getByTestId('avatar-caption')).toHaveText(CLIP_TEXT);
      await expect(page.getByTestId('avatar-dock')).toHaveAttribute('data-avatar-state', 'idle');
      expect(speakRequests()).toBe(1);

      // Nobody heard it: the panel's replay button carries a dot, and so does the bubble once minimised.
      await expect(replay).not.toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByTestId('avatar-unheard-dot')).toHaveCount(1);
      await page.getByRole('button', { name: 'Minimise Lucy' }).click();
      await expect(page.getByTestId('avatar-bubble')).toHaveAttribute('aria-label', /unheard message/);
      await expect(page.getByTestId('avatar-unheard-dot')).toBeVisible();
    }, { timeout: 15_000 });

    await test.step('back in front of the screen, she plays it again', async () => {
      const bubble = page.getByTestId('avatar-bubble');
      await setTabHidden(false);
      await bubble.click();
      await expect(page.getByTestId('avatar-dock')).toBeVisible();
      // The caption still has the last text.
      await expect(page.getByTestId('avatar-caption')).toHaveText(CLIP_TEXT);
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
      await expect(page.getByTestId('avatar-caption')).toHaveText(CLIP_TEXT);
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
});
