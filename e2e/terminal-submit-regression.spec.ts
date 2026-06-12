import { test, expect } from './fixtures.js';
import {
  getTasks,
  getTmuxNameForPrompt,
  injectSessionStart,
  injectStopEvent,
  injectToolUse,
  resetServer,
} from './battle-helpers.js';
import type { APIRequestContext, Page } from '@playwright/test';
import type { AgentType } from '../src/shared/protocol.js';

interface WrittenChunk {
  text: string;
  hex: string;
}

async function launchViaUIWithAgent(page: Page, prompt: string, cwd: string, agentType: AgentType) {
  await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
  const expectedTaskCount = await currentTaskCount(page) + 1;
  await page.locator('.btn-launch').click();
  await page.locator('.dialog textarea').fill(prompt);
  await page.locator('.dialog .agent-type-select select').selectOption(agentType);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.fill(cwd);
  await page.locator('.dialog .btn-primary').click();
  await expect(page.locator('.dialog')).not.toBeVisible();
  await expect(page.locator('.statusbar')).toContainText(`${expectedTaskCount} task`, { timeout: 5000 });
}

async function currentTaskCount(page: Page): Promise<number> {
  const status = await page.locator('.statusbar').textContent();
  const match = status?.match(/(\d+)\s+tasks?/);
  return match ? Number(match[1]) : 0;
}

async function writtenChunks(request: APIRequestContext, tmuxName: string): Promise<WrittenChunk[]> {
  const res = await request.get(`/api/test/written-chunks/${encodeURIComponent(tmuxName)}`);
  expect(res.status()).toBe(200);
  const body = await res.json() as { chunks: WrittenChunk[] };
  return body.chunks;
}

async function logicalSubmissions(request: APIRequestContext, tmuxName: string): Promise<string[]> {
  const res = await request.get(`/api/test/keys-received/${encodeURIComponent(tmuxName)}`);
  expect(res.status()).toBe(200);
  const body = await res.json() as { keysReceived: string[] };
  return body.keysReceived;
}

function expectSubmittedAsMessageThenEnter(chunks: WrittenChunk[], inputText: string) {
  const index = chunks.findIndex((chunk, i) => (
    chunk.text.includes(`\x1b[200~${inputText}\x1b[201~`) && chunks[i + 1]?.hex === '0d'
  ));
  expect(index, `expected "${inputText}" followed by Enter chunk`).toBeGreaterThanOrEqual(0);
}

async function assertTaskAgentType(request: APIRequestContext, prompt: string, agentType: AgentType) {
  await expect.poll(async () => {
    const task = (await getTasks(request)).find((candidate) => candidate.prompt === prompt);
    const session = task?.sessions[task.sessions.length - 1];
    return { taskAgentType: task?.agentType, sessionAgentType: session?.agentType };
  }, { timeout: 5000 }).toEqual({ taskAgentType: agentType, sessionAgentType: agentType });
}

test.describe('Terminal prompt submission from bottom response input', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  for (const agentType of ['claude-code', 'codex-cli'] as const) {
    test(`Enter on a finding sends text plus submitting Enter to ${agentType} before advancing`, async ({ page, request }) => {
      const firstPrompt = `Finding Submit ${agentType} Alpha`;
      const secondPrompt = `Finding Submit ${agentType} Beta`;
      const inputText = `continue ${agentType} from finding`;

      await launchViaUIWithAgent(page, firstPrompt, `/test/${agentType}-finding-alpha`, agentType);
      await assertTaskAgentType(request, firstPrompt, agentType);
      const firstTmux = await getTmuxNameForPrompt(request, firstPrompt);
      await injectSessionStart(request, firstTmux);
      await injectStopEvent(request, firstTmux, 'Waiting for input.');

      await launchViaUIWithAgent(page, secondPrompt, `/test/${agentType}-finding-beta`, agentType);
      await assertTaskAgentType(request, secondPrompt, agentType);
      const secondTmux = await getTmuxNameForPrompt(request, secondPrompt);
      await injectSessionStart(request, secondTmux);
      await injectStopEvent(request, secondTmux, 'Waiting for input.');

      await expect(page.locator('.finding-card')).toHaveCount(2);
      await page.locator('.finding-card').first().click();
      const initiallySelected = (await page.locator('.finding-card.selected .finding-task').textContent())?.trim();
      expect(initiallySelected).toBeTruthy();

      const reply = page.locator('.response-row textarea');
      await reply.fill(inputText);
      await reply.press('Enter');

      await expect(page.locator('.sent-overlay')).toBeVisible();
      await expect.poll(async () => {
        return (await page.locator('.finding-card.selected .finding-task').textContent())?.trim();
      }, { timeout: 5000 }).not.toBe(initiallySelected);

      await expect.poll(() => logicalSubmissions(request, firstTmux), { timeout: 3000 }).toContain(inputText);
      expectSubmittedAsMessageThenEnter(await writtenChunks(request, firstTmux), inputText);
      expect(await logicalSubmissions(request, secondTmux)).not.toContain(inputText);
      expect((await writtenChunks(request, secondTmux)).map((chunk) => chunk.text).join('')).not.toContain(inputText);
    });

    test(`Enter on a healthy row sends text plus submitting Enter to ${agentType} without switching tasks`, async ({ page, request }) => {
      const firstPrompt = `Healthy Submit ${agentType} Alpha`;
      const secondPrompt = `Healthy Submit ${agentType} Beta`;
      const inputText = `continue ${agentType} from healthy row`;

      await launchViaUIWithAgent(page, firstPrompt, `/test/${agentType}-healthy-alpha`, agentType);
      await assertTaskAgentType(request, firstPrompt, agentType);
      const firstTmux = await getTmuxNameForPrompt(request, firstPrompt);
      await injectSessionStart(request, firstTmux);
      await injectToolUse(request, firstTmux);

      await launchViaUIWithAgent(page, secondPrompt, `/test/${agentType}-healthy-beta`, agentType);
      await assertTaskAgentType(request, secondPrompt, agentType);
      const secondTmux = await getTmuxNameForPrompt(request, secondPrompt);
      await injectSessionStart(request, secondTmux);
      await injectToolUse(request, secondTmux);

      await expect(page.locator('.healthy-row')).toHaveCount(2);
      await page.locator('.healthy-row').first().click();
      const initiallySelected = (await page.locator('.healthy-row.selected .healthy-row-name').textContent())?.trim();
      expect(initiallySelected).toBeTruthy();

      const reply = page.locator('.response-row textarea');
      await reply.fill(inputText);
      await reply.press('Enter');

      await expect(page.locator('.sent-overlay')).toBeVisible();
      await expect(page.locator('.healthy-row.selected .healthy-row-name')).toHaveText(initiallySelected!);

      await expect.poll(() => logicalSubmissions(request, firstTmux), { timeout: 3000 }).toContain(inputText);
      expectSubmittedAsMessageThenEnter(await writtenChunks(request, firstTmux), inputText);
      expect(await logicalSubmissions(request, secondTmux)).not.toContain(inputText);
      expect((await writtenChunks(request, secondTmux)).map((chunk) => chunk.text).join('')).not.toContain(inputText);
    });
  }
});
