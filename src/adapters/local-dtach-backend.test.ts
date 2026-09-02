/**
 * Tests for LocalDtachBackend.
 *
 * These are integration tests — they exercise a real dtach binary. If
 * dtach is not on PATH and vendor/dtach/dtach is missing, tests are
 * skipped with a message. Running the full suite locally requires
 * `scripts/build-dtach.sh` first.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LocalDtachBackend, buildDtachSpawn } from './local-dtach-backend.js';
import { findDtachMasterPidSync, verifyMasterIdentity } from './local-dtach-process-identity.js';
import { type BackendError, SessionGoneError, WriteTimeoutError } from './terminal-backend.js';
import { reapDtachReferencing } from '../test-utils/reap-dtach.js';

describe('buildDtachSpawn', () => {
  const dtach = '/vendor/dtach/dtach';
  const dtachArgs = ['-n', '/tmp/s.sock', '-r', 'winch', '-E', 'claude'];

  it('wraps the dtach master in `setsid -f` on Linux so it detaches from Kookr', () => {
    const { command, args } = buildDtachSpawn('linux', dtach, dtachArgs);
    expect(command).toBe('setsid');
    expect(args).toEqual(['-f', dtach, ...dtachArgs]);
  });

  it('spawns dtach directly on macOS, where setsid is absent', () => {
    // dtach -n already daemonizes and the caller (createSession) passes
    // detached:true (setsid(2) semantics), so no external `setsid` binary is
    // needed. NOTE: the createSession wiring that forwards this argv into
    // spawnChild(..., { detached: true }) is exercised end-to-end only by the
    // integration tests below, which run on Linux CI — the macOS spawn branch
    // itself is verified here at the argv level.
    const { command, args } = buildDtachSpawn('darwin', dtach, dtachArgs);
    expect(command).toBe(dtach);
    expect(args).toEqual(dtachArgs);
    expect(args).not.toContain('-f');
  });

  it('uses setsid on non-darwin platforms (darwin is the only exception)', () => {
    // The backend's contract: every platform except darwin gets `setsid -f`.
    // Lock that in so a future `=== 'linux'` narrowing doesn't silently drop
    // the wrapper on other setsid-bearing platforms.
    const { command } = buildDtachSpawn('freebsd', dtach, dtachArgs);
    expect(command).toBe('setsid');
  });
});

function resolveDtachBinary(): string | null {
  // Prefer the vendored copy if present, otherwise fall back to PATH.
  const vendored = join(process.cwd(), 'vendor', 'dtach', 'dtach');
  if (existsSync(vendored)) return vendored;
  try {
    execFileSync('dtach', ['--help'], { stdio: 'pipe' });
    return 'dtach';
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll a pid file written by a spawned agent until it holds a valid pid. */
async function waitForPidFile(pidFile: string, timeoutMs = 3_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const parsed = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return -1;
}

async function waitForFileContents(filePath: string, expected: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath) && readFileSync(filePath, 'utf8') === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`file did not contain expected contents within ${timeoutMs}ms: ${filePath}`);
}

/**
 * Poll until a freshly created dtach master is identity-verifiable.
 *
 * `createSession` resolves the master pid by scanning `/proc` for the process
 * that references the socket; under load the `setsid -f` fork can leave that
 * scan momentarily empty, so the manifest entry is written with `pid: -1` and
 * the master only becomes `/proc`-verifiable a few milliseconds later. A
 * reconnect/recovery call issued inside that window re-scans and can transiently
 * miss the master, yielding `identity-unverified` instead of the outcome the
 * test is actually exercising. That timing race is the root cause of the
 * ~1/run flake in the concurrent reconnect/recovery cases (kookr-ai/kookr#1627);
 * waiting on the real identity gate makes those assertions deterministic
 * without mocking the behaviour under test. Throws on timeout so a genuinely
 * unverifiable master fails loudly rather than masking a regression.
 *
 * This mirrors the exact gate the production reconnect/recovery paths apply
 * (`LocalDtachRecovery`: `pid <= 0 → findDtachMasterPidSync`, then
 * `verifyMasterIdentity`), so polling it converges precisely when — and only
 * when — those paths would stop returning `identity-unverified`.
 */
async function waitForMasterIdentity(
  socketDir: string,
  id: string,
  timeoutMs = 3_000,
): Promise<void> {
  const manifestPath = join(socketDir, 'test', 'manifest.json');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        entries: Array<{ sessionId: string; pid: number; sock: string }>;
      };
      const entry = manifest.entries.find((e) => e.sessionId === id);
      if (entry) {
        let pid = entry.pid;
        if (pid <= 0) pid = findDtachMasterPidSync(entry.sock, DTACH!);
        if (verifyMasterIdentity(pid, entry.sock, DTACH!)) return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`master identity for session ${id} not verifiable within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** All processes whose cmdline references `sock`, with their argv tokens. */
function procsReferencingSock(sock: string): Array<{ pid: number; tokens: string[] }> {
  const out: Array<{ pid: number; tokens: string[] }> = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf-8');
      if (cmdline.includes(sock)) out.push({ pid: Number(name), tokens: cmdline.split('\0') });
    } catch {
      // process exited between readdir and read — skip
    }
  }
  return out;
}

const DTACH = resolveDtachBinary();
const skipIfNoDtach = DTACH ? it : it.skip;
const HAS_PROC = existsSync('/proc/self');
// Tests that exercise the /proc-based pid resolution need both dtach and /proc.
const skipIfNoProc = DTACH && HAS_PROC ? it : it.skip;
const skipIfNoSetsidWrapper = process.platform === 'darwin' ? it.skip : it;

// Real-subprocess observation windows for the "expected live" recovery tests
// (kookr-ai/kookr#1915). These tests spawn a REAL `dtach -a` child and assert
// that a genuinely-emitting session is observed live within a fixed window. A
// live agent here ticks ~every 50ms, so the window only has to outlast the fresh
// attach's first-byte latency — which balloons under full-suite CPU contention
// (many vitest workers spawning dtach at once, esp. on WSL2), racing the old
// sub-second windows into a false `recovered-unverified`.
//
// The grace window is a CEILING, not a fixed cost: observeRecoveryProgress
// resolves on the first post-settle byte, so a generous grace adds no wall-clock
// on a healthy session while removing the race. Widening it does NOT weaken the
// behavioral distinction the tests assert — a genuinely wedged/silent session
// still never emits a byte, so it still classifies unverified regardless of how
// long we wait (covered by the silent-`cat` and spawn-failure cases, whose short
// windows are intentionally left untouched). KOOKR_TEST_TIMING_SCALE (>= 1) lets
// an exceptionally slow CI host widen further without code changes.
const TIMING_SCALE = Math.max(1, Number(process.env.KOOKR_TEST_TIMING_SCALE) || 1);
/** Settle window: discount the one-shot on-attach redraw before counting progress. */
const LIVE_SETTLE_MS = Math.round(100 * TIMING_SCALE);
/** Grace ceiling: outlast fresh-attach first-byte latency under load. */
const LIVE_GRACE_MS = Math.round(5_000 * TIMING_SCALE);

describe('LocalDtachBackend', () => {
  let tmpDir: string;
  let backend: LocalDtachBackend;

  beforeAll(() => {
    if (!DTACH) {
      console.warn(
        '[local-dtach-backend.test] dtach not found at vendor/dtach/dtach and not on PATH; integration tests will be skipped. Run scripts/build-dtach.sh to enable them.',
      );
    }
  });

  skipIfNoDtach('normalizes TERM=dumb before spawning the PTY child', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-term-env-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });
    const termFile = join(tmpDir, 'term.txt');

    try {
      await backend.createSession({
        id: 'term-env',
        command: '/bin/sh',
        args: ['-c', `printf '%s' "$TERM" > ${JSON.stringify(termFile)}; sleep 1`],
        env: { TERM: 'dumb' },
      });

      await waitForFileContents(termFile, 'xterm-256color');
    } finally {
      await backend.killSession('term-env').catch(() => undefined);
      backend.close();
    }
  });

  skipIfNoDtach('normalizes TERM=dumb in a replace-mode PTY environment', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-term-env-replace-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });
    const termFile = join(tmpDir, 'term.txt');

    try {
      await backend.createSession({
        id: 'term-env-replace',
        command: '/bin/sh',
        args: ['-c', `printf '%s' "$TERM" > ${JSON.stringify(termFile)}; sleep 1`],
        envMode: 'replace',
        env: { PATH: process.env.PATH ?? '', TERM: 'dumb' },
      });

      await waitForFileContents(termFile, 'xterm-256color');
    } finally {
      await backend.killSession('term-env-replace').catch(() => undefined);
      backend.close();
    }
  });

  afterEach(async () => {
    // dtach masters spawned via setsid survive the test process, so reap any
    // that still reference this test's tmpDir (and the agent/shell children
    // they host) BEFORE removing the directory — otherwise each created
    // session leaks a resident dtach holder (kookr-ai/kookr#784).
    if (tmpDir) {
      try {
        await reapDtachReferencing(tmpDir);
      } catch {
        // best-effort
      }
    }
    try {
      if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  skipIfNoDtach('rejects session ids with unsafe characters', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });

    await expect(
      backend.createSession({
        id: '../escape',
        command: '/bin/sh',
        args: ['-c', 'sleep 1'],
      }),
    ).rejects.toThrow(/must match/);
  });

  skipIfNoDtach('rejects session ids that would overflow the UDS path limit', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });

    await expect(
      backend.createSession({
        id: 'x'.repeat(100),
        command: '/bin/sh',
        args: ['-c', 'sleep 1'],
      }),
    ).rejects.toThrow(/too long/);
  });

  it('handles dtach master spawn errors as a per-session failure', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    const missingDtach = join(tmpDir, 'missing-dtach');
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: missingDtach,
    });

    const errors: unknown[] = [];
    backend.onBackendError((err) => {
      errors.push(err);
    });

    await expect(
      backend.createSession({
        id: 'spawn-error',
        command: '/bin/sh',
        args: ['-c', 'cat'],
      }),
    ).rejects.toThrow(/dtach master spawn failed.*not found or not executable/);

    expect(errors).toContainEqual({
      kind: 'dtach-unavailable',
      binary: missingDtach,
    });
    expect(backend.getStats().lastError).toEqual(errors[0]);

    const manifestPath = join(tmpDir, 'test', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      entries: Array<{ sessionId: string }>;
    };
    expect(manifest.entries.find((e) => e.sessionId === 'spawn-error')).toBeUndefined();
  });

  skipIfNoSetsidWrapper('handles missing setsid as a per-session failure', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    const fakeDtach = join(tmpDir, 'fake-dtach');
    writeFileSync(fakeDtach, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeDtach, 0o755);
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: fakeDtach,
    });

    const errors: unknown[] = [];
    backend.onBackendError((err) => {
      errors.push(err);
    });

    await expect(
      backend.createSession({
        id: 'setsid-error',
        command: '/bin/sh',
        args: ['-c', 'cat'],
        env: { PATH: '' },
      }),
    ).rejects.toThrow(/dtach master spawn failed.*not found or not executable/);

    expect(errors).toContainEqual({
      kind: 'dtach-unavailable',
      binary: 'setsid',
    });

    const manifestPath = join(tmpDir, 'test', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      entries: Array<{ sessionId: string }>;
    };
    expect(manifest.entries.find((e) => e.sessionId === 'setsid-error')).toBeUndefined();
  });

  skipIfNoDtach(
    'rejects sessions when the socketDir consumes the sun_path budget (catches the macOS /var/folders overflow)',
    async () => {
      // Simulate macOS's typical $TMPDIR=/var/folders/XX/<hash>/T with a long
      // base, well within 107 bytes on its own but combined with the standard
      // kookr-dtach/<uid>/<instanceId>/ structure plus a 40-char ID and `.sock`
      // it overflows. Pre-fix, this test passed validateSessionId silently and
      // failed at bind() with EINVAL (`AF_UNIX path too long`).
      const longBase = mkdtempSync(join(tmpdir(), 'ldb-mac-sim-' + 'x'.repeat(40) + '-'));
      tmpDir = longBase;
      backend = new LocalDtachBackend({
        socketDir: longBase,
        instanceId: 'port-4800',
        dtachBinary: DTACH!,
      });

      await expect(
        backend.createSession({
          id: 'session-' + 'x'.repeat(32),
          command: '/bin/sh',
          args: ['-c', 'sleep 1'],
        }),
      ).rejects.toThrow(/sun_path limit|too long/);
    },
  );

  skipIfNoDtach('creates a session and writes a manifest entry with status active', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });

    const id = 'manifest-smoke';
    await backend.createSession({
      id,
      command: '/bin/sh',
      args: ['-c', 'cat'], // waits for stdin, keeps pty alive
    });

    try {
      const manifestPath = join(tmpDir, 'test', 'manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        entries: Array<{ sessionId: string; status: string; sock: string }>;
      };
      const entry = manifest.entries.find((e) => e.sessionId === id);
      expect(entry).toBeDefined();
      expect(entry!.status).toBe('active');
      expect(existsSync(entry!.sock)).toBe(true);

      expect(await backend.listSessions()).toContain(id);
      expect(await backend.isAlive(id)).toBe(true);
    } finally {
      await backend.killSession(id);
      expect(await backend.isAlive(id)).toBe(false);
    }
  }, 10_000);

  skipIfNoDtach('write throws SessionGoneError for unknown id', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });

    await expect(backend.write('does-not-exist', new Uint8Array([0x79]))).rejects.toBeInstanceOf(
      SessionGoneError,
    );
  });

  skipIfNoDtach('killSession on an unknown id is a no-op', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });

    await expect(backend.killSession('does-not-exist')).resolves.not.toThrow();
  });

  skipIfNoDtach(
    'killSession reaps the agent child, not just the dtach master (kookr#784)',
    async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
      backend = new LocalDtachBackend({
        socketDir: tmpDir,
        instanceId: 'test',
        dtachBinary: DTACH!,
      });

      const id = 'reap-agent-child';
      const pidFile = join(tmpDir, 'child.pid');
      // The hosted "agent" ignores SIGHUP, exactly like claude/codex/node do —
      // so the old master-only kill (which only closes the pty and delivers
      // SIGHUP) would leave it orphaned. dtach forks it into its own session,
      // so it is not in the master's process group either. It records its pid
      // and exits on SIGTERM, which is what the new tree-reap delivers directly.
      await backend.createSession({
        id,
        command: '/bin/bash',
        args: ['-c', `trap "" HUP; trap 'exit 0' TERM; echo $$ > ${pidFile}; sleep 600 & wait`],
      });

      // Wait for the agent to publish its pid, then confirm it is alive.
      let childPid = -1;
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (existsSync(pidFile)) {
          const raw = readFileSync(pidFile, 'utf-8').trim();
          const parsed = Number.parseInt(raw, 10);
          if (Number.isInteger(parsed) && parsed > 0) {
            childPid = parsed;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(childPid).toBeGreaterThan(0);
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive(childPid)).toBe(true);

      await backend.killSession(id);

      // The agent child must be gone — reaped via the SIGKILL escalation, not
      // left orphaned and reparented to init.
      expect(alive(childPid)).toBe(false);
    },
  );

  skipIfNoProc(
    'resolves the dtach -n master, not the -a attach child, when both reference the socket',
    async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
      backend = new LocalDtachBackend({
        socketDir: tmpDir,
        instanceId: 'test',
        dtachBinary: DTACH!,
      });

      const id = 'disambig-master';
      // createSession opens the persistent internal attach (`dtach -a <sock>`)
      // as its last step, so after it returns BOTH the master (`dtach -n`) and
      // the attach (`dtach -a`) carry the socket in their cmdline — exactly the
      // ambiguity findDtachMasterPidSync must resolve to the master.
      await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'cat'] });
      const sock = join(tmpDir, 'test', `${id}.sock`);

      // Confirm the ambiguity is real: a live `-n` master AND a live `-a` attach.
      const refs = procsReferencingSock(sock);
      const masters = refs.filter((p) => p.tokens.includes('-n'));
      const attaches = refs.filter((p) => p.tokens.includes('-a'));
      expect(masters.length).toBe(1);
      expect(attaches.length).toBeGreaterThanOrEqual(1);

      const resolver = backend as unknown as { findDtachMasterPidSync(s: string): number };
      const resolved = resolver.findDtachMasterPidSync(sock);
      expect(resolved).toBe(masters[0]!.pid);
      // And it must match the pid the manifest recorded at create time.
      const manifest = JSON.parse(
        readFileSync(join(tmpDir, 'test', 'manifest.json'), 'utf-8'),
      ) as { entries: Array<{ pid: number }> };
      expect(resolved).toBe(manifest.entries[0]!.pid);

      await backend.killSession(id);
    },
  );

  skipIfNoProc(
    'killSession reaps via socket scan when the manifest pid is unresolved (-1)',
    async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
      backend = new LocalDtachBackend({
        socketDir: tmpDir,
        instanceId: 'test',
        dtachBinary: DTACH!,
      });

      const id = 'fallback-pid';
      const pidFile = join(tmpDir, 'child.pid');
      await backend.createSession({
        id,
        command: '/bin/bash',
        args: ['-c', `trap "" HUP; trap 'exit 0' TERM; echo $$ > ${pidFile}; sleep 600 & wait`],
      });
      const childPid = await waitForPidFile(pidFile);
      expect(childPid).toBeGreaterThan(0);
      expect(isPidAlive(childPid)).toBe(true);

      // Simulate a recovered/rebuilt entry whose master pid never resolved
      // (the historical timeout path that made killSession a no-op). killSession
      // must fall back to a live socket scan and still reap the whole tree.
      const manifestPath = join(tmpDir, 'test', 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        entries: Array<{ pid: number }>;
      };
      manifest.entries[0]!.pid = -1;
      writeFileSync(manifestPath, JSON.stringify(manifest));

      await backend.killSession(id);

      expect(isPidAlive(childPid)).toBe(false);
    },
  );

  skipIfNoDtach('replays prior output to a second attach after the first detaches', async () => {
    // End-to-end regression for the "blank terminal on reconnect" bug. Uses
    // a write→tty-echo loop so the test doesn't depend on child-startup
    // output ordering — the only guarantee we need is that bytes the monitor
    // observed before dispose are replayed to a fresh attachSession.
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });

    const id = 'replay-test';
    const REPLAY_MARKER = 'REPLAY_OK_42';

    // `cat` with default tty line discipline echoes stdin back to stdout,
    // which is exactly the loop we need: the write goes monitor → dtach
    // master → child, then the echo bytes come back master → monitor.
    await backend.createSession({
      id,
      command: '/bin/sh',
      args: ['-c', 'exec cat'],
    });

    try {
      const firstBytes: Uint8Array[] = [];
      const unsubscribeFirst = backend.onData(id, (b) => { firstBytes.push(b); });

      // Send the marker via the first handle; the tty echoes it back.
      await backend.write(id, new TextEncoder().encode(REPLAY_MARKER + '\n'));

      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (firstBytes.map((b) => Buffer.from(b).toString('utf-8')).join('').includes(REPLAY_MARKER)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const firstSeen = firstBytes.map((b) => Buffer.from(b).toString('utf-8')).join('');
      expect(firstSeen).toContain(REPLAY_MARKER);

      // Detach viewer 1. Child + dtach master keep running; the backend
      // retains the ring for future captureBytes() replay.
      unsubscribeFirst();

      // Viewer 2's reconnect path now replays via captureBytes() before
      // subscribing to onData. This is the exact bug the fix targets:
      // previously the ring was per-bridge, so the reconnect saw a blank
      // terminal.
      const secondSeen = Buffer.from(await backend.captureBytes(id)).toString('utf-8');
      expect(secondSeen).toContain(REPLAY_MARKER);
    } finally {
      await backend.killSession(id);
    }
  }, 15_000);

  it('captureBytes returns logical-order bytes after the in-memory ring wraps', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH ?? 'dtach',
    });

    type AttachedForTest = {
      id: string;
      sock: string;
      pty: null;
      ringHead: number;
      ringBuffer: Buffer;
      lastFlushedHead: number;
      dataSubscribers: Set<(data: Uint8Array) => void>;
      writeMutex: Promise<void>;
      pendingWriters: number;
      reattachWindow: number[];
      reattachCount: number;
      currentSize: null;
    };
    const attached = (
      backend as unknown as { attached: Map<string, AttachedForTest> }
    ).attached;

    const CAPACITY = 1024 * 1024;
    const id = 'wrapped-capture';
    const head = CAPACITY + 512 + 7;
    const ringBuffer = Buffer.alloc(CAPACITY);
    for (let logical = head - CAPACITY; logical < head; logical += 1) {
      ringBuffer[logical % CAPACITY] = logical & 0xff;
    }
    attached.set(id, {
      id,
      sock: '/tmp/not-used.sock',
      pty: null,
      ringHead: head,
      ringBuffer,
      lastFlushedHead: -1,
      dataSubscribers: new Set(),
      writeMutex: Promise.resolve(),
      pendingWriters: 0,
      reattachWindow: [],
      reattachCount: 0,
      currentSize: null,
    });

    try {
      const replay = await backend.captureBytes(id, 2048);
      expect(replay.length).toBe(2048);
      for (let i = 0; i < replay.length; i += 1) {
        expect(replay[i]).toBe((head - replay.length + i) & 0xff);
      }
    } finally {
      backend.close();
    }
  });

  it('write passes multi-byte UTF-8 to the pty byte-exact (no Latin-1 round trip)', async () => {
    // Regression for the mojibake bug: the write path used
    // `Buffer.from(data).toString('binary')` — a Latin-1 decode — before
    // pty.write. node-pty re-encodes strings as UTF-8, so every multi-byte
    // UTF-8 character was corrupted ("—" reached the agent as "â\x80\x94").
    // The pty is faked here so the test asserts the exact payload handed to
    // node-pty; the string case emulates node-pty's own UTF-8 string encode.
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH ?? 'dtach',
    });

    const ptyWrites: Array<string | Buffer> = [];
    const fakePty = {
      write: (data: string | Buffer) => {
        ptyWrites.push(data);
      },
    };
    const id = 'utf8-write';
    const attached = (
      backend as unknown as { attached: Map<string, Record<string, unknown>> }
    ).attached;
    attached.set(id, {
      id,
      sock: '/tmp/not-used.sock',
      pty: fakePty,
      ringHead: 0,
      ringBuffer: Buffer.alloc(1024),
      lastFlushedHead: -1,
      dataSubscribers: new Set(),
      writeMutex: Promise.resolve(),
      pendingWriters: 0,
      reattachWindow: [],
      reattachCount: 0,
      currentSize: null,
    });

    try {
      const text = 'em dash — and accent é\r';
      const expected = Array.from(new TextEncoder().encode(text));

      await backend.write(id, new TextEncoder().encode(text));
      await backend.writeSequence(id, [new TextEncoder().encode('café —'), Uint8Array.of(0x0d)]);

      expect(ptyWrites).toHaveLength(3);
      // Emulate what node-pty does with each payload: strings are encoded
      // as UTF-8 (CustomWriteStream default), Buffers pass through verbatim.
      const toPtyBytes = (p: string | Buffer): number[] =>
        typeof p === 'string' ? Array.from(Buffer.from(p, 'utf-8')) : Array.from(p);
      expect(toPtyBytes(ptyWrites[0]!)).toEqual(expected);
      expect(toPtyBytes(ptyWrites[1]!)).toEqual(Array.from(new TextEncoder().encode('café —')));
      expect(toPtyBytes(ptyWrites[2]!)).toEqual([0x0d]);
    } finally {
      backend.close();
    }
  });

  it('tracks writeMutex queue depth high-water and WriteTimeoutError counts (issue #1776)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH ?? 'dtach',
      writeTimeoutMs: 40,
    });

    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let holdEntered = false;
    const fakePty = {
      write: () => {
        if (!holdEntered) {
          holdEntered = true;
          return hold;
        }
        // Subsequent writers after the hold is released complete immediately.
        return undefined;
      },
    };
    const id = 'write-metrics';
    const attached = (
      backend as unknown as { attached: Map<string, Record<string, unknown>> }
    ).attached;
    attached.set(id, {
      id,
      sock: '/tmp/not-used.sock',
      pty: fakePty,
      ringHead: 0,
      ringBuffer: Buffer.alloc(1024),
      lastFlushedHead: -1,
      dataSubscribers: new Set(),
      writeMutex: Promise.resolve(),
      pendingWriters: 0,
      reattachWindow: [],
      reattachCount: 0,
      currentSize: null,
    });

    try {
      expect(backend.getStats()).toMatchObject({
        pendingWriters: 0,
        maxPendingWriters: 0,
        writeTimeoutCount: 0,
      });

      const first = backend.write(id, new TextEncoder().encode('a'));
      // Let the first writer acquire the mutex and enter the blocked pty.write.
      await new Promise((r) => setTimeout(r, 5));
      expect(backend.getStats().pendingWriters).toBe(1);

      const second = backend.write(id, new TextEncoder().encode('b'));
      const third = backend.write(id, new TextEncoder().encode('c'));
      await new Promise((r) => setTimeout(r, 5));
      expect(backend.getStats().pendingWriters).toBe(3);
      expect(backend.getStats().maxPendingWriters).toBe(3);

      releaseHold();
      await Promise.all([first, second, third]);
      expect(backend.getStats().pendingWriters).toBe(0);
      expect(backend.getStats().maxPendingWriters).toBe(3);

      // Blocked write that never completes → WriteTimeoutError + counter bump.
      fakePty.write = () => new Promise(() => {});
      await expect(backend.write(id, new TextEncoder().encode('z'))).rejects.toBeInstanceOf(
        WriteTimeoutError,
      );
      expect(backend.getStats().writeTimeoutCount).toBe(1);
      expect(backend.getStats().errorCount).toBeGreaterThanOrEqual(1);
      expect(backend.getStats().lastError).toMatchObject({ kind: 'write-timed-out', id });
      // Mutex must release after timeout so idle path is unblocked.
      expect(backend.getStats().pendingWriters).toBe(0);
    } finally {
      backend.close();
    }
  });

  skipIfNoDtach('round-trips multi-byte UTF-8 through write → tty echo byte-exact', async () => {
    // End-to-end mojibake regression through a real dtach + pty: `cat` with
    // default tty line discipline echoes stdin back, so the em-dash and the
    // accented character must come back exactly as written. Pre-fix, the
    // Latin-1 round trip in the write path corrupted the bytes before they
    // ever reached the child.
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });

    const id = 'utf8-roundtrip';
    const MARKER = 'UTF8_OK — café é\n';

    await backend.createSession({
      id,
      command: '/bin/sh',
      args: ['-c', 'exec cat'],
    });

    try {
      const chunks: Uint8Array[] = [];
      backend.onData(id, (b) => {
        chunks.push(b);
      });

      await backend.write(id, new TextEncoder().encode(MARKER));

      const seen = (): string =>
        new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !seen().includes('UTF8_OK')) {
        await new Promise((r) => setTimeout(r, 25));
      }

      const echoed = seen();
      expect(echoed).toContain('UTF8_OK — café é');
      // Assert byte-exactness, not just decoded similarity: the historical
      // corruption produced "â" for "—", which a lenient decode
      // would still surface as *some* string.
      expect(echoed).not.toContain('â');
    } finally {
      await backend.killSession(id);
    }
  }, 15_000);

  skipIfNoDtach('persists ring buffer across a backend restart', async () => {
    // Regression guard for the "blank terminal after pnpm prod:restart" bug.
    // dtach masters are spawned via setsid and survive a Kookr process exit,
    // so on restart codex-cli (or any TUI) is still running but emits ~0 B/s.
    // Without on-disk persistence the new backend's ring is empty and the
    // browser sees a blank viewport. This test simulates that exact state by
    // (1) writing a marker into a session's ring, (2) calling backend.close()
    // — which flushes + disposes the attach but does NOT kill the dtach master —
    // and (3) spawning a fresh backend at the same instanceDir. The first
    // captureBytes() on the new backend must replay the persisted marker.
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });

    const id = 'restart-persist';
    const MARKER = 'RESTART_OK_77';
    let backend2: LocalDtachBackend | null = null;

    await backend.createSession({
      id,
      command: '/bin/sh',
      args: ['-c', 'exec cat'],
    });

    try {
      // Drive the marker into the ring via tty echo (same loop as the
      // captureBytes-replay test below).
      const seen: Uint8Array[] = [];
      const off = backend.onData(id, (b) => {
        seen.push(b);
      });
      await backend.write(id, new TextEncoder().encode(MARKER + '\n'));

      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if (seen.map((b) => Buffer.from(b).toString('utf-8')).join('').includes(MARKER)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(seen.map((b) => Buffer.from(b).toString('utf-8')).join('')).toContain(MARKER);
      off();

      // Tear down the backend the way a Kookr restart does. close() flushes
      // every active ring, kills the internal attach child, and clears state.
      // The dtach master keeps running because it was spawned with setsid.
      backend.close();

      // Snapshot file must be on disk before the new backend starts up. Data
      // and metadata share one atomically-committed file (issue #2829).
      const ringsDir = join(tmpDir, 'test', 'rings');
      expect(existsSync(join(ringsDir, `${id}.ring`))).toBe(true);

      // Spawn a fresh backend pointing at the same instanceDir — the exact
      // condition `pnpm prod:restart` produces. The session must still be
      // visible (manifest recovery) and its scrollback restored on first
      // capture.
      backend2 = new LocalDtachBackend({
        socketDir: tmpDir,
        instanceId: 'test',
        dtachBinary: DTACH!,
      });
      // Give recoverOnStartup (async, fire-and-forget) a tick to settle so
      // listSessions reflects the manifest. captureBytes works either way
      // because it falls back to readManifestSync.
      await new Promise((r) => setTimeout(r, 25));
      expect(await backend2.isAlive(id)).toBe(true);

      const replayed = Buffer.from(await backend2.captureBytes(id)).toString('utf-8');
      expect(replayed).toContain(MARKER);
    } finally {
      // Use whichever backend is alive to kill the dtach master so the test
      // doesn't leak it into the host. Tolerate failure on both paths.
      const cleanup = backend2 ?? backend;
      try {
        await cleanup.killSession(id);
      } catch {
        // best-effort
      }
      // killSession is contracted to remove the ring snapshot — assert it,
      // otherwise removePersistedRing could silently regress to a no-op.
      expect(existsSync(join(tmpDir, 'test', 'rings', `${id}.ring`))).toBe(false);
      if (backend2) backend2.close();
    }
  }, 15_000);

  skipIfNoDtach('persists wrapped ring buffer (head > capacity) across restart', async () => {
    // Wraparound regression guard. The fresh-ring case (head < capacity) and
    // the wrapped case use different code paths in `persistRing` — wrapped
    // rings split the logical-ordered copy across the modular boundary. A
    // fix that off-by-ones the split byte would still pass the small-marker
    // test above but quietly corrupt scrollback for any session that's been
    // running long enough to fill the ring (~90 s of token streaming on
    // codex). Drive the ring well past its capacity by writing a bytes
    // pattern from a `head -c` source; assert the trailing slice (the part
    // that should survive eviction) is preserved across restart byte-exact.
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });

    const id = 'wrap-persist';
    // Use a small capacity-equivalent payload to keep the test fast: write
    // RING_BUFFER_BYTES + a known tail, then assert the tail is what
    // captureBytes returns. We can't change RING_BUFFER_BYTES from the test,
    // but we can write 1 MB + ~1 KB through `cat`'s tty echo — slow at 1 MB
    // but bounded. Use printf with a block-pattern + a unique tail marker.
    const TAIL_MARKER = 'WRAP_TAIL_777';
    const FILLER_BYTES = 1024 * 1024 + 4096; // > 1 MB so the ring wraps

    let backend2: LocalDtachBackend | null = null;
    await backend.createSession({
      id,
      command: '/bin/sh',
      args: ['-c', 'exec cat'],
    });

    try {
      // Pump filler then the tail. Use a fixed byte pattern so we can verify
      // the wraparound copy preserves byte order, then send a unique tail
      // marker that MUST land in the surviving suffix.
      const filler = Buffer.alloc(FILLER_BYTES, 0x41); // ASCII 'A'
      // Chunk the write to stay below the per-write timeout — a single 1 MB
      // pty.write would race the 2 s default.
      const CHUNK = 32 * 1024;
      for (let off = 0; off < filler.length; off += CHUNK) {
        await backend.write(id, new Uint8Array(filler.subarray(off, off + CHUNK)));
      }
      await backend.write(id, new TextEncoder().encode(TAIL_MARKER + '\n'));

      // Wait for the cat-echoed bytes to populate the ring past its capacity.
      // We poll a bounded window and break as soon as captureBytes shows the
      // marker — that guarantees the tail bytes have arrived.
      const deadline = Date.now() + 10_000;
      let preCapture = new Uint8Array(0);
      while (Date.now() < deadline) {
        preCapture = await backend.captureBytes(id);
        if (Buffer.from(preCapture).toString('utf-8').includes(TAIL_MARKER)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(Buffer.from(preCapture).toString('utf-8')).toContain(TAIL_MARKER);
      // Pre-restart capture should be capped at the ring size — confirms we
      // genuinely wrapped, otherwise this test isn't exercising the split path.
      expect(preCapture.length).toBe(1024 * 1024);

      backend.close();

      backend2 = new LocalDtachBackend({
        socketDir: tmpDir,
        instanceId: 'test',
        dtachBinary: DTACH!,
      });
      const postCapture = await backend2.captureBytes(id);
      // Restored capture must equal the pre-restart capture byte-for-byte.
      // A wraparound copy off-by-one would differ at the split point.
      expect(postCapture.length).toBe(preCapture.length);
      expect(Buffer.from(postCapture).equals(Buffer.from(preCapture))).toBe(true);
      expect(Buffer.from(postCapture).toString('utf-8')).toContain(TAIL_MARKER);
    } finally {
      const cleanup = backend2 ?? backend;
      try {
        await cleanup.killSession(id);
      } catch {
        // best-effort
      }
      if (backend2) backend2.close();
    }
  }, 30_000);

  skipIfNoDtach('re-attach after pty crash restores the last-known size', async () => {
    // Regression guard: when the internal attach child exits (crash, OS kill),
    // the backend lazily re-spawns on the next write/resize via `ensureWritable`
    // -> `attachPtyInto(sock, undefined)`. Without the `currentSize` fallback,
    // the replacement pty would snap back to node-pty's 80x24 default and the
    // hosted TUI would re-flow its viewport. This test locks the "reapply
    // stored size" behavior in place.
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
    });

    type IPtyLike = { cols: number; rows: number; kill: () => void };
    type AttachedLike = { pty: IPtyLike | null };
    const peek = (id: string): AttachedLike =>
      (backend as unknown as { attached: Map<string, AttachedLike> }).attached.get(id)!;

    const id = 'size-restore';
    await backend.createSession({
      id,
      command: '/bin/sh',
      args: ['-c', 'exec cat'],
      size: { cols: 120, rows: 40 },
    });

    try {
      // Sanity: initial attach was sized from spec.size.
      expect(peek(id).pty?.cols).toBe(120);
      expect(peek(id).pty?.rows).toBe(40);

      // Simulate a crash of the internal attach child. The dtach master keeps
      // running (we only kill the attach PTY, not the socket).
      const oldPty = peek(id).pty;
      expect(oldPty).not.toBeNull();
      oldPty!.kill();

      // Wait for `pty.onExit` to null the session's pty handle.
      const deadline = Date.now() + 3_000;
      while (peek(id).pty !== null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(peek(id).pty).toBeNull();

      // Any writable op forces `ensureWritable` -> re-attach. We use resize
      // with the same dimensions so the only change under test is the
      // attachPtyInto path, not the size itself.
      await backend.resize(id, 120, 40);

      const newPty = peek(id).pty;
      expect(newPty).not.toBeNull();
      expect(newPty!.cols).toBe(120);
      expect(newPty!.rows).toBe(40);
    } finally {
      await backend.killSession(id);
    }
  }, 10_000);
});

/**
 * reconnect-transport (kookr-ai/kookr#1347). These exercise the safe transport
 * repair: it rebuilds ONLY Kookr's internal `dtach -a` attach child, preserves
 * the dtach master + agent processes, and never writes terminal input.
 */
describe('LocalDtachBackend reconnectTransport', () => {
  let tmpDir: string;
  let backend: LocalDtachBackend;

  afterEach(async () => {
    if (tmpDir) {
      try {
        await reapDtachReferencing(tmpDir);
      } catch {
        // best-effort
      }
    }
    try {
      if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function manifestPidFor(id: string): number {
    const manifest = JSON.parse(
      readFileSync(join(tmpDir, 'test', 'manifest.json'), 'utf-8'),
    ) as { entries: Array<{ sessionId: string; pid: number }> };
    return manifest.entries.find((e) => e.sessionId === id)!.pid;
  }

  /** Live pids whose cmdline references `sock` and carries the `-a` (attach) flag. */
  function attachPids(sock: string): number[] {
    return procsReferencingSock(sock)
      .filter((p) => p.tokens.includes('-a'))
      .map((p) => p.pid);
  }

  skipIfNoProc(
    'rebuilds only the internal attach child, preserving master + agent pids',
    async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
      backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

      const id = 'reconnect-ok';
      // A session that keeps emitting output, so a fresh-liveness byte is
      // guaranteed within the window regardless of dtach's redraw behaviour.
      await backend.createSession({
        id,
        command: '/bin/sh',
        args: ['-c', 'while true; do echo tick; sleep 0.05; done'],
      });
      const sock = join(tmpDir, 'test', `${id}.sock`);

      const masterPid = manifestPidFor(id);
      const resolver = backend as unknown as { findAgentPidSync(pid: number): number | null };
      const agentPidBefore = resolver.findAgentPidSync(masterPid);
      expect(agentPidBefore).toBeGreaterThan(0);
      const attachBefore = attachPids(sock);
      expect(attachBefore.length).toBeGreaterThanOrEqual(1);

      const result = await backend.reconnectTransport(id, { livenessTimeoutMs: 2_000 });

      expect(result.outcome).toBe('success');
      expect(result.reason).toBe('reconnected');
      expect(result.identityVerified).toBe(true);
      // Master + agent pids are unchanged and still alive.
      expect(result.masterPid).toBe(masterPid);
      expect(result.agentPid).toBe(agentPidBefore);
      expect(isPidAlive(masterPid)).toBe(true);
      expect(isPidAlive(agentPidBefore!)).toBe(true);
      // A fresh attach generation replaced the old internal attach child.
      expect(result.newGeneration).toBe(result.previousGeneration + 1);
      const deadline = Date.now() + 2_000;
      while (attachBefore.some((p) => isPidAlive(p)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const attachAfter = attachPids(sock);
      // The old attach pid is gone; a new one references the same socket.
      expect(attachBefore.every((p) => !isPidAlive(p))).toBe(true);
      expect(attachAfter.some((p) => !attachBefore.includes(p))).toBe(true);

      await backend.killSession(id);
    },
    20_000,
  );

  skipIfNoProc('rejects when the master identity cannot be verified', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'reconnect-identity';
    await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'exec cat'] });

    // Overwrite the manifest pid with a live-but-not-dtach pid (this test
    // process): alive, so process.kill(pid,0) succeeds, but /proc/<pid>/exe is
    // not dtach — identity must fail without disposing the attach child.
    const manifestPath = join(tmpDir, 'test', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      entries: Array<{ sessionId: string; pid: number }>;
    };
    manifest.entries.find((e) => e.sessionId === id)!.pid = process.pid;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = await backend.reconnectTransport(id);
    expect(result.outcome).toBe('failure');
    expect(result.reason).toBe('identity-unverified');
    expect(result.identityVerified).toBe(false);
    // The attach child was NOT rebuilt (identity is checked before disposal).
    expect(result.newGeneration).toBe(result.previousGeneration);

    // NOTE: do NOT call killSession here — the manifest pid now points at this
    // test process, and killSession reaps the manifest pid's tree. afterEach
    // reaps the real dtach master by cmdline (referencing tmpDir) instead.
  });

  skipIfNoDtach('rejects when the dtach socket is missing', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'reconnect-nosock';
    await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'exec cat'] });
    const sock = join(tmpDir, 'test', `${id}.sock`);
    unlinkSync(sock);

    const result = await backend.reconnectTransport(id);
    expect(result.outcome).toBe('failure');
    expect(result.reason).toBe('socket-missing');

    await backend.killSession(id);
  });

  skipIfNoProc('reports attach-spawn-failed when the fresh attach cannot be opened', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'reconnect-spawnfail';
    await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'exec cat'] });
    // Settle the identity gate before the reconnect so the assertion exercises
    // the attach-spawn path, not a racing `identity-unverified` (#1627).
    await waitForMasterIdentity(tmpDir, id);

    // Make the fresh attach spawn throw AFTER identity + disposal.
    const anyBackend = backend as unknown as { attachPtyInto: (...a: unknown[]) => void };
    anyBackend.attachPtyInto = () => {
      throw new Error('spawn boom');
    };

    const result = await backend.reconnectTransport(id);
    expect(result.outcome).toBe('failure');
    expect(result.reason).toBe('attach-spawn-failed');
    expect(result.identityVerified).toBe(true);

    await backend.killSession(id);
  });

  skipIfNoProc('reports inconclusive when no fresh-liveness byte arrives in the window', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'reconnect-timeout';
    await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'exec cat'] });

    // Replace the attach with a silent fake pty so the liveness probe never
    // fires — deterministically exercising the bounded-wait timeout path
    // without depending on dtach's redraw behaviour.
    const anyBackend = backend as unknown as {
      attachPtyInto: (sess: { pty: unknown; attachGeneration: number }) => void;
    };
    anyBackend.attachPtyInto = (sess) => {
      sess.pty = {
        kill() {},
        resize() {},
        write() {},
        onData() {},
        onExit() {},
      };
      sess.attachGeneration += 1;
    };

    const result = await backend.reconnectTransport(id, { livenessTimeoutMs: 100 });
    expect(result.outcome).toBe('inconclusive');
    expect(result.reason).toBe('liveness-timeout');
    expect(result.identityVerified).toBe(true);
    expect(result.newGeneration).toBe(result.previousGeneration + 1);

    await backend.killSession(id);
  });

  skipIfNoProc('collapses concurrent duplicate requests onto one reconnect attempt', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'reconnect-dup';
    await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'exec cat'] });

    const [r1, r2] = await Promise.all([
      backend.reconnectTransport(id, { livenessTimeoutMs: 300 }),
      backend.reconnectTransport(id, { livenessTimeoutMs: 300 }),
    ]);
    // Same result object → the duplicate collapsed onto the in-flight attempt.
    expect(r1).toBe(r2);
    // Exactly one generation bump, not two.
    expect(r1.newGeneration).toBe(r1.previousGeneration + 1);

    await backend.killSession(id);
  }, 10_000);

  skipIfNoProc('rejects a second reconnect within the cooldown window', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({
      socketDir: tmpDir,
      instanceId: 'test',
      dtachBinary: DTACH!,
      reconnectCooldownMs: 10_000,
    });

    const id = 'reconnect-cooldown';
    await backend.createSession({
      id,
      command: '/bin/sh',
      args: ['-c', 'while true; do echo tick; sleep 0.05; done'],
    });

    const first = await backend.reconnectTransport(id, { livenessTimeoutMs: 2_000 });
    expect(first.outcome).not.toBe('failure');
    const second = await backend.reconnectTransport(id, { livenessTimeoutMs: 2_000 });
    expect(second.outcome).toBe('failure');
    expect(second.reason).toBe('cooldown');
    // The rejected duplicate did not rebuild the transport.
    expect(second.newGeneration).toBe(second.previousGeneration);

    await backend.killSession(id);
  }, 20_000);

  skipIfNoProc('writes zero bytes to the fresh attach on the real path (no-input guarantee)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'reconnect-noinput';
    // `cat` would echo any injected input, but we assert the stronger property
    // directly: instrument the freshly-attached pty's `write` and prove the
    // reconnect + liveness wait never calls it.
    await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'exec cat'] });

    let writesDuringReconnect = 0;
    const proto = Object.getPrototypeOf(backend) as {
      attachPtyInto(sess: { pty: { write(d: unknown): unknown } }, sock: string, size?: unknown): void;
    };
    const realAttach = proto.attachPtyInto;
    (backend as unknown as { attachPtyInto: typeof realAttach }).attachPtyInto = function attach(sess, sock, size) {
      realAttach.call(this, sess, sock, size);
      const realWrite = sess.pty.write.bind(sess.pty);
      sess.pty.write = (data: unknown): unknown => {
        writesDuringReconnect += 1;
        return realWrite(data);
      };
    };

    const result = await backend.reconnectTransport(id, { livenessTimeoutMs: 300 });
    expect(result.outcome).not.toBe('failure');
    expect(writesDuringReconnect).toBe(0);

    await backend.killSession(id);
  }, 10_000);

  skipIfNoProc('keeps existing onData subscribers attached across a real reconnect', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'reconnect-subs';
    await backend.createSession({
      id,
      command: '/bin/sh',
      args: ['-c', 'while true; do echo tick; sleep 0.05; done'],
    });

    // A single subscriber registered ONCE, never re-registered — the exact
    // SessionBridge continuity the repair must preserve across dispose+respawn.
    const received: Uint8Array[] = [];
    const off = backend.onData(id, (b) => received.push(b));

    const result = await backend.reconnectTransport(id, { livenessTimeoutMs: 2_000 });
    expect(result.outcome).toBe('success');

    // Fresh bytes emitted strictly AFTER the reconnect completed still reach the
    // same subscriber — if the rebuild had dropped it, this count would freeze.
    const afterReconnect = received.length;
    const deadline = Date.now() + 2_000;
    while (received.length <= afterReconnect && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(received.length).toBeGreaterThan(afterReconnect);

    off();
    await backend.killSession(id);
  }, 15_000);

  skipIfNoProc('reports attach-spawn-failed when the fresh attach exits immediately', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'reconnect-immediate-exit';
    await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'exec cat'] });

    // Model a fresh attach that comes up then dies before the liveness wait:
    // `attachPtyInto` bumps the generation but leaves no live pty. This is the
    // `if (!sess.pty)` branch, distinct from a synchronous spawn throw.
    const anyBackend = backend as unknown as {
      attachPtyInto: (sess: { pty: unknown; attachGeneration: number }) => void;
    };
    anyBackend.attachPtyInto = (sess) => {
      sess.pty = null;
      sess.attachGeneration += 1;
    };

    const result = await backend.reconnectTransport(id, { livenessTimeoutMs: 50 });
    expect(result.outcome).toBe('failure');
    expect(result.reason).toBe('attach-spawn-failed');
    expect(result.identityVerified).toBe(true);

    await backend.killSession(id);
  });
});

/**
 * Non-destructive current-frame snapshot for absolute-TUI browser opens.
 * Uses a temporary secondary `dtach -a` without recycling the primary attach
 * or burning the reconnect-transport retry budget.
 */
describe('LocalDtachBackend captureCurrentFrame', () => {
  let tmpDir: string;
  let backend: LocalDtachBackend;

  afterEach(async () => {
    if (tmpDir) {
      try {
        await reapDtachReferencing(tmpDir);
      } catch {
        // best-effort
      }
    }
    try {
      if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function attachPids(sock: string): number[] {
    return procsReferencingSock(sock)
      .filter((p) => p.tokens.includes('-a'))
      .map((p) => p.pid);
  }

  skipIfNoProc(
    'returns the current screen without recycling the primary attach',
    async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
      backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

      const id = 'frame-snapshot';
      // Keep emitting so both the primary attach and a secondary snapshot see
      // non-empty screen content (dtach attach-replay dumps the current buffer).
      await backend.createSession({
        id,
        command: '/bin/sh',
        args: ['-c', 'while true; do printf "frame-marker-ABC\\n"; sleep 0.05; done'],
      });
      await new Promise((r) => setTimeout(r, 200));

      const sock = join(tmpDir, 'test', `${id}.sock`);
      const attachBefore = attachPids(sock);
      expect(attachBefore.length).toBeGreaterThanOrEqual(1);
      const generationBefore = backend.getSessionDiagnostics?.(id)?.attachGeneration;

      const frame = await backend.captureCurrentFrame(id, {
        timeoutMs: 2_000,
        quietMs: 100,
        minHoldMs: 150,
        cols: 100,
        rows: 30,
      });

      expect(frame.length).toBeGreaterThan(4);
      const text = Buffer.from(frame).toString('latin1');
      // Full screen dump (not just a leading clear) — marker may be present, or
      // at least substantially more than ESC[H ESC[J.
      expect(text.includes('frame-marker-ABC') || frame.length > 32).toBe(true);

      // Primary attach must not have been recycled (generation unchanged).
      const attachAfter = attachPids(sock);
      expect(attachAfter.some((p) => attachBefore.includes(p))).toBe(true);
      const generationAfter = backend.getSessionDiagnostics?.(id)?.attachGeneration;
      if (generationBefore !== undefined && generationAfter !== undefined) {
        expect(generationAfter).toBe(generationBefore);
      }

      await backend.killSession(id);
    },
    20_000,
  );

  skipIfNoProc('throws SessionGoneError for an unknown session', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });
    await expect(backend.captureCurrentFrame('no-such-session')).rejects.toBeInstanceOf(SessionGoneError);
  });
});

/**
 * Post-restart recovery state machine (kookr-ai/kookr#1345).
 *
 * These exercise `verifyRecoveredSession`: after a Kookr restart the dtach
 * master + agent survive, but the resumed internal attach can come up wedged
 * (alive but emitting no bytes) — a false-healthy state that process/socket
 * liveness misses. The machine classifies each recovered session and self-heals
 * ONLY the attach transport for sessions expected to be working, bounded by a
 * grace window + repair cap, without ever touching the agent.
 */
describe('LocalDtachBackend verifyRecoveredSession', () => {
  let tmpDir: string;
  let backend: LocalDtachBackend;

  afterEach(async () => {
    if (tmpDir) {
      try {
        await reapDtachReferencing(tmpDir);
      } catch {
        // best-effort
      }
    }
    try {
      if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function manifestPidFor(id: string): number {
    const manifest = JSON.parse(
      readFileSync(join(tmpDir, 'test', 'manifest.json'), 'utf-8'),
    ) as { entries: Array<{ sessionId: string; pid: number }> };
    return manifest.entries.find((e) => e.sessionId === id)!.pid;
  }

  /** A silent PTY double — models a wedged attach that never emits a byte. */
  function silentPty(): Record<string, () => void> {
    return { kill() {}, resize() {}, write() {}, onData() {}, onExit() {} };
  }

  /** Live pids whose cmdline references `sock` and carries the `-a` (attach) flag. */
  function attachPids(sock: string): number[] {
    return procsReferencingSock(sock)
      .filter((p) => p.tokens.includes('-a'))
      .map((p) => p.pid);
  }

  /**
   * Replace the session's current attach with a silent double so the initial
   * recovery probe observes a wedged (byte-less) transport, exactly like the
   * production false-healthy state. The subsequent repair spawns a REAL
   * `dtach -a`, so the actual respawn path is exercised.
   */
  function wedgeCurrentAttach(id: string): void {
    const anyB = backend as unknown as {
      attached: Map<string, { pty: unknown; disposePtyListeners: (() => void) | null }>;
      disposeAttachChildOnly(sess: unknown): void;
    };
    const sess = anyB.attached.get(id)!;
    anyB.disposeAttachChildOnly(sess);
    sess.pty = silentPty();
    sess.disposePtyListeners = null;
  }

  // Criterion 1: dtach-backed agent, restart the backend, post-restart output continues.
  skipIfNoProc('classifies a still-emitting recovered session live and output continues', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'recover-live';
    // Keeps emitting after the restart, so ONGOING progress (not just an on-attach
    // redraw) is guaranteed within the window.
    await backend.createSession({
      id,
      command: '/bin/sh',
      args: ['-c', 'while true; do echo tick; sleep 0.05; done'],
    });
    const masterPid = manifestPidFor(id);
    const resolver = backend as unknown as { findAgentPidSync(pid: number): number | null };
    const agentPidBefore = resolver.findAgentPidSync(masterPid);
    expect(agentPidBefore).toBeGreaterThan(0);

    // Restart Kookr: close() flushes + disposes the internal attach but leaves
    // the setsid'd dtach master (and its agent) running.
    backend.close();
    const backend2 = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });
    await new Promise((r) => setTimeout(r, 25)); // let recoverOnStartup settle

    try {
      const result = await backend2.verifyRecoveredSession(id, {
        expectWorking: true,
        settleWindowMs: LIVE_SETTLE_MS,
        graceWindowMs: LIVE_GRACE_MS,
      });
      expect(result.classification).toBe('recovered-live');
      expect(result.repairAttempts).toBe(0);
      expect(result.identityVerified).toBe(true);
      expect(result.livenessObserved).toBe(true);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(result.masterPid).toBe(masterPid);
      expect(result.agentPid).toBe(agentPidBefore);
      expect(isPidAlive(masterPid)).toBe(true);
      expect(isPidAlive(agentPidBefore!)).toBe(true);

      // Post-restart output continues to reach a subscriber.
      const seen: number[] = [];
      const off = backend2.onData(id, (b) => seen.push(b.length));
      const deadline = Date.now() + 2_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      off();
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      await backend2.killSession(id);
      backend2.close();
    }
  }, 20_000);

  // Criterion 2 + 4: wedged internal attach → recycle ONLY the attach child with
  // a REAL fresh dtach -a; dtach master + agent PID unchanged and alive.
  skipIfNoProc('repairs a wedged attach by recycling only the (real) attach child', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'recover-wedged';
    // Emitting session so the fresh REAL attach observes ongoing progress and the
    // repair resolves to live.
    await backend.createSession({
      id,
      command: '/bin/sh',
      args: ['-c', 'while true; do echo tick; sleep 0.05; done'],
    });
    const sock = join(tmpDir, 'test', `${id}.sock`);
    const masterPid = manifestPidFor(id);
    const resolver = backend as unknown as { findAgentPidSync(pid: number): number | null };
    const agentPidBefore = resolver.findAgentPidSync(masterPid);
    expect(agentPidBefore).toBeGreaterThan(0);
    const attachBefore = attachPids(sock);
    expect(attachBefore.length).toBeGreaterThanOrEqual(1);

    // Model the wedged attach that survived into the observation window. The
    // repair path below is NOT stubbed — it spawns a real `dtach -a`.
    wedgeCurrentAttach(id);

    const result = await backend.verifyRecoveredSession(id, {
      expectWorking: true,
      settleWindowMs: LIVE_SETTLE_MS,
      graceWindowMs: LIVE_GRACE_MS,
      maxRepairAttempts: 3,
    });

    expect(result.classification).toBe('recovered-live');
    expect(result.repairAttempts).toBe(1); // one real recycle brought it back
    expect(result.livenessObserved).toBe(true);
    // The agent + master were never signalled — same pids, still alive.
    expect(result.masterPid).toBe(masterPid);
    expect(result.agentPid).toBe(agentPidBefore);
    expect(isPidAlive(masterPid)).toBe(true);
    expect(isPidAlive(agentPidBefore!)).toBe(true);

    // A NEW real `dtach -a` replaced the old attach child; the pre-wedge attach
    // pid is gone (killed by dispose), a fresh one references the same socket.
    const deadline = Date.now() + 2_000;
    while (attachBefore.some((p) => isPidAlive(p)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(attachBefore.every((p) => !isPidAlive(p))).toBe(true);
    const attachAfter = attachPids(sock);
    expect(attachAfter.some((p) => !attachBefore.includes(p))).toBe(true);

    await backend.killSession(id);
  }, 20_000);

  // Criterion 3 + 6 + 7: a permanently-silent session (real cat, no output) is
  // bounded by the repair cap with REAL dtach spawns (no orphan storm), surfaces
  // the distinct unverified finding, and records structured diagnostics.
  skipIfNoProc('bounds real repairs (no attach storm) and surfaces a distinct unverified finding', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'recover-storm';
    // A genuinely silent agent: `cat` with no input never produces output, so
    // every REAL attach observes no progress (the on-attach redraw is discounted
    // by the settle window). This exercises the real repair-spawn cap.
    await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'exec cat'] });
    const sock = join(tmpDir, 'test', `${id}.sock`);
    const masterPid = manifestPidFor(id);

    const findings: Array<{ kind: string }> = [];
    backend.onBackendError((e) => findings.push(e));

    const result = await backend.verifyRecoveredSession(id, {
      expectWorking: true,
      settleWindowMs: 80,
      graceWindowMs: 120,
      maxRepairAttempts: 2,
      restartEpoch: 1234567,
    });

    expect(result.classification).toBe('recovered-unverified');
    expect(result.repairAttempts).toBe(2); // capped — did NOT spin further
    expect(result.failureReason).toBe('no-liveness-after-repair');
    expect(result.livenessObserved).toBe(false);
    // Structured diagnostics carry the restart epoch, attempt count, and reason.
    expect(result.restartEpoch).toBe(1234567);
    expect(result.masterPid).toBe(masterPid);

    // No orphan storm: dispose-before-respawn means at most one real `dtach -a`
    // is alive at a time — the repairs did NOT accumulate attach processes.
    expect(attachPids(sock).length).toBeLessThanOrEqual(1);

    // A distinct, actionable finding — NOT stale_agent.
    const unverified = findings.filter((f) => f.kind === 'session-recovery-unverified');
    expect(unverified).toHaveLength(1);
    expect(unverified[0]).toMatchObject({
      kind: 'session-recovery-unverified',
      id,
      attempts: 2,
      failureReason: 'no-liveness-after-repair',
    });
    expect(findings.some((f) => f.kind === 'stale_agent')).toBe(false);

    await backend.killSession(id);
  }, 20_000);

  // Criterion 5: a known-idle (not-expected-working) session is never repaired.
  skipIfNoProc('does not repair a known-idle session that is legitimately silent', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'recover-idle';
    await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'exec cat'] });

    wedgeCurrentAttach(id);

    // If repair were (wrongly) attempted, it would call the real attachPtyInto.
    let attachCalls = 0;
    const anyB = backend as unknown as {
      attachPtyInto: (...a: unknown[]) => void;
    };
    const realAttach = Object.getPrototypeOf(backend).attachPtyInto;
    anyB.attachPtyInto = function attach(this: unknown, ...a: unknown[]) {
      attachCalls += 1;
      return realAttach.apply(this, a);
    };

    const result = await backend.verifyRecoveredSession(id, {
      expectWorking: false,
      settleWindowMs: 40,
      graceWindowMs: 60,
    });

    expect(result.classification).toBe('recovered-idle');
    expect(result.repairAttempts).toBe(0);
    expect(attachCalls).toBe(0); // NO repair attaches were opened

    await backend.killSession(id);
  }, 15_000);

  // Medium coverage: a repair attach that cannot be spawned is a distinct terminal
  // failure (attach-spawn-failed), not masked as generic no-liveness.
  skipIfNoProc('reports attach-spawn-failed when a repair attach cannot be opened', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'recover-spawnfail';
    await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'exec cat'] });

    wedgeCurrentAttach(id);
    // Make the repair spawn throw AFTER identity + dispose.
    const anyB = backend as unknown as { attachPtyInto: (...a: unknown[]) => void };
    anyB.attachPtyInto = () => {
      throw new Error('spawn boom');
    };

    const result = await backend.verifyRecoveredSession(id, {
      expectWorking: true,
      settleWindowMs: 20,
      graceWindowMs: 40,
      maxRepairAttempts: 3,
    });

    expect(result.classification).toBe('recovered-unverified');
    expect(result.failureReason).toBe('attach-spawn-failed');
    expect(result.repairAttempts).toBe(1); // broke out on the hard spawn failure
    expect(result.identityVerified).toBe(true);

    await backend.killSession(id);
  }, 15_000);

  // Coverage: an unknown session id classifies unverified without any repair.
  it('reports session-unknown for an id with no manifest entry', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH ?? 'dtach' });

    const result = await backend.verifyRecoveredSession('no-such-session', { expectWorking: true });
    expect(result.classification).toBe('recovered-unverified');
    expect(result.failureReason).toBe('session-unknown');
    expect(result.identityVerified).toBe(false);
    expect(result.repairAttempts).toBe(0);
  });

  // Criterion: identity that cannot be verified never touches the attach child.
  skipIfNoProc('reports unverified with identity-unverified when the master is not ours', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const id = 'recover-identity';
    await backend.createSession({ id, command: '/bin/sh', args: ['-c', 'exec cat'] });

    // Point the manifest pid at this test process: alive, but /proc/<pid>/exe is
    // not dtach — identity must fail before any repair.
    const manifestPath = join(tmpDir, 'test', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      entries: Array<{ sessionId: string; pid: number }>;
    };
    manifest.entries.find((e) => e.sessionId === id)!.pid = process.pid;
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = await backend.verifyRecoveredSession(id, { expectWorking: true, graceWindowMs: 40 });
    expect(result.classification).toBe('recovered-unverified');
    expect(result.failureReason).toBe('identity-unverified');
    expect(result.identityVerified).toBe(false);
    expect(result.repairAttempts).toBe(0);

    // Do NOT killSession — manifest pid points at this process; afterEach reaps
    // the real dtach master by cmdline instead.
  });

  // Criterion 8: multiple sessions recover concurrently; one failure does not
  // block the others.
  skipIfNoProc('recovers multiple sessions concurrently without one failure blocking others', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-test-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: DTACH! });

    const liveA = 'concurrent-a';
    const liveB = 'concurrent-b';
    const broken = 'concurrent-broken';
    for (const id of [liveA, liveB]) {
      await backend.createSession({
        id,
        command: '/bin/sh',
        args: ['-c', 'while true; do echo tick; sleep 0.05; done'],
      });
    }
    await backend.createSession({ id: broken, command: '/bin/sh', args: ['-c', 'exec cat'] });
    // Settle each healthy master's identity gate before the concurrent verify so
    // `recovered-live` is not lost to a racing `identity-unverified` under load
    // (#1627). The broken session goes through the socket-missing path below, so
    // its identity is never consulted.
    await waitForMasterIdentity(tmpDir, liveA);
    await waitForMasterIdentity(tmpDir, liveB);
    // Break the third session's transport: remove its socket → socket-missing.
    unlinkSync(join(tmpDir, 'test', `${broken}.sock`));

    const [ra, rb, rbroken] = await Promise.all([
      backend.verifyRecoveredSession(liveA, { expectWorking: true, settleWindowMs: LIVE_SETTLE_MS, graceWindowMs: LIVE_GRACE_MS }),
      backend.verifyRecoveredSession(liveB, { expectWorking: true, settleWindowMs: LIVE_SETTLE_MS, graceWindowMs: LIVE_GRACE_MS }),
      backend.verifyRecoveredSession(broken, { expectWorking: true, settleWindowMs: LIVE_SETTLE_MS, graceWindowMs: LIVE_GRACE_MS }),
    ]);

    // The two healthy sessions recovered live despite the third failing.
    expect(ra.classification).toBe('recovered-live');
    expect(rb.classification).toBe('recovered-live');
    expect(rbroken.classification).toBe('recovered-unverified');
    expect(rbroken.failureReason).toBe('socket-missing');

    await backend.killSession(liveA);
    await backend.killSession(liveB);
    await backend.killSession(broken);
  }, 20_000);
});

/**
 * Constructor-time startup recovery containment (kookr-ai/kookr#2828).
 *
 * These do not need a real dtach binary: the failure lives entirely in the
 * manifest-recovery pass, which touches only the manifest store and the socket
 * dir scan. They prove the old `void this.recovery.recoverOnStartup()` — which
 * let an ENOSPC / unwritable-manifest rejection escape as an unhandled promise
 * rejection with no stable operator-visible state — is now an observed,
 * contained, single-pass transition.
 */
describe('LocalDtachBackend startup recovery containment (issue #2828)', () => {
  let tmpDir: string;
  let backend: LocalDtachBackend | null = null;

  afterEach(() => {
    if (backend) {
      try {
        backend.close();
      } catch {
        // best-effort
      }
      backend = null;
    }
    try {
      if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('reports succeeded on a healthy (missing-manifest) startup, leaving diagnostics untouched', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-recover-'));
    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: 'dtach' });

    await backend.whenStartupRecoverySettled();

    expect(backend.getStartupRecoveryState()).toEqual({ status: 'succeeded', error: null });
    expect(backend.getStats().startupRecoveryState).toEqual({ status: 'succeeded', error: null });
    // Healthy-path diagnostics stay exactly as before — no phantom error.
    expect(backend.getStats().lastError).toBeNull();
    expect(backend.getStats().errorCount).toBe(0);
  });

  it('contains an ENOSPC-style recovery write failure instead of an unhandled rejection', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-recover-'));
    // Seed an unparseable manifest so recovery enters the corrupt-rebuild
    // branch, whose `writeAtomic` is exactly where a disk-full backend throws.
    const instanceDir = join(tmpDir, 'test');
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, 'manifest.json'), '{ this is not valid json');

    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onRejection);
    try {
      backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: 'dtach' });

      // Fail the persist step like a full disk, and count reconciliation reads.
      // Both synchronous patches land before recovery's first `await` yields the
      // microtask that runs the corrupt-rebuild path, so the rebuild's
      // `writeAtomic` call hits the throwing stub.
      const store = backend as unknown as {
        manifestStore: {
          writeAtomic: (m: unknown) => void;
          readForRecovery: () => unknown;
          read: () => { entries: Array<{ sessionId: string }> };
        };
      };
      const realWriteAtomic = store.manifestStore.writeAtomic.bind(store.manifestStore);
      store.manifestStore.writeAtomic = (): never => {
        const err = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      };
      let reads = 0;
      const realReadForRecovery = store.manifestStore.readForRecovery.bind(store.manifestStore);
      store.manifestStore.readForRecovery = (): unknown => {
        reads += 1;
        return realReadForRecovery();
      };

      const errors: BackendError[] = [];
      backend.onBackendError((e) => errors.push(e));

      await backend.whenStartupRecoverySettled();
      // Drain the queues so a would-be escaped rejection has a chance to surface.
      await new Promise((r) => setTimeout(r, 10));

      // Stable, observable failure state — not a silent partial startup.
      expect(backend.getStartupRecoveryState().status).toBe('failed');
      expect(backend.getStartupRecoveryState().error).toContain('ENOSPC');
      expect(backend.getStats().startupRecoveryState?.status).toBe('failed');

      // Structured error emitted; cumulative counters preserved (bumped once).
      expect(backend.getStats().lastError).toMatchObject({ kind: 'startup-recovery-failed' });
      expect(backend.getStats().errorCount).toBe(1);
      expect(errors.filter((e) => e.kind === 'startup-recovery-failed')).toHaveLength(1);

      // The failure did not escape the backend boundary.
      expect(rejections).toHaveLength(0);

      // Bounded single pass ON THE FAILURE PATH — where a retry-on-failure loop
      // (the unbounded-resource-growth regression the issue guards against) would
      // most plausibly be introduced: recovery reads the manifest exactly once
      // and does not re-enter after the write threw.
      expect(reads).toBe(1);

      // Fail-open: once the disk-full condition clears, the store's own write
      // path works again — the containment did not wedge the manifest store into
      // a dead backend. Restore the real writer and round-trip a manifest.
      store.manifestStore.writeAtomic = realWriteAtomic;
      store.manifestStore.writeAtomic({
        version: 1,
        instanceId: 'test',
        entries: [{ sessionId: 'probe', pid: -1, startedAt: new Date().toISOString(), status: 'recovered', sock: join(instanceDir, 'probe.sock') }],
      });
      expect(store.manifestStore.read().entries.map((e) => e.sessionId)).toEqual(['probe']);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('reconciles an existing valid manifest to succeeded in a single pass, diagnostics clean', async () => {
    // The healthy-path-with-existing-sessions case: a parseable manifest whose
    // entry has aged out. Recovery takes the `valid` branch, reconciles the
    // entry away, and persists — exercising the non-empty happy path (not just
    // the empty missing-manifest case) that the acceptance criterion
    // "healthy path + cumulative diagnostics unchanged" asserts.
    tmpDir = mkdtempSync(join(tmpdir(), 'ldb-recover-'));
    const instanceDir = join(tmpDir, 'test');
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(
      join(instanceDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        instanceId: 'test',
        entries: [
          {
            sessionId: 'stale',
            pid: -1,
            // Epoch start — far older than PENDING_TTL_MS, so it ages out.
            startedAt: '1970-01-01T00:00:00.000Z',
            status: 'pending',
            sock: join(instanceDir, 'stale.sock'),
          },
        ],
      }),
    );

    backend = new LocalDtachBackend({ socketDir: tmpDir, instanceId: 'test', dtachBinary: 'dtach' });

    // Count reconciliation reads on this non-trivial (valid, non-empty) path so
    // "single bounded pass" is proven where recovery actually does work.
    let reads = 0;
    const store = backend as unknown as {
      manifestStore: { readForRecovery: () => unknown; read: () => { entries: unknown[] } };
    };
    const original = store.manifestStore.readForRecovery.bind(store.manifestStore);
    store.manifestStore.readForRecovery = (): unknown => {
      reads += 1;
      return original();
    };

    await backend.whenStartupRecoverySettled();
    await new Promise((r) => setTimeout(r, 10));

    expect(backend.getStartupRecoveryState()).toEqual({ status: 'succeeded', error: null });
    // Cumulative diagnostics stay clean through a real reconcile — no phantom error.
    expect(backend.getStats().lastError).toBeNull();
    expect(backend.getStats().errorCount).toBe(0);
    // The aged-out entry was reconciled away and the manifest re-persisted.
    expect(store.manifestStore.read().entries).toEqual([]);
    // Bounded single pass on the valid, non-empty branch.
    expect(reads).toBe(1);
  });
});
