import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './relay-runtime-fixtures.js';

const SHARE_CSRF_HEADER = 'x-kookr-csrf';

async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
}

async function createTask(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/tasks', {
    data: {
      prompt: 'Paired relay credential task with pairing_secret_marker',
      cwd: '/private/paired-relay',
    },
  });
  expect(res.status()).toBe(201);
}

async function selectTask(page: Page) {
  await expect(page.locator('.statusbar')).toContainText('1 task', { timeout: 5_000 });
  const shareButton = page.getByTestId('task-share-button');
  if (await shareButton.isVisible().catch(() => false)) return;
  await page.locator('.healthy-row, .finding-card').first().click();
  await expect(shareButton).toBeVisible();
}

test.describe('Easy connection sharing Phase B1 relay pairing', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await expect(page.locator('.health-dot-connected')).toBeVisible();
  });

  test('owner pairs a custom relay with an admin token and can create an A0 share without exposing secrets', async ({ page, request }) => {
    const credentialsRes = await request.get('/api/test/relay-credentials');
    expect(credentialsRes.status()).toBe(200);
    const credentials = await credentialsRes.json() as { relayUrl: string; nodeToken: string };

    const csrfRes = await request.get('/api/share/csrf-token');
    expect(csrfRes.status()).toBe(200);
    const csrf = (await csrfRes.json() as { csrfToken: string }).csrfToken;

    const anonymousPair = await request.post('/api/relay-connection/pair', {
      headers: {
        Origin: page.url().replace(/\/$/, ''),
        [SHARE_CSRF_HEADER]: csrf,
      },
      data: {
        relayUrl: credentials.relayUrl,
      },
    });
    expect(anonymousPair.status()).toBe(400);
    await expect(anonymousPair.text()).resolves.not.toContain(credentials.nodeToken);

    await page.locator('button[aria-label="Settings"]').click();
    const settings = page.locator('.settings-dialog');
    await expect(settings).toBeVisible();
    await settings.getByRole('tab', { name: 'Sharing' }).click();
    await settings.getByLabel('Relay URL').fill(credentials.relayUrl);
    await settings.getByLabel('Relay admin token').fill('admin-secret');
    await settings.getByLabel('Display name').fill('Paired E2E node');
    await settings.getByRole('button', { name: 'Pair' }).click();
    await expect(settings).toContainText('Connected', { timeout: 10_000 });
    await expect(settings).not.toContainText('admin-secret');
    await expect(settings).not.toContainText(credentials.nodeToken);
    await expect(settings).not.toContainText('kookr_tok_v1_');
    await settings.locator('.dialog-close').click();

    const statusRes = await request.get('/api/relay-connection');
    expect(statusRes.status()).toBe(200);
    const statusBody = await statusRes.json() as { status: { relayConnected: boolean; relayUrl?: string } };
    expect(statusBody.status.relayConnected).toBe(true);
    expect(statusBody.status.relayUrl).toBe(credentials.relayUrl);
    expect(JSON.stringify(statusBody)).not.toContain('admin-secret');
    expect(JSON.stringify(statusBody)).not.toContain(credentials.nodeToken);
    expect(JSON.stringify(statusBody)).not.toContain('kookr_tok_v1_');

    await createTask(request);
    await selectTask(page);
    await page.getByTestId('task-share-button').click();

    const dialog = page.getByRole('dialog', { name: 'Share this task' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Create share link' }).click();
    const linkInput = dialog.locator('.task-share-link input');
    await expect(linkInput).toBeVisible();
    const joinUrl = await linkInput.inputValue();
    const parsed = new URL(joinUrl);
    expect(parsed.pathname).toMatch(/^\/relay\/join\/\d{3}-\d{3}$/);
    expect(parsed.search).toBe('');
    expect(parsed.hash).toContain('password=');
    expect(joinUrl).not.toContain('?password');
    expect(joinUrl).not.toContain('admin-secret');
    expect(joinUrl).not.toContain(credentials.nodeToken);
    expect(joinUrl).not.toContain('kookr_tok_v1_');
  });
});
