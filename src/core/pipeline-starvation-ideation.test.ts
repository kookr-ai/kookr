import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from './tasks.js';
import {
  countEligibleIssueCreatedInRunDir,
  countTerminatedAtLaunchIdeaScoutsForRepo,
  findRecentSuccessfulIdeationAtMs,
  findRecentSuccessfulIdeationDetails,
  isIdeaScoutInFlightForRepo,
} from './pipeline-starvation-ideation.js';

describe('pipeline-starvation ideation discovery (#1715 / overnight-throughput PR1)', () => {
  test('DONE alone without issue-created is NOT successful ideation', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-'));
    const runDir = join(base, 'run-1');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'state.md'), '# scout\n\n<promise>DONE</promise>\n', 'utf-8');

    const found = await findRecentSuccessfulIdeationAtMs('jeanibarz/lucy', {
      nowMs: Date.now(),
      ideaScoutStateDir: base,
    });
    expect(found).toBeNull();
  });

  test('DONE + non-umbrella issue-created counts as successful ideation', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-'));
    const runDir = join(base, 'run-ok');
    await mkdir(join(runDir, 'recommendations', '01-leaf'), { recursive: true });
    await writeFile(join(runDir, 'state.md'), '# scout\n\nDONE\n', 'utf-8');
    await writeFile(
      join(runDir, 'recommendations', '01-leaf', 'issue-created.json'),
      JSON.stringify({ number: 99, title: 'feat: bound control-room feed caches' }),
      'utf-8',
    );

    const details = await findRecentSuccessfulIdeationDetails('jeanibarz/lucy', {
      nowMs: Date.now(),
      ideaScoutStateDir: base,
    });
    expect(details).not.toBeNull();
    expect(details!.issueCreatedCount).toBe(1);
    expect(details!.runKey).toBe('run-ok');
  });

  test('umbrella-only issue-created does NOT count as eligible ideation', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-'));
    const runDir = join(base, 'run-umb');
    await mkdir(join(runDir, 'recommendations', '01-umb'), { recursive: true });
    await writeFile(join(runDir, 'state.md'), '<promise>DONE</promise>\n', 'utf-8');
    await writeFile(
      join(runDir, 'recommendations', '01-umb', 'issue-created.json'),
      JSON.stringify({ number: 100, title: 'Umbrella: trustworthy gates' }),
      'utf-8',
    );

    const found = await findRecentSuccessfulIdeationAtMs('jeanibarz/lucy', {
      nowMs: Date.now(),
      ideaScoutStateDir: base,
    });
    expect(found).toBeNull();
    expect(await countEligibleIssueCreatedInRunDir(runDir)).toBe(0);
  });

  test('ignores runs without a DONE marker and without issue-created', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-'));
    const runDir = join(base, 'run-wip');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'state.md'), '# scout still running\n', 'utf-8');

    const found = await findRecentSuccessfulIdeationAtMs('jeanibarz/lucy', {
      nowMs: Date.now(),
      ideaScoutStateDir: base,
    });
    expect(found).toBeNull();
  });

  test('detects in-flight scout by playbookId + projectId', () => {
    const store = new TaskStore();
    store.createTask({
      prompt: 'scout',
      cwd: '/tmp',
      playbookId: 'repository-idea-scout.md',
      projectId: 'github.com/jeanibarz/lucy',
    });
    expect(isIdeaScoutInFlightForRepo('jeanibarz/lucy', store.listTasks())).toBe(true);
    expect(isIdeaScoutInFlightForRepo('kookr-ai/kookr', store.listTasks())).toBe(false);
  });

  test('counts idea-scouts that died at launch inside the window (#2744)', () => {
    const store = new TaskStore();
    const live = store.createTask({
      prompt: 'scout',
      cwd: '/tmp',
      playbookId: 'repository-idea-scout.md',
      projectId: 'github.com/jeanibarz/lucy',
    });
    const dead = store.createTask({
      prompt: 'scout',
      cwd: '/tmp',
      playbookId: 'repository-idea-scout.md',
      projectId: 'github.com/jeanibarz/lucy',
    });
    store.setDisposition(dead.id, {
      reason: 'launch_error',
      at: new Date().toISOString(),
      source: 'launch-service',
      detail: 'Grok authentication expired',
    });
    store.terminateTask(dead.id);
    const otherRepo = store.createTask({
      prompt: 'scout',
      cwd: '/tmp',
      playbookId: 'repository-idea-scout.md',
      projectId: 'github.com/kookr-ai/kookr',
    });
    store.setDisposition(otherRepo.id, {
      reason: 'launch_error',
      at: new Date().toISOString(),
      source: 'launch-service',
    });
    store.terminateTask(otherRepo.id);

    const sinceMs = live.createdAt.getTime() - 1;
    expect(countTerminatedAtLaunchIdeaScoutsForRepo('jeanibarz/lucy', store.listTasks(), sinceMs)).toBe(1);
    expect(countTerminatedAtLaunchIdeaScoutsForRepo('jeanibarz/lucy', store.listTasks(), Date.now() + 60_000)).toBe(0);
    expect(isIdeaScoutInFlightForRepo('jeanibarz/lucy', store.listTasks())).toBe(true);
  });
});
