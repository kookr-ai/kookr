import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildNotRecordedHint, wrapLessonRemember } from './kb-remember-spool-wrap.js';
import { readPendingLessons } from './lesson-write-spool.js';

async function fakeKb(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-fake-kb-'));
  const path = join(dir, 'kb');
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return path;
}

function collectStreams(): {
  stdout: NodeJS.WritableStream & { chunks: string[] };
  stderr: NodeJS.WritableStream & { chunks: string[] };
} {
  const make = () => {
    const chunks: string[] = [];
    return {
      chunks,
      write(chunk: string | Buffer) {
        chunks.push(String(chunk));
        return true;
      },
      end() {
        return this;
      },
    } as unknown as NodeJS.WritableStream & { chunks: string[] };
  };
  return { stdout: make(), stderr: make() };
}

describe('wrapLessonRemember', () => {
  test('pass-through success does not touch the spool and emits the recorded marker', async () => {
    const bin = await fakeKb(`#!/bin/sh\necho '{"action":"create","lesson":true,"write_performed":true}'\nexit 0\n`);
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-'));
    const streams = collectStreams();
    const result = await wrapLessonRemember({
      argv: ['remember', '--kb=agent-task-lessons', '--title=ok', '--stdin', '--yes'],
      stdinBody: '## Mistake\na\n## Why it happened\nb\n## Better next time\nc\n',
      realKbBin: bin,
      spoolDir,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(result.exitCode).toBe(0);
    expect(result.spooled).toBe(false);
    expect(await readPendingLessons(spoolDir)).toHaveLength(0);
    // The gate keys off this stdout marker, not the bare invocation (#1538).
    expect(streams.stdout.chunks.join('')).toContain('KOOKR_LESSON_WRITE: recorded');
  });

  test('exit-0 no-op (write_performed:false) is reported as not-recorded, not a write', async () => {
    // Defensive against a future kb that similarity-suppresses with a clean exit.
    const bin = await fakeKb(
      `#!/bin/sh\necho '{"action":"similarity-check","write_performed":false}'\nexit 0\n`,
    );
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-'));
    const streams = collectStreams();
    const result = await wrapLessonRemember({
      argv: ['remember', '--kb=agent-task-lessons', '--title=dup', '--stdin', '--yes'],
      stdinBody: '## Mistake\na\n## Why it happened\nb\n## Better next time\nc\n',
      realKbBin: bin,
      spoolDir,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(result.exitCode).toBe(0);
    expect(result.spooled).toBe(false);
    const out = streams.stdout.chunks.join('');
    expect(out).toContain('KOOKR_LESSON_WRITE: not-recorded');
    expect(out).not.toContain('KOOKR_LESSON_WRITE: recorded');
  });

  test('runtime failure spools the lesson and exits 0', async () => {
    const bin = await fakeKb(`#!/bin/sh\necho 'provider down' >&2\nexit 1\n`);
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-'));
    const streams = collectStreams();
    const body = '## Mistake\na\n## Why it happened\nb\n## Better next time\nc\n';
    const result = await wrapLessonRemember({
      argv: ['remember', '--kb=agent-task-lessons', '--title=spool-me', '--stdin', '--yes'],
      stdinBody: body,
      realKbBin: bin,
      spoolDir,
      taskId: 'task-xyz',
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(result.exitCode).toBe(0);
    expect(result.spooled).toBe(true);
    const pending = await readPendingLessons(spoolDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.title).toBe('spool-me');
    expect(pending[0]!.taskId).toBe('task-xyz');
    expect(streams.stderr.chunks.join('')).toMatch(/durable spool/);
    // Durably captured → confirmed to the gate just like a direct write (#1538).
    expect(streams.stdout.chunks.join('')).toContain('KOOKR_LESSON_WRITE: recorded');
  });

  test('argv validation failure (exit 2) is not spooled', async () => {
    const bin = await fakeKb(`#!/bin/sh\necho 'bad argv' >&2\nexit 2\n`);
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-'));
    const streams = collectStreams();
    const result = await wrapLessonRemember({
      argv: ['remember', '--kb=agent-task-lessons', '--title=bad', '--stdin', '--yes'],
      stdinBody: 'body\n',
      realKbBin: bin,
      spoolDir,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(result.exitCode).toBe(2);
    expect(result.spooled).toBe(false);
    expect(await readPendingLessons(spoolDir)).toHaveLength(0);
  });

  test('similarity refuse (exit 3) is not spooled', async () => {
    const bin = await fakeKb(`#!/bin/sh\necho 'similar' >&2\nexit 3\n`);
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-'));
    const streams = collectStreams();
    const result = await wrapLessonRemember({
      argv: ['remember', '--lesson', '--title=sim', '--stdin', '--yes'],
      stdinBody: '## Mistake\na\n## Why it happened\nb\n## Better next time\nc\n',
      realKbBin: bin,
      spoolDir,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    expect(result.exitCode).toBe(3);
    expect(result.spooled).toBe(false);
    expect(await readPendingLessons(spoolDir)).toHaveLength(0);
    // Nothing stored → the gate must not count it (#1538 loophole).
    const out = streams.stdout.chunks.join('');
    expect(out).toContain('KOOKR_LESSON_WRITE: not-recorded');
    expect(out).not.toContain('KOOKR_LESSON_WRITE: recorded');
  });

  test('non-lesson remember is not spooled even on failure', async () => {
    const bin = await fakeKb(`#!/bin/sh\necho fail >&2\nexit 1\n`);
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-'));
    const streams = collectStreams();
    const result = await wrapLessonRemember({
      argv: ['remember', '--kb=work', '--title=note', '--stdin', '--yes'],
      stdinBody: 'note body\n',
      realKbBin: bin,
      spoolDir,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    // wrapLessonRemember with non-lesson still runs; isLessonRememberArgv is false
    // so it pass-throughs without spool. Exit code preserved.
    expect(result.spooled).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(await readPendingLessons(spoolDir)).toHaveLength(0);
  });
});

describe('buildNotRecordedHint (issue #3695)', () => {
  // Trimmed copy of the real `kb remember` similarity-guard JSON envelope.
  const guardOutput = JSON.stringify({
    action: 'similarity-check',
    write_performed: false,
    candidates: [
      { knowledge_base: 'agent-task-lessons', relative_path: 'read-the-refusal.md', score: 0.4 },
      { knowledge_base: 'agent-task-lessons', relative_path: 'other.md', score: 0.7 },
    ],
  }, null, 2);

  test('similarity guard: names the closest existing lesson and gives a one-call skip', () => {
    const hint = buildNotRecordedHint(3, guardOutput);
    expect(hint).toContain('a similar lesson already exists: read-the-refusal.md');
    expect(hint).toContain(`printf 'No generic KB lesson: %s\\n' 'covered by read-the-refusal.md'`);
    expect(hint).toContain('--force only if your lesson is genuinely new');
    expect(hint).not.toContain('other.md');
  });

  test('similarity guard without parseable candidates still offers the skip', () => {
    const hint = buildNotRecordedHint(3, 'similar');
    expect(hint).toContain('see the candidates below');
    expect(hint).toContain("'covered by <path>'");
  });

  test('similarity guard in --format=md output: reads the "- Path:" line', () => {
    const hint = buildNotRecordedHint(3, '## Similar notes\n- KB: agent-task-lessons\n- Path: md-note.md\n- Score: 0.4\n');
    expect(hint).toContain("'covered by md-note.md'");
  });

  test('a quote in the candidate path cannot break the suggested printf', () => {
    const hint = buildNotRecordedHint(3, '"relative_path": "it\'s.md"');
    expect(hint).toContain("'covered by its.md'");
  });

  test('body passed as an argument: says the body goes on stdin', () => {
    const hint = buildNotRecordedHint(2, 'kb remember: unexpected argument: Mistake: did x');
    expect(hint).toMatch(/body on stdin, not as an argument/);
    expect(hint).toContain('--stdin --yes');
  });

  test('missing sections: names the three level-2 headings', () => {
    const hint = buildNotRecordedHint(2, 'kb remember --lesson: missing required sections: Mistake.');
    expect(hint).toContain('"## Mistake"');
    expect(hint).toContain('"## Better next time"');
  });

  test('other failures keep the generic advice', () => {
    expect(buildNotRecordedHint(2, 'kb remember: missing --kb=<name>')).toMatch(/re-run with --force/);
  });

  test('wrapLessonRemember prints the cause-specific hint for a guard refusal', async () => {
    const bin = await fakeKb(
      `#!/bin/sh\necho '{"action":"similarity-check","write_performed":false,"candidates":[{"relative_path":"dup.md"}]}'\nexit 3\n`,
    );
    const spoolDir = await mkdtemp(join(tmpdir(), 'kookr-spool-'));
    const streams = collectStreams();
    await wrapLessonRemember({
      argv: ['remember', '--lesson', '--title=sim', '--stdin', '--yes'],
      stdinBody: '## Mistake\n\na\n',
      realKbBin: bin,
      spoolDir,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    const out = streams.stdout.chunks.join('');
    expect(out.indexOf('KOOKR_LESSON_WRITE: not-recorded')).toBe(0);
    expect(out).toContain("'covered by dup.md'");
  });
});
