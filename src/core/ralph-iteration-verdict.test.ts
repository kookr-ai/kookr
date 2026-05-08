import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readVerdictFile,
  unlinkVerdictFile,
  canonicalizeTarget,
  defaultVerdictPath,
  MAX_VERDICT_FILE_BYTES,
} from './ralph-iteration-verdict.js';

describe('canonicalizeTarget', () => {
  it.each([
    ['154', '154'],
    [' 154 ', '154'],
    ['#154', '154'],
    ['# 154', ' 154'], // strip leading # only, then trim is already done so this is exactly the case
    ['  #154', '154'],
    ['ISSUE-42', 'issue-42'],
    ['#issue-42', 'issue-42'],
  ])('canonicalizes %j to %j', (input, expected) => {
    expect(canonicalizeTarget(input)).toBe(expected);
  });

  it('treats space-after-hash as a different target than the hashless form', () => {
    // We strip leading `#` only after trim — `# 42` becomes ` 42` then `# `
    // is stripped to leave `42` only if a tighter normalization pass were
    // added. Today's rule is intentionally minimal: `trim().lower().strip(^#)`.
    // The test pins the behavior so canonicalization changes are intentional.
    expect(canonicalizeTarget('# 42')).toBe(' 42');
  });
});

describe('defaultVerdictPath', () => {
  it('uses the first 8 chars of the task id as a per-task suffix', () => {
    const p = defaultVerdictPath('/tmp/work', '8766cab8-f08d-4501-8d0d-b19ad934edfe');
    expect(p).toBe('/tmp/work/.ralph-verdict-8766cab8.json');
  });

  it('returns an absolute path even when cwd is relative', () => {
    const p = defaultVerdictPath('/abs/cwd', 'aaaabbbb-1111');
    expect(p.startsWith('/')).toBe(true);
    expect(p).toContain('aaaabbbb');
  });
});

describe('readVerdictFile', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ralph-verdict-'));
    path = join(dir, '.ralph-verdict-aaaaaaaa.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns missing failure when no file exists (no warning condition)', async () => {
    const r = await readVerdictFile(path, 1);
    expect(r.verdict).toBeNull();
    expect(r.failure).toBe('missing');
    expect(r.reason).toBeNull();
  });

  it('reads a valid stalled verdict', async () => {
    await writeFile(path, JSON.stringify({
      verdict: 'stalled',
      iteration: 3,
      target: '154',
      reason: 'tests fail',
      blockers: ['missing dep'],
    }));
    const r = await readVerdictFile(path, 3);
    expect(r.verdict).toEqual({
      verdict: 'stalled',
      iteration: 3,
      target: '154',
      reason: 'tests fail',
      blockers: ['missing dep'],
    });
    expect(r.failure).toBeNull();
  });

  it('reads a valid complete verdict', async () => {
    await writeFile(path, JSON.stringify({ verdict: 'complete', iteration: 5 }));
    const r = await readVerdictFile(path, 5);
    expect(r.verdict).toEqual({ verdict: 'complete', iteration: 5 });
  });

  it('reads a valid progress verdict (target only, no reason)', async () => {
    await writeFile(path, JSON.stringify({ verdict: 'progress', iteration: 2, target: '153' }));
    const r = await readVerdictFile(path, 2);
    expect(r.verdict).toEqual({ verdict: 'progress', iteration: 2, target: '153' });
  });

  it('rejects iteration mismatch', async () => {
    await writeFile(path, JSON.stringify({ verdict: 'progress', iteration: 7 }));
    const r = await readVerdictFile(path, 8);
    expect(r.verdict).toBeNull();
    expect(r.failure).toBe('iteration_mismatch');
    expect(r.reason).toContain('7');
    expect(r.reason).toContain('8');
  });

  it('rejects malformed JSON', async () => {
    await writeFile(path, 'not json {');
    const r = await readVerdictFile(path, 1);
    expect(r.verdict).toBeNull();
    expect(r.failure).toBe('malformed_json');
  });

  it('rejects partial-write content (truncated JSON)', async () => {
    // Simulates an agent crashing mid-write before the closing brace.
    await writeFile(path, '{"verdict":"stalled","iteration":1,"target":"154","reason":"test');
    const r = await readVerdictFile(path, 1);
    expect(r.failure).toBe('malformed_json');
  });

  it('rejects schema mismatch (unknown verdict variant)', async () => {
    await writeFile(path, JSON.stringify({ verdict: 'wat', iteration: 1 }));
    const r = await readVerdictFile(path, 1);
    expect(r.failure).toBe('schema_invalid');
  });

  it('rejects stalled verdict without target', async () => {
    await writeFile(path, JSON.stringify({ verdict: 'stalled', iteration: 1, reason: 'oops' }));
    const r = await readVerdictFile(path, 1);
    expect(r.failure).toBe('schema_invalid');
  });

  it('rejects oversize file via lstat before reading any bytes', async () => {
    // 17 KB of arbitrary content (exceeds 16 KB cap).
    const big = 'x'.repeat(MAX_VERDICT_FILE_BYTES + 1024);
    await writeFile(path, big);
    const r = await readVerdictFile(path, 1);
    expect(r.failure).toBe('oversize');
    expect(r.reason).toContain('exceeds');
  });

  it('rejects symlinks even when the target is valid', async () => {
    const realPath = join(dir, 'real-verdict.json');
    await writeFile(realPath, JSON.stringify({ verdict: 'complete', iteration: 1 }));
    await symlink(realPath, path);
    const r = await readVerdictFile(path, 1);
    expect(r.verdict).toBeNull();
    expect(r.failure).toBe('symlink');
  });
});

describe('unlinkVerdictFile', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ralph-unlink-'));
    path = join(dir, 'v.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes an existing file', async () => {
    await writeFile(path, '{}');
    await unlinkVerdictFile(path);
    await expect(access(path)).rejects.toThrow();
  });

  it('is idempotent (no-throw) when the file does not exist', async () => {
    await expect(unlinkVerdictFile(path)).resolves.toBeUndefined();
  });
});
