import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

const LONG_PLAYBOOK = `---
name: Implement GitHub Issue
description: Claim GitHub issues one at a time, implement them, and optionally merge completed PRs
tags: [workflow, loopable]
parameters:
  - name: issueId
    description: "Specific issue number (leave empty to claim the next eligible open issue)"
    required: false
  - name: repo
    description: "GitHub repo (owner/name, leave empty for current repo)"
    required: false
  - name: mergeAfterImplementation
    description: "Merge policy after the implementation PR is ready"
    required: true
    default: "false"
    type: select
    options:
      - label: "Open PR only"
        value: "false"
      - label: "Merge when safe"
        value: "true"
  - name: assignee
    description: "GitHub username to assign the PR (leave empty for current user)"
    required: false
loop:
  iterationCap: 20
  costCapUsd: 25
checklist:
  - Resolved target issue
  - Acquired or resumed the repo-scoped issue claim
  - Read and understood the issue requirements
  - Created or resumed a git worktree with descriptive branch name
  - Implemented the solution following project conventions
  - All existing tests pass
  - New tests written for the changes
  - Type-check passes if TypeScript project
  - Created PR linking the issue with Closes #N
  - PR has a clear summary and test plan
  - Merge policy checked
  - Claim released when complete
---

Implement GitHub issues end-to-end.
`;

test.describe('Dialog viewport fit', () => {
  test('long playbook launch dialog stays within a large desktop viewport', async ({ page, request }) => {
    const cwd = `/tmp/kookr-e2e-dialog-fit-${Date.now()}`;

    const createResponse = await request.post('/api/test/create-playbook-files', {
      data: {
        cwd,
        playbooks: [{ filename: 'implement-github-issue.md', content: LONG_PLAYBOOK }],
      },
    });
    expect(createResponse.ok()).toBe(true);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('.logo')).toBeVisible();

    await page.locator('.btn-launch').click();
    await expect(page.locator('.dialog')).toBeVisible();
    await page.getByPlaceholder('/home/user/my-project').fill(cwd);
    await page.getByRole('button', { name: 'Playbooks' }).click();
    await page.getByText('Implement GitHub Issue', { exact: true }).click();

    await expect(page.locator('.playbook-checklist')).toBeVisible();
    await expectVisibleDialogsWithinViewport(page);
    await expectElementWithinViewport(page.getByRole('button', { name: 'Launch Playbook' }), page);
  });
});

async function expectVisibleDialogsWithinViewport(page: Page) {
  const dialogs = page.locator([
    '.dialog:visible',
    '.settings-dialog:visible',
    '.confirm-dialog:visible',
    '.snooze-dialog:visible',
    '[role="dialog"]:visible',
  ].join(', '));
  const count = await dialogs.count();
  expect(count, 'expected at least one visible dialog surface').toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    await expectElementWithinViewport(dialogs.nth(index), page);
  }
}

async function expectElementWithinViewport(locator: Locator, page: Page) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box, 'element should have a viewport box').not.toBeNull();
  expect(viewport, 'page should have a viewport').not.toBeNull();
  if (!box || !viewport) return;

  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}
