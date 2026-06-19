/**
 * Tests for LocalDtachBackend.
 *
 * These are integration tests — they exercise a real dtach binary. If
 * dtach is not on PATH and vendor/dtach/dtach is missing, tests are
 * skipped with a message. Running the full suite locally requires
 * `scripts/build-dtach.sh` first.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { LocalDtachBackend, buildDtachSpawn } from './local-dtach-backend.js';
import { killProcessTree } from './process-tree.js';
import { SessionGoneError } from './terminal-backend.js';

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

/**
 * Reap any dtach masters (and the agent/shell children they host) whose
 * command line references `dir`. dtach masters are spawned via `setsid` and
 * survive the test process, so without this the suite leaks one resident
 * dtach holder per created session (kookr-ai/kookr#784). Linux-only; degrades
 * to a no-op where `/proc` is unavailable.
 */
async function reapDtachReferencing(dir: string): Promise<void> {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return;
  }
  const targets: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf-8').replace(/\0/g, ' ');
      if (cmdline.includes('dtach') && cmdline.includes(dir)) targets.push(Number(name));
    } catch {
      // process exited between readdir and read — skip
    }
  }
  for (const pid of targets) {
    await killProcessTree(pid, { graceMs: 2_000 });
  }
}

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

      // Snapshot files must be on disk before the new backend starts up.
      const ringsDir = join(tmpDir, 'test', 'rings');
      expect(existsSync(join(ringsDir, `${id}.bin`))).toBe(true);
      expect(existsSync(join(ringsDir, `${id}.meta.json`))).toBe(true);

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
      expect(existsSync(join(tmpDir, 'test', 'rings', `${id}.bin`))).toBe(false);
      expect(existsSync(join(tmpDir, 'test', 'rings', `${id}.meta.json`))).toBe(false);
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
      //
      // The pattern is `'A' * 255 + '\n'` repeated. The newline every 256 bytes
      // is load-bearing on macOS: a cooked-mode pty enforces MAX_CANON (the
      // maximum canonical input line length); a line longer than that with no
      // newline makes the line discipline ring the bell (BEL, 0x07) and STOP
      // echoing input — so a flat 1 MB of 'A' never echoes through `cat` and the
      // tail marker is permanently blocked behind the over-long line. Keeping
      // each line short keeps `cat`'s tty echo flowing on both Linux and macOS.
      const fillerLine = Buffer.from('A'.repeat(255) + '\n');
      const fillerReps = Math.ceil(FILLER_BYTES / fillerLine.length);
      const filler = Buffer.concat(Array(fillerReps).fill(fillerLine)).subarray(
        0,
        FILLER_BYTES,
      );
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
