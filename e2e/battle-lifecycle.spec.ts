/**
 * Battle-test E2E suite — Stop agent, edge cases, and integration scenarios.
 *
 * Covers: Stop agent (cancel confirm/dismiss), edge cases & resilience,
 * full integration scenarios.
 */
import { test, expect } from './fixtures.js';
import {
  resetServer,
  launchViaUI,
  getLatestTmuxName,
  getTmuxNameForPrompt,
  getTasks,
  injectSessionStart,
  injectStopEvent,
  injectToolUse,
  injectPermissionEvent,
  waitForAgentCount,
  waitForFindingCount,
} from './battle-helpers.js';

// ---------------------------------------------------------------------------
// Suite 11: Stop agent
// ---------------------------------------------------------------------------

test.describe('Stop agent', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('cancel agent shows confirm dialog', async ({ page, request }) => {
    await launchViaUI(page, 'Confirm cancel', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();

    let dialogSeen = false;
    page.on('dialog', (dialog) => {
      dialogSeen = true;
      dialog.dismiss(); // Dismiss the cancel confirm
    });

    await page.locator('[data-testid="action-cancel"]').click();
    expect(dialogSeen).toBe(true);

    // Agent should still be present (we dismissed the confirm)
    await expect(page.locator('.finding-card')).toBeVisible();
  });

  test('confirmed cancel removes agent from monitor', async ({ page, request }) => {
    await launchViaUI(page, 'Remove on cancel', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-testid="action-cancel"]').click();

    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator('.healthy-row')).not.toBeVisible();

    // Snapshot should contain only the cancelled task (synthetic entry)
    const res = await request.get('/api/snapshot');
    const snapshot = await res.json();
    expect(snapshot.length).toBe(1);
    expect(snapshot[0].taskStatus).toBe('cancelled');
  });

  test('cancel one of multiple agents leaves others intact', async ({ page, request }) => {
    await launchViaUI(page, 'Keep me', '/test/a');
    const tmux1 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux1);
    await injectStopEvent(request, tmux1);

    await launchViaUI(page, 'Cancel me', '/test/b');
    const tmux2 = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux2);
    await injectStopEvent(request, tmux2);

    await expect(page.locator('.finding-card')).toHaveCount(2);

    // Select second finding and cancel it
    await page.locator('.finding-card').nth(1).click();
    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-testid="action-cancel"]').click();

    // Selecting the cancelled task also filters to its project. Show the
    // remaining project's finding before checking that it survived.
    await page.getByTestId('project-icon-all').click();
    await expect(page.locator('.finding-card')).toHaveCount(1, { timeout: 10000 });
    await expect(page.locator('.finding-card')).toContainText('Keep me');
  });
});

// ---------------------------------------------------------------------------
// Suite 12: Edge cases & resilience
// ---------------------------------------------------------------------------

test.describe('Edge cases & resilience', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('rapid event injection does not break UI', async ({ page, request }) => {
    await launchViaUI(page, 'Rapid events', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    // Fire many events rapidly
    for (let i = 0; i < 10; i++) {
      await injectToolUse(request, tmuxName, `Tool${i}`);
    }
    await injectStopEvent(request, tmuxName);

    // UI should still be responsive
    await expect(page.locator('.finding-card')).toBeVisible({ timeout: 5000 });
  });

  test('agent transitions from anomaly to healthy to anomaly', async ({ page, request }) => {
    await launchViaUI(page, 'Bounce test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    // First: anomaly
    await injectStopEvent(request, tmuxName);
    await expect(page.locator('.finding-card')).toBeVisible();

    // Then: healthy
    await injectToolUse(request, tmuxName);
    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 3000 });

    // Then: anomaly again
    await injectStopEvent(request, tmuxName);
    await expect(page.locator('.finding-card')).toBeVisible({ timeout: 3000 });
  });

  test('agent transitions through multiple anomaly types', async ({ page, request }) => {
    await launchViaUI(page, 'Multi anomaly', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    // Start with a completed turn (Stop event)
    await injectStopEvent(request, tmuxName);
    await expect(page.locator('.finding-severity')).toContainText('Signaled Complete');

    // Transition to permission
    await injectPermissionEvent(request, tmuxName);
    await expect(page.locator('.finding-severity')).toContainText('Permission');

    // Back to healthy
    await injectToolUse(request, tmuxName);
    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 3000 });
  });

  test('server reset clears all state', async ({ page, request }) => {
    // Launch agents
    await launchViaUI(page, 'Agent X', '/test/x');
    await launchViaUI(page, 'Agent Y', '/test/y');
    await waitForAgentCount(page, 2);

    // Reset
    await resetServer(request);

    // Wait for snapshot update
    await page.waitForTimeout(500);

    // Reload page to get fresh state
    await page.goto('/');
    await expect(page.locator('.statusbar')).toContainText('0 tasks');
    await expect(page.locator('.findings-empty')).toContainText('No agents running');
  });

  test('all-clear state displays correctly', async ({ page, request }) => {
    await launchViaUI(page, 'Clear agent', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectToolUse(request, tmuxName);

    await expect(page.locator('.findings-all-clear')).toContainText('All clear');
    await expect(page.locator('.finding-card')).not.toBeVisible();
  });

  test('empty state has no findings or healthy sections', async ({ page }) => {
    await expect(page.locator('.findings-empty')).toBeVisible();
    await expect(page.locator('.findings-all-clear')).not.toBeVisible();
    await expect(page.locator('.healthy-section')).not.toBeVisible();
    await expect(page.locator('.finding-card')).not.toBeVisible();
  });

  test('launching many agents does not degrade UI', async ({ page, request }) => {
    for (let i = 0; i < 5; i++) {
      await launchViaUI(page, `Agent ${i}`, `/test/${i}`);
    }
    await waitForAgentCount(page, 5);

    // All should be trackable
    const tasks = await getTasks(request);
    expect(tasks.length).toBe(5);

    // Make all have anomalies — use 2 types (max 2 each to avoid grouping, 5th goes to perm)
    for (let i = 0; i < tasks.length; i++) {
      const tmux = tasks[i].sessions[0].tmuxSession;
      await injectSessionStart(request, tmux);
      if (i % 2 === 0) {
        await injectPermissionEvent(request, tmux);
      } else {
        await injectStopEvent(request, tmux);
      }
    }
    // 3 permission + 2 stop → permission group + 2 stop cards. Check via statusbar instead.
    await waitForFindingCount(page, 5);
  });
});

// ---------------------------------------------------------------------------
// Suite 21: Full integration scenario
// ---------------------------------------------------------------------------

test.describe('Full integration scenarios', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('complete multi-agent triage workflow', async ({ page, request }) => {
    // Launch 3 agents
    await launchViaUI(page, 'Auth fix', '/test/auth');
    const tmux1 = await getTmuxNameForPrompt(request, 'Auth fix');

    await launchViaUI(page, 'API refactor', '/test/api');
    const tmux2 = await getTmuxNameForPrompt(request, 'API refactor');

    await launchViaUI(page, 'UI polish', '/test/ui');
    const tmux3 = await getTmuxNameForPrompt(request, 'UI polish');

    await waitForAgentCount(page, 3);

    // Initialize all
    await injectSessionStart(request, tmux1);
    await injectSessionStart(request, tmux2);
    await injectSessionStart(request, tmux3);

    // Agent 1: permission (warning), Agent 2: needs_input (info), Agent 3: healthy
    await injectPermissionEvent(request, tmux1);
    await injectStopEvent(request, tmux2);
    await injectToolUse(request, tmux3);
    // Publish the seeded projects before navigation selects their drawers.
    const summaries = await request.post('/api/test/broadcast-project-summaries');
    expect(summaries.ok()).toBe(true);

    await expect(page.locator('.finding-card')).toHaveCount(2);
    await expect(page.locator('.healthy-row')).toHaveCount(1);
    for (const project of ['auth', 'api']) {
      await expect(page.getByTestId(`project-icon-local/${project}`)).toBeVisible();
    }

    // Navigate to highest priority (permission)
    await page.keyboard.press('Alt+n');
    await expect(page.locator('.detail-badge')).toContainText('PERMISSION');
    await expect(page.getByTestId('project-detail-drawer')).toBeVisible();
    await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();

    // Respond to permission agent
    await page.locator('.response-row textarea').fill('Approve the permission');
    await page.locator('[data-testid="send-next-button"]').click();
    await expect(page.locator('.sent-overlay')).toBeVisible();

    // After advance, should be on needs_input agent
    await expect(page.locator('.sent-overlay')).not.toBeVisible({ timeout: 3000 });

    // Send & Next already selected the remaining finding; another navigation
    // would deselect it instead of delivering the second reply.
    await expect(page.locator('.finding-card.selected .finding-task')).toHaveText('API refactor');
    await page.locator('.response-row textarea').fill('Run the tests again');
    await page.getByTestId('send-next-button').click();
    await page.getByTestId('project-icon-all').click();
    await expect(page.locator('.finding-card')).toHaveCount(0);
    await expect(page.locator('.healthy-row')).toHaveCount(3);
  });

  test('agent lifecycle: launch → anomaly → respond → healthy → complete', async ({ page, request }) => {
    // Launch
    await launchViaUI(page, 'Full lifecycle', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);

    // Working (healthy)
    await injectToolUse(request, tmuxName);
    await expect(page.locator('.healthy-row')).toBeVisible();

    // Anomaly
    await injectStopEvent(request, tmuxName, 'Found a problem, need guidance');
    await expect(page.locator('.finding-card')).toBeVisible();

    // Respond
    await page.locator('.finding-card').click();
    await page.locator('.response-row textarea').fill('Try approach X');
    await page.locator('[data-testid="send-next-button"]').click();

    // Agent resumes
    await injectToolUse(request, tmuxName);
    await expect(page.locator('.finding-card')).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator('.healthy-row')).toBeVisible();

    // Complete the task
    await page.locator('.healthy-row').click();
    await page.locator('[data-testid="action-complete"]').click();
    await page.getByRole('dialog', { name: 'Complete Task' }).getByRole('button', { name: 'Complete' }).click();

    // Agent removed
    await expect(page.locator('.healthy-row')).not.toBeVisible({ timeout: 5000 });
  });

  test('rapid launch-and-triage: 4 agents in succession', async ({ page, request }, testInfo) => {
    // Four UI launches and four verified terminal deliveries include the normal
    // sent overlays; keep room for that real work when other suites share the CPU.
    testInfo.setTimeout(30_000);
    const agents = new Map<string, string>();

    // Use mixed anomaly types and distinct prompt text to avoid finding grouping.
    for (let i = 0; i < 4; i++) {
      const prompt = `Rapid ${i}`;
      await launchViaUI(page, prompt, `/test/${i}`);
      const tmux = await getTmuxNameForPrompt(request, prompt);
      agents.set(prompt, tmux);
      await injectSessionStart(request, tmux);
      if (i % 2 === 0) {
        await injectStopEvent(request, tmux, `I need your help for rapid task ${i}.`);
      } else {
        await injectPermissionEvent(request, tmux, undefined, `npm install rapid-${i}`);
      }
      await expect(page.locator('.finding-card')).toHaveCount(i + 1, { timeout: 10000 });
    }

    const summaries = await request.post('/api/test/broadcast-project-summaries');
    expect(summaries.ok()).toBe(true);
    for (let i = 0; i < 4; i++) {
      await expect(page.getByTestId(`project-icon-local/${i}`)).toBeVisible();
    }

    // Navigate once, then let Send & Next advance. Navigating again between
    // replies skips findings and can revisit an already-answered task.
    await page.keyboard.press('Alt+n');
    const answered = new Set<string>();
    for (let i = 0; i < 4; i++) {
      await expect(page.getByTestId('project-detail-drawer')).toBeVisible();
      await expect(page.locator('.terminal-xterm .xterm-screen')).toBeVisible();
      const selected = page.locator('.finding-card.selected .finding-task');
      await expect(selected).toHaveText(/^Rapid [0-3]$/);
      const prompt = (await selected.textContent())!;
      expect(answered.has(prompt)).toBe(false);
      const tmux = agents.get(prompt)!;
      const reply = `Fix ${i}`;
      await page.locator('.response-row textarea').fill(reply);
      await page.getByTestId('send-next-button').click();
      await expect.poll(async () => {
        const response = await request.get(`/api/test/keys-received/${encodeURIComponent(tmux)}`);
        const data = await response.json();
        return data.keysReceived as string[];
      }).toContain(reply);
      answered.add(prompt);
    }
    expect(answered.size).toBe(4);
    await page.getByTestId('project-icon-all').click();
    await expect(page.locator('.finding-card')).toHaveCount(0);
  });
});
