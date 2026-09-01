import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  appendLessonWrite,
  applyDegradationProbe,
  buildLessonEntry,
  contentHashFor,
  deadLetterPath,
  DEFAULT_DEGRADED_ALERT_THRESHOLD_MS,
  drainLessonSpool,
  emptySpoolState,
  extractRememberKb,
  extractRememberTitle,
  isLessonRememberArgv,
  MAX_LESSON_DRAIN_ATTEMPTS,
  pendingPath,
  readPendingLessons,
  readSpoolState,
  writeSpoolState,
} from './lesson-write-spool.js';

const dirs: string[] = [];

afterEach(async () => {
  // temp dirs are under os.tmpdir; leave cleanup to OS. Track for sanity.
  dirs.length = 0;
});

async function tempSpoolDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-lesson-spool-'));
  dirs.push(dir);
  return dir;
}

describe('contentHashFor', () => {
  test('is stable for equivalent body whitespace', () => {
    const a = contentHashFor('agent-task-lessons', 'title', 'body\n');
    const b = contentHashFor('agent-task-lessons', 'title', 'body\n\n');
    const c = contentHashFor('agent-task-lessons', 'title', 'body  \n');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test('changes when title or kb differs', () => {
    const base = contentHashFor('agent-task-lessons', 'a', 'body\n');
    expect(contentHashFor('agent-task-lessons', 'b', 'body\n')).not.toBe(base);
    expect(contentHashFor('other', 'a', 'body\n')).not.toBe(base);
  });
});

describe('appendLessonWrite + drainLessonSpool', () => {
  test('spools a lesson durably and survives re-read', async () => {
    const spoolDir = await tempSpoolDir();
    const entry = buildLessonEntry({
      title: 'do not drop lessons',
      body: '## Mistake\nx\n## Why it happened\ny\n## Better next time\nz\n',
      taskId: 'task-1',
    });
    const result = await appendLessonWrite(spoolDir, entry);
    expect(result.appended).toBe(true);
    expect(result.reason).toBe('appended');

    const pending = await readPendingLessons(spoolDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.contentHash).toBe(entry.contentHash);
    expect(pending[0]!.title).toBe('do not drop lessons');
    expect(pending[0]!.taskId).toBe('task-1');

    // File survives as JSONL
    const raw = await readFile(pendingPath(spoolDir), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
  });

  test('duplicate content hash is a no-op append', async () => {
    const spoolDir = await tempSpoolDir();
    const entry = buildLessonEntry({ title: 'same', body: 'body\n' });
    await appendLessonWrite(spoolDir, entry);
    const second = await appendLessonWrite(spoolDir, {
      ...entry,
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(second.appended).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(await readPendingLessons(spoolDir)).toHaveLength(1);
  });

  test('drain writes successfully and empties the spool (idempotent re-drain)', async () => {
    const spoolDir = await tempSpoolDir();
    const e1 = buildLessonEntry({ title: 'one', body: 'body one\n' });
    const e2 = buildLessonEntry({ title: 'two', body: 'body two\n' });
    await appendLessonWrite(spoolDir, e1);
    await appendLessonWrite(spoolDir, e2);

    const written: string[] = [];
    const first = await drainLessonSpool({
      spoolDir,
      write: async (entry) => {
        written.push(entry.title);
        return { ok: true };
      },
    });
    expect(first.written).toBe(2);
    expect(first.remaining).toBe(0);
    expect(written).toEqual(['one', 'two']);
    expect(await readPendingLessons(spoolDir)).toHaveLength(0);

    const second = await drainLessonSpool({
      spoolDir,
      write: async () => {
        throw new Error('should not be called on empty spool');
      },
    });
    expect(second.attempted).toBe(0);
    expect(second.written).toBe(0);
    expect(second.remaining).toBe(0);
  });

  test('TS-LESSON-004: keeps a transient failure and removes it after a successful retry', async () => {
    const spoolDir = await tempSpoolDir();
    await appendLessonWrite(spoolDir, buildLessonEntry({ title: 'ok', body: 'a\n' }));
    await appendLessonWrite(spoolDir, buildLessonEntry({ title: 'fail', body: 'b\n' }));

    let failOnce = true;
    const first = await drainLessonSpool({
      spoolDir,
      write: async (entry) => {
        if (entry.title === 'fail' && failOnce) {
          failOnce = false;
          return { ok: false, error: 'provider down' };
        }
        return { ok: true };
      },
    });
    expect(first.written).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.deadLettered).toBe(0);
    expect(first.remaining).toBe(1);

    const remaining = await readPendingLessons(spoolDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.title).toBe('fail');
    expect(remaining[0]!.lastError).toBe('provider down');
    expect(remaining[0]!.attempts).toBe(1);

    const second = await drainLessonSpool({
      spoolDir,
      write: async () => ({ ok: true }),
    });
    expect(second.written).toBe(1);
    expect(second.deadLettered).toBe(0);
    expect(second.remaining).toBe(0);
  });

  test('TS-LESSON-004: reserves an attempt before invoking the provider', async () => {
    const spoolDir = await tempSpoolDir();
    await appendLessonWrite(
      spoolDir,
      buildLessonEntry({ title: 'ambiguous-call', body: 'reserve first\n' }),
    );

    await expect(drainLessonSpool({
      spoolDir,
      write: async () => {
        expect((await readPendingLessons(spoolDir))[0]!.attempts).toBe(1);
        throw new Error('process stopped while provider outcome was unknown');
      },
    })).rejects.toThrow('provider outcome was unknown');

    expect((await readPendingLessons(spoolDir))[0]!.attempts).toBe(1);
    const recovered = await drainLessonSpool({
      spoolDir,
      write: async () => ({ ok: true }),
    });
    expect(recovered).toMatchObject({ written: 1, remaining: 0 });
  });

  test('TS-LESSON-004: quarantines an ambiguous fifth attempt without a sixth call', async () => {
    const spoolDir = await tempSpoolDir();
    await appendLessonWrite(
      spoolDir,
      {
        ...buildLessonEntry({ title: 'ambiguous-fifth', body: 'do not call six times\n' }),
        attempts: MAX_LESSON_DRAIN_ATTEMPTS - 1,
      },
    );

    await expect(drainLessonSpool({
      spoolDir,
      write: async () => {
        expect((await readPendingLessons(spoolDir))[0]!.attempts)
          .toBe(MAX_LESSON_DRAIN_ATTEMPTS);
        throw new Error('fifth outcome was unknown');
      },
    })).rejects.toThrow('fifth outcome was unknown');

    const unexpectedWrite = vi.fn(async () => ({ ok: true }));
    const recovered = await drainLessonSpool({ spoolDir, write: unexpectedWrite });
    expect(unexpectedWrite).not.toHaveBeenCalled();
    expect(recovered).toMatchObject({ deadLettered: 1, remaining: 0 });
    expect((await readFile(deadLetterPath(spoolDir), 'utf8')).trim().split('\n'))
      .toHaveLength(1);
  });

  test('TS-LESSON-004: moves a permanently failing entry to the dead-letter file at the attempt cap', async () => {
    const spoolDir = await tempSpoolDir();
    const poison = buildLessonEntry({ title: 'poison', body: 'always rejected\n' });
    await appendLessonWrite(spoolDir, poison);

    for (let attempt = 1; attempt <= MAX_LESSON_DRAIN_ATTEMPTS; attempt += 1) {
      const result = await drainLessonSpool({
        spoolDir,
        write: async () => ({ ok: false, error: `rejected attempt ${attempt}` }),
      });
      expect(result.deadLettered).toBe(attempt === MAX_LESSON_DRAIN_ATTEMPTS ? 1 : 0);
      expect(result.remaining).toBe(attempt === MAX_LESSON_DRAIN_ATTEMPTS ? 0 : 1);
    }

    expect(await readPendingLessons(spoolDir)).toHaveLength(0);
    const deadLetters = (await readFile(deadLetterPath(spoolDir), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { contentHash: string; attempts: number; lastError: string });
    expect(deadLetters).toEqual([
      expect.objectContaining({
        contentHash: poison.contentHash,
        attempts: MAX_LESSON_DRAIN_ATTEMPTS,
        lastError: `rejected attempt ${MAX_LESSON_DRAIN_ATTEMPTS}`,
      }),
    ]);
  });

  test('TS-LESSON-004: reconciles an already dead-lettered active entry without another write attempt', async () => {
    const spoolDir = await tempSpoolDir();
    const poison = {
      ...buildLessonEntry({ title: 'crash-window', body: 'already quarantined\n' }),
      attempts: MAX_LESSON_DRAIN_ATTEMPTS - 1,
    };
    await appendLessonWrite(spoolDir, poison);
    await writeFile(
      deadLetterPath(spoolDir),
      `${JSON.stringify({
        ...poison,
        attempts: MAX_LESSON_DRAIN_ATTEMPTS,
        lastError: 'fifth failure',
      })}\n`,
      'utf8',
    );
    const write = vi.fn(async () => ({ ok: false, error: 'must not run' }));

    const result = await drainLessonSpool({ spoolDir, write });

    expect(write).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 0, deadLettered: 1, remaining: 0 });
    expect(await readPendingLessons(spoolDir)).toHaveLength(0);
    const deadLetterLines = (await readFile(deadLetterPath(spoolDir), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(deadLetterLines).toHaveLength(1);
  });

  test('TS-LESSON-004: appends a valid dead letter after a torn JSONL tail', async () => {
    const spoolDir = await tempSpoolDir();
    const poison = {
      ...buildLessonEntry({ title: 'torn-tail', body: 'preserve a record boundary\n' }),
      attempts: MAX_LESSON_DRAIN_ATTEMPTS - 1,
    };
    await appendLessonWrite(spoolDir, poison);
    await writeFile(deadLetterPath(spoolDir), '{"schemaVersion":"lesson-write', 'utf8');

    const result = await drainLessonSpool({
      spoolDir,
      write: async () => ({ ok: false, error: 'fifth failure' }),
    });

    expect(result).toMatchObject({ deadLettered: 1, remaining: 0 });
    const lines = (await readFile(deadLetterPath(spoolDir), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0]!)).toThrow();
    expect(JSON.parse(lines[1]!) as { contentHash: string }).toMatchObject({
      contentHash: poison.contentHash,
    });
  });

  test('TS-LESSON-004: dead-lettering bounds the active spool size for multiple poison entries', async () => {
    const spoolDir = await tempSpoolDir();
    for (const title of ['poison-one', 'poison-two', 'poison-three']) {
      await appendLessonWrite(spoolDir, buildLessonEntry({ title, body: `${title}\n` }));
    }

    for (let attempt = 1; attempt <= MAX_LESSON_DRAIN_ATTEMPTS; attempt += 1) {
      await drainLessonSpool({
        spoolDir,
        write: async () => ({ ok: false, error: 'permanent rejection' }),
      });
    }

    expect(await readPendingLessons(spoolDir)).toHaveLength(0);
    expect(await readFile(pendingPath(spoolDir), 'utf8')).toBe('');
    const deadLetterLines = (await readFile(deadLetterPath(spoolDir), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(deadLetterLines).toHaveLength(3);

    const afterQuarantine = await drainLessonSpool({
      spoolDir,
      write: async () => {
        throw new Error('quarantined entries must not be retried');
      },
    });
    expect(afterQuarantine.attempted).toBe(0);
    expect(afterQuarantine.remaining).toBe(0);
  });

  test('TS-LESSON-004: serializes concurrent drains and preserves lessons appended during a write', async () => {
    const spoolDir = await tempSpoolDir();
    await appendLessonWrite(
      spoolDir,
      buildLessonEntry({ title: 'in-flight', body: 'being drained\n' }),
    );
    let signalStarted: (() => void) | undefined;
    let releaseWrite: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const firstDrain = drainLessonSpool({
      spoolDir,
      write: async () => {
        signalStarted?.();
        await held;
        return { ok: true };
      },
    });
    await started;

    const competingWrite = vi.fn(async () => ({ ok: true }));
    const competingDrain = await drainLessonSpool({ spoolDir, write: competingWrite });
    expect(competingWrite).not.toHaveBeenCalled();
    expect(competingDrain).toMatchObject({ attempted: 0, remaining: 1 });

    await appendLessonWrite(
      spoolDir,
      buildLessonEntry({ title: 'arrived-later', body: 'must survive rewrite\n' }),
    );
    releaseWrite?.();
    expect(await firstDrain).toMatchObject({ written: 1, remaining: 1 });
    expect((await readPendingLessons(spoolDir)).map((entry) => entry.title))
      .toEqual(['arrived-later']);
  });

  test('TS-LESSON-004: excludes a live foreign drainer and reclaims its lock after exit', async () => {
    const spoolDir = await tempSpoolDir();
    await appendLessonWrite(
      spoolDir,
      {
        ...buildLessonEntry({ title: 'foreign-holder', body: 'shared spool\n' }),
        attempts: MAX_LESSON_DRAIN_ATTEMPTS - 1,
      },
    );
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      stdio: 'ignore',
    });
    await once(holder, 'spawn');
    const drainLock = join(spoolDir, 'drain.lock');
    const write = vi.fn(async () => ({ ok: false, error: 'permanent rejection' }));
    const previousProbeEnv = {
      lang: process.env.LANG,
      lcAll: process.env.LC_ALL,
      tz: process.env.TZ,
    };
    try {
      if (holder.pid == null) throw new Error('child lock holder did not expose a pid');
      await mkdir(drainLock);
      await symlink(
        JSON.stringify({ pid: holder.pid, generation: await lockGenerationForTest(holder.pid) }),
        join(drainLock, 'foreign.claim'),
      );
      process.env.LANG = 'fr_FR.UTF-8';
      process.env.LC_ALL = 'fr_FR.UTF-8';
      process.env.TZ = 'Pacific/Honolulu';
      const busy = await drainLessonSpool({ spoolDir, write });
      expect(busy).toMatchObject({ attempted: 0, remaining: 1 });
      expect(write).not.toHaveBeenCalled();
    } finally {
      restoreEnv('LANG', previousProbeEnv.lang);
      restoreEnv('LC_ALL', previousProbeEnv.lcAll);
      restoreEnv('TZ', previousProbeEnv.tz);
      if (holder.exitCode == null) {
        const exited = once(holder, 'exit');
        holder.kill();
        await exited;
      }
    }

    const reclaimed = await drainLessonSpool({ spoolDir, write });
    expect(write).toHaveBeenCalledOnce();
    expect(reclaimed).toMatchObject({ failed: 1, deadLettered: 1, remaining: 0 });
  });

  test('TS-LESSON-004: reclaims a stale claim when its PID has been reused', async () => {
    const spoolDir = await tempSpoolDir();
    await appendLessonWrite(
      spoolDir,
      buildLessonEntry({ title: 'reused-pid', body: 'stale generation must be reclaimed\n' }),
    );
    const drainLock = join(spoolDir, 'drain.lock');
    await mkdir(drainLock);
    const staleClaim = join(drainLock, 'stale-reused-pid.claim');
    await symlink(
      JSON.stringify({ pid: process.pid, generation: 'previous-process-generation' }),
      staleClaim,
    );
    const write = vi.fn(async () => ({ ok: true }));

    const result = await drainLessonSpool({ spoolDir, write });

    expect(write).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ written: 1, remaining: 0 });
  });
});

async function lockGenerationForTest(pid: number): Promise<string> {
  if (process.platform === 'linux') {
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(') ');
    const startTime = stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
    if (commandEnd < 0 || !startTime || !/^\d+$/.test(startTime)) {
      throw new Error(`could not identify test lock holder ${pid}`);
    }
    return `linux:${bootId}:${startTime}`;
  }
  const startedAt = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 4_096,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
  }).trim().replace(/\s+/g, ' ');
  if (!startedAt) throw new Error(`could not identify test lock holder ${pid}`);
  return `${process.platform}:${startedAt}`;
}

function restoreEnv(name: 'LANG' | 'LC_ALL' | 'TZ', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('applyDegradationProbe', () => {
  const threshold = DEFAULT_DEGRADED_ALERT_THRESHOLD_MS;

  test('records degraded-since on first degraded probe', () => {
    const now = new Date('2026-07-23T12:00:00.000Z');
    const tick = applyDegradationProbe({
      previous: emptySpoolState(),
      status: 'degraded',
      now,
      thresholdMs: threshold,
    });
    expect(tick.state.kbDegradedSince).toBe(now.toISOString());
    expect(tick.shouldFireAlert).toBe(false);
    expect(tick.shouldDrain).toBe(false);
    expect(tick.degradedForMs).toBe(0);
  });

  test('fires alert once when degraded past threshold', () => {
    const start = new Date('2026-07-23T10:00:00.000Z');
    const later = new Date(start.getTime() + threshold + 1);
    const first = applyDegradationProbe({
      previous: emptySpoolState(),
      status: 'degraded',
      now: start,
      thresholdMs: threshold,
    });
    const second = applyDegradationProbe({
      previous: first.state,
      status: 'degraded',
      now: later,
      thresholdMs: threshold,
    });
    expect(second.shouldFireAlert).toBe(true);
    expect(second.state.alertFiredAt).toBe(later.toISOString());
    expect(second.degradedForMs).toBeGreaterThanOrEqual(threshold);

    // Third tick in the same streak must not re-fire.
    const third = applyDegradationProbe({
      previous: second.state,
      status: 'degraded',
      now: new Date(later.getTime() + 60_000),
      thresholdMs: threshold,
    });
    expect(third.shouldFireAlert).toBe(false);
    expect(third.state.alertFiredAt).toBe(later.toISOString());
  });

  test('healthy probe clears streak and requests drain', () => {
    const start = new Date('2026-07-23T10:00:00.000Z');
    const degraded = applyDegradationProbe({
      previous: emptySpoolState(),
      status: 'degraded',
      now: start,
      thresholdMs: threshold,
    });
    const healthy = applyDegradationProbe({
      previous: { ...degraded.state, lastPendingCount: 2 },
      status: 'healthy',
      now: new Date('2026-07-23T13:00:00.000Z'),
      thresholdMs: threshold,
    });
    expect(healthy.state.kbDegradedSince).toBeNull();
    expect(healthy.state.alertFiredAt).toBeNull();
    expect(healthy.state.lastProbeStatus).toBe('healthy');
    expect(healthy.shouldDrain).toBe(true);
    expect(healthy.shouldFireAlert).toBe(false);
  });
});

describe('spool state persistence', () => {
  test('round-trips state.json', async () => {
    const spoolDir = await tempSpoolDir();
    const state = {
      ...emptySpoolState(),
      kbDegradedSince: '2026-07-22T10:08:00.000Z',
      lastProbeStatus: 'degraded' as const,
      lastProbeAt: '2026-07-23T10:00:00.000Z',
    };
    await writeSpoolState(spoolDir, state);
    const loaded = await readSpoolState(spoolDir);
    expect(loaded).toEqual(state);
  });

  test('state overwrite round-trips cleanly (durable rewrite path)', async () => {
    const spoolDir = await tempSpoolDir();
    const first = {
      ...emptySpoolState(),
      kbDegradedSince: '2026-07-22T10:08:00.000Z',
      lastProbeStatus: 'degraded' as const,
      lastProbeAt: '2026-07-23T10:00:00.000Z',
      lastPendingCount: 2,
    };
    await writeSpoolState(spoolDir, first);
    expect(await readSpoolState(spoolDir)).toEqual(first);

    const second = {
      ...emptySpoolState(),
      lastProbeStatus: 'healthy' as const,
      lastProbeAt: '2026-07-23T12:00:00.000Z',
      lastPendingCount: 0,
    };
    await writeSpoolState(spoolDir, second);
    expect(await readSpoolState(spoolDir)).toEqual(second);
  });

  test('missing state file returns empty state', async () => {
    const spoolDir = await tempSpoolDir();
    expect(await readSpoolState(spoolDir)).toEqual(emptySpoolState());
  });

  test('corrupt state file fails open to empty', async () => {
    const spoolDir = await tempSpoolDir();
    await writeFile(join(spoolDir, 'state.json'), 'not-json{', 'utf8');
    expect(await readSpoolState(spoolDir)).toEqual(emptySpoolState());
  });
});

describe('rewritePending durability (via drain)', () => {
  test('partial drain rewrites remaining entries so they re-read intact', async () => {
    const spoolDir = await tempSpoolDir();
    const keep = buildLessonEntry({ title: 'keep-me', body: 'survives rewrite\n' });
    const drop = buildLessonEntry({ title: 'drop-me', body: 'drained away\n' });
    await appendLessonWrite(spoolDir, keep);
    await appendLessonWrite(spoolDir, drop);

    await drainLessonSpool({
      spoolDir,
      write: async (entry) => {
        if (entry.title === 'drop-me') return { ok: true };
        return { ok: false, error: 'still degraded' };
      },
    });

    const remaining = await readPendingLessons(spoolDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.title).toBe('keep-me');
    expect(remaining[0]!.body).toBe(keep.body);
    expect(remaining[0]!.lastError).toBe('still degraded');

    // On-disk JSONL is a single rewritten line (not append-only residue of both).
    const raw = await readFile(pendingPath(spoolDir), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).title).toBe('keep-me');
  });
});

describe('remember argv helpers', () => {
  test('detects lesson remember via --lesson and --kb', () => {
    expect(isLessonRememberArgv(['remember', '--lesson', '--title=x'])).toBe(true);
    expect(isLessonRememberArgv(['remember', '--kb=agent-task-lessons', '--title=x'])).toBe(true);
    expect(isLessonRememberArgv(['remember', '--kb', 'agent-task-lessons', '--title=x'])).toBe(true);
    expect(isLessonRememberArgv(['remember', '--kb=work', '--title=x'])).toBe(false);
    expect(isLessonRememberArgv(['search', 'foo'])).toBe(false);
    expect(isLessonRememberArgv(['doctor'])).toBe(false);
  });

  test('extracts title and kb', () => {
    expect(extractRememberTitle(['remember', '--title=hello world', '--stdin'])).toBe('hello world');
    expect(extractRememberTitle(['remember', '--title', 'hello', '--stdin'])).toBe('hello');
    expect(extractRememberKb(['remember', '--lesson'])).toBe('agent-task-lessons');
    expect(extractRememberKb(['remember', '--kb=work'])).toBe('work');
  });
});
