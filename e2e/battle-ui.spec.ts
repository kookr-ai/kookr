/**
 * Battle-test E2E suite — UI layout, launch dialog, keyboard, and sidebar tests.
 *
 * Covers: UI layout & components, launch dialog, quick launch, keyboard shortcuts,
 * rename task, focus management, sidebar collapsible sections.
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
} from './battle-helpers.js';

// ---------------------------------------------------------------------------
// Suite 7: UI layout & components
// ---------------------------------------------------------------------------

test.describe('UI layout', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('findings panel structure is correct', async ({ page }) => {
    await expect(page.locator('.findings-panel')).toBeVisible();
    await expect(page.locator('.findings-header')).toContainText('Supervisor Findings');
  });

  test('detail panel shows empty state initially', async ({ page }) => {
    await expect(page.locator('.detail-empty')).toContainText('No agents running');
    await expect(page.locator('.detail-empty kbd')).toContainText('Alt+L');
  });

  // Keyboard-hint affordances were moved out of the statusbar at some point
  // (the current StatusBar.tsx renders task/finding counts, sound/achievement
  // controls, and the reflection prompt — no Alt+N / Alt+J / Alt+L / Enter
  // chrome). Marking fixme rather than deleting so the intent ("verify the
  // common shortcuts are surfaced *somewhere* the user can see them") is
  // preserved if the hints come back.
  test.fixme('statusbar shows keyboard hints', async ({ page }) => {
    const bar = page.locator('.statusbar');
    await expect(bar).toContainText('Alt+N');
    await expect(bar).toContainText('Enter');
    await expect(bar).toContainText('Alt+J');
    await expect(bar).toContainText('Alt+L');
  });

  test('topbar queue dots show when findings exist', async ({ page, request }) => {
    await launchViaUI(page, 'Queue dots', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await expect(page.locator('.queue-dots')).toBeVisible();
    await expect(page.locator('.queue-dot')).toHaveCount(1);
  });

  test('queue dots update count with multiple findings', async ({ page, request }) => {
    await launchViaUI(page, 'A', '/test/a');
    const tmuxA = await getTmuxNameForPrompt(request, 'A');
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    await launchViaUI(page, 'B', '/test/b');
    const tmuxB = await getTmuxNameForPrompt(request, 'B');
    await injectSessionStart(request, tmuxB);
    await injectStopEvent(request, tmuxB);

    await expect(page.locator('.queue-dot')).toHaveCount(2);
  });

  test('queue-dot shows current state when finding is selected', async ({ page, request }) => {
    await launchViaUI(page, 'Dot test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Select the finding
    await page.locator('.finding-card').click();

    // Queue dot should have 'current' class
    await expect(page.locator('.queue-dot.current')).toHaveCount(1);
  });

  test('finding card has correct severity class', async ({ page, request }) => {
    await launchViaUI(page, 'Severity class', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectPermissionEvent(request, tmuxName);

    await expect(page.locator('.finding-card.permission')).toBeVisible();
  });

  test('selected finding card has selected class', async ({ page, request }) => {
    await launchViaUI(page, 'Selected class', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    await expect(page.locator('.finding-card.selected')).toBeVisible();
  });

  test('mobile viewport uses findings/task tabs and touch actions', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    await launchViaUI(page, 'Mobile dashboard', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await expect(page.getByTestId('mobile-dashboard-tabs')).toBeVisible();
    await expect(page.getByTestId('mobile-quick-actions')).toBeVisible();
    await expect(page.getByTestId('mobile-tab-findings')).toHaveClass(/active/);
    await expect(page.locator('.finding-card')).toBeVisible();

    await page.locator('.finding-card').click();

    await expect(page.getByTestId('mobile-tab-task')).toHaveClass(/active/);
    await expect(page.locator('.detail-header')).toBeVisible();
    await expect(page.locator('.response-row input')).toBeVisible();

    await page.getByTestId('mobile-tab-findings').click();
    await expect(page.getByTestId('mobile-tab-findings')).toHaveClass(/active/);
    await expect(page.locator('.findings-panel')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Suite 8: Launch dialog behavior
// ---------------------------------------------------------------------------

test.describe('Launch dialog', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('dialog opens and focuses prompt textarea', async ({ page }) => {
    await page.locator('.btn-launch').click();
    await expect(page.locator('.dialog')).toBeVisible();
    await expect(page.locator('.dialog h3')).toContainText('Launch New Task');
    await expect(page.locator('.dialog textarea')).toBeFocused();
  });

  test('dialog closes on cancel button', async ({ page }) => {
    await page.locator('.btn-launch').click();
    await page.locator('.dialog .btn-secondary').click();
    await expect(page.locator('.dialog')).not.toBeVisible();
  });

  // Backdrop-click dismiss was deliberately removed in PR #439 — clicking
  // outside the dialog is now a silent no-op so users don't lose typed task
  // descriptions to a misclick. The new behavior (overlay click stays open;
  // X / Cancel / Escape close) is covered by `launch-dialog-dismiss.spec.ts`.

  test('dialog closes on Escape key', async ({ page }) => {
    await page.locator('.btn-launch').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dialog')).not.toBeVisible();
  });

  test('submit disabled with empty prompt', async ({ page }) => {
    await page.locator('.btn-launch').click();
    // CWD may have a default, but prompt is empty
    await expect(page.locator('.dialog .btn-primary')).toBeDisabled();
  });

  test('submit disabled with empty cwd', async ({ page }) => {
    await page.locator('.btn-launch').click();
    await page.locator('.dialog textarea').fill('Some task');
    const cwdInput = page.locator('.dialog input[type="text"]').first();
    await cwdInput.clear();
    await expect(page.locator('.dialog .btn-primary')).toBeDisabled();
  });

  test('successful launch creates task and closes dialog', async ({ page, request }) => {
    await launchViaUI(page, 'Dialog launch', '/test/project');
    await expect(page.locator('.dialog')).not.toBeVisible();
    await waitForAgentCount(page, 1);

    const tasks = await getTasks(request);
    expect(tasks.length).toBe(1);
  });

  test('default cwd is server cwd', async ({ page }) => {
    await page.locator('.btn-launch').click();
    const cwdInput = page.locator('.dialog input[type="text"]').first();
    const cwdValue = await cwdInput.inputValue();
    // Should be the serverCwd from test-server.ts: '/home/user/projects'
    expect(cwdValue).toBe('/home/user/projects');
  });
});

// ---------------------------------------------------------------------------
// Suite 9: Quick launch
// ---------------------------------------------------------------------------

test.describe('Quick launch', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('Ctrl+L opens quick launch bar', async ({ page }) => {
    await page.keyboard.press('Alt+l');
    await expect(page.locator('.quick-launch-bar')).toBeVisible();
    await expect(page.locator('.quick-launch-input')).toBeFocused();
  });

  test('Escape closes quick launch', async ({ page }) => {
    await page.keyboard.press('Alt+l');
    await expect(page.locator('.quick-launch-bar')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.quick-launch-bar')).not.toBeVisible();
  });

  test('Enter submits quick launch with prompt', async ({ page, request }) => {
    await expect(page.locator('.health-dot-connected')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Alt+l');
    await page.locator('.quick-launch-input').fill('Quick task');
    await page.keyboard.press('Enter');

    await expect(page.locator('.quick-launch-bar')).not.toBeVisible();
    await waitForAgentCount(page, 1);
  });

  test('quick launch shows server cwd', async ({ page }) => {
    await page.keyboard.press('Alt+l');
    await expect(page.locator('.quick-launch-cwd')).toContainText('/home/user/projects');
  });

  test('quick launch shows selected agent cwd when available', async ({ page, request }) => {
    await launchViaUI(page, 'Agent with cwd', '/custom/project/path');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Select the agent
    await page.locator('.finding-card').click();

    // Open quick launch — should inherit the selected agent's cwd
    await page.keyboard.press('Alt+l');
    await expect(page.locator('.quick-launch-cwd')).toContainText('/custom/project/path');
  });
});

// ---------------------------------------------------------------------------
// Suite 10: Keyboard shortcuts
// ---------------------------------------------------------------------------

test.describe('Keyboard shortcuts', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('Tab skips current finding when not focused on input', async ({ page, request }) => {
    await launchViaUI(page, 'Tab skip', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Wait for finding to render, then select it via keyboard
    await expect(page.locator('.finding-card')).toBeVisible();
    await page.keyboard.press('Alt+n');
    await expect(page.locator('.finding-card.selected')).toBeVisible();

    // Blur any input
    await page.locator('.logo').click();

    // Tab should skip
    await page.keyboard.press('Tab');
  });

  test('Tab does NOT skip when focused on input', async ({ page, request }) => {
    await launchViaUI(page, 'Tab input', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();

    // Focus on the response input
    const input = page.locator('.response-row input');
    await input.focus();

    // Tab should not skip (normal tab behavior in input)
    await page.keyboard.press('Tab');

    // Finding should still be selected
    await expect(page.locator('.finding-card.selected')).toBeVisible();
  });

  test('Ctrl+N with no findings does not crash', async ({ page }) => {
    // No agents, press Ctrl+N — should be a no-op
    await page.keyboard.press('Alt+n');
    // Page should still be functional
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('Ctrl+L then Enter without prompt does nothing', async ({ page }) => {
    await page.keyboard.press('Alt+l');
    await page.keyboard.press('Enter');
    // Quick launch should close (onBlur) but no task created
    await expect(page.locator('.statusbar')).toContainText('0 tasks');
  });
});

// ---------------------------------------------------------------------------
// Suite 13: Rename task behavior
// ---------------------------------------------------------------------------

test.describe('Rename task', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('double-click opens inline edit in findings panel', async ({ page, request }) => {
    await launchViaUI(page, 'Rename me', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-task').dblclick();
    await expect(page.locator('.finding-task-edit')).toBeVisible();
    await expect(page.locator('.finding-task-edit')).toBeFocused();
  });

  test('Escape cancels rename without saving', async ({ page, request }) => {
    await launchViaUI(page, 'Keep original', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-task').dblclick();
    const editInput = page.locator('.finding-task-edit');
    await editInput.fill('New name that should not save');
    await editInput.press('Escape');

    // Original name should remain
    await expect(page.locator('.finding-task')).toContainText('Keep original');

    // API should not have the new name
    const tasks = await getTasks(request);
    expect(tasks[0].name).toBeUndefined();
  });

  test('rename in detail panel heading', async ({ page, request }) => {
    await launchViaUI(page, 'Detail rename', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    await page.locator('.detail-header h2').dblclick();

    const editInput = page.locator('.detail-heading-edit');
    await expect(editInput).toBeVisible();
    await editInput.clear();
    await editInput.fill('Renamed via detail');
    await editInput.press('Enter');

    await expect(page.locator('.detail-header h2')).toContainText('Renamed via detail');

    // Verify in API
    const tasks = await getTasks(request);
    expect(tasks[0].name).toBe('Renamed via detail');
  });

  test('rename syncs between findings panel and detail panel', async ({ page, request }) => {
    await launchViaUI(page, 'Sync rename', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    // Select the finding to show detail panel
    await page.locator('.finding-card').click();
    // Wait for delayed selection to take effect (click-dblclick disambiguation)
    await expect(page.locator('.detail-header')).toBeVisible();

    // Rename in findings panel
    await page.locator('.finding-task').dblclick();
    const editInput = page.locator('.finding-task-edit');
    await editInput.clear();
    await editInput.fill('Synced Name');
    await editInput.press('Enter');

    // Both panels should show the new name
    await expect(page.locator('.finding-task')).toContainText('Synced Name');
    await expect(page.locator('.detail-header h2')).toContainText('Synced Name');
  });
});

// ---------------------------------------------------------------------------
// Suite 14: Focus management
// ---------------------------------------------------------------------------

test.describe('Focus management', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('selecting a finding with anomaly focuses response input', async ({ page, request }) => {
    await launchViaUI(page, 'Focus test', '/test/project');
    const tmuxName = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxName);
    await injectStopEvent(request, tmuxName);

    await page.locator('.finding-card').click();
    // Response input should be focused
    await expect(page.locator('.response-row input')).toBeFocused();
  });

  test('anomaly does not steal focus from response input of different agent', async ({ page, request }) => {
    // Agent A: needs input
    await launchViaUI(page, 'Agent A', '/test/a');
    const tmuxA = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    // Agent B: healthy
    await launchViaUI(page, 'Agent B', '/test/b');
    const tmuxB = await getLatestTmuxName(request);
    await injectSessionStart(request, tmuxB);

    // Select Agent A and focus response input
    await page.locator('.finding-card').click();
    const responseInput = page.locator('.response-row input');
    await responseInput.focus();
    await responseInput.fill('I am typing');

    // Agent B gets an anomaly
    await injectStopEvent(request, tmuxB);
    await page.waitForTimeout(500);

    // Focus should still be on the response input
    await expect(responseInput).toBeFocused();
  });

  test('anomaly does not steal focus from rename input', async ({ page, request }) => {
    const renamePrompt = 'Rename focus';
    const backgroundPrompt = 'Background';
    await launchViaUI(page, renamePrompt, '/test/a');
    const tmuxA = await getTmuxNameForPrompt(request, renamePrompt);
    await injectSessionStart(request, tmuxA);
    await injectStopEvent(request, tmuxA);

    await launchViaUI(page, backgroundPrompt, '/test/b');
    const tmuxB = await getTmuxNameForPrompt(request, backgroundPrompt);
    await injectSessionStart(request, tmuxB);

    // Start renaming agent A
    await page.locator('.finding-task').dblclick();
    const editInput = page.locator('.finding-task-edit');
    await editInput.fill('New name');

    // Background agent gets anomaly
    await injectStopEvent(request, tmuxB);
    await page.waitForTimeout(500);

    // Focus should still be on the rename input
    await expect(editInput).toBeFocused();
  });
});

// ---------------------------------------------------------------------------
// Suite: Sidebar scalability — collapsible sections & scroll behavior
// ---------------------------------------------------------------------------

test.describe('sidebar collapsible sections', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetServer(request);
    await page.goto('/');
    await expect(page.locator('.logo')).toHaveText('KOOKR');
  });

  test('section headers have chevrons and are clickable', async ({ page, request }) => {
    // Launch agents to populate healthy section
    await launchViaUI(page, 'Agent A', '/test/a');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectToolUse(request, tmux);

    // Healthy section should be visible with chevron
    await expect(page.locator('.healthy-section')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.healthy-section .section-chevron')).toBeVisible();
    // Default state: expanded (down-pointing chevron ▾)
    await expect(page.locator('.healthy-section .section-chevron')).toHaveText('\u25BE');
  });

  test('clicking section header collapses and re-expands healthy section', async ({ page, request }) => {
    await launchViaUI(page, 'Collapse test', '/test/a');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectToolUse(request, tmux);

    await expect(page.locator('.healthy-section')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.healthy-row')).toBeVisible();

    // Collapse the healthy section
    await page.locator('.healthy-section .section-header').click();
    await expect(page.locator('.healthy-section .section-chevron')).toHaveText('\u25B8');
    await expect(page.locator('.healthy-row')).not.toBeVisible();
    // Header with count should still be visible
    await expect(page.locator('.healthy-label')).toContainText('Healthy (1)');

    // Re-expand
    await page.locator('.healthy-section .section-header').click();
    await expect(page.locator('.healthy-section .section-chevron')).toHaveText('\u25BE');
    await expect(page.locator('.healthy-row')).toBeVisible();
  });

  test('collapsing snoozed section hides snoozed rows', async ({ page, request }) => {
    await launchViaUI(page, 'Snooze collapse', '/test/a');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux);

    await expect(page.locator('.finding-card')).toBeVisible({ timeout: 3000 });

    // Snooze the finding
    await page.locator('.finding-actions .btn-xs:has-text("Snooze")').click();
    await page.locator('.snooze-dialog-btn:has-text("5m")').click();
    await expect(page.locator('.snoozed-section')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.snoozed-label')).toContainText('Snoozed (1)');
    if (await page.locator('.snoozed-section .section-chevron').textContent() === '\u25B8') {
      await page.locator('.snoozed-section .section-header').click();
    }
    await expect(page.locator('.snoozed-row')).toBeVisible();

    // Collapse snoozed section
    await page.locator('.snoozed-section .section-header').click();
    await expect(page.locator('.snoozed-row')).not.toBeVisible();
    await expect(page.locator('.snoozed-label')).toContainText('Snoozed (1)');
  });

  test('findings section is NOT collapsible', async ({ page, request }) => {
    await launchViaUI(page, 'Findings no collapse', '/test/a');
    const tmux = await getLatestTmuxName(request);
    await injectSessionStart(request, tmux);
    await injectStopEvent(request, tmux);

    await expect(page.locator('.finding-card')).toBeVisible({ timeout: 3000 });

    // Findings section should not have a section-header (not collapsible)
    const findingsScrollArea = page.locator('.findings-scroll-area');
    // The finding cards are direct children of the scroll area, not inside a collapsible section
    await expect(findingsScrollArea.locator('> .finding-card')).toBeVisible();
    // There should be no section-header before the finding cards
    await expect(page.locator('.findings-header .section-header')).not.toBeVisible();
  });

  test('findings remain visible when healthy section has many agents', async ({ page, request }) => {
    // Create a finding first
    await launchViaUI(page, 'Finding agent', '/test/finding');
    const findingTmux = await getLatestTmuxName(request);
    await injectSessionStart(request, findingTmux);
    await injectStopEvent(request, findingTmux);
    await expect(page.locator('.finding-card')).toBeVisible({ timeout: 3000 });

    // Launch multiple healthy agents
    for (let i = 0; i < 5; i++) {
      await launchViaUI(page, `Healthy ${i}`, `/test/h${i}`);
      const tmux = await getLatestTmuxName(request);
      await injectSessionStart(request, tmux);
      await injectToolUse(request, tmux);
    }
    await waitForAgentCount(page, 6);

    // Finding card should still be visible (not pushed off screen)
    await expect(page.locator('.finding-card')).toBeVisible();
    // All sections should exist in the scroll area
    await expect(page.locator('.healthy-section')).toBeVisible();
  });

  test('collapsing healthy section reclaims space for findings', async ({ page, request }) => {
    // Launch several healthy agents
    for (let i = 0; i < 3; i++) {
      await launchViaUI(page, `Agent ${i}`, `/test/${i}`);
      const tmux = await getLatestTmuxName(request);
      await injectSessionStart(request, tmux);
      await injectToolUse(request, tmux);
    }
    await waitForAgentCount(page, 3);

    // All 3 healthy rows visible
    await expect(page.locator('.healthy-row')).toHaveCount(3, { timeout: 3000 });

    // Collapse healthy section
    await page.locator('.healthy-section .section-header').click();

    // Rows hidden, but label visible
    await expect(page.locator('.healthy-row')).not.toBeVisible();
    await expect(page.locator('.healthy-label')).toContainText('Healthy (3)');
  });

  test('all sections scroll together in single container', async ({ page, request }) => {
    // Create agents in different states: finding + healthy + snoozed
    await launchViaUI(page, 'Finding agent', '/test/f');
    const fTmux = await getTmuxNameForPrompt(request, 'Finding agent');
    await injectSessionStart(request, fTmux);
    await injectStopEvent(request, fTmux);
    await expect(page.locator('.finding-card')).toBeVisible({ timeout: 3000 });

    await launchViaUI(page, 'Healthy agent', '/test/h');
    const hTmux = await getTmuxNameForPrompt(request, 'Healthy agent');
    await injectSessionStart(request, hTmux);
    await injectToolUse(request, hTmux);

    await waitForAgentCount(page, 2);

    // Findings in scroll area, healthy in bottom sections
    const scrollArea = page.locator('.findings-scroll-area');
    await expect(scrollArea).toBeVisible();
    await expect(scrollArea.locator('.finding-card')).toBeVisible();
    const bottomSections = page.locator('.bottom-sections');
    await expect(bottomSections.locator('.healthy-section')).toBeVisible();
  });
});
