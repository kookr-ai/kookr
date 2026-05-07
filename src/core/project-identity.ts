import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { existsSync } from 'node:fs';
import { endsWithProtectedSuffix, deriveParentRepoFromProtected } from './worktree-protection.js';

const execFileAsync = promisify(execFile);
const NESTED_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
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

/**
 * Normalize a git remote URL to a canonical form: "github.com/owner/repo"
 *
 * Handles:
 * - HTTPS: https://github.com/owner/repo.git → github.com/owner/repo
 * - SSH:   git@github.com:owner/repo.git    → github.com/owner/repo
 * - Protocol prefix stripping
 * - .git suffix stripping
 * - Trailing slash stripping
 * - Case normalization (lowercase)
 */
export function normalizeGitRemote(url: string): string {
  let normalized = url.trim();

  // Strip protocol prefixes first (before user@ stripping)
  normalized = normalized.replace(/^(https?|git|ssh):\/\//, '');

  // Strip SSH user prefix: git@github.com:owner/repo → github.com/owner/repo
  normalized = normalized.replace(/^[a-zA-Z0-9_-]+@/, '');
  // Convert SSH colon syntax to slash
  normalized = normalized.replace(/^([^:/]+):(?!\/)/, '$1/');

  // Strip .git suffix
  normalized = normalized.replace(/\.git$/, '');

  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, '');

  // Lowercase for case-insensitive comparison
  normalized = normalized.toLowerCase();

  return normalized;
}

/**
 * Normalize a repo specifier to a project ID.
 *
 * Handles:
 * - owner/repo → github.com/owner/repo
 * - github.com/owner/repo → github.com/owner/repo
 * - Full remote URLs via normalizeGitRemote()
 */
export function projectIdFromRepoSpecifier(specifier: string): string | null {
  const normalized = specifier.trim();
  if (!normalized) return null;

  if (/^[a-z]+:\/\//i.test(normalized) || /^[a-zA-Z0-9_.-]+@[^:]+:/.test(normalized)) {
    return normalizeGitRemote(normalized);
  }

  if (/^[^/\s]+\.[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(normalized)) {
    return normalized.toLowerCase();
  }

  if (/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    return `github.com/${normalized.toLowerCase()}`;
  }

  return null;
}

/**
 * Extract an explicit repo flag from `gh pr create` or `gh issue` commands.
 * Supports:
 * - `-R owner/repo`
 * - `-R=owner/repo`
 * - `--repo owner/repo`
 * - `--repo=owner/repo`
 * - quoted values
 */
export function extractRepoSpecifierFromGhCommand(command: string): string | null {
  const match = command.match(
    /(?:^|\s)(?:--repo|-R)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/m,
  );
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw?.trim() || null;
}

/**
 * Extract the first command-level `cd` target from a shell command.
 * Used to recover the real repo when the outer session CWD is a tool repo.
 */
export function extractShellCwd(command: string): string | null {
  const match = command.match(
    /(?:^|[;\n]|&&|\|\|)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/m,
  );
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw?.trim() || null;
}

/**
 * Derive a project ID from a GitHub pull request URL.
 */
export function projectIdFromPrUrl(prUrl: string): string | null {
  const match = prUrl.trim().match(
    /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/\d+(?:[?#/].*)?$/i,
  );
  if (!match) return null;
  return normalizeGitRemote(`https://${match[1]}/${match[2]}/${match[3]}`);
}

/**
 * Extract a display name from a project ID.
 * "github.com/grafana/grafana" → "grafana/grafana"
 * "local/my-project" → "my-project"
 */
export function projectDisplayName(projectId: string): string {
  const parts = projectId.split('/');
  // For "local/dirname" format, return just the dirname
  if (parts[0] === 'local' && parts.length === 2) {
    return parts[1];
  }
  // For host/owner/repo format, return owner/repo
  if (parts.length >= 3) {
    return parts.slice(1).join('/');
  }
  return projectId;
}

/**
 * Resolve the project ID for a working directory.
 *
 * Runs `git remote get-url origin` to get the remote URL, then normalizes it.
 * Falls back to CWD basename (prefixed with "local/") if no git remote exists.
 */
export async function getProjectId(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      env: gitExecEnv(),
      timeout: 5000,
    });
    const remoteUrl = stdout.trim();
    if (remoteUrl) {
      return normalizeGitRemote(remoteUrl);
    }
  } catch {
    // Not a git repo or no remote — fall through to basename
  }
  return `local/${basename(cwd)}`;
}

/**
 * Pick the canonical local-checkout path to record for a project, given a
 * task's cwd. Used by agent-lifecycle to stamp ProjectConfig.localPath on
 * first task start.
 *
 * - cwd missing on disk → null (skip stamping; the cwd is unusable).
 * - cwd ends with the kookr-prod self-hosting suffix:
 *   - parent exists → parent (prefer the canonical clone over the worktree).
 *   - parent missing → cwd itself (something is better than nothing).
 * - otherwise → cwd.
 *
 * Deliberately narrow: the only suffix-aware rule is the literal "kookr-prod"
 * carve-out for Kookr's own self-hosting layout. Generic worktree-suffix
 * stripping was dropped after review showed false-positives on adversarial
 * names (e.g. `bandwidth-surgery-m1-harness` next to `bandwidth-surgery`).
 * Users with multi-worktree layouts use the launch dialog's explicit
 * "Set as default for this project" affordance instead.
 */
export function deriveCanonicalPath(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  if (endsWithProtectedSuffix(cwd)) {
    const parent = deriveParentRepoFromProtected(cwd);
    if (parent !== cwd && existsSync(parent)) return parent;
    return cwd;
  }
  return cwd;
}

/**
 * Deterministic color index (0-7) for a project ID.
 * Same algorithm as presentation.ts projectColor but operates on projectId.
 */
export function projectColorIndex(projectId: string): number {
  let hash = 0;
  for (let i = 0; i < projectId.length; i++) {
    hash = ((hash << 5) - hash + projectId.charCodeAt(i)) | 0;
  }
  return ((hash % 8) + 8) % 8;
}
