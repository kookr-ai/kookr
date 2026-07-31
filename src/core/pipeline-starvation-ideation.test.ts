import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from './tasks.js';
import {
  findRecentSuccessfulIdeationAtMs,
  isIdeaScoutInFlightForRepo,
} from './pipeline-starvation-ideation.js';

describe('pipeline-starvation ideation discovery (#1715)', () => {
  test('finds a recent DONE idea-scout run by state.md mtime', async () => {
    const base = await mkdtemp(join(tmpdir(), 'kookr-ideation-'));
    const runDir = join(base, 'run-1');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'state.md'), '# scout\n\n<promise>DONE</promise>\n', 'utf-8');

    const found = await findRecentSuccessfulIdeationAtMs('jeanibarz/lucy', {
      nowMs: Date.now(),
      ideaScoutStateDir: base,
    });
    expect(found).not.toBeNull();
    expect(found!).toBeGreaterThan(Date.now() - 60_000);
  });

  test('ignores runs without a DONE marker', async () => {
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
});
