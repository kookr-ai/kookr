import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENCODE_PINNED_VERSION } from './opencode-preflight.js';
import * as fsp from 'node:fs/promises';
import { isOpenCodeSeedReady, prepareOpenCodeSeed, resolveOpenCodeSeedDir, seedConfigDir, type SeedRunner } from './opencode-seed.js';

// `link` delegates to the real one; one test makes it fail with EXDEV (seed and session on different devices).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'oc-seed-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** Fake opencode: populate the config dir like the real npm install would. */
const populate: SeedRunner = async (_bin, _args, env) => {
  const cfg = env.OPENCODE_CONFIG_DIR!;
  mkdirSync(join(cfg, 'node_modules', '@opencode-ai', 'plugin'), { recursive: true });
  writeFileSync(join(cfg, 'node_modules', '@opencode-ai', 'plugin', 'index.js'), 'x');
  for (const f of ['package.json', 'package-lock.json', '.gitignore']) writeFileSync(join(cfg, f), f);
};

describe('resolveOpenCodeSeedDir', () => {
  it('defaults under the pinned tools dir and honours the env override', () => {
    expect(resolveOpenCodeSeedDir({}, '/h')).toBe(`/h/.kookr/tools/opencode-${OPENCODE_PINNED_VERSION}/seed`);
    expect(resolveOpenCodeSeedDir({ KOOKR_OPENCODE_SEED_DIR: '/x/s' }, '/h')).toBe('/x/s');
  });
});

describe('prepareOpenCodeSeed', () => {
  it('builds the template once with a throwaway config dir, then reuses it', async () => {
    const seedDir = join(tmp, 'tools', 'seed');
    const runner = vi.fn(populate);
    const first = await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner, env: { PATH: '/bin' } });
    expect(first).toBe(seedDir);
    expect(isOpenCodeSeedReady(seedDir)).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![1]).toEqual(['debug', 'config']);
    expect(runner.mock.calls[0]![2].OPENCODE_CONFIG_DIR!.startsWith(join(tmp, 'tools'))).toBe(true);
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner })).toBe(seedDir);
    expect(runner).toHaveBeenCalledTimes(1);
    // scratch + lock are cleaned up
    expect(existsSync(`${seedDir}.lock`)).toBe(false);
  });

  it('never deletes an operator-pointed directory that is not a seed (data-loss regression)', async () => {
    const seedDir = join(tmp, 'my-important-dir');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'precious.txt'), 'keep me');
    const warn = vi.fn();
    const res = await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner: vi.fn(populate), warn });
    expect(res).toBeUndefined();
    expect(readFileSync(join(seedDir, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing to replace'));
  });

  it('never deletes a foreign .lock directory, even an old one (data-loss regression)', async () => {
    const seedDir = join(tmp, 'tools', 'seed');
    const lockDir = `${seedDir}.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'precious'), 'keep me');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockDir, old, old);
    const warn = vi.fn();
    const res = await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner: vi.fn(populate), warn, lockStaleMs: 1000, lockWaitMs: 500 });
    expect(res).toBeUndefined();
    expect(readFileSync(join(lockDir, 'precious'), 'utf8')).toBe('keep me');
  });

  it('breaks a stale lock only when it carries our owner file', async () => {
    const seedDir = join(tmp, 'tools', 'seed');
    const lockDir = `${seedDir}.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, '.kookr-seed-lock'), '1\n');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockDir, old, old);
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner: vi.fn(populate), lockStaleMs: 1000 })).toBe(seedDir);
  });

  it('returns promptly (no spin) when the lock dir cannot be created', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // chmod does not restrict root
    const parent = join(tmp, 'ro');
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o555);
    const started = Date.now();
    try {
      const res = await prepareOpenCodeSeed({ bin: 'oc', seedDir: join(parent, 'seed'), runner: vi.fn(populate), warn: vi.fn(), lockWaitMs: 30_000 });
      expect(res).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it('replaces an empty directory and a stale seed (marker present)', async () => {
    const empty = join(tmp, 'empty-seed');
    mkdirSync(empty, { recursive: true });
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir: empty, runner: vi.fn(populate) })).toBe(empty);
    expect(isOpenCodeSeedReady(empty)).toBe(true);
  });

  it('returns undefined with a warning (never throws) when the run fails or output is incomplete', async () => {
    const warn = vi.fn();
    const seedDir = join(tmp, 'seed');
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir, warn, runner: async () => { throw new Error('offline'); } })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'));
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir, warn, runner: async () => {} })).toBeUndefined();
    expect(isOpenCodeSeedReady(seedDir)).toBe(false);
    expect(existsSync(`${seedDir}.lock`)).toBe(false);
  });

  it('concurrent callers run the binary once', async () => {
    const seedDir = join(tmp, 'seed');
    const runner = vi.fn(async (...a: Parameters<SeedRunner>) => { await new Promise((r) => setTimeout(r, 50)); await populate(...a); });
    const out = await Promise.all([1, 2, 3].map(() => prepareOpenCodeSeed({ bin: 'oc', seedDir, runner })));
    expect(out).toEqual([seedDir, seedDir, seedDir]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('removes stale seed-build-* scratch dirs before building, but keeps fresh ones and unrelated dirs', async () => {
    const tools = join(tmp, 'tools');
    const seedDir = join(tools, 'seed');
    mkdirSync(tools, { recursive: true });
    const stale = join(tools, 'seed-build-crashed');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'junk'), 'x');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(stale, old, old);
    const fresh = join(tools, 'seed-build-inflight');
    mkdirSync(fresh, { recursive: true });
    const unrelated = join(tools, 'seed-build-not-a-dir');
    writeFileSync(unrelated, 'keep me');
    utimesSync(unrelated, old, old);
    const other = join(tools, 'other-crashed');
    mkdirSync(other, { recursive: true });
    utimesSync(other, old, old);
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner: vi.fn(populate), scratchStaleMs: 60_000 })).toBe(seedDir);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(readFileSync(unrelated, 'utf8')).toBe('keep me');
  });

  it('also reclaims stale scratch dirs when the seed is already ready (the build path is never reached again)', async () => {
    const tools = join(tmp, 'tools');
    const seedDir = join(tools, 'seed');
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner: vi.fn(populate) })).toBe(seedDir);
    const old = new Date(Date.now() - 3_600_000);
    const stale = join(tools, 'seed-build-crashed-earlier');
    mkdirSync(stale, { recursive: true });
    utimesSync(stale, old, old);
    const fresh = join(tools, 'seed-build-inflight');
    mkdirSync(fresh, { recursive: true });
    const runner = vi.fn(populate);
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner, scratchStaleMs: 60_000 })).toBe(seedDir);
    expect(runner).not.toHaveBeenCalled();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('never reclaims the configured seed dir itself, even when it is named seed-build-* and old', async () => {
    const tools = join(tmp, 'tools');
    const seedDir = join(tools, 'seed-build-template');
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner: vi.fn(populate) })).toBe(seedDir);
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(seedDir, old, old);
    const runner = vi.fn(populate);
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner, scratchStaleMs: 60_000 })).toBe(seedDir);
    expect(runner).not.toHaveBeenCalled();
    expect(isOpenCodeSeedReady(seedDir)).toBe(true);
  });

  it.each(['', '/', '/.', '/../seed-build-template'])('also keeps the seed dir when the configured path is spelled with a suffix %j', async (suffix) => {
    const tools = join(tmp, 'tools');
    const real = join(tools, 'seed-build-template');
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir: real, runner: vi.fn(populate) })).toBe(real);
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(real, old, old);
    const runner = vi.fn(populate);
    await prepareOpenCodeSeed({ bin: 'oc', seedDir: `${real}${suffix}`, runner, scratchStaleMs: 60_000 });
    expect(runner).not.toHaveBeenCalled();
    expect(isOpenCodeSeedReady(real)).toBe(true);
  });

  it('breaks a stale lock', async () => {
    const seedDir = join(tmp, 'seed');
    mkdirSync(`${seedDir}.lock`, { recursive: true });
    writeFileSync(join(`${seedDir}.lock`, '.kookr-seed-lock'), '1\n'); // a lock our own (crashed) build left behind
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner: populate, lockStaleMs: -1 })).toBe(seedDir);
  });
});

describe('seedConfigDir', () => {
  it('does not follow a directory symlink inside node_modules (no materialised copy, no loop)', async () => {
    const seedDir = join(tmp, 'seed');
    await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner: populate });
    const nm = join(seedDir, 'node_modules');
    // A symlink back to node_modules' parent would loop forever if linkTree followed directory symlinks.
    symlinkSync('..', join(nm, 'loop'));
    symlinkSync('@opencode-ai', join(nm, 'alias'));
    const target = join(tmp, 'sess', 'cfg');
    await seedConfigDir(seedDir, target);
    const loopDst = join(target, 'node_modules', 'loop');
    expect(lstatSync(loopDst).isSymbolicLink()).toBe(true);
    expect(readdirSync(join(target, 'node_modules')).sort()).toEqual(['@opencode-ai', 'alias', 'loop']);
  });

  it('recreates symlinks as symlinks even when hardlinking fails (EXDEV), instead of copying through them', async () => {
    const seedDir = join(tmp, 'seed');
    await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner: populate });
    const nm = join(seedDir, 'node_modules');
    symlinkSync('@opencode-ai', join(nm, 'dir-alias')); // a directory symlink: copyFile on it would throw EISDIR
    symlinkSync('../package.json', join(nm, 'file-alias'));
    const exdev = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    vi.mocked(fsp.link).mockRejectedValue(exdev);
    try {
      const target = join(tmp, 'sess', 'cfg');
      await seedConfigDir(seedDir, target);
      const dirDst = join(target, 'node_modules', 'dir-alias');
      const fileDst = join(target, 'node_modules', 'file-alias');
      expect(lstatSync(dirDst).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dirDst)).toBe('@opencode-ai');
      expect(lstatSync(fileDst).isSymbolicLink()).toBe(true);
      expect(readlinkSync(fileDst)).toBe('../package.json');
      // regular files still fall back to a copy
      expect(readFileSync(join(target, 'node_modules/@opencode-ai/plugin/index.js'), 'utf8')).toBe('x');
    } finally {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(fsp.link).mockReset();
      vi.mocked(fsp.link).mockImplementation(actual.link);
    }
  });

  it('hardlinks files (no extra disk) and preserves the tree', async () => {
    const seedDir = join(tmp, 'seed');
    await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner: populate });
    const target = join(tmp, 'sess', 'cfg');
    await seedConfigDir(seedDir, target);
    const a = join(seedDir, 'node_modules/@opencode-ai/plugin/index.js');
    const b = join(target, 'node_modules/@opencode-ai/plugin/index.js');
    expect(readFileSync(b, 'utf8')).toBe('x');
    expect(statSync(a).ino).toBe(statSync(b).ino);
    expect(readFileSync(join(target, 'package.json'), 'utf8')).toBe('package.json');
  });
});
