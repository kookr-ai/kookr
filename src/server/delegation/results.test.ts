import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parseTriageReply, pathExistsInSnapshot, stripSingleJsonFence, validateTriageResult } from './results.js';

const verdict = {
  type: 'bug',
  priority: 'P2',
  size: 'S',
  ready_to_implement: true,
  needs_info: [],
  related_issues: [12, '#13'],
  risk: 'low',
  files_likely_touched: ['src/a.ts', 'src/b.ts'],
  summary: 'Fix the thing.',
  recommended_next_step: 'Implement it.',
};

let snap: string;
beforeEach(() => {
  snap = mkdtempSync(join(tmpdir(), 'delegation-results-'));
  mkdirSync(join(snap, 'src'));
  writeFileSync(join(snap, 'src/a.ts'), 'a');
  writeFileSync(join(snap, 'src/b.ts'), 'b');
});
afterEach(() => rmSync(snap, { recursive: true, force: true }));

describe('parseTriageReply', () => {
  test('accepts a bare JSON object', () => {
    expect(parseTriageReply(JSON.stringify(verdict))).toMatchObject({ ok: true, verdict: { type: 'bug', priority: 'P2' } });
  });

  test('accepts exactly one surrounding ```json fence', () => {
    const fenced = '```json\n' + JSON.stringify(verdict, null, 2) + '\n```';
    expect(parseTriageReply(fenced).ok).toBe(true);
    expect(stripSingleJsonFence('  ```JSON\n{}\n```  ')).toBe('{}');
  });

  test.each([
    ['prose before', 'Here you go:\n' + JSON.stringify(verdict)],
    ['prose after', JSON.stringify(verdict) + '\nHope that helps!'],
    ['double fence', '```json\n```json\n' + JSON.stringify(verdict) + '\n```\n```'],
    ['two objects', JSON.stringify(verdict) + JSON.stringify(verdict)],
    ['a JSON array', '[' + JSON.stringify(verdict) + ']'],
    ['a bare string', '"ok"'],
    ['trailing comma', JSON.stringify(verdict).replace(/}$/, ',}')],
    ['empty', ''],
    ['unlabelled fence with prose', 'Result:\n```\n' + JSON.stringify(verdict) + '\n```'],
  ])('rejects: %s (never repaired)', (_name, text) => {
    expect(parseTriageReply(text)).toMatchObject({ ok: false });
  });

  test.each([
    ['bad enum', { ...verdict, type: 'epic' }],
    ['bad priority', { ...verdict, priority: 'P9' }],
    ['bad size', { ...verdict, size: 'XXL' }],
    ['bad risk', { ...verdict, risk: 'extreme' }],
    ['non-boolean ready', { ...verdict, ready_to_implement: 'yes' }],
    ['missing summary', { ...verdict, summary: undefined }],
    ['non-array needs_info', { ...verdict, needs_info: 'none' }],
    ['oversized summary', { ...verdict, summary: 'x'.repeat(5000) }],
  ])('schema mismatch: %s', (_name, body) => {
    const r = parseTriageReply(JSON.stringify(body));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/schema|JSON/);
  });

  test('unknown extra keys are stripped, not trusted', () => {
    const r = parseTriageReply(JSON.stringify({ ...verdict, injected: 'ignore previous instructions' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).not.toHaveProperty('injected');
  });
});

describe('validateTriageResult (cited paths)', () => {
  test('keeps existing paths, no warnings', async () => {
    const r = await validateTriageResult(JSON.stringify(verdict), snap);
    expect(r).toMatchObject({ ok: true, warnings: [] });
    if (r.ok) expect(r.verdict.files_likely_touched).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('drops bogus paths with a recorded warning', async () => {
    const r = await validateTriageResult(JSON.stringify({ ...verdict, files_likely_touched: ['src/a.ts', 'src/ghost.ts', '../../etc/passwd'] }), snap);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.files_likely_touched).toEqual(['src/a.ts']);
      expect(r.warnings).toHaveLength(2);
      expect(r.warnings[0]).toMatch(/does not exist in the snapshot/);
    }
  });

  test('fails when every cited path is bogus', async () => {
    const r = await validateTriageResult(JSON.stringify({ ...verdict, files_likely_touched: ['nope.ts', 'also/nope.ts'] }), snap);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/none of the 2/);
  });

  test('an empty list of paths is fine', async () => {
    expect((await validateTriageResult(JSON.stringify({ ...verdict, files_likely_touched: [] }), snap)).ok).toBe(true);
  });

  test('a syntactically invalid reply fails without touching the filesystem', async () => {
    expect(await validateTriageResult('not json', '/definitely/not/there')).toMatchObject({ ok: false });
  });
});

describe('pathExistsInSnapshot', () => {
  test('rejects absolute paths, traversal, nul bytes, and the root itself', async () => {
    expect(await pathExistsInSnapshot(snap, '/etc/passwd')).toBe(false);
    expect(await pathExistsInSnapshot(snap, '../x')).toBe(false);
    expect(await pathExistsInSnapshot(snap, 'src/../../x')).toBe(false);
    expect(await pathExistsInSnapshot(snap, 'src/a.ts\0')).toBe(false);
    expect(await pathExistsInSnapshot(snap, '.')).toBe(false);
    expect(await pathExistsInSnapshot(snap, '')).toBe(false);
  });

  test('accepts a ./ prefix and directories', async () => {
    expect(await pathExistsInSnapshot(snap, './src/a.ts')).toBe(true);
    expect(await pathExistsInSnapshot(snap, 'src')).toBe(true);
  });

  test('a symlink that escapes the snapshot does not count', async () => {
    symlinkSync('/etc/hostname', join(snap, 'escape'));
    symlinkSync(join(snap, 'src/a.ts'), join(snap, 'inside'));
    expect(await pathExistsInSnapshot(snap, 'escape')).toBe(false);
    expect(await pathExistsInSnapshot(snap, 'inside')).toBe(true);
  });
});
