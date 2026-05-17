import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './relay-fixtures.js';

async function resetServer(request: APIRequestContext) {
  await request.post('/api/test/reset');
}

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
  await expect(dialog.getByText('View-only access')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create share link' }).click();
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
  await expect(dialog.getByRole('status')).toContainText('Waiting for viewer');
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
    await expect(dialog.getByRole('status')).toContainText('Viewer connected', { timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Revoke' }).click();
    await expect(dialog.getByRole('status')).toContainText('Revoked', { timeout: 10_000 });
    await expect(dialog.getByRole('button', { name: 'Create new share' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
    await expect(dialog.getByText('Link expires in')).toHaveCount(0);
    await expect(dialog.getByText('Display label')).toHaveCount(0);
    await expect(dialog.getByText('Approved grants')).toHaveCount(0);
    await expect(dialog.getByText('Terminal sharing')).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: 'Share ID' })).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: 'Password' })).toHaveCount(0);
    await expect(collaboratorPage.getByRole('status')).toContainText('Disconnected', { timeout: 10_000 });

    await collaborator.close();
  });

  test('owner approval unlocks collaborator terminal input without reloading the join page', async ({ page, request, browser }) => {
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
    await expect(collaboratorPage.getByRole('button', { name: 'Request terminal input' })).toBeEnabled({ timeout: 10_000 });
    await expect(collaboratorPage.getByLabel('Terminal input message')).toBeDisabled();

    const message = 'approved terminal input from dashboard flow';
    const keysBeforeApprovalRequest = await getKeysReceived(request, tmuxName);
    await collaboratorPage.getByRole('button', { name: 'Request terminal input' }).click();
    await expect(collaboratorPage.getByLabel('Terminal sharing status')).toContainText('Waiting for owner approval.');
    await expect(collaboratorPage.getByLabel('Terminal input message')).toBeDisabled();
    expect(await getKeysReceived(request, tmuxName)).toEqual(keysBeforeApprovalRequest);
    const reloadSentinel = await collaboratorPage.evaluate(() => {
      const value = crypto.randomUUID();
      (window as Window & { __kookrApprovalSentinel?: string }).__kookrApprovalSentinel = value;
      return value;
    });

    const dialog = page.getByRole('dialog', { name: 'Share this task' });
    await expect(dialog.getByRole('status')).toContainText('Viewer connected', { timeout: 10_000 });
    const requestPanel = dialog.getByLabel('Collaborator grant requests');
    await expect(requestPanel).toContainText('Watch terminal, Send messages', { timeout: 10_000 });
    await requestPanel.getByRole('button', { name: 'Approve' }).click();
    await expect(dialog.getByLabel('Approved collaborator grants')).toContainText('Watch terminal, Send messages', { timeout: 10_000 });

    await expect(collaboratorPage.getByText('Terminal input approved')).toBeVisible({ timeout: 10_000 });
    await expect(collaboratorPage.getByLabel('Shared terminal')).toBeVisible();
    const terminalInput = collaboratorPage.getByLabel('Terminal input message');
    await expect(terminalInput).toBeEnabled({ timeout: 10_000 });
    await expect.poll(() => collaboratorPage.evaluate(() => (
      (window as Window & { __kookrApprovalSentinel?: string }).__kookrApprovalSentinel
    ))).toBe(reloadSentinel);

    await terminalInput.fill(message);
    await collaboratorPage.getByRole('button', { name: 'Send Enter' }).click();
    await expect(collaboratorPage.getByRole('status')).toContainText(/Terminal input (sent|accepted)/, { timeout: 10_000 });
    await expect(async () => {
      expect(await getKeysReceived(request, tmuxName)).toContain(message);
    }).toPass({ timeout: 5_000 });

    expect(requestedUrls.some((url) => url.includes('inviteToken=') || url.includes('password=') || url.includes('memberToken='))).toBe(false);

    await dialog.getByRole('button', { name: 'Revoke' }).click();
    await expect(dialog.getByRole('status')).toContainText('Revoked', { timeout: 10_000 });
    await expect(collaboratorPage.getByRole('status')).toContainText('Disconnected', { timeout: 10_000 });
    await expect(terminalInput).toBeDisabled();

    await collaborator.close();
  });
});
