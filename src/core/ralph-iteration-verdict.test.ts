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
    // `# 42` strips leading `#` only — after trim the input is `# 42`, so the
    // result is ` 42`. Pinned to flag any future canonicalization change as
    // intentional.
    ['# 42', ' 42'],
    ['  #154', '154'],
    ['ISSUE-42', 'issue-42'],
    ['#issue-42', 'issue-42'],
  ])('canonicalizes %j to %j', (input, expected) => {
    expect(canonicalizeTarget(input)).toBe(expected);
  });

  it('NFC-normalizes composed vs decomposed Unicode so the same logical target accrues counts', () => {
    const composed = canonicalizeTarget('café'); // é precomposed (U+00E9)
    const decomposed = canonicalizeTarget('café'); // e + combining acute (U+0301)
    expect(composed).toBe(decomposed);
  });
});

describe('defaultVerdictPath', () => {
  it('uses the first 12 chars of the task id as a per-task suffix', () => {
    const p = defaultVerdictPath('/tmp/work', '8766cab8-f08d-4501-8d0d-b19ad934edfe');
    expect(p).toBe('/tmp/work/.ralph-verdict-8766cab8-f08.json');
  });

  it('resolves a relative cwd against process.cwd()', () => {
    // When cwd is relative, `path.resolve` joins with process.cwd(). We don't
    // assert the prefix value (which depends on the test runner's cwd) but we
    // do assert the result is absolute and ends with the suffix-bearing
    // basename — i.e. the function never returns a relative path.
    const p = defaultVerdictPath('relative/sub', 'aaaabbbbccccdddd');
    expect(p.startsWith('/')).toBe(true);
    expect(p.endsWith('/.ralph-verdict-aaaabbbbcccc.json')).toBe(true);
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

  it('rejects partial-write content (truncated JSON) with full result shape', async () => {
    // Simulates an agent crashing mid-write before the closing brace.
    await writeFile(path, '{"verdict":"stalled","iteration":1,"target":"154","reason":"test');
    const r = await readVerdictFile(path, 1);
    expect(r.verdict).toBeNull();
    expect(r.failure).toBe('malformed_json');
    expect(r.reason).toContain('not valid JSON');
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

  it('rejects files larger than MAX_VERDICT_FILE_BYTES', async () => {
    // 17 KB of arbitrary content (exceeds 16 KB cap). The size check uses
    // `lstat` before any allocation so a 1 GB file would not OOM the engine —
    // black-box tests can't directly observe that ordering, but the cap
    // boundary itself is the user-visible contract.
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
