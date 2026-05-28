import type { APIRequestContext, Page } from '@playwright/test';
import { resetServer } from './reset-server.js';
import { test, expect } from './relay-fixtures.js';


async function createTask(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/tasks', {
    data: {
      prompt: 'Investigate customer billing issue with github_pat_should_not_leak',
      cwd: '/private/customer-billing',
    },
  });
  expect(res.status()).toBe(201);
}

async function getLatestTmuxName(request: APIRequestContext): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const res = await request.get('/api/tasks');
    const tasks = await res.json() as Array<{
      status: string;
      sessions: Array<{ tmuxSession: string }>;
    }>;
    const inProgress = tasks.filter((task) => task.status === 'inProgress');
    const last = inProgress.at(-1);
    const session = last?.sessions.at(-1);
    if (session) return session.tmuxSession;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for an in-progress task session');
}

async function getKeysReceived(request: APIRequestContext, tmuxName: string): Promise<string[]> {
  const res = await request.get(`/api/test/keys-received/${encodeURIComponent(tmuxName)}`);
  expect(res.status()).toBe(200);
  const body = await res.json() as { keysReceived: string[] };
  return body.keysReceived;
}

async function selectTask(page: Page) {
  await expect(page.locator('.statusbar')).toContainText('1 task', { timeout: 5_000 });
  const shareButton = page.getByTestId('task-share-button');
  if (await shareButton.isVisible().catch(() => false)) return;
  await page.locator('.healthy-row, .finding-card').first().click();
  await expect(shareButton).toBeVisible();
}

async function createShareFromDashboard(page: Page): Promise<string> {
  await page.getByTestId('task-share-button').click();
  const dialog = page.getByRole('dialog', { name: 'Share this task' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Contact Share is the secure Kookr-to-Kookr path.');
  await dialog.locator('.task-share-path', { hasText: 'Create guest link' }).click();
  await expect(dialog).toContainText('Guest Link is lower assurance');
  await dialog.getByRole('button', { name: 'Create guest link', exact: true }).click();
  const shareIdInput = dialog.getByRole('textbox', { name: 'Share ID' });
  const passwordInput = dialog.locator('.task-share-ticket label', { hasText: 'Password' }).locator('input');
  await expect(shareIdInput).toBeVisible();
  await expect(passwordInput).toBeVisible();
  await expect(shareIdInput).toHaveValue(/^\d{3}-\d{3}$/);
  await expect(passwordInput).not.toHaveValue('');
  const linkInput = dialog.locator('.task-share-link input');
  await expect(linkInput).toBeVisible();
  const joinUrl = await linkInput.inputValue();
  const parsed = new URL(joinUrl);
  expect(parsed.pathname).toMatch(/^\/relay\/join\/\d{3}-\d{3}$/);
  expect(parsed.search).toBe('');
  expect(parsed.hash).toContain('password=');
  expect(joinUrl).not.toContain('?password');
  await expect(dialog.locator('.task-share-state')).toContainText('Waiting for viewer');
  return joinUrl;
}

test.describe('Easy connection sharing Phase A0', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
    await expect(page.locator('.health-dot-connected')).toBeVisible();
  });

  test('owner creates a share, collaborator sees safe projection, revoke disconnects', async ({ page, request, browser }) => {
    await createTask(request);
    await selectTask(page);
    const joinUrl = await createShareFromDashboard(page);

    const collaborator = await browser.newContext();
    const collaboratorPage = await collaborator.newPage();
    const requestedUrls: string[] = [];
    collaboratorPage.on('request', (req) => requestedUrls.push(req.url()));
    collaboratorPage.on('websocket', (ws) => requestedUrls.push(ws.url()));

    const joinResponse = await collaboratorPage.goto(joinUrl);
    expect(joinResponse?.headers()['referrer-policy']).toBe('no-referrer');
    await expect.poll(() => collaboratorPage.evaluate(() => location.hash)).toBe('');
    await expect(collaboratorPage.getByLabel('Share ID')).toHaveValue(/^\d{3}-\d{3}$/);
    await expect(collaboratorPage.getByLabel('Password')).not.toHaveValue('');
    await collaboratorPage.getByLabel('Display name').fill('Dogfood guest');
    await collaboratorPage.getByRole('button', { name: 'Join' }).click();

    await expect(collaboratorPage.getByLabel('Shared task projection')).toBeVisible({ timeout: 10_000 });
    await expect(collaboratorPage.locator('#task-status')).toContainText(/open|inProgress|pending|needsInput/);
    await expect(collaboratorPage.locator('body')).not.toContainText('/private/customer-billing');
    await expect(collaboratorPage.locator('body')).not.toContainText('github_pat_should_not_leak');
    expect(requestedUrls.some((url) => url.includes('inviteToken=') || url.includes('password=') || url.includes('memberToken='))).toBe(false);

    const dialog = page.getByRole('dialog', { name: 'Share this task' });
    await expect(dialog.locator('.task-share-state')).toContainText('Viewer connected', { timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Revoke' }).click();
    await expect(dialog.locator('.task-share-state')).toContainText('Revoked', { timeout: 10_000 });
    await expect(dialog.getByRole('button', { name: 'Create new guest link' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
    await expect(dialog.getByText('Link expires in')).toHaveCount(0);
    await expect(dialog.getByText('Display label')).toHaveCount(0);
    await expect(dialog.getByText('Approved grants')).toHaveCount(0);
    await expect(dialog.getByText('Terminal sharing')).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: 'Share ID' })).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: 'Password' })).toHaveCount(0);
    await expect(collaboratorPage.locator('#status')).toContainText('Disconnected', { timeout: 10_000 });

    await collaborator.close();
  });

  test('owner approves guest terminal viewing through the share modal', async ({ page, request, browser }) => {
    await createTask(request);
    await selectTask(page);
    const joinUrl = await createShareFromDashboard(page);

    const collaborator = await browser.newContext();
    const collaboratorPage = await collaborator.newPage();

    await collaboratorPage.goto(joinUrl);
    await expect.poll(() => collaboratorPage.evaluate(() => location.hash)).toBe('');
    await collaboratorPage.getByLabel('Display name').fill('Dogfood guest');
    await collaboratorPage.getByRole('button', { name: 'Join' }).click();

    await expect(collaboratorPage.getByLabel('Shared task projection')).toBeVisible({ timeout: 10_000 });
    await expect(collaboratorPage.locator('#terminal-banner')).toContainText(
      'Terminal viewing requires owner approval.',
      { timeout: 10_000 },
    );
    await collaboratorPage.getByRole('button', { name: 'Request terminal viewing' }).click();
    await expect(collaboratorPage.locator('#terminal-status-title')).toContainText('Terminal request pending');

    const dialog = page.getByRole('dialog', { name: 'Share this task' });
    const terminalRequests = dialog.locator('[aria-label="Terminal viewing requests"]');
    await expect(dialog.locator('.task-share-state')).toContainText('Viewer connected', { timeout: 10_000 });
    await expect(terminalRequests).toContainText('Dogfood guest requested terminal viewing', {
      timeout: 10_000,
    });
    await expect(dialog.getByRole('button', { name: 'Approve' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Approve' }).click();

    await expect(dialog.getByText('Watch terminal')).toBeVisible({ timeout: 10_000 });
    await expect(terminalRequests).toHaveCount(0);
    await expect(collaboratorPage.locator('#terminal-status-title')).toContainText('Terminal viewing approved', {
      timeout: 10_000,
    });
    await expect(collaboratorPage.getByLabel('Shared terminal')).toBeVisible();
    await expect(collaboratorPage.getByLabel('Terminal input message')).toBeDisabled();

    await collaborator.close();
  });

  test('guest terminal input requests remain non-actionable for owners', async ({ page, request, browser }) => {
    await createTask(request);
    const tmuxName = await getLatestTmuxName(request);
    await selectTask(page);
    const joinUrl = await createShareFromDashboard(page);

    const collaborator = await browser.newContext();
    const collaboratorPage = await collaborator.newPage();
    const requestedUrls: string[] = [];
    collaboratorPage.on('request', (req) => requestedUrls.push(req.url()));
    collaboratorPage.on('websocket', (ws) => requestedUrls.push(ws.url()));

    const joinResponse = await collaboratorPage.goto(joinUrl);
    expect(joinResponse?.headers()['referrer-policy']).toBe('no-referrer');
    await expect.poll(() => collaboratorPage.evaluate(() => location.hash)).toBe('');
    await collaboratorPage.getByLabel('Display name').fill('Dogfood guest');
    await collaboratorPage.getByRole('button', { name: 'Join' }).click();

    await expect(collaboratorPage.getByLabel('Shared task projection')).toBeVisible({ timeout: 10_000 });
    await expect(collaboratorPage.locator('#terminal-banner')).toContainText(
      'Terminal viewing requires owner approval.',
      { timeout: 10_000 },
    );
    await expect(collaboratorPage.getByRole('button', { name: 'Request terminal viewing' })).toHaveCount(1);
    await expect(collaboratorPage.getByLabel('Terminal input message')).toBeDisabled();

    const keysAfterJoin = await getKeysReceived(request, tmuxName);
    const terminalInput = collaboratorPage.getByLabel('Terminal input message');
    await expect(terminalInput).toBeDisabled();
    expect(await getKeysReceived(request, tmuxName)).toEqual(keysAfterJoin);

    const dialog = page.getByRole('dialog', { name: 'Share this task' });
    await expect(dialog.locator('.task-share-state')).toContainText('Viewer connected', { timeout: 10_000 });
    await expect(dialog.getByText('Guest links stay view-only')).toHaveCount(0);
    await expect(dialog.getByText('One control request is waiting')).toHaveCount(0);
    await expect(dialog.getByLabel('Collaborator grant requests')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Deny' })).toHaveCount(0);
    await expect(collaboratorPage.getByText('Terminal input approved')).toHaveCount(0);
    await expect(terminalInput).toBeDisabled();

    expect(await getKeysReceived(request, tmuxName)).toEqual(keysAfterJoin);

    expect(requestedUrls.some((url) => url.includes('inviteToken=') || url.includes('password=') || url.includes('memberToken='))).toBe(false);

    await dialog.getByRole('button', { name: 'Revoke' }).click();
    await expect(dialog.locator('.task-share-state')).toContainText('Revoked', { timeout: 10_000 });
    await expect(collaboratorPage.locator('#status')).toContainText('Disconnected', { timeout: 10_000 });
    await expect(terminalInput).toBeDisabled();

    await collaborator.close();
  });
});
