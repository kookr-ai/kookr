import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertKookrDiff, snapshotDir, type FileSnapshot } from './local-only-smoke-files.js';

const startupFiles = [
  'last-good-health.json',
  'server.lock.sqlite',
  'tasks.json.pre-sqlite-2026-09-14T02-20-45-356Z',
  'tasks.sqlite',
  'timer-health.state.json',
];

function snapshot(paths: string[], type: 'file' | 'dir' | 'other' = 'file', size = 1, mtimeMs = 1): FileSnapshot {
  return { entries: new Map(paths.map((path) => [path, { type, size, mtimeMs }])) };
}

describe('local-only smoke filesystem assertion', () => {
  it('admits the SQLite startup artifacts observed in an isolated smoke run', () => {
    const root = mkdtempSync(join(tmpdir(), 'local-only-smoke-files-'));
    try {
      writeFileSync(join(root, 'tasks.json'), '[]\n');
      const before = snapshotDir(root);
      for (const file of startupFiles) writeFileSync(join(root, file), 'state\n');
      mkdirSync(join(root, 'hooks'));
      writeFileSync(join(root, 'hooks', 'smoke.jsonl'), '{}\n');
      expect(() => assertKookrDiff(before, snapshotDir(root))).not.toThrow();

      writeFileSync(join(root, 'unexpected.sqlite'), 'state\n');
      expect(() => assertKookrDiff(before, snapshotDir(root))).toThrow('new file: unexpected.sqlite');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(startupFiles)('allows subsequent updates and removal of %s', (file) => {
    expect(() => assertKookrDiff(snapshot([file]), snapshot([file], 'file', 2, 2))).not.toThrow();
    expect(() => assertKookrDiff(snapshot([file]), snapshot([]))).not.toThrow();
  });

  it.each(startupFiles)('does not admit a directory or symlink named %s', (file) => {
    for (const type of ['dir', 'other'] as const) {
      expect(() => assertKookrDiff(snapshot([]), snapshot([file], type))).toThrow(`new ${type}: ${file}`);
    }
  });

  it.each([
    'unexpected.json',
    'unexpected.sqlite',
    'tasks.sqlite-wal',
    'tasks.sqlite-shm',
    'server.lock.sqlite-journal',
    'tasks.sqlite/extra.json',
    'last-good-health.json.tmp',
    'tasks.json.pre-sqlite-',
    'tasks.json.pre-sqlite-unrelated',
    'tasks.json.pre-sqlite-2026-09-14T02-20-45-356Z.extra',
    'tasks.json.pre-sqlite-2026-09-14T02:20:45.356Z',
    'nested/tasks.sqlite',
  ])('rejects unexpected startup state: %s', (file) => {
    expect(() => assertKookrDiff(snapshot([]), snapshot([file]))).toThrow(`new file: ${file}`);
  });

  it.each(['audit.db', 'audit.jsonl', 'command-journal.jsonl', 'node-epoch', 'policy-cache.json'])(
    'rejects forbidden artifacts even under an existing allowed directory: %s', (file) => {
      for (const path of [file, `hooks/${file}`, `sessions/${file}`, `settings/${file}`, `activity/${file}`]) {
        expect(() => assertKookrDiff(snapshot([path]), snapshot([path]))).toThrow(`forbidden file: ${path}`);
      }
    },
  );

  it.each(['remote/tasks.sqlite', 'relay/tasks.sqlite'])('rejects remote or relay state: %s', (file) => {
    expect(() => assertKookrDiff(snapshot([]), snapshot([file]))).toThrow(`forbidden file: ${file}`);
  });

  it('preserves unchanged unrelated files but rejects changes and removals', () => {
    const before = snapshot(['operator.json']);
    expect(() => assertKookrDiff(before, snapshot(['operator.json']))).not.toThrow();
    for (const after of [snapshot(['operator.json'], 'file', 2), snapshot(['operator.json'], 'file', 1, 2)]) {
      expect(() => assertKookrDiff(before, after)).toThrow('changed file: operator.json');
    }
    expect(() => assertKookrDiff(before, snapshot(['operator.json'], 'dir'))).toThrow('changed dir: operator.json');
    expect(() => assertKookrDiff(before, snapshot([]))).toThrow('removed: operator.json');
  });
});
