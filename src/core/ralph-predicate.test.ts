import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStopPredicate } from './ralph-predicate.js';

describe('runStopPredicate', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ralph-pred-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns satisfied=true when the command exits 0', async () => {
    const r = await runStopPredicate('exit 0', { cwd: dir, iteration: 1 });
    expect(r.satisfied).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.errored).toBe(false);
  });

  it('returns satisfied=false when the command exits non-zero', async () => {
    const r = await runStopPredicate('exit 7', { cwd: dir, iteration: 1 });
    expect(r.satisfied).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(r.timedOut).toBe(false);
  });

  it('exposes RALPH_ITERATION to the predicate', async () => {
    const out = join(dir, 'iter');
    await runStopPredicate(`printf '%s' "$RALPH_ITERATION" > ${out}`, { cwd: dir, iteration: 42 });
    const written = await readFile(out, 'utf-8');
    expect(written).toBe('42');
  });

  it('exposes RALPH_LAST_OUTPUT_FILE when provided', async () => {
    const sink = join(dir, 'sink');
    await runStopPredicate(`printf '%s' "$RALPH_LAST_OUTPUT_FILE" > ${sink}`, {
      cwd: dir,
      iteration: 1,
      lastOutputFile: '/tmp/some/path.jsonl',
    });
    const written = await readFile(sink, 'utf-8');
    expect(written).toBe('/tmp/some/path.jsonl');
  });

  it('does not set RALPH_LAST_OUTPUT_FILE when omitted', async () => {
    const sink = join(dir, 'sink');
    await runStopPredicate(
      `if [ -z "\${RALPH_LAST_OUTPUT_FILE+set}" ]; then printf '%s' unset > ${sink}; else printf '%s' set > ${sink}; fi`,
      { cwd: dir, iteration: 1 },
    );
    const written = await readFile(sink, 'utf-8');
    expect(written).toBe('unset');
  });

  it('runs the predicate inside the supplied cwd', async () => {
    await writeFile(join(dir, 'marker'), 'hello');
    const r = await runStopPredicate('test -f marker', { cwd: dir, iteration: 1 });
    expect(r.satisfied).toBe(true);
  });

  it('marks the result timedOut when the predicate exceeds the budget', async () => {
    const r = await runStopPredicate('sleep 5', {
      cwd: dir,
      iteration: 1,
      timeoutMs: 100,
    });
    expect(r.timedOut).toBe(true);
    expect(r.satisfied).toBe(false);
    expect(r.errored).toBe(false);
  });

  it('returns errored=true when spawn fails', async () => {
    const fakeSpawn = (() => {
      throw new Error('spawn ENOENT');
    }) as unknown as typeof import('node:child_process').spawn;
    const r = await runStopPredicate('exit 0', {
      cwd: dir,
      iteration: 1,
      spawn: fakeSpawn,
    });
    expect(r.errored).toBe(true);
    expect(r.satisfied).toBe(false);
    expect(r.errorMessage).toContain('ENOENT');
  });

  it('treats a signal-killed process as not satisfied even if exit code is 0', async () => {
    // SIGTERM-killed shell: exit code may be null on some platforms. The
    // contract is: satisfied requires exit 0 AND no signal AND no timeout.
    const r = await runStopPredicate('sleep 3', {
      cwd: dir,
      iteration: 1,
      timeoutMs: 50,
    });
    expect(r.satisfied).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it('grep-style predicate (the M1 example) works against a real file', async () => {
    const promptFile = join(dir, 'prompt.md');
    await writeFile(promptFile, 'work in progress\n<promise>DONE</promise>\n');
    const r = await runStopPredicate('grep -q "<promise>DONE</promise>" prompt.md', {
      cwd: dir,
      iteration: 1,
    });
    expect(r.satisfied).toBe(true);

    await writeFile(promptFile, 'still working\n');
    const r2 = await runStopPredicate('grep -q "<promise>DONE</promise>" prompt.md', {
      cwd: dir,
      iteration: 2,
    });
    expect(r2.satisfied).toBe(false);
    expect(r2.exitCode).toBe(1);
  });
});
