import { test, expect } from './dictation-corpus-fixtures.js';
import { getTasks, resetServer } from './battle-helpers.js';

test.use({
  corpusEnabled: false,
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test('collection disabled keeps dictation and launch usable with an honest omitted status', async ({ page, request, corpus }) => {
  await resetServer(request);
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await page.keyboard.press('Alt+l');
  const field = page.locator('.quick-launch-draft');
  await field.locator('.btn-voice').click();
  await expect(field.locator('.voice-preview')).toContainText(corpus.prediction);
  await field.locator('.btn-voice.recording').click();
  await expect(page.locator('.quick-launch-input')).toHaveValue(corpus.prediction);
  await expect(page.locator('.quick-launch-bar')).toContainText(/omitted|disabled/i);
  await page.locator('.quick-launch-input').press('Enter');
  await expect.poll(async () => (await getTasks(request)).length).toBe(1);
  const response = await request.get('/api/stt/corpus/records');
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).records).toEqual([]);
});
