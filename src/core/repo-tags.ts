import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_TAGS_FILE = '.kookr/repo-tags';
const GIT_REMOTE_TIMEOUT_MS = 2000;

/**
 * Detect repo-tags for a given cwd. Tags drive plugin playbook visibility:
 * a plugin playbook with `repo-tags: [github]` in its frontmatter is hidden
 * in cwds that lack the `github` tag.
 *
 * Resolution merges three sources (deduplicated):
 *  1. `KOOKR_REPO_TAGS` env (comma- or newline-separated) — short-circuits
 *     filesystem and subprocess checks; primarily for tests and power users.
 *  2. Tags listed in `<cwd>/.kookr/repo-tags` (one per line; blank and
 *     `#`-prefixed lines ignored).
 *  3. Auto-detected: `github` if `git remote get-url origin` returns a
 *     github.com URL.
 *
 * Returns deduplicated tags. Empty array on no detection.
 */
export async function detectRepoTags(cwd: string): Promise<string[]> {
  const override = process.env.KOOKR_REPO_TAGS;
  if (override !== undefined) {
    return parseTagList(override);
  }

  const tags = new Set<string>();
  for (const tag of await readRepoTagsFile(cwd)) tags.add(tag);
  if (await isGithubRepo(cwd)) tags.add('github');
  return Array.from(tags);
}

/**
 * True when `playbook.repoTags` is empty/absent (always visible) or it
 * intersects `projectTags` by at least one tag.
 */
export function repoTagsAllow(
  playbookRepoTags: string[] | undefined,
  projectTags: string[],
): boolean {
  if (!playbookRepoTags || playbookRepoTags.length === 0) return true;
  return playbookRepoTags.some((tag) => projectTags.includes(tag));
}

function parseTagList(raw: string): string[] {
  const seen = new Set<string>();
  for (const item of raw.split(/[,\n]/)) {
    const trimmed = item.trim();
    if (trimmed.length > 0 && !trimmed.startsWith('#')) seen.add(trimmed);
  }
  return Array.from(seen);
}

async function readRepoTagsFile(cwd: string): Promise<string[]> {
  try {
    const content = await readFile(join(cwd, REPO_TAGS_FILE), 'utf-8');
    return parseTagList(content);
  } catch {
    return [];
  }
}

async function isGithubRepo(cwd: string): Promise<boolean> {
  if (!existsSync(join(cwd, '.git'))) return false;
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: GIT_REMOTE_TIMEOUT_MS,
    });
    return /github\.com/i.test(stdout);
  } catch {
    return false;
  }
}
