import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../../relay/server.js';
import {
  buildRelayDoctorReport,
  diagnoseRelayEnv,
  diagnoseRelayNode,
  diagnoseRelayProcess,
  relayLifecyclePaths,
  startRelay,
  stopRelay,
} from './relay-lifecycle.js';

const cleanupDirs: string[] = [];
let relay: RelayServerHandle | null = null;

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function listenRelay(opts: { adminToken?: string } = {}): Promise<string> {
  relay = createRelayServer({ adminToken: opts.adminToken ?? 'admin-secret', bindHost: '127.0.0.1' });
  await new Promise<void>((resolve) => relay!.httpServer.listen(0, '127.0.0.1', () => resolve()));
  return relay.url();
}

async function createTemporaryPortListener(host = '127.0.0.1'): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP listener');
  return {
    port: address.port,
    close: () => new Promise((resolveClose, reject) => server.close((err) => err ? reject(err) : resolveClose())),
  };
}

async function freePort(): Promise<number> {
  const listener = await createTemporaryPortListener('127.0.0.1');
  const port = listener.port;
  await listener.close();
  return port;
}

async function waitForRelayAdmin(relayUrl: string, token: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL('/relay/admin/nodes', relayUrl), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`relay did not become ready: ${lastError}`);
}

afterEach(async () => {
  if (relay) {
    await relay.close();
    relay = null;
  }
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('relay lifecycle diagnostics', () => {
  it('diagnoses a stopped relay and missing env without exposing secrets', async () => {
    const cwd = await tempDir('kookr-relay-stopped-');
    const kookrDir = join(cwd, '.kookr');
    const portProbe = await createTemporaryPortListener('127.0.0.1');
    const port = portProbe.port;
    await portProbe.close();
    const report = await buildRelayDoctorReport({
      cwd,
      kookrDir,
      env: {
        KOOKR_DIR: kookrDir,
        KOOKR_RELAY_BIND_HOST: '127.0.0.1',
        KOOKR_RELAY_PORT: String(port),
        KOOKR_RELAY_TOKEN: 'kookr_tok_v1_super_secret',
      },
      now: () => new Date('2026-05-17T10:00:00.000Z'),
    });

    expect(report.process.state).toBe('stopped');
    expect(report.env.state).toBe('missing-env');
    expect(report.node.state).toBe('not-configured');
    expect(JSON.stringify(report)).not.toContain('super_secret');
    expect(report.nextActions).toContain('Start the local relay with pnpm relay:start.');
    expect(report.nextActions).toContain('Fix .env before starting relay.');
  });

  it('treats stale pid files as removable relay state', async () => {
    const cwd = await tempDir('kookr-relay-stale-');
    const paths = relayLifecyclePaths(join(cwd, '.kookr'));
    mkdirSync(paths.kookrDir, { recursive: true });
    writeFileSync(paths.pidPath, '99999999\n', 'utf8');

    const before = await diagnoseRelayProcess({
      cwd,
      kookrDir: paths.kookrDir,
      env: { KOOKR_RELAY_PORT: '18999' },
    });
    expect(before.state).toBe('stale-pid');

    const stopped = await stopRelay({
      cwd,
      kookrDir: paths.kookrDir,
      env: { KOOKR_RELAY_PORT: '18999' },
    });
    expect(stopped).toBe('Removed stale relay pid file.');
    expect(() => readFileSync(paths.pidPath, 'utf8')).toThrow();
  });

  it('cleans stale pid and starts the detached relay with env values loaded from .env', async () => {
    const configDir = await tempDir('kookr-relay-start-env-');
    const cwd = process.cwd();
    const kookrDir = join(configDir, '.kookr');
    const paths = relayLifecyclePaths(kookrDir);
    const port = await freePort();
    mkdirSync(paths.kookrDir, { recursive: true });
    writeFileSync(paths.pidPath, '99999999\n', 'utf8');
    const envFilePath = join(configDir, '.env');
    await writeFile(envFilePath, 'KOOKR_RELAY_ADMIN_TOKEN=env-file-secret\n', 'utf8');

    const env = {
      KOOKR_DIR: kookrDir,
      KOOKR_RELAY_ENV_FILE: envFilePath,
      KOOKR_RELAY_BIND_HOST: '127.0.0.1',
      KOOKR_RELAY_PORT: String(port),
    };
    try {
      await startRelay({ cwd, kookrDir, env });
      await waitForRelayAdmin(`http://127.0.0.1:${port}`, 'env-file-secret');
      const diagnosis = await diagnoseRelayProcess({ cwd, kookrDir, env });
      expect(diagnosis.state).toBe('running');
      expect(() => readFileSync(paths.pidPath, 'utf8')).not.toThrow();
    } finally {
      await stopRelay({ cwd, kookrDir, env }).catch(() => undefined);
    }

    const after = await diagnoseRelayProcess({ cwd, kookrDir, env });
    expect(after.state).toBe('stopped');
  });

  it('uses the same .env admin token for doctor policy diagnostics', async () => {
    const configDir = await tempDir('kookr-relay-doctor-env-policy-');
    const cwd = process.cwd();
    const kookrDir = join(configDir, '.kookr');
    const port = await freePort();
    const envFilePath = join(configDir, '.env');
    await writeFile(envFilePath, 'KOOKR_RELAY_ADMIN_TOKEN=doctor-env-secret\n', 'utf8');
    const env = {
      KOOKR_DIR: kookrDir,
      KOOKR_RELAY_ENV_FILE: envFilePath,
      KOOKR_RELAY_BIND_HOST: '127.0.0.1',
      KOOKR_RELAY_PORT: String(port),
    };

    try {
      await startRelay({ cwd, kookrDir, env });
      await waitForRelayAdmin(`http://127.0.0.1:${port}`, 'doctor-env-secret');
      const report = await buildRelayDoctorReport({ cwd, kookrDir, env });
      expect(report.env.state).toBe('ok');
      expect(report.policy).toEqual(expect.objectContaining({
        status: 'ok',
        nodeCount: 0,
        invitationCount: 0,
      }));
    } finally {
      await stopRelay({ cwd, kookrDir, env }).catch(() => undefined);
    }
  });

  it('honors .env relay topology keys when starting and diagnosing the relay', async () => {
    const configDir = await tempDir('kookr-relay-env-topology-');
    const cwd = process.cwd();
    const kookrDir = join(configDir, '.kookr');
    const port = await freePort();
    const envFilePath = join(configDir, '.env');
    const stateDbPath = join(configDir, 'custom-relay.sqlite');
    await writeFile(envFilePath, [
      'KOOKR_RELAY_ADMIN_TOKEN=topology-env-secret',
      'KOOKR_RELAY_BIND_HOST=127.0.0.1',
      `KOOKR_RELAY_PORT=${port}`,
      `KOOKR_RELAY_STATE_DB_PATH=${stateDbPath}`,
      '',
    ].join('\n'), 'utf8');
    const env = {
      KOOKR_DIR: kookrDir,
      KOOKR_RELAY_ENV_FILE: envFilePath,
    };

    try {
      await startRelay({ cwd, kookrDir, env });
      await waitForRelayAdmin(`http://127.0.0.1:${port}`, 'topology-env-secret');
      const report = await buildRelayDoctorReport({ cwd, kookrDir, env });
      expect(report.process).toEqual(expect.objectContaining({
        state: 'running',
        port,
        relayUrl: `http://127.0.0.1:${port}`,
      }));
      expect(report.paths.dbPath).toBe(join(kookrDir, 'relay.sqlite'));
      expect(report.storage.dbPath).toBe(stateDbPath);
      const state = JSON.parse(readFileSync(relayLifecyclePaths(kookrDir).statePath, 'utf8')) as { stateDbPath?: string };
      expect(state.stateDbPath).toBe(stateDbPath);
    } finally {
      await stopRelay({ cwd, kookrDir, env }).catch(() => undefined);
    }
  });

  it('refuses to claim a port owned by another process', async () => {
    const cwd = await tempDir('kookr-relay-foreign-port-');
    const listener = await createTemporaryPortListener('127.0.0.1');
    try {
      const diagnosis = await diagnoseRelayProcess({
        cwd,
        kookrDir: join(cwd, '.kookr'),
        env: { KOOKR_RELAY_BIND_HOST: '127.0.0.1', KOOKR_RELAY_PORT: String(listener.port) },
      });
      expect(diagnosis.state).toBe('foreign-port');
      expect(diagnosis.message).toContain(String(listener.port));
    } finally {
      await listener.close();
    }
  });

  it('refuses to start when the configured relay port belongs to another process', async () => {
    const cwd = await tempDir('kookr-relay-start-foreign-port-');
    const listener = await createTemporaryPortListener('127.0.0.1');
    try {
      await expect(startRelay({
        cwd,
        kookrDir: join(cwd, '.kookr'),
        env: {
          KOOKR_RELAY_BIND_HOST: '127.0.0.1',
          KOOKR_RELAY_PORT: String(listener.port),
          KOOKR_RELAY_INSECURE_DEV: '1',
        },
      })).rejects.toThrow(/already listening|choose KOOKR_RELAY_PORT/);
    } finally {
      await listener.close();
    }
  });

  it('refuses to stop a relay pid owned by another runtime topology', async () => {
    const cwd = await tempDir('kookr-relay-stop-foreign-topology-');
    const otherCwd = await tempDir('kookr-relay-stop-other-topology-');
    const kookrDir = join(cwd, '.kookr');
    const paths = relayLifecyclePaths(kookrDir);
    const port = await freePort();
    mkdirSync(kookrDir, { recursive: true });
    writeFileSync(paths.pidPath, `${process.pid}\n`, 'utf8');
    await writeFile(paths.statePath, JSON.stringify({
      schemaVersion: 'relay-lifecycle-state.v1',
      mode: 'detached',
      pid: process.pid,
      command: ['node', 'relay/server.ts'],
      cwd: otherCwd,
      bindHost: '127.0.0.1',
      port,
      relayUrl: `http://127.0.0.1:${port}`,
      stateDbPath: paths.dbPath,
      logPath: paths.logPath,
      startedAt: '2026-05-17T00:00:00.000Z',
    }), 'utf8');

    const env = { KOOKR_RELAY_BIND_HOST: '127.0.0.1', KOOKR_RELAY_PORT: String(port) };
    const diagnosis = await diagnoseRelayProcess({ cwd, kookrDir, env });
    expect(diagnosis.state).toBe('foreign-process');
    await expect(stopRelay({ cwd, kookrDir, env })).rejects.toThrow(/Refusing to stop an unowned process/);
  });

  it('reports rejected node tokens as a re-pair diagnosis', async () => {
    const cwd = await tempDir('kookr-relay-token-');
    const relayUrl = await listenRelay();

    const diagnosis = await diagnoseRelayNode({
      cwd,
      kookrDir: join(cwd, '.kookr'),
      env: {
        KOOKR_RELAY_URL: relayUrl,
        KOOKR_RELAY_TOKEN: 'wrong-token',
      },
    });

    expect(diagnosis).toEqual(expect.objectContaining({
      state: 'token-rejected',
      relayUrl,
      message: 'Relay rejected the configured node token; re-pair this node.',
    }));
  });

  it('detects relay env changes that require relay restart', async () => {
    const cwd = await tempDir('kookr-relay-restart-required-');
    const kookrDir = join(cwd, '.kookr');
    const paths = relayLifecyclePaths(kookrDir);
    mkdirSync(kookrDir, { recursive: true });
    const envPath = join(cwd, '.env');
    await writeFile(envPath, 'KOOKR_RELAY_ADMIN_TOKEN=old-secret\n', 'utf8');
    const oldHash = 'old-env-hash';
    await writeFile(paths.statePath, JSON.stringify({
      schemaVersion: 'relay-lifecycle-state.v1',
      mode: 'detached',
      pid: 99999999,
      command: ['node', 'relay/server.ts'],
      cwd,
      bindHost: '127.0.0.1',
      port: 8080,
      relayUrl: 'http://127.0.0.1:8080',
      stateDbPath: paths.dbPath,
      logPath: paths.logPath,
      startedAt: '2026-05-17T00:00:00.000Z',
      envFilePath: envPath,
      envFileHash: oldHash,
    }), 'utf8');
    await writeFile(envPath, 'KOOKR_RELAY_ADMIN_TOKEN=new-secret\n', 'utf8');

    const diagnosis = diagnoseRelayEnv({
      cwd,
      kookrDir,
      env: { KOOKR_RELAY_ADMIN_TOKEN: 'old-secret' },
    });

    expect(diagnosis).toEqual(expect.objectContaining({
      state: 'restart-required',
      requiresRestart: true,
      message: 'The relay env file changed after the relay process started; restart relay with pnpm relay:restart.',
    }));
  });

  it('reports fix-env instead of restart-required when env changes remove the admin token', async () => {
    const cwd = await tempDir('kookr-relay-env-token-removed-');
    const kookrDir = join(cwd, '.kookr');
    const paths = relayLifecyclePaths(kookrDir);
    mkdirSync(kookrDir, { recursive: true });
    const envPath = join(cwd, '.env');
    await writeFile(envPath, 'KOOKR_RELAY_ADMIN_TOKEN=old-secret\n', 'utf8');
    let stateText = '';
    await startRelay({ cwd: process.cwd(), kookrDir, env: {
      KOOKR_RELAY_ENV_FILE: envPath,
      KOOKR_RELAY_BIND_HOST: '127.0.0.1',
      KOOKR_RELAY_PORT: String(await freePort()),
    } }).then(async () => {
      stateText = readFileSync(paths.statePath, 'utf8');
      await stopRelay({ cwd: process.cwd(), kookrDir, env: { KOOKR_RELAY_ENV_FILE: envPath } }).catch(() => undefined);
    });
    await writeFile(paths.statePath, stateText, 'utf8');
    await writeFile(envPath, '# token removed\n', 'utf8');

    const diagnosis = diagnoseRelayEnv({ cwd, kookrDir, env: {} });
    expect(diagnosis).toEqual(expect.objectContaining({
      state: 'missing-admin-token',
      requiresRestart: false,
    }));
  });

  it('ignores comment-only .env changes for restart-required diagnosis', async () => {
    const cwd = await tempDir('kookr-relay-env-comment-');
    const kookrDir = join(cwd, '.kookr');
    const paths = relayLifecyclePaths(kookrDir);
    mkdirSync(kookrDir, { recursive: true });
    const envPath = join(cwd, '.env');
    await writeFile(envPath, 'KOOKR_RELAY_ADMIN_TOKEN=stable-secret\n', 'utf8');
    await startRelay({ cwd: process.cwd(), kookrDir, env: {
      KOOKR_RELAY_ENV_FILE: envPath,
      KOOKR_RELAY_BIND_HOST: '127.0.0.1',
      KOOKR_RELAY_PORT: String(await freePort()),
    } });
    const stateText = readFileSync(paths.statePath, 'utf8');
    await stopRelay({ cwd: process.cwd(), kookrDir, env: { KOOKR_RELAY_ENV_FILE: envPath } }).catch(() => undefined);
    await writeFile(paths.statePath, stateText, 'utf8');
    await writeFile(envPath, '# harmless comment\nKOOKR_RELAY_ADMIN_TOKEN=stable-secret\n', 'utf8');

    const diagnosis = diagnoseRelayEnv({ cwd, kookrDir, env: {} });
    expect(diagnosis.state).toBe('ok');
  });

  it('does not trust a relay-looking pid when the state file records a different pid', async () => {
    const configDir = await tempDir('kookr-relay-state-pid-mismatch-');
    const cwd = process.cwd();
    const kookrDir = join(configDir, '.kookr');
    const paths = relayLifecyclePaths(kookrDir);
    const port = await freePort();
    const envFilePath = join(configDir, '.env');
    await writeFile(envFilePath, 'KOOKR_RELAY_ADMIN_TOKEN=pid-mismatch-secret\n', 'utf8');
    const env = {
      KOOKR_RELAY_ENV_FILE: envFilePath,
      KOOKR_RELAY_BIND_HOST: '127.0.0.1',
      KOOKR_RELAY_PORT: String(port),
    };
    let pid = 0;
    try {
      await startRelay({ cwd, kookrDir, env });
      await waitForRelayAdmin(`http://127.0.0.1:${port}`, 'pid-mismatch-secret');
      pid = Number.parseInt(readFileSync(paths.pidPath, 'utf8'), 10);
      const state = JSON.parse(readFileSync(paths.statePath, 'utf8')) as { pid: number };
      await writeFile(paths.statePath, JSON.stringify({ ...state, pid: pid + 1 }), 'utf8');

      const diagnosis = await diagnoseRelayProcess({ cwd, kookrDir, env });
      expect(diagnosis).toEqual(expect.objectContaining({
        state: 'foreign-process',
        pid,
      }));
    } finally {
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // already exited
        }
      }
    }
  });

  it('dispatches relay status through the package script', async () => {
    const cwd = await tempDir('kookr-relay-script-status-');
    const port = await freePort();
    const output = execFileSync('pnpm', ['relay:status'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        KOOKR_DIR: join(cwd, '.kookr'),
        KOOKR_RELAY_BIND_HOST: '127.0.0.1',
        KOOKR_RELAY_PORT: String(port),
      },
    });

    expect(output).toContain('"state": "stopped"');
    expect(output).toContain(`"port": ${port}`);
  });
});
