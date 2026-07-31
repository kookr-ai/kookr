import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { listSignalFiles } from '../observability/signal-delivery/index.js';
import { runSignalEmitCli } from './kookr-signal-emit.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-signal-emit-cli-'));
}

// Silence CLI stdout/stderr during tests.
const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
afterEach(() => { outSpy.mockClear(); errSpy.mockClear(); });

describe('runSignalEmitCli transition', () => {
  test('ok then alert spools an alert signal', async () => {
    const dir = await tempDir();
    expect(await runSignalEmitCli(['transition', '--source', 'deploy-lag', '--status', 'ok', '--dir', dir])).toBe(0);
    expect(await listSignalFiles(dir)).toEqual([]);

    expect(await runSignalEmitCli(['transition', '--source', 'deploy-lag', '--status', 'alert', '--detail', '7 behind', '--dir', dir])).toBe(0);
    expect(await listSignalFiles(dir)).toEqual(['deploy-lag-alert.json']);
  });

  test('missing --status is a user error', async () => {
    const dir = await tempDir();
    expect(await runSignalEmitCli(['transition', '--source', 's', '--dir', dir])).toBe(2);
  });

  test('invalid --status is a user error', async () => {
    const dir = await tempDir();
    expect(await runSignalEmitCli(['transition', '--source', 's', '--status', 'bogus', '--dir', dir])).toBe(2);
  });
});

describe('runSignalEmitCli liveness', () => {
  test('a missing artifact in the registry spools a stale signal', async () => {
    const dir = await tempDir();
    const fixtures = await tempDir();
    const registryPath = join(fixtures, 'registry.json');
    await writeFile(registryPath, JSON.stringify([
      { name: 'gate-heartbeat', maxAgeMs: 3_600_000, path: join(fixtures, 'nonexistent-artifact.json') },
    ]));

    expect(await runSignalEmitCli(['liveness', '--registry', registryPath, '--dir', dir])).toBe(0);
    expect(await listSignalFiles(dir)).toContain('liveness-gate-heartbeat-stale.json');
  });

  test('a fresh artifact emits nothing', async () => {
    const dir = await tempDir();
    const fixtures = await tempDir();
    const artifact = join(fixtures, 'fresh.json');
    await writeFile(artifact, '{}');
    const registryPath = join(fixtures, 'registry.json');
    await writeFile(registryPath, JSON.stringify([
      { name: 'ledger', maxAgeMs: 3_600_000, path: artifact },
    ]));

    expect(await runSignalEmitCli(['liveness', '--registry', registryPath, '--dir', dir])).toBe(0);
    expect(await listSignalFiles(dir)).toEqual([]);
  });

  test('missing --registry is a user error', async () => {
    expect(await runSignalEmitCli(['liveness'])).toBe(2);
  });
});

describe('runSignalEmitCli misc', () => {
  test('no subcommand returns user error with help', async () => {
    expect(await runSignalEmitCli([])).toBe(2);
  });

  test('unknown subcommand returns user error', async () => {
    expect(await runSignalEmitCli(['bogus'])).toBe(2);
  });
});
