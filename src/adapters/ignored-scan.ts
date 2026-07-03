import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const NESTED_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE',
] as const;

function gitExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of NESTED_GIT_ENV_VARS) {
    delete env[name];
  }
  return env;
}

export interface IgnoredScanResult {
  hasSensitiveIgnored: boolean;
  /** up to a small sample (cap 5) of sensitive ignored paths. */
  sample: string[];
}

/** Ignored paths under these prefixes are considered regenerable (safe), not sensitive. */
export const REGENERABLE_IGNORED_ALLOWLIST = [
  'node_modules/',
  'dist/',
  'build/',
  'target/',
  '.next/',
  'graphify-out/',
] as const;

const DEFAULT_TIMEOUT_MS = 5000;
const SAMPLE_CAP = 5;

/**
 * Scan a worktree's git-ignored paths for anything sensitive (i.e. not covered
 * by the regenerable allowlist, like build output directories). Best-effort:
 * never throws — any git failure degrades to a "nothing sensitive found" result.
 */
export async function scanIgnored(
  worktreePath: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<IgnoredScanResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const { stdout } = await execFile(
      'git',
      ['-C', worktreePath, 'status', '--ignored', '--porcelain'],
      { timeout: timeoutMs, signal: opts?.signal, env: gitExecEnv() },
    );

    const sample: string[] = [];
    let hasSensitiveIgnored = false;
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('!! ')) continue;
      const path = line.slice(3);
      const isRegenerable = REGENERABLE_IGNORED_ALLOWLIST.some((prefix) => path.startsWith(prefix));
      if (isRegenerable) continue;
      hasSensitiveIgnored = true;
      if (sample.length < SAMPLE_CAP) sample.push(path);
    }
    return { hasSensitiveIgnored, sample };
  } catch {
    return { hasSensitiveIgnored: false, sample: [] };
  }
}
