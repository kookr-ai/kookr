import { test, expect } from './fixtures.js';
import { injectSessionStart, injectStopEvent, resetServer } from './battle-helpers.js';

test('a truncated terminal keeps streaming and accepting input after repeated tab switches', async ({ page, request }) => {
  await resetServer(request);
  let connections = 0;
  await page.routeWebSocket('**/ws/terminal/**', (browser) => {
    connections++;
    const server = browser.connectToServer();
    server.onMessage((message) => {
      if (typeof message === 'string') {
        const control = JSON.parse(message);
        if (control.type === 'seed-end') {
          // Captured from a live Codex viewport-ring seed: older history exists,
          // but the truncated prefix cannot certify an exact parser cursor.
          browser.send(JSON.stringify({ ...control, cursor: null, historyAvailable: true, approximate: true }));
          return;
        }
      }
      browser.send(message);
    });
  });
  const settings = await (await request.get('/api/settings')).json();
  await request.put('/api/settings', { data: { ...settings, quotaHeadroomThreshold: 0 } });
  const response = await request.post('/api/tasks', {
    headers: { 'X-Kookr-Launch-Source': 'ui' },
    data: { prompt: 'Terminal recovery check', cwd: '/test/terminal-recovery' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const task = await response.json() as { sessions: Array<{ tmuxSession: string }> };
  const tmuxName = task.sessions.at(-1)!.tmuxSession;
  await request.post('/api/test/set-terminal-content', {
    data: { tmuxName, content: { text: 'Recovered live output', mode: 'streaming', lineDelayMs: 20 } },
  });
  await injectSessionStart(request, tmuxName);
  await injectStopEvent(request, tmuxName, 'Waiting for input.');
  await page.goto('/');
  await page.locator('.finding-card').first().click();

  for (let i = 0; i < 5; i++) {
    await expect.poll(() => connections).toBe(i + 1);
    await expect(page.getByTestId('terminal-attach-pending')).toHaveCount(0);
    await expect(page.getByText('Some earlier terminal output is unavailable.', { exact: true })).toBeVisible();
    await expect(page.locator('.xterm-rows')).toContainText('Recovered live output');
    await page.locator('.xterm-helper-textarea').press('x');
    await expect.poll(async () => {
      const result = await request.get(`/api/test/written-chunks/${tmuxName}`);
      const body = await result.json() as { chunks: Array<{ text: string }> };
      return body.chunks.filter((chunk) => chunk.text === 'x').length;
    }).toBe(i + 1);
    if (i === 4) break;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByTestId('terminal-attach-pending')).toContainText('paused');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
});
