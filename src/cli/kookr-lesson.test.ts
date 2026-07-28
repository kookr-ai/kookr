import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { runLessonCli } from './kookr-lesson.js';
import { appendLessonWrite, buildLessonEntry, readPendingLessons } from '../core/lesson-write-spool.js';

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    out: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
    err: { error: (...a: unknown[]) => errors.push(a.map(String).join(' ')) },
  };
}

describe('kookr lesson CLI', () => {
  test('status reports empty spool', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kookr-lesson-cli-'));
    const spoolDir = join(home, 'spool');
    const io = captureIo();
    const code = await runLessonCli(['status', '--dir', spoolDir, '--json'], {
      env: { HOME: home },
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs.join('\n'));
    expect(payload.pendingCount).toBe(0);
  });

  test('drain --dry-run lists pending without writing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kookr-lesson-cli-'));
    const spoolDir = join(home, 'spool');
    await appendLessonWrite(spoolDir, buildLessonEntry({ title: 'pending-one', body: 'x\n' }));
    const io = captureIo();
    const code = await runLessonCli(['drain', '--dir', spoolDir, '--dry-run', '--json'], {
      env: { HOME: home },
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs.join('\n'));
    expect(payload.pendingCount).toBe(1);
    expect(payload.titles).toEqual(['pending-one']);
    expect(await readPendingLessons(spoolDir)).toHaveLength(1);
  });

  test('remember spools when kb binary is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kookr-lesson-cli-'));
    const spoolDir = join(home, 'spool');
    const io = captureIo();
    const body = '## Mistake\na\n## Why it happened\nb\n## Better next time\nc\n';
    const code = await runLessonCli(
      ['remember', '--title=cli-spool', `--dir=${spoolDir}`, '--stdin', '--yes', '--json'],
      {
        env: { HOME: home, PATH: '/nonexistent-bin-dir', KOOKR_TASK_ID: 't1' },
        out: io.out,
        err: io.err,
        stdin: Readable.from([body]),
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs.join('\n'));
    expect(payload.spooled).toBe(true);
    const pending = await readPendingLessons(spoolDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.title).toBe('cli-spool');
    expect(pending[0]!.taskId).toBe('t1');
  });

  test('remember succeeds when a working kb is on PATH', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kookr-lesson-cli-'));
    const spoolDir = join(home, 'spool');
    const binDir = await mkdtemp(join(tmpdir(), 'kookr-fake-kb-bin-'));
    const kbPath = join(binDir, 'kb');
    await writeFile(kbPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(kbPath, 0o755);

    const io = captureIo();
    const body = '## Mistake\na\n## Why it happened\nb\n## Better next time\nc\n';
    const code = await runLessonCli(
      ['remember', '--title=ok-write', `--dir=${spoolDir}`, '--stdin', '--yes', '--json'],
      {
        env: { HOME: home, PATH: binDir },
        out: io.out,
        err: io.err,
        stdin: Readable.from([body]),
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs.join('\n'));
    expect(payload.ok).toBe(true);
    expect(payload.spooled).toBe(false);
    expect(await readPendingLessons(spoolDir)).toHaveLength(0);
  });
});
