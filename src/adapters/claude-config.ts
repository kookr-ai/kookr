import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Claude Code workspace-trust persistence (PoC 003 gap 8).
 *
 * Codex launch already writes `trust_level = "trusted"` into
 * `~/.codex/config.toml` so the first interactive session in a new cwd
 * does not sit on a "do you trust this folder?" dialog. Claude Code
 * stores the same fact as `projects[cwd].hasTrustDialogAccepted` in
 * `~/.claude.json`. Without that bit, Claude 2.1+ paints a dialog whose
 * default choice is "No, exit"; Kookr's paste-ready timeout then sends
 * Enter and kills the session.
 *
 * This helper is the Claude equivalent of {@link ensureCodexWorkspaceTrusted}:
 * set the bit for `cwd` before `createSession`, and do not rewrite the
 * file when it is already true.
 */

export interface EnsureClaudeWorkspaceTrustedOptions {
  /** Override `~/.claude.json`. Tests inject a temp path. */
  configPath?: string;
}

export interface ClaudeTrustUpsertResult {
  next: Record<string, unknown>;
  changed: boolean;
}

/** Default Claude Code user-config path (`~/.claude.json`). */
export function defaultClaudeConfigPath(): string {
  return join(homedir(), '.claude.json');
}

/**
 * Minimal project object matching the shape Claude writes for a newly
 * observed cwd, with trust already accepted so the dialog is skipped.
 */
export function defaultTrustedClaudeProjectEntry(): Record<string, unknown> {
  return {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
  };
}

/**
 * Pure upsert: set `projects[cwd].hasTrustDialogAccepted = true`.
 * Returns `changed: false` and the original object when the bit is
 * already true so callers can skip the disk write.
 */
export function upsertClaudeWorkspaceTrust(
  parsed: unknown,
  cwd: string,
): ClaudeTrustUpsertResult {
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const root: Record<string, unknown> = isPlainObject(parsed) ? { ...parsed } : {};
  const projects: Record<string, unknown> = isPlainObject(root.projects)
    ? { ...root.projects }
    : {};
  const existing = projects[cwd];

  if (isPlainObject(existing)) {
    if (existing.hasTrustDialogAccepted === true) {
      return { next: isPlainObject(parsed) ? parsed : root, changed: false };
    }
    projects[cwd] = { ...existing, hasTrustDialogAccepted: true };
    root.projects = projects;
    return { next: root, changed: true };
  }

  projects[cwd] = defaultTrustedClaudeProjectEntry();
  root.projects = projects;
  return { next: root, changed: true };
}

/**
 * Persist workspace trust for `cwd` in Claude Code's user config.
 * No-op when the cwd is already trusted. Missing config is created;
 * unreadable JSON is left untouched and rethrown so the caller can
 * fall through to the in-session dialog handler instead of wiping
 * a 5 MB config.
 */
export async function ensureClaudeWorkspaceTrusted(
  cwd: string,
  options?: EnsureClaudeWorkspaceTrustedOptions,
): Promise<'updated' | 'unchanged'> {
  const configPath = options?.configPath ?? defaultClaudeConfigPath();
  const absCwd = resolve(cwd);

  let parsed: unknown = {};
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf-8')) as unknown;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }

  const { next, changed } = upsertClaudeWorkspaceTrust(parsed, absCwd);
  if (!changed) return 'unchanged';

  await mkdir(dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  await rename(tmpPath, configPath);
  return 'updated';
}
