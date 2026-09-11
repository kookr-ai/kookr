import { execFileSync, fork, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect as connectSocket, Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHostBackend } from './terminal-host.js';
import { ViewerConnectionRegistry } from './viewer-connection-registry.js';
import { TERMINAL_V2_PROTOCOL } from '../shared/terminal-protocol.js';

describe('NFR-TERM-001: native isolated terminal ownership', () => {
  let host: TerminalHostBackend | undefined;
  let directory: string | undefined;
  const cleanup: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    if (host) {
      for (const id of await host.listSessions().catch(() => [])) await host.killSession(id);
      await host.closeAndDrain(); host = undefined;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    directory = await mkdtemp('/tmp/kookr-host-test-');
    host = await TerminalHostBackend.create({ socketDir: directory, instanceId: 'test',
      dtachBinary: resolve('vendor/dtach/dtach'), ringFlushIntervalMs: 100 });
    await host.createSession({ id: 'shell', command: '/bin/bash', args: ['--noprofile', '--norc'],
      env: { PS1: 'HOST_READY> ' }, size: { cols: 100, rows: 30 } });
    await expect.poll(async () => new TextDecoder().decode(await host!.captureBytes('shell'))).toContain('HOST_READY>');
    return host;
  }
  async function connect(backend: TerminalHostBackend, expiry?: number, policy: { revoked?: boolean; evict?: ReturnType<typeof vi.fn> } = {}) {
    const registry = new ViewerConnectionRegistry({ autoStartSweep: false,
      resolveGrantLiveness: () => policy.revoked ? 'revoked' : 'active', resolveGrantExpiryMs: () => expiry ?? null,
      onEvict: policy.evict });
    const server = createServer();
    server.on('upgrade', (request, socket, head) => {
      if (!(socket instanceof Socket)) { socket.destroy(); return; }
      backend.handoff(request, socket, head, 'shell', expiry
        ? { kind: 'viewer', grantId: 'test-viewer', scope: { kind: 'all' } } : { kind: 'owner' }, registry);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/shell`, TERMINAL_V2_PROTOCOL);
    cleanup.push(async () => { ws.terminate(); registry.stopSweep(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    const controls: Array<Record<string, unknown>> = [];
    const output: Buffer[] = [];
    ws.on('message', (data, binary) => {
      if (binary) output.push(Buffer.from(data as Buffer));
      else {
        const frame = JSON.parse(data.toString()); controls.push(frame);
        if (frame.type === 'hello') ws.send(JSON.stringify({ type: 'attach', attachId: 'a', generation: frame.generation,
          cols: 100, rows: 30 }));
      }
    });
    await expect.poll(() => controls.some((frame) => frame.type === 'seed-end')).toBe(true);
    return { ws, registry, controls, output, url: `ws://127.0.0.1:${address.port}/ws/terminal/shell` };
  }

  it('owns writes, readiness, captures and graceful persistence in one child', async () => {
    const backend = await start();
    backend.inputCoordinator.registerSession('shell');
    await backend.inputCoordinator.writeInput('shell', new TextEncoder().encode("printf 'HOST_MARKER\\n'\r"));
    await expect.poll(async () => new TextDecoder().decode(await backend.captureBytes('shell'))).toContain('HOST_MARKER');
    await expect.poll(() => backend.inputCoordinator.getSnapshot('shell')?.readinessVersion).toBe(1);
    expect(backend.getHostHealth().pid).not.toBe(process.pid);
    expect(backend.getStats().attachFailedCount).toBe(0);
    expect(backend.getStats().terminalHost).toMatchObject({
      status: 'ready', pendingRequests: 0, restarts: 0,
      channelBytes: expect.any(Number), streamBytes: expect.any(Number),
      reconstructionBytes: expect.any(Number), outputBytes: expect.any(Number),
      persistenceBytes: expect.any(Number), rssBytes: expect.any(Number),
    });
    expect(await backend.isAlive('shell')).toBe(true);
  });

  it('hands off an established socket so child-local pong survives a 200 ms parent stall', async () => {
    const backend = await start(); const { url } = await connect(backend);
    // The external probe owns the measuring clock and runs while this thread
    // is deliberately blocked. Its socket is distinct from the one above.
    const probe = spawn(process.execPath, ['-e', `
      const { WebSocket } = require('ws');
      const ws = new WebSocket(process.argv[1], process.argv[2]);
      ws.on('open', () => console.log('READY'));
      process.stdin.once('data', () => setTimeout(() => {
        const at = Date.now(); const start = performance.now();
        ws.once('pong', () => { console.log(JSON.stringify({ at, rtt: performance.now()-start })); ws.terminate(); process.stdin.destroy(); }); ws.ping();
      }, 50));
      ws.on('error', () => process.exit(2)); setTimeout(() => process.exit(3), 5000).unref();
    `, url, TERMINAL_V2_PROTOCOL], { stdio: ['pipe', 'pipe', 'pipe'] });
    cleanup.push(() => { if (probe.exitCode === null) probe.kill(); });
    let output = ''; probe.stdout.on('data', (data) => { output += String(data); });
    await expect.poll(() => output).toContain('READY');
    const blockedAt = Date.now(); probe.stdin.write('ping');
    execFileSync(process.execPath, ['-e', 'const end = Date.now()+200; while (Date.now()<end) {}']);
    const unblockedAt = Date.now();
    await expect.poll(() => output).toContain('rtt');
    const result = JSON.parse(output.trim().split('\n').at(-1)!);
    expect(result.at).toBeGreaterThanOrEqual(blockedAt);
    expect(result.at).toBeLessThan(unblockedAt);
    expect(result.rtt).toBeLessThan(100);
  });

  it('expires a viewer in the child even when main does not renew its lease', async () => {
    const backend = await start();
    const { ws, registry } = await connect(backend, Date.now() + 1000);
    await expect.poll(() => ws.readyState, { timeout: 3000 }).toBe(WebSocket.CLOSED);
    await expect.poll(() => registry.size()).toBe(0);
    expect(await backend.isAlive('shell')).toBe(true);
  });

  it('releases transferred connection slots when a WebSocket handshake is rejected', async () => {
    const backend = await start();
    const { registry, url } = await connect(backend);
    expect(registry.size()).toBe(1);
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = connectSocket(Number(new URL(url).port), '127.0.0.1');
        cleanup.push(() => { socket.destroy(); });
        let response = '';
        socket.on('data', (data) => { response += data.toString(); });
        socket.once('error', reject);
        socket.once('close', () => resolve(response));
        socket.once('connect', () => socket.write([
          'GET /ws/terminal/shell HTTP/1.1', 'Host: localhost', 'Connection: Upgrade',
          'Upgrade: websocket', 'Sec-WebSocket-Key: malformed', 'Sec-WebSocket-Version: 13', '', '',
        ].join('\r\n')));
      });
      expect(reply).toContain('400 Bad Request');
      await expect.poll(() => registry.size()).toBe(1);
    }
  });

  it('restores surviving readiness with a fresh epoch after child replacement', async () => {
    const backend = await start();
    await expect.poll(() => backend.inputCoordinator.getSnapshot('shell')).not.toBeNull();
    const previous = backend.inputCoordinator.getSnapshot('shell')!;
    const old = backend.getHostHealth();
    process.kill(old.pid!, 'SIGKILL');
    await expect.poll(() => backend.getHostHealth().generation, { timeout: 10_000 }).not.toBe(old.generation);
    await expect.poll(() => backend.getHostHealth().status, { timeout: 10_000 }).toBe('ready');
    expect(await backend.isAlive('shell')).toBe(true);
    await expect.poll(() => backend.inputCoordinator.getSnapshot('shell')).not.toBeNull();
    expect(backend.inputCoordinator.getSnapshot('shell')!.inputStateEpoch).not.toBe(previous.inputStateEpoch);
    await backend.inputCoordinator.markToolStarted('shell');
    await backend.inputCoordinator.markTurnStopped('shell');
    const current = backend.inputCoordinator.getSnapshot('shell')!;
    expect(current.readinessVersion).toBe(2);
    expect(await backend.inputCoordinator.markPromptReady('shell', {
      observedEpoch: previous.inputStateEpoch, observedReadinessVersion: previous.readinessVersion,
    })).toBe(false);
    expect(await backend.inputCoordinator.markPromptReady('shell', {
      observedEpoch: current.inputStateEpoch, observedReadinessVersion: current.readinessVersion,
    })).toBe(true);
  });

  it('restores registrations made during an outage and excludes sessions cleaned up during it', async () => {
    const backend = await start();
    const coordinator = backend.inputCoordinator;
    const old = backend.getHostHealth();
    process.kill(old.pid!, 'SIGKILL');
    await expect.poll(() => backend.getHostHealth().status).toBe('unavailable');
    coordinator.cleanupSession('shell');
    coordinator.registerSession('recovered-during-outage');
    await expect.poll(() => backend.getHostHealth().generation, { timeout: 10_000 }).not.toBe(old.generation);
    await expect.poll(() => coordinator.getSnapshot('recovered-during-outage')).not.toBeNull();
    await coordinator.markToolStarted('shell');
    expect(coordinator.getSnapshot('shell')).toBeNull();
    await coordinator.markToolStarted('recovered-during-outage');
    expect(coordinator.getSnapshot('recovered-during-outage')?.prompt).toEqual({ kind: 'blocked', reason: 'running' });
  });

  it('keeps readiness admission available while ordinary RPCs saturate the host', async () => {
    const backend = await start();
    const old = backend.getHostHealth();
    process.kill(old.pid!, 'SIGSTOP');
    const traffic = Promise.allSettled(Array.from({ length: 128 }, () => backend.captureBytes('shell')));
    const marks = Promise.allSettled([
      backend.inputCoordinator.markToolStarted('shell'),
      backend.inputCoordinator.markTurnStopped('shell'),
    ]);
    // Let the parent admit requests while the child cannot drain them.
    await new Promise((resolve) => setTimeout(resolve, 30));
    process.kill(old.pid!, 'SIGCONT');
    expect((await traffic).some((result) => result.status === 'rejected')).toBe(true);
    expect((await marks).every((result) => result.status === 'fulfilled')).toBe(true);
    expect(backend.inputCoordinator.getSnapshot('shell')).toMatchObject({ readinessVersion: 2, prompt: { kind: 'unknown' } });
  });

  it('acknowledges actual viewer revocation once without closing an owner of the same session', async () => {
    const backend = await start(); const owner = await connect(backend);
    const policy = { revoked: false, evict: vi.fn() };
    const viewer = await connect(backend, Date.now() + 10_000, policy);
    policy.revoked = true; viewer.registry.sweep();
    await expect.poll(() => viewer.ws.readyState).toBe(WebSocket.CLOSED);
    await expect.poll(() => policy.evict.mock.calls.length).toBe(1);
    expect(policy.evict).toHaveBeenCalledWith(expect.objectContaining({ reason: 'revoked', kind: 'terminal' }));
    expect(owner.ws.readyState).toBe(WebSocket.OPEN);
    expect(await backend.isAlive('shell')).toBe(true);
  });

  it('rejects capture/write RPCs during an outage without declaring the agent dead or replaying input', async () => {
    const backend = await start(); const old = backend.getHostHealth();
    process.kill(old.pid!, 'SIGSTOP');
    const pending = backend.write('shell', new TextEncoder().encode('MUST_NOT_REPLAY'));
    const read = backend.captureBytes('shell');
    const failures = Promise.allSettled([pending, read]);
    process.kill(old.pid!, 'SIGKILL');
    expect((await failures).every((result) => result.status === 'rejected')).toBe(true);
    await expect.poll(() => backend.getHostHealth().generation, { timeout: 10_000 }).not.toBe(old.generation);
    await expect.poll(() => backend.getHostHealth().status, { timeout: 10_000 }).toBe('ready');
    expect(await backend.isAlive('shell')).toBe(true);
    expect(new TextDecoder().decode(await backend.captureBytes('shell'))).not.toContain('MUST_NOT_REPLAY');
  });

  it('retains complete persisted history after graceful host replacement', async () => {
    let backend = await start();
    await backend.write('shell', new TextEncoder().encode("printf 'PERSISTED_CHECKPOINT\\n'\r"));
    await expect.poll(async () => new TextDecoder().decode(await backend.captureBytes('shell'))).toContain('PERSISTED_CHECKPOINT');
    await backend.closeAndDrain();
    host = backend = await TerminalHostBackend.create({ socketDir: directory, instanceId: 'test', dtachBinary: resolve('vendor/dtach/dtach') });
    expect(await backend.isAlive('shell')).toBe(true);
    expect(new TextDecoder().decode(await backend.captureBytes('shell'))).toContain('PERSISTED_CHECKPOINT');
  });

  it('reclaims completed-session cache slots so readiness survives >512 register/cleanup cycles', { timeout: 20_000 }, async () => {
    const backend = await start();
    const coordinator = backend.inputCoordinator;
    // Drive more than the 512-entry readiness-cache capacity through
    // register/cleanup cycles. Each cleanup leaves a null tombstone in the
    // parent cache; without reclamation these permanently consume capacity and
    // starve every later session. `isAlive` forces the ordered RPC responses
    // (which carry the readiness snapshots/tombstones) to be processed and the
    // per-session mutation marker to clear before the next cycle.
    for (let i = 0; i < 520; i++) {
      const id = `probe-${i}`;
      coordinator.registerSession(id);
      coordinator.cleanupSession(id);
      await backend.isAlive(id);
    }
    // A fresh registration must still become readable — the defect left the
    // parent snapshot null even though the host stayed healthy.
    const fresh = 'fresh-after-churn';
    coordinator.registerSession(fresh);
    await expect.poll(() => coordinator.getSnapshot(fresh)?.readinessVersion, { timeout: 10_000 }).toBe(0);
    const snapshot = coordinator.getSnapshot(fresh);
    expect(snapshot).not.toBeNull();
    // And the readiness path (what event-pipeline gates on the readable
    // snapshot) must fire for that fresh session.
    expect(await coordinator.markPromptReady(fresh,
      { observedEpoch: snapshot!.inputStateEpoch, observedReadinessVersion: snapshot!.readinessVersion })).toBe(true);
  });

  it('applies a hook-replay burst of readiness transitions without dropping any past the RPC cap', { timeout: 30_000 }, async () => {
    const backend = await start();
    const coordinator = backend.inputCoordinator;
    // Hook replay dispatches readiness marks synchronously without awaiting. In
    // host mode each is an RPC; firing >128 concurrently would overflow the
    // client's in-flight cap (128) and silently drop one (e.g. the trailing
    // stop), leaving the prompt stuck. Serialization must let the whole burst
    // apply. 130 just exceeds the cap while keeping the serialized round-trips
    // (and thus the wall-clock under full-suite contention) modest.
    const BURST = 130;
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < BURST; i++) pending.push(coordinator.markToolStarted('shell'));
    pending.push(coordinator.markTurnStopped('shell'));
    const results = await Promise.allSettled(pending);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // The trailing stop was applied (prompt not stuck blocked/running) and every
    // transition counted toward the readiness version.
    await expect.poll(() => coordinator.getSnapshot('shell')?.readinessVersion, { timeout: 15_000 }).toBe(BURST + 1);
    const snapshot = coordinator.getSnapshot('shell')!;
    expect(snapshot.prompt.kind).toBe('unknown');
    expect(await coordinator.markPromptReady('shell',
      { observedEpoch: snapshot.inputStateEpoch, observedReadinessVersion: snapshot.readinessVersion })).toBe(true);
  });

  it('does not drop readiness transitions in a cross-session burst past the RPC cap', { timeout: 30_000 }, async () => {
    const backend = await start();
    const coordinator = backend.inputCoordinator;
    // Hook replay across many sessions dispatches one fire-and-forget transition
    // per session synchronously. Per-session serialization does not bound this
    // (each session has one in-flight RPC), so without a global admission bound a
    // >128 cross-session burst overflows the RPC client's 128 in-flight cap and
    // rejects — dropping transitions. The global semaphore must queue them so all
    // are accepted. (Unregistered ids resolve as no-ops, which still exercises
    // admission — the point is that none are rejected by the cap.)
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 200; i++) pending.push(coordinator.markToolStarted(`cross-${i}`));
    const results = await Promise.allSettled(pending);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('closes child-owned sockets on parent IPC death while preserving the dtach master', async () => {
    directory = await mkdtemp('/tmp/kookr-host-test-');
    const parent = fork(join(__dirname, '__fixtures__/terminal-host-parent.ts'), [directory, resolve('vendor/dtach/dtach')],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    cleanup.push(() => { if (parent.exitCode === null && !parent.killed) parent.kill('SIGKILL'); });
    const ready = await new Promise<{ pid: number; port: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 5000);
      parent.once('message', (value) => { clearTimeout(timer); resolve(value as { pid: number; port: number }); });
      parent.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture exited before ready')); });
    });
    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws/terminal/shell`, TERMINAL_V2_PROTOCOL);
    cleanup.push(() => ws.terminate());
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    parent.kill('SIGKILL');
    await expect.poll(() => ws.readyState, { timeout: 5000 }).toBe(WebSocket.CLOSED);
    await expect.poll(async () => {
      try {
        process.kill(ready.pid, 0);
        if (process.platform === 'linux') return /\) Z /.test(await readFile(`/proc/${ready.pid}/stat`, 'utf8'));
        return false;
      } catch { return true; }
    }, { timeout: 5000 }).toBe(true);
    host = await TerminalHostBackend.create({ socketDir: directory, instanceId: 'test', dtachBinary: resolve('vendor/dtach/dtach') });
    expect(await host.isAlive('shell')).toBe(true);
  });
});
