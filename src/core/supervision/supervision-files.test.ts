import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveDataDir,
  supervisionDir,
  writeFileAtomic,
  writeSupervisionFiles,
  type SupervisionFs,
  type SupervisionState,
} from './supervision-files.js';

const state: SupervisionState = {
  supervisionId: 'sup-1',
  targets: [{ taskId: 'task-aaaaaaaa', name: 'alpha' }],
  goals: ['ship it'],
  deadlineAt: '2026-11-08T20:00:00.000Z',
  createdAt: '2026-11-08T16:00:00.000Z',
  supervisorTaskId: null,
};

describe('resolveDataDir', () => {
  it('maps the resolved server port to the data dir and ignores KOOKR_DIR', () => {
    expect(resolveDataDir('http://127.0.0.1:4800', { KOOKR_DIR: '/x/data' }, '/h')).toBe('/h/.kookr');
    expect(resolveDataDir('http://127.0.0.1:4801', { KOOKR_DIR: '/x/data' }, '/h')).toBe('/h/.kookr-4801');
  });
  it('falls back to KOOKR_PORT (numerically normalised) when the URL has no port', () => {
    expect(resolveDataDir('https://kookr.example', { KOOKR_PORT: '4801' }, '/h')).toBe('/h/.kookr-4801');
    expect(resolveDataDir(undefined, { KOOKR_PORT: '04800' }, '/h')).toBe('/h/.kookr');
    expect(resolveDataDir(undefined, { KOOKR_PORT: 'auto' }, '/h')).toBe('/h/.kookr');
    expect(resolveDataDir(undefined, {}, '/h')).toBe('/h/.kookr');
  });
});

describe('writeSupervisionFiles', () => {
  it('writes brief.md and state.json and leaves no temp files', () => {
    const root = mkdtempSync(join(tmpdir(), 'sup-files-'));
    const dir = writeSupervisionFiles(root, state, '# brief\n');
    expect(dir).toBe(supervisionDir(root, 'sup-1'));
    expect(readFileSync(join(dir, 'brief.md'), 'utf-8')).toBe('# brief\n');
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))).toEqual(state);
    expect(readdirSync(dir).sort()).toEqual(['brief.md', 'state.json']);
  });

  it('rewrites only state.json when no brief is given', () => {
    const root = mkdtempSync(join(tmpdir(), 'sup-files-'));
    const dir = writeSupervisionFiles(root, state, 'brief');
    writeSupervisionFiles(root, { ...state, supervisorTaskId: 't-sup' }, undefined);
    expect(readFileSync(join(dir, 'brief.md'), 'utf-8')).toBe('brief');
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')).supervisorTaskId).toBe('t-sup');
  });
});

describe('writeFileAtomic', () => {
  it('writes to a temp path then renames onto the final path', () => {
    const calls: string[] = [];
    const fs: SupervisionFs = {
      mkdirSync: () => undefined,
      writeFileSync: (p) => calls.push(`write ${p}`),
      renameSync: (a, b) => calls.push(`rename ${a} -> ${b}`),
      rmSync: (p) => calls.push(`rm ${p}`),
    };
    writeFileAtomic('/d/state.json', 'x', fs);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^write \/d\/state\.json\.tmp-/);
    expect(calls[1]).toMatch(/^rename \/d\/state\.json\.tmp-\d+ -> \/d\/state\.json$/);
  });

  it('never touches the final path and cleans up when the write fails', () => {
    const calls: string[] = [];
    const fs: SupervisionFs = {
      mkdirSync: () => undefined,
      writeFileSync: () => {
        throw new Error('disk full');
      },
      renameSync: (a, b) => calls.push(`rename ${a} -> ${b}`),
      rmSync: (p) => calls.push(`rm ${p}`),
    };
    expect(() => writeFileAtomic('/d/state.json', 'x', fs)).toThrow('disk full');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^rm \/d\/state\.json\.tmp-/);
  });
});

describe('reading supervisions (P2a)', () => {
  it('lists and reads states, tolerating P1 files and garbage', async () => {
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { listSupervisionStates, readSupervisionState, writeSupervisionFiles } = await import('./supervision-files.js');
    const dir = mkdtempSync(join(tmpdir(), 'kookr-sup-read-'));
    try {
      const p1 = {
        supervisionId: 'sup-a',
        targets: [{ taskId: 't', name: 'n' }],
        goals: [],
        deadlineAt: '2026-11-08T14:00:00.000Z',
        createdAt: '2026-11-08T10:00:00.000Z',
        supervisorTaskId: null,
      };
      writeSupervisionFiles(dir, p1, 'brief');
      mkdirSync(join(dir, 'supervisions', 'broken'), { recursive: true });
      writeFileSync(join(dir, 'supervisions', 'broken', 'state.json'), '{not json');
      expect(listSupervisionStates(dir)).toEqual([p1]);
      expect(readSupervisionState(dir, 'sup-a')).toEqual(p1);
      expect(readSupervisionState(dir, '../sup-a')).toBeUndefined();
      expect(readSupervisionState(dir, 'missing')).toBeUndefined();
      expect(listSupervisionStates(join(dir, 'nowhere'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
