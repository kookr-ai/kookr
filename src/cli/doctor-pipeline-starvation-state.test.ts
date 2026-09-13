import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyPipelineStarvationState,
  pipelineStarvationStatePath,
} from '../core/pipeline-starvation.js';
import { loadPipelineStarvationState } from '../core/pipeline-starvation-state.js';
import {
  checkPipelineStarvationState,
  PIPELINE_STATE_MAX_ENTRIES,
  PIPELINE_STATE_MAX_FILE_BYTES,
} from './doctor-pipeline-starvation-state.js';

// Copy the native module namespace so filesystem spies can replace its exports.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

describe('pipeline recovery state doctor advisory', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), 'doctor-pipeline-')); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeState(contents: string, repo = 'owner/repo') {
    const path = pipelineStarvationStatePath(dir, repo);
    await fs.writeFile(path, contents);
    return path;
  }

  it('distinguishes absent state from a valid envelope and preserves recovery history', async () => {
    expect(await checkPipelineStarvationState(join(dir, 'absent'))).toMatchObject({
      status: 'ok', summary: 'Pipeline recovery state absent (no ledgers found)',
    });
    expect(await checkPipelineStarvationState(dir)).toMatchObject({ status: 'ok' });
    const state = {
      ...emptyPipelineStarvationState('owner/repo', 0),
      handledRunKeys: ['handled-run'],
      lastStarvationScoutAt: '2026-09-12T00:00:00.000Z',
      lastBatchKickAt: '2026-09-12T01:00:00.000Z',
    };
    const path = await writeState(JSON.stringify(state));
    const before = await fs.readFile(path);
    expect(await checkPipelineStarvationState(dir)).toMatchObject({
      status: 'ok', summary: 'Pipeline recovery state valid (1 ledger envelopes checked)',
    });
    expect(await fs.readFile(path)).toEqual(before);
    expect(await fs.readdir(dir)).toEqual(['owner-repo.json']);
  });

  it('diagnoses malformed JSON without changing the runtime loader or state bytes', async () => {
    const path = await writeState('{"handledRunKeys":');
    await expect(loadPipelineStarvationState('owner/repo', { stateDir: dir })).rejects.toBeInstanceOf(SyntaxError);
    const before = await fs.readFile(path);
    expect(await checkPipelineStarvationState(dir)).toMatchObject({
      id: 'ops.pipeline-starvation-state', status: 'warn', required: false,
      detail: expect.stringContaining('malformed_json'),
      recommendedAction: expect.stringContaining('cooldown and handled-run history'),
    });
    expect(await fs.readFile(path)).toEqual(before);
  });

  it.each([null, [], {}, { schemaVersion: 99, repo: 'owner/repo' }])(
    'warns about unsupported schema/envelope %j', async (state) => {
      const path = await writeState(JSON.stringify(state));
      const before = await fs.readFile(path);
      expect(await checkPipelineStarvationState(dir)).toMatchObject({
        status: 'warn', detail: expect.stringContaining('unsupported_schema'),
      });
      expect(await fs.readFile(path)).toEqual(before);
    },
  );

  it('distinguishes schema fallback from foreign repository identity accepted by runtime', async () => {
    await writeState(JSON.stringify({ schemaVersion: 99, repo: 'owner/repo' }));
    expect((await loadPipelineStarvationState('owner/repo', { stateDir: dir })).handledRunKeys).toEqual([]);
    await writeState(JSON.stringify(emptyPipelineStarvationState('foreign/repo', 0)));
    expect((await loadPipelineStarvationState('owner/repo', { stateDir: dir })).repo).toBe('foreign/repo');
    expect(await checkPipelineStarvationState(dir)).toMatchObject({
      status: 'warn', detail: expect.stringContaining('repository_identity_mismatch'),
    });
  });

  it.each(['', '../foreign/repo', null])('rejects invalid repository identity %j', async (repo) => {
    await writeState(JSON.stringify({ ...emptyPipelineStarvationState('owner/repo', 0), repo }));
    expect(await checkPipelineStarvationState(dir)).toMatchObject({
      status: 'warn', detail: expect.stringContaining('repository_identity_mismatch'),
    });
  });

  it('uses the runtime slug normalization for valid repository names', async () => {
    await writeState(JSON.stringify(emptyPipelineStarvationState('Owner/Some.Repo', 0)), 'Owner/Some.Repo');
    expect(await checkPipelineStarvationState(dir)).toMatchObject({ status: 'ok' });
  });

  it('reports unreadable files and directories as advisories', async () => {
    await writeState('{}');
    vi.spyOn(fs, 'open').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await checkPipelineStarvationState(dir)).toMatchObject({
      status: 'warn', detail: expect.stringContaining('unreadable (EACCES)'),
    });
    vi.spyOn(fs, 'opendir').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await checkPipelineStarvationState(dir)).toMatchObject({
      status: 'warn', detail: expect.stringContaining('unreadable (EACCES)'),
    });
  });

  it('does not follow state symlinks or read non-regular files', async () => {
    const target = join(dir, 'target');
    await fs.writeFile(target, 'preserve me');
    await fs.symlink(target, join(dir, 'owner-repo.json'));
    await fs.mkdir(join(dir, 'another-repo.json'));
    const open = vi.spyOn(fs, 'open');
    expect(await checkPipelineStarvationState(dir)).toMatchObject({
      status: 'warn', detail: expect.stringContaining('unreadable (not a regular file)'),
    });
    expect(open).not.toHaveBeenCalled();
    expect(await fs.readFile(target, 'utf8')).toBe('preserve me');
  });

  it('refuses a ledger replaced by a symlink between enumeration and open', async () => {
    const state = JSON.stringify(emptyPipelineStarvationState('owner/repo', 0));
    const path = await writeState(state);
    const target = join(dir, 'target');
    await fs.writeFile(target, state);
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.unlink(path);
      await fs.symlink(target, path);
      return open(...args);
    });
    expect(await checkPipelineStarvationState(dir)).toMatchObject({
      status: 'warn', detail: expect.stringContaining('unreadable'),
    });
    expect(await fs.readFile(target, 'utf8')).toBe(state);
  });

  it('bounds bytes before parsing and leaves oversized files unchanged', async () => {
    const bytes = Buffer.alloc(PIPELINE_STATE_MAX_FILE_BYTES + 1, 32);
    const path = await writeState(bytes.toString());
    expect(await checkPipelineStarvationState(dir)).toMatchObject({
      status: 'warn', detail: expect.stringContaining('file_too_large'),
    });
    expect(await fs.readFile(path)).toEqual(bytes);
  });

  it('still enforces the byte cap when a ledger grows after stat', async () => {
    const path = await writeState(' '.repeat(PIPELINE_STATE_MAX_FILE_BYTES + 10));
    const open = fs.open;
    const readSizes: number[] = [];
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const originalStat = await handle.stat();
      vi.spyOn(handle, 'stat').mockResolvedValue({ ...originalStat, size: 0, isFile: () => true });
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        readSizes.push(result.bytesRead);
        return result;
      });
      return handle;
    });
    expect(await checkPipelineStarvationState(dir)).toMatchObject({
      status: 'warn', detail: expect.stringContaining('file_too_large'),
    });
    expect(readSizes.reduce((sum, size) => sum + size, 0)).toBe(PIPELINE_STATE_MAX_FILE_BYTES + 1);
    expect((await fs.stat(path)).size).toBe(PIPELINE_STATE_MAX_FILE_BYTES + 10);
  });

  it('bounds directory traversal including ignored entries and exposes incomplete coverage', async () => {
    for (let i = 0; i <= PIPELINE_STATE_MAX_ENTRIES; i++) {
      await fs.writeFile(join(dir, `ignored-${i}.tmp`), '');
    }
    const open = vi.spyOn(fs, 'open');
    expect(await checkPipelineStarvationState(dir)).toMatchObject({
      status: 'warn', detail: expect.stringContaining('scan_limit'),
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('caps the number of ledger reads', async () => {
    for (let i = 0; i <= PIPELINE_STATE_MAX_ENTRIES; i++) {
      const repo = `owner/repo-${i}`;
      await writeState(JSON.stringify(emptyPipelineStarvationState(repo, 0)), repo);
    }
    const open = vi.spyOn(fs, 'open');
    const check = await checkPipelineStarvationState(dir);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('scan_limit');
    expect(open).toHaveBeenCalledTimes(PIPELINE_STATE_MAX_ENTRIES);
  });
});
