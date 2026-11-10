import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

/** Env for host git commands that touch a worker-writable repo: no global/system config, no prompts, no hooks. */
const SAFE_GIT_ENV = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Per-task clone for a container worker (RFC #3541 F10). `--no-hardlinks` matters: the default hardlinks objects, so a
 * worker could corrupt the host repo through them. Run as the host user, so the clone is owned by the uid the container
 * runs as. The worker commits locally; nothing is pushed (no credentials are mounted).
 */
export async function cloneForWorker(sourceRepo: string, destDir: string): Promise<void> {
  await mkdir(dirname(destDir), { recursive: true, mode: 0o700 });
  await execFileAsync('git', ['clone', '--local', '--no-hardlinks', '--quiet', '--', sourceRepo, destDir], { env: SAFE_GIT_ENV(), timeout: 120_000 });
}

export interface ExtractResult {
  ref: string;
  /** Commit the worker ended on (the new ref's tip). */
  head: string;
}

/**
 * Pull the worker's result into the SOURCE repo under `refs/kookr/opencode/<taskId>`, without ever running git inside
 * the clone as a trusted repository: the clone's own config (hooks, fsmonitor, aliases) is worker-controlled, so the host
 * runs `git fetch <clone-path>` from the source repo with global/system config disabled. A fetch needs only the clone's
 * object store through `upload-pack`, which does not execute repo-configured hooks.
 */
export async function extractDeliverable(sourceRepo: string, cloneDir: string, taskId: string): Promise<ExtractResult> {
  if (!TASK_ID.test(taskId)) throw new Error(`invalid task id ${JSON.stringify(taskId)}`);
  const ref = `refs/kookr/opencode/${taskId}`;
  // `objects/info/alternates` is repo DATA a worker can write: it would make the fetch read another host repo's objects.
  if (await lstat(join(cloneDir, '.git', 'objects', 'info', 'alternates')).then(() => true, () => false)) {
    throw new Error('clone has an objects/info/alternates file; refusing to fetch from it');
  }
  await execFileAsync('git', ['-C', sourceRepo, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', cloneDir, `+HEAD:${ref}`], { env: SAFE_GIT_ENV(), timeout: 120_000 });
  const { stdout } = await execFileAsync('git', ['-C', sourceRepo, 'rev-parse', '--verify', ref], { env: SAFE_GIT_ENV() });
  return { ref, head: stdout.trim() };
}

/** `git fsck` on the host repo with the hardened env; resolves true when clean. */
export async function fsckClean(repo: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repo, 'fsck', '--no-dangling', '--strict'], { env: SAFE_GIT_ENV(), timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

/** Plain-file read of a deliverable the worker wrote (`PR_BODY.md`, `REVIEW.md`): no symlink following out of the clone. */
export async function readDeliverableFile(cloneDir: string, name: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error(`invalid deliverable name ${JSON.stringify(name)}`);
  // O_NOFOLLOW closes the lstat-then-read window: a symlink swapped in after a check still cannot be read through.
  const fh = await open(join(cloneDir, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => undefined);
  if (!fh) return undefined;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > 1_000_000) return undefined;
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}
