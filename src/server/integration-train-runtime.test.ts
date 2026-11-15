import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  effectiveIntegrationTrainStateDir,
  isIntegrationTrainProcess,
  looksLikeTrainCommand,
  readIntegrationTrainStatus,
  repoKeyFromRemoteUrl,
} from './integration-train-runtime.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'train-runtime-'));
  dirs.push(d);
  return d;
}

describe('repoKeyFromRemoteUrl', () => {
  it('gives the ssh and https forms of one repository the same key', () => {
    for (const url of [
      'git@github.com:kookr-ai/kookr.git',
      'https://github.com/kookr-ai/kookr',
      'https://github.com/kookr-ai/kookr.git/',
      'ssh://git@github.com/Kookr-AI/kookr.git',
    ]) {
      expect(repoKeyFromRemoteUrl(url)).toBe('kookr-ai-kookr');
    }
  });

  it('separates repositories and rejects URLs with no owner/name', () => {
    expect(repoKeyFromRemoteUrl('git@github.com:kookr-ai/lucy.git')).toBe('kookr-ai-lucy');
    expect(repoKeyFromRemoteUrl('/tmp/origin.git')).toBeNull();
    expect(repoKeyFromRemoteUrl('https://github.com/kookr')).toBeNull();
    expect(repoKeyFromRemoteUrl('')).toBeNull();
  });
});

describe('train process identity', () => {
  it('recognises only the run loop of the train script', () => {
    expect(looksLikeTrainCommand('/usr/bin/node --import tsx /srv/kookr/scripts/integration-train.ts run --worktree /w')).toBe(true);
    expect(looksLikeTrainCommand('node scripts/integration-train.ts run')).toBe(true);
    expect(looksLikeTrainCommand('node scripts/integration-train.ts cycle')).toBe(false);
    expect(looksLikeTrainCommand('node scripts/integration-train.ts runner')).toBe(false);
    expect(looksLikeTrainCommand('vim scripts/integration-train.test.ts')).toBe(false);
    expect(looksLikeTrainCommand('sleep 100')).toBe(false);
  });

  it('treats a gone pid and a reused pid as not the train', () => {
    expect(isIntegrationTrainProcess(42, () => null)).toBe(false);
    expect(isIntegrationTrainProcess(42, () => 'postgres: writer process')).toBe(false);
    expect(isIntegrationTrainProcess(42, () => 'node scripts/integration-train.ts run')).toBe(true);
    // this test process is alive but is not the train
    expect(isIntegrationTrainProcess(process.pid)).toBe(false);
  });
});

describe('readIntegrationTrainStatus', () => {
  it('reports the halt, the last cycle and whether the pid is the train', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'train.pid'), '1234');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ halted: { reason: 'base-red', main: 'a', integration: 'b', at: '2026-11-15T10:00:00Z' } }));
    writeFileSync(join(dir, 'last-cycle.json'), JSON.stringify({ at: '2026-11-15T10:01:00Z', outcome: 'halted', reason: 'base-red' }));
    expect(readIntegrationTrainStatus(dir, (pid) => pid === 1234)).toEqual({
      stateDir: dir,
      running: true,
      pid: 1234,
      halted: { reason: 'base-red', at: '2026-11-15T10:00:00Z' },
      lastCycle: { at: '2026-11-15T10:01:00Z', outcome: 'halted', reason: 'base-red' },
    });
    expect(readIntegrationTrainStatus(dir, () => false).running).toBe(false);
  });

  it('is empty and never throws for a missing or corrupt directory', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'state.json'), '{not json');
    expect(readIntegrationTrainStatus(join(dir, 'nope'))).toMatchObject({ running: false, pid: null, halted: null, lastCycle: null });
    expect(readIntegrationTrainStatus(dir)).toMatchObject({ halted: null });
  });
});

describe('effectiveIntegrationTrainStateDir', () => {
  it('prefers the keyed directory and falls back to the pre-#3796 shared one', () => {
    const kookrDir = tmp();
    const base = join(kookrDir, 'integration-train');
    expect(effectiveIntegrationTrainStateDir(kookrDir, 'acme-kookr')).toBe(join(base, 'acme-kookr'));
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'state.json'), '{}');
    expect(effectiveIntegrationTrainStateDir(kookrDir, 'acme-kookr')).toBe(base);
    mkdirSync(join(base, 'acme-kookr'));
    writeFileSync(join(base, 'acme-kookr', 'state.json'), '{}');
    expect(effectiveIntegrationTrainStateDir(kookrDir, 'acme-kookr')).toBe(join(base, 'acme-kookr'));
  });
});
