import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { KB_LESSON_SKIP_MARKER } from './kb-lesson-classifier.js';
import { parsePlaybook } from './playbook-parser.js';

describe('issue-proposal-refinement playbook', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'issue-proposal-refinement.md',
  );
  const content = readFileSync(playbookPath, 'utf8');
  const playbook = parsePlaybook(content, 'issue-proposal-refinement.md', '/');

  test('ships as a loopable GitHub workflow with bounded task lifecycle', () => {
    expect(playbook.name).toBe('Refine GitHub Issue Proposals');
    expect(playbook.repoTags).toEqual(['github']);
    expect(playbook.tags).toEqual(expect.arrayContaining(['workflow', 'loopable']));
    expect(playbook.dependencies).toEqual(['kb']);
    expect(playbook.deliveryPreAuthorized).toBe(false);
    expect(playbook.autoCloseOnSignal).toBe(true);
    expect(playbook.effectiveLoop?.iterationCap).toBe(20);
    expect(playbook.loop?.stopPredicate).toContain('.proposal-refinement-stop');
  });

  test('declares the complete safe launch form', () => {
    expect(playbook.parameters.map((parameter) => parameter.name)).toEqual([
      'repo',
      'issueSelector',
      'limit',
      'batchSize',
      'selfContinuation',
      'allowOtherAuthors',
      'closePolicy',
      'continuationEnvelope',
    ]);
    expect(playbook.parameters.find((parameter) => parameter.name === 'repo')).toMatchObject({
      source: 'tracked-projects',
      defaultFrom: 'git-remote',
    });
    expect(playbook.parameters.find((parameter) => parameter.name === 'limit')?.default).toBe('all');
    expect(playbook.parameters.find((parameter) => parameter.name === 'batchSize')?.default).toBe('1');
    expect(playbook.parameters.find((parameter) => parameter.name === 'selfContinuation')?.default).toBe('false');
    expect(playbook.parameters.find((parameter) => parameter.name === 'allowOtherAuthors')?.default).toBe('false');
    expect(playbook.parameters.find((parameter) => parameter.name === 'closePolicy')?.default).toBe('never');
  });

  test('documents standard, looped, and self-continuing launch modes', () => {
    expect(playbook.body).toContain('## Launch modes');
    expect(playbook.body).toMatch(/Standard.*one eligible issue/is);
    expect(playbook.body).toMatch(/Looped.*one issue per iteration/is);
    expect(playbook.body).toMatch(/batchSize: 1.*pure self-continuation chain/is);
  });

  test('validates selectors, total limit, batch size, policies, and continuation input before selection', () => {
    const validation = playbook.body.slice(
      playbook.body.indexOf('## Phase 0: Validate launch parameters'),
      playbook.body.indexOf('## Phase 1: Resolve candidates'),
    );
    expect(validation).toMatch(/all.*positive integer/i);
    expect(validation).toMatch(/batchSize.*1.*20/i);
    expect(validation).toContain('repo: state: is: archived: linked:');
    expect(validation).toContain('CONTINUATION_ENVELOPE_VERSION=1');
    expect(validation).toContain('processedCount');
    expect(validation).toContain('remainingBudget');
    expect(validation).toMatch(/fail closed/i);
  });

  test('checks state and author before reading an issue body', () => {
    const trust = playbook.body.indexOf('Author trust gate');
    const bodyRead = playbook.body.indexOf('Read the trusted body');
    expect(trust).toBeGreaterThan(0);
    expect(bodyRead).toBeGreaterThan(trust);
    expect(playbook.body).toContain('CURRENT_USER=$(gh api user -q .login)');
    expect(playbook.body).toContain('{{allowOtherAuthors}}');
    expect(playbook.body).toMatch(/Do not read.*body.*before.*author/is);
  });

  test('uses the repo-scoped issue claim API and releases only owned claims', () => {
    expect(playbook.body).toContain('/api/issue-claims?repo=$REPO&number=$TARGET');
    expect(playbook.body).toContain('-X POST "$KOOKR_API_BASE_URL/api/issue-claims"');
    expect(playbook.body).toContain('-X DELETE "$KOOKR_API_BASE_URL/api/issue-claims"');
    expect(playbook.body).toContain('CLAIMS_API_AVAILABLE');
    expect(playbook.body).toContain('CLAIM_OWNED');
    expect(playbook.body).toContain('claim_contended');
  });

  test('defines revision markers that make matching bodies ineligible and edited bodies eligible', () => {
    expect(playbook.body).toContain('<!-- kookr:issue-refinement:v1 body-sha256=<digest> disposition=<outcome> task=<task-id> -->');
    expect(playbook.body).toContain('createHash("sha256")');
    expect(playbook.body).toMatch(/exclude.*marker/i);
    expect(playbook.body).toMatch(/matching marker.*skip/is);
    expect(playbook.body).toMatch(/digest does not match.*eligible/is);
    expect(playbook.body).toMatch(/\*\*keep\*\* outcome still writes the marker/i);
  });

  test('offers only the four dispositions and gates close behind explicit policy', () => {
    const disposition = playbook.body.slice(
      playbook.body.indexOf('## Phase 4: Choose one disposition'),
      playbook.body.indexOf('## Phase 5: Compare and write'),
    );
    for (const value of ['keep', 'refine', 'close', 'blocked']) {
      expect(disposition).toContain(`**${value}**`);
    }
    expect(disposition).toContain('CLOSE_POLICY=allow-evidenced');
    expect(disposition).toMatch(/never.*close/i);
    expect(disposition).toMatch(/obsolete|duplicate|out of scope|net-negative/i);
  });

  test('re-fetches title and body immediately before mutation and rejects stale analysis', () => {
    const write = playbook.body.slice(
      playbook.body.indexOf('## Phase 5: Compare and write'),
      playbook.body.indexOf('## Phase 6: Release the claim'),
    );
    expect(write).toContain('ANALYZED_TITLE');
    expect(write).toContain('ANALYZED_BODY');
    expect(write).toContain('CURRENT_TITLE');
    expect(write).toContain('CURRENT_BODY');
    expect(write).toContain('body_changed_before_update');
    expect(write).toMatch(/refus.*overwrite/is);
  });

  test('records one progress verdict per disposition and stops at batch or total limits', () => {
    expect(playbook.body).toMatch(/one issue per Ralph iteration/i);
    expect(playbook.body).toContain('"verdict":"progress"');
    expect(playbook.body).toContain('"verdict":"stalled"');
    expect(playbook.body).toContain('"verdict":"complete"');
    expect(playbook.body).toContain('BATCH_COMPLETED_AFTER');
    expect(playbook.body).toContain('TOTAL_PROCESSED_AFTER');
    expect(playbook.body).toContain('$BATCH_CWD/.proposal-refinement-stop');
  });

  test('uses the Ralph retry cap and excludes engine-burned targets', () => {
    expect(playbook.body).toContain('{{ralph.burnedOutTargets}}');
    expect(playbook.body).toContain('BURNED_FILTER');
    expect(playbook.body).toMatch(/bounded consecutive-stall threshold/i);
    expect(playbook.body).toContain('attempt cap');
  });

  test('launches a linked, content-distinct successor with conserved budget', () => {
    const handoff = playbook.body.slice(playbook.body.indexOf('## Phase 8: Batch-boundary handoff'));
    expect(handoff).toContain('self-continuation-task');
    expect(handoff).toContain('continuation envelope v1');
    expect(handoff).toContain('processedCount');
    expect(handoff).toContain('remainingBudget');
    expect(handoff).toContain('sourceRevision');
    expect(handoff).toContain('parentTaskId');
    expect(handoff).toContain('/api/playbooks/ralph-loop');
    expect(handoff).toContain('issue-proposal-refinement.md');
    expect(handoff).toContain('"scope": "plugin"');
    expect(handoff).toContain('kookr signal completion-ready');
    expect(handoff).toContain('/api/tasks/${KOOKR_TASK_ID}/complete');
    expect(handoff).toMatch(/Do not spawn.*limit.*exhausted.*hard blocker/is);
  });

  test('reconciles the chain with an end-of-chain sweep instead of silent drift fixes', () => {
    expect(playbook.body).toContain('End-of-chain sweep');
    expect(playbook.body).toContain('stale-open-but-shipped');
    expect(playbook.body).toMatch(/do not silently "fix" the drift/i);
  });

  test('keeps target repository inspection read-only and creates no worktree', () => {
    expect(playbook.body).toMatch(/Do not create a git worktree/i);
    expect(playbook.body).toMatch(/Do not modify tracked files/i);
    expect(playbook.body).not.toContain('git worktree add');
    expect(playbook.checklist.some((item) => /worktree/i.test(item))).toBe(true);
  });

  test('requires a visible post-task lesson decision before completion', () => {
    expect(playbook.body).toContain('kb remember --kb=agent-task-lessons');
    expect(playbook.body).toContain(KB_LESSON_SKIP_MARKER);
    expect(playbook.body.indexOf(KB_LESSON_SKIP_MARKER)).toBeLessThan(
      playbook.body.indexOf('kookr signal completion-ready'),
    );
  });
});
