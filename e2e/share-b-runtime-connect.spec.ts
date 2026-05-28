import type { APIRequestContext, Page } from '@playwright/test';
import { resetServer } from './reset-server.js';
import { test, expect } from './relay-runtime-fixtures.js';

const SHARE_CSRF_HEADER = 'x-kookr-csrf';


async function createTask(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/tasks', {
    data: {
      prompt: 'Runtime relay credential task with runtime_secret_marker',
      cwd: '/private/runtime-relay',
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

test.describe('Easy connection sharing Phase B runtime relay connect', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await expect(page.locator('.health-dot-connected')).toBeVisible();
  });

  test('runtime connect starts the relay manager and enables A0 sharing without restart', async ({ page, request }) => {
    const credentialsRes = await request.get('/api/test/relay-credentials');
    expect(credentialsRes.status()).toBe(200);
    const credentials = await credentialsRes.json() as { relayUrl: string; nodeId: string; nodeToken: string };

    const csrfRes = await request.get('/api/share/csrf-token');
    expect(csrfRes.status()).toBe(200);
    const csrf = (await csrfRes.json() as { csrfToken: string }).csrfToken;

    const connectRes = await request.post('/api/relay-connection/connect', {
      headers: {
        Origin: page.url().replace(/\/$/, ''),
        [SHARE_CSRF_HEADER]: csrf,
      },
      data: {
        relayUrl: credentials.relayUrl,
        nodeId: credentials.nodeId,
        relayToken: credentials.nodeToken,
        displayName: 'Runtime E2E node',
      },
    });
    expect(connectRes.status()).toBe(200);
    const connectBody = await connectRes.json() as { status: { relayConnected: boolean; relayUrl?: string; relayToken?: string } };
    expect(connectBody.status.relayUrl).toBe(credentials.relayUrl);
    expect(JSON.stringify(connectBody)).not.toContain(credentials.nodeToken);

    await expect.poll(async () => {
      const res = await request.get('/api/relay-connection');
      const body = await res.json() as { status: { relayConnected: boolean; connectionState: string } };
      return `${body.status.connectionState}:${body.status.relayConnected}`;
    }).toBe('connected:true');

    await createTask(request);
    await selectTask(page);
    await page.getByTestId('task-share-button').click();

    const dialog = page.getByRole('dialog', { name: 'Share this task' });
    await expect(dialog).toBeVisible();
    await dialog.locator('.task-share-path', { hasText: 'Create guest link' }).click();
    await dialog.getByRole('button', { name: 'Create guest link', exact: true }).click();
    const linkInput = dialog.locator('.task-share-link input');
    await expect(linkInput).toBeVisible();
    const joinUrl = await linkInput.inputValue();
    const parsed = new URL(joinUrl);
    expect(parsed.pathname).toMatch(/^\/relay\/join\/\d{3}-\d{3}$/);
    expect(parsed.search).toBe('');
    expect(parsed.hash).toContain('password=');
    expect(joinUrl).not.toContain('?password');
  });
});
