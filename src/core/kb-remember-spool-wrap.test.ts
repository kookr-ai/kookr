import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { wrapLessonRemember } from './kb-remember-spool-wrap.js';
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
  test('pass-through success does not touch the spool', async () => {
    const bin = await fakeKb(`#!/bin/sh\necho '{"action":"create"}'\nexit 0\n`);
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
