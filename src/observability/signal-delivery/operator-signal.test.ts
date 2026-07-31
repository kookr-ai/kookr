import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  defaultOperatorSignalDir,
  listSignalFiles,
  loadDeliveredMarker,
  OPERATOR_SIGNAL_SCHEMA,
  readSignal,
  saveDeliveredMarker,
  signalFileName,
  writeOperatorSignal,
} from './operator-signal.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-operator-signal-'));
}

describe('signalFileName', () => {
  test('sanitizes keys deterministically', () => {
    expect(signalFileName('deploy-lag:alert')).toBe('deploy-lag-alert.json');
    expect(signalFileName('Liveness/Gate Heartbeat')).toBe('liveness-gate-heartbeat.json');
    expect(signalFileName('deploy-lag:alert')).toBe(signalFileName('deploy-lag:alert'));
  });

  test('never produces a leading dot (would collide with markers)', () => {
    expect(signalFileName('.hidden').startsWith('.')).toBe(false);
    expect(signalFileName('::')).toBe('signal.json');
  });
});

describe('writeOperatorSignal / read / list', () => {
  test('writes a valid signal file and reads it back', async () => {
    const dir = await tempDir();
    const { fileName, signal } = await writeOperatorSignal(dir, {
      key: 'deploy-lag:alert',
      kind: 'alert',
      source: 'deploy-lag',
      title: 'deploy-lag entered ALERT',
      detail: '7 commits behind',
    }, () => new Date('2026-07-31T00:00:00Z'));

    expect(fileName).toBe('deploy-lag-alert.json');
    expect(signal.schemaVersion).toBe(OPERATOR_SIGNAL_SCHEMA);
    expect(signal.createdAt).toBe('2026-07-31T00:00:00.000Z');

    const readBack = await readSignal(dir, fileName);
    expect(readBack?.title).toBe('deploy-lag entered ALERT');
    expect(readBack?.detail).toBe('7 commits behind');
  });

  test('re-emitting the same key overwrites in place (one file)', async () => {
    const dir = await tempDir();
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 'first' });
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 'second' });
    const files = await listSignalFiles(dir);
    expect(files).toEqual(['k.json']);
    expect((await readSignal(dir, 'k.json'))?.title).toBe('second');
  });

  test('listSignalFiles ignores markers, state dotfiles, and temp files', async () => {
    const dir = await tempDir();
    await writeOperatorSignal(dir, { key: 'a', kind: 'info', source: 's', title: 't' });
    await saveDeliveredMarker(dir, { 'a.json': '2026-07-31T00:00:00Z' });
    await writeFile(join(dir, '.liveness-state.json'), '{}');
    await writeFile(join(dir, 'b.json.tmp-123'), '{}');
    const files = await listSignalFiles(dir);
    expect(files).toEqual(['a.json']);
  });

  test('readSignal returns null for missing or invalid content', async () => {
    const dir = await tempDir();
    expect(await readSignal(dir, 'nope.json')).toBeNull();
    await writeFile(join(dir, 'bad.json'), 'not json');
    expect(await readSignal(dir, 'bad.json')).toBeNull();
    await writeFile(join(dir, 'wrong.json'), JSON.stringify({ schemaVersion: 'x' }));
    expect(await readSignal(dir, 'wrong.json')).toBeNull();
  });

  test('listSignalFiles returns [] for a missing directory', async () => {
    expect(await listSignalFiles(join(tmpdir(), 'kookr-does-not-exist-xyz'))).toEqual([]);
  });
});

describe('delivered marker', () => {
  test('round-trips and tolerates corruption', async () => {
    const dir = await tempDir();
    expect(await loadDeliveredMarker(dir)).toEqual({});
    await saveDeliveredMarker(dir, { 'a.json': 'ts' });
    expect(await loadDeliveredMarker(dir)).toEqual({ 'a.json': 'ts' });
    await writeFile(join(dir, '.delivered.json'), 'garbage');
    expect(await loadDeliveredMarker(dir)).toEqual({});
  });
});

describe('defaultOperatorSignalDir', () => {
  test('honors env override', () => {
    expect(defaultOperatorSignalDir({ KOOKR_OPERATOR_SIGNAL_DIR: '/custom/dir' } as NodeJS.ProcessEnv))
      .toBe('/custom/dir');
  });

  test('falls back to home-scoped playbook-state path', () => {
    const dir = defaultOperatorSignalDir({ HOME: '/home/u' } as NodeJS.ProcessEnv);
    expect(dir).toBe('/home/u/.kookr/playbook-state/operator-signals'); // portability-ok: fixture exercises HOME-based path derivation
  });
});
