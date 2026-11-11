/**
 * Pre-seeded opencode config dirs (boot-time optimisation).
 *
 * Every fresh `OPENCODE_CONFIG_DIR` and every fresh `XDG_CONFIG_HOME/opencode`
 * makes opencode run an in-process `npm install @opencode-ai/plugin@<pinned>`
 * against the npm registry (about 64 MB, 6-7 s each, and with no network the TUI
 * never becomes ready). We run that install once into a Kookr-owned seed
 * template and hardlink it into each session (`cp -al` semantics, no extra disk).
 * A seeded session also gets `OPENCODE_FAST_BOOT=1`; an unseeded one must not.
 *
 * Seed failure is never fatal: the composer simply falls back to unseeded.
 */
import { spawn } from 'node:child_process';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { OPENCODE_PINNED_VERSION } from './opencode-preflight.js';

export const OPENCODE_SEED_DIR_ENV = 'KOOKR_OPENCODE_SEED_DIR';
/** Entries copied from a populated config dir into the seed template. */
export const OPENCODE_SEED_ENTRIES = ['node_modules', 'package.json', 'package-lock.json', '.gitignore'] as const;
const READY_MARKER = '.seed-ready';

/** `KOOKR_OPENCODE_SEED_DIR`, else `<home>/.kookr/tools/opencode-<pinned>/seed`. */
export function resolveOpenCodeSeedDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env[OPENCODE_SEED_DIR_ENV]?.trim() || join(home, '.kookr', 'tools', `opencode-${OPENCODE_PINNED_VERSION}`, 'seed');
}

export function isOpenCodeSeedReady(seedDir: string): boolean {
  return OPENCODE_SEED_ENTRIES.every((e) => existsSync(join(seedDir, e))) && existsSync(join(seedDir, READY_MARKER));
}

export type SeedRunner = (bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<void>;

const defaultRunner: SeedRunner = (bin, args, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`seed run timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`seed run exited ${code}`)); });
  });

export interface PrepareOpenCodeSeedOptions {
  bin: string;
  seedDir: string;
  env?: NodeJS.ProcessEnv;
  runner?: SeedRunner;
  timeoutMs?: number;
  lockStaleMs?: number;
  lockWaitMs?: number;
  /** Scratch `seed-build-*` dirs older than this are removed before building (default 1 hour). */
  scratchStaleMs?: number;
  warn?: (msg: string) => void;
}

const SCRATCH_PREFIX = 'seed-build-';

/**
 * Remove scratch dirs a crashed previous build left next to the seed (~64 MB each). Only directories whose name
 * starts with the exact `seed-build-` prefix and whose mtime is older than `staleMs` are touched, so an in-flight
 * build (fresh mtime) and unrelated operator directories survive. Best-effort: failures are warning-only.
 */
async function cleanStaleScratchDirs(seedDir: string, staleMs: number, warn: (msg: string) => void): Promise<void> {
  const parent = dirname(seedDir);
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const dir = join(parent, name);
    // KOOKR_OPENCODE_SEED_DIR is operator-settable: never reclaim the seed (or its lock) itself, whatever it is called.
    if (dir === seedDir || dir === `${seedDir}.lock`) continue;
    try {
      const st = await lstat(dir);
      if (!st.isDirectory()) continue;
      if (Date.now() - st.mtimeMs <= staleMs) continue;
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      warn(`[opencode-seed] could not remove stale scratch dir ${dir} (${(err as Error).message})`);
    }
  }
}

const LOCK_OWNER_FILE = '.kookr-seed-lock';

/**
 * Take the seed build lock. The lock dir is only ever removed when it carries our owner file (a stale lock
 * left by a crashed Kookr build); a directory we did not create is never deleted, and any mkdir failure other
 * than EEXIST (read-only/unwritable parent, ...) is thrown so the caller boots unseeded instead of spinning.
 */
async function acquireLock(lockDir: string, staleMs: number, waitMs: number, seedDir: string): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(join(lockDir, LOCK_OWNER_FILE), `${process.pid}\n`);
      } catch (err) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => { /* we just created it */ });
        throw err;
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Someone else is seeding (or died holding the lock).
      if (isOpenCodeSeedReady(seedDir)) return false;
      try {
        const stale = Date.now() - (await stat(lockDir)).mtimeMs > staleMs;
        if (stale && existsSync(join(lockDir, LOCK_OWNER_FILE))) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
        if (stale) return false; // an old directory we did not create: leave it alone, boot unseeded
      } catch {
        // the lock vanished between mkdir and stat: retry, but never without the deadline/sleep below
      }
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * Ensure the seed template exists; returns its path, or `undefined` when it could not be built
 * (offline, binary failure, ...), in which case callers run unseeded. Idempotent and concurrency-safe
 * (lock dir + atomic rename into place).
 */
export async function prepareOpenCodeSeed(opts: PrepareOpenCodeSeedOptions): Promise<string | undefined> {
  const { bin, seedDir } = opts;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  if (isOpenCodeSeedReady(seedDir)) {
    // The build path below is never reached once a seed exists, so a scratch dir left by an earlier crash that
    // was still fresh when the seed got built would otherwise stay for ever. Best effort, errors only warn.
    await cleanStaleScratchDirs(seedDir, opts.scratchStaleMs ?? 3_600_000, warn);
    return seedDir;
  }
  const lockDir = `${seedDir}.lock`;
  let scratch: string | undefined;
  let locked = false;
  try {
    await mkdir(dirname(seedDir), { recursive: true });
    locked = await acquireLock(lockDir, opts.lockStaleMs ?? 180_000, opts.lockWaitMs ?? 120_000, seedDir);
    if (!locked) return isOpenCodeSeedReady(seedDir) ? seedDir : undefined;
    if (isOpenCodeSeedReady(seedDir)) return seedDir;
    await cleanStaleScratchDirs(seedDir, opts.scratchStaleMs ?? 3_600_000, warn);
    scratch = await mkdtemp(join(dirname(seedDir), SCRATCH_PREFIX));
    const cfg = join(scratch, 'cfg');
    await mkdir(join(cfg, 'plugins'), { recursive: true });
    // A plugins dir is what makes opencode install `@opencode-ai/plugin`; `debug config` exits right after.
    await writeFile(join(cfg, 'plugins', 'seed.js'), 'export const Seed = async () => ({})\n');
    const env: NodeJS.ProcessEnv = {
      ...(opts.env ?? process.env),
      OPENCODE_CONFIG_DIR: cfg,
      XDG_CONFIG_HOME: join(scratch, 'xdg'),
      XDG_DATA_HOME: join(scratch, 'data'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    delete env.OPENCODE_FAST_BOOT;
    await (opts.runner ?? defaultRunner)(bin, ['debug', 'config'], env, opts.timeoutMs ?? 120_000);
    const staged = join(scratch, 'seed');
    await mkdir(staged);
    for (const entry of OPENCODE_SEED_ENTRIES) {
      if (!existsSync(join(cfg, entry))) throw new Error(`opencode did not produce ${entry} in the seed config dir`);
      await rename(join(cfg, entry), join(staged, entry));
    }
    await writeFile(join(staged, READY_MARKER), `${OPENCODE_PINNED_VERSION}\n`);
    // Only replace a directory that is a (stale) seed or empty: KOOKR_OPENCODE_SEED_DIR is operator-settable and must
    // never cause an unrelated directory to be deleted.
    if (existsSync(seedDir) && !existsSync(join(seedDir, READY_MARKER)) && (await readdir(seedDir)).length > 0) {
      throw new Error(`${seedDir} exists, is not empty and is not an opencode seed; refusing to replace it`);
    }
    await rm(seedDir, { recursive: true, force: true });
    await rename(staged, seedDir);
    return seedDir;
  } catch (err) {
    warn(`[opencode-seed] could not prepare the config seed (${(err as Error).message}); sessions will boot unseeded (slower, needs network)`);
    return undefined;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    if (locked) await rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function linkTree(src: string, dst: string): Promise<void> {
  // lstat, not stat: a symlink inside the seed (e.g. node_modules/.bin entries) must not be followed, or a directory
  // symlink would be materialised or loop.
  const st = await lstat(src);
  if (st.isDirectory()) {
    await mkdir(dst, { recursive: true });
    for (const name of await readdir(src)) await linkTree(join(src, name), join(dst, name));
    return;
  }
  if (st.isSymbolicLink()) {
    // Recreate the link itself. `link()` on a symlink is platform dependent (macOS may follow it) and the copy
    // fallback below would dereference it (a directory symlink then fails with EISDIR).
    try {
      await symlink(await readlink(src), dst);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return;
  }
  try {
    await link(src, dst);
  } catch (err) {
    // EXDEV (other device), EPERM, EMLINK...: fall back to a copy.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
    await copyFile(src, dst);
  }
}

/** Hardlink (copy fallback) the seed template entries into `targetDir`. */
export async function seedConfigDir(seedDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  for (const entry of OPENCODE_SEED_ENTRIES) {
    // node_modules is hardlinked (big); the small manifest files are COPIED so an in-place rewrite by npm/bun or an
    // agent inside one session can never change the shared template for later sessions.
    if (entry === 'node_modules') await linkTree(join(seedDir, entry), join(targetDir, entry));
    else await copyFile(join(seedDir, entry), join(targetDir, entry));
  }
  await chmod(targetDir, 0o700);
}

