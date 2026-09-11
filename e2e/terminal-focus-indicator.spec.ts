import { test, expect } from './fixtures.js';
import {
  resetServer,
  injectSessionStart,
  injectStopEvent,
} from './battle-helpers.js';

test.describe('Terminal focus indicator', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('uses border focus state without rendering a text badge over the terminal', async ({ page, request }) => {
    // This test launches a fake agent. The operator's live provider quota must
    // not decide whether its terminal focus styling can be exercised.
    const settings = await (await request.get('/api/settings')).json();
    const configured = await request.put('/api/settings', { data: { ...settings, quotaHeadroomThreshold: 0 } });
    expect(configured.ok()).toBe(true);
    const response = await request.post('/api/tasks', {
      headers: { 'X-Kookr-Launch-Source': 'ui' },
      data: { prompt: 'Terminal focus indicator check', cwd: '/test/project' },
    });
    const restored = await request.put('/api/settings', { data: settings });
    expect(restored.ok()).toBe(true);
    expect(response.ok(), await response.text()).toBe(true);
    const task = await response.json() as {
      sessions?: Array<{ tmuxSession: string }>;
    };
    const tmuxName = task.sessions?.at(-1)?.tmuxSession;
    expect(tmuxName).toBeTruthy();

    await injectSessionStart(request, tmuxName!);
    await injectStopEvent(request, tmuxName!, 'Waiting for input.');
    await page.locator('.finding-card').first().click();
    await page.locator('.terminal-xterm').click();

    const terminal = page.locator('.terminal-col');
    await expect(terminal).toHaveClass(/zone-active/);
    await expect(terminal).toHaveCSS('border-color', 'rgb(45, 212, 191)');

    const beforeContent = await terminal.evaluate((el) =>
      window.getComputedStyle(el, '::before').content,
    );
    expect(beforeContent).toBe('none');
  });
});
