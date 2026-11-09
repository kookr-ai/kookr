import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENCODE_PINNED_VERSION } from './opencode-preflight.js';
import { isOpenCodeSeedReady, prepareOpenCodeSeed, resolveOpenCodeSeedDir, seedConfigDir, type SeedRunner } from './opencode-seed.js';

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

  it('breaks a stale lock', async () => {
    const seedDir = join(tmp, 'seed');
    mkdirSync(`${seedDir}.lock`, { recursive: true });
    expect(await prepareOpenCodeSeed({ bin: 'oc', seedDir, runner: populate, lockStaleMs: -1 })).toBe(seedDir);
  });
});

describe('seedConfigDir', () => {
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
