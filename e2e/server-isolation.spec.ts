import { test, expect } from './fixtures.js';
import { resetServer } from './battle-helpers.js';

test('reset removes the previous sweep report from new browser sessions', async ({ page, request }) => {
  await resetServer(request);
  // This fictional tracked project has no worktree to remove.
  const tracked = await request.post('/api/projects/track', { data: { repo: 'sweep/reset-isolation' } });
  expect(tracked.ok()).toBe(true);
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await page.getByTestId('command-trigger').click();
  await page.getByTestId('command-palette-input').fill('sweep');
  await page.locator('[data-testid="command-palette-action"][data-action-id="sweep"]').click();
  await page.getByRole('dialog', { name: 'Sweep merged worktrees' }).getByRole('button', { name: 'Sweep', exact: true }).click();
  await expect(page.locator('.toast-info')).toContainText('Swept 1 project(s) · skipped 1');

  await page.reload();
  await expect(page.getByRole('button', { name: 'View last sweep report', exact: true })).toBeVisible();
  await resetServer(request);
  await page.reload();
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'View last sweep report', exact: true })).toHaveCount(0);
});

test('reset restores launch budgets while preserving the configured limit', async ({ request }) => {
  await resetServer(request);
  const settings = await (await request.get('/api/settings')).json();
  const configured = await request.put('/api/settings', {
    data: { ...settings, spawnBurstLimit: 5, quotaHeadroomThreshold: 0 },
  });
  expect(configured.ok()).toBe(true);
  expect((await configured.json()).spawnBurstLimit).toBe(5);

  let launchIndex = 0;
  const launch = () => request.post('/api/tasks', {
    headers: { 'X-Kookr-Launch-Source': 'ui' },
    data: { prompt: `Launch budget isolation ${launchIndex++}`, cwd: '/test/project', agentType: 'claude-code' },
  });

  try {
    for (let testCase = 0; testCase < 2; testCase++) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await launch();
        expect(response.ok(), await response.text()).toBe(true);
      }
      const rejected = await launch();
      expect(rejected.status()).toBe(429);
      expect(await rejected.json()).toMatchObject({ code: 'spawn_burst_limit', limit: 5 });
      await resetServer(request);
    }
  } finally {
    const restored = await request.put('/api/settings', { data: settings });
    expect(restored.ok()).toBe(true);
    await resetServer(request);
  }
});

test('fake server advertises every supported agent without host executable probes', async ({ page, request }) => {
  await resetServer(request);
  await page.goto('/');
  await expect(page.locator('.health-dot-connected')).toBeVisible();
  await page.locator('.btn-launch').click();
  const picker = page.locator('.dialog').getByLabel('Agent', { exact: true });
  for (const agentType of ['claude-code', 'codex-cli', 'grok-build']) {
    await picker.selectOption(agentType);
    await expect(picker).toHaveValue(agentType);
  }
});
