import type { Page, WebSocketRoute } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { resetServer, getTasks } from './battle-helpers.js';

test.use({
  permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

async function interruptedSpeech(page: Page, deadline?: number) {
  let connection: WebSocketRoute | undefined;
  let stops = 0;
  await page.routeWebSocket(/^ws:\/\/localhost:9999/, socket => {
    connection = socket;
    let sent = false;
    socket.onMessage(data => {
      if (typeof data !== 'string') {
        if (!sent) socket.send(JSON.stringify({ type: 'progressive', activeText: 'Ces mots restent incomplets.' }));
        sent = true;
      } else if (JSON.parse(data).type === 'config') {
        socket.send(JSON.stringify({ type: 'config_ack', language: JSON.parse(data).language, finalization_timeout_ms: deadline }));
      } else if (JSON.parse(data).type === 'stop') {
        stops += 1;
      }
    });
  });
  return { disconnect: () => connection?.close({ code: 1011, reason: 'Test connection interruption' }), stops: () => stops };
}

async function openLaunch(page: Page) {
  await page.locator('.btn-launch').click();
  await expect(page.locator('#launch-task-description')).toBeVisible();
}

async function recordPrompt(page: Page) {
  const field = page.locator('#launch-task-description').locator('..');
  await field.locator('.btn-voice').click();
  await expect(field.locator('.voice-preview')).toHaveText('Ces mots restent incomplets.');
  return field;
}

test.beforeEach(async ({ request }) => { await resetServer(request); });

for (const deadline of [undefined, 125_000]) {
  test(`timeout preserves prompt through dialog close and reload (${deadline ?? 15_000} ms)`, async ({ page, request }) => {
    const speech = await interruptedSpeech(page, deadline);
    await page.goto('/');
    await expect(page.locator('.health-dot-connected')).toBeVisible();
    await openLaunch(page);
    const input = page.locator('#launch-task-description');
    await input.fill('Texte déjà tapé.');
    const field = await recordPrompt(page);
    await page.clock.install();
    await field.locator('.btn-voice.recording').click();
    // The real worklet must acknowledge its drain before advancing timers.
    await expect.poll(speech.stops).toBe(1);
    await page.clock.fastForward((deadline ?? 15_000) - 1000);
    await expect(field.locator('.btn-voice.processing')).toBeVisible();
    await page.clock.fastForward(1001);
    await expect(field.getByRole('group', { name: 'Incomplete dictation for prompt' })).toBeVisible();
    await expect(input).toHaveValue('Texte déjà tapé.');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await expect(page.locator('.health-dot-connected')).toBeVisible();
    await openLaunch(page);
    await expect(input).toHaveValue('Texte déjà tapé.');
    await expect(page.getByRole('group', { name: 'Incomplete dictation for prompt' })).toContainText('Ces mots restent incomplets.');
    await expect(page.getByRole('group', { name: 'Incomplete dictation for criteria' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Ces mots restent incomplets.');
    await page.getByRole('button', { name: 'Restore to prompt', exact: true }).click();
    await expect(input).toHaveValue('Texte déjà tapé. Ces mots restent incomplets.');
    await expect(page.locator('.voice-recovery')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await openLaunch(page);
    await expect(input).toHaveValue('Texte déjà tapé. Ces mots restent incomplets.');
    expect(await getTasks(request)).toHaveLength(0);
  });
}

test('closing an active dictation keeps recovery without typed text; another field cannot consume it', async ({ page, request }) => {
  await interruptedSpeech(page);
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await openLaunch(page);
  await recordPrompt(page);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await openLaunch(page);
  await expect(page.locator('#launch-task-description')).toHaveValue('');
  await expect(page.getByRole('group', { name: 'Incomplete dictation for prompt' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Incomplete dictation for criteria' })).toHaveCount(0);
  await expect(page.locator('#launch-task-description').locator('..').locator('.btn-voice')).toBeDisabled();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('.voice-recovery')).toHaveCount(0);
  await recordPrompt(page);
  expect(await getTasks(request)).toHaveLength(0);
});

test('disconnect recovery remains available and switching launch directory isolates it', async ({ page }) => {
  const { disconnect } = await interruptedSpeech(page);
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await openLaunch(page);
  const cwd = page.locator('#launch-task-cwd');
  const originalCwd = await cwd.inputValue();
  await recordPrompt(page);
  disconnect();
  await expect(page.locator('.voice-recovery')).toBeVisible();
  await cwd.fill('/tmp/different-dictation-owner');
  await expect(page.locator('.voice-recovery')).toHaveCount(0);
  await cwd.fill(originalCwd);
  await expect(page.locator('.voice-recovery')).toContainText('Ces mots restent incomplets.');
});
