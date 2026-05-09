import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const REPO_KEY_MAX_SLUG_LEN = 100;
const REPO_KEY_HASH_LEN = 8;
export const SEMANTIC_CHECKPOINT_SCHEMA_VERSION = 'semantic-checkpoint.v1';
export const CHECKPOINT_JSON_FILENAME = 'CHECKPOINT.json';
export const CHECKPOINT_MARKDOWN_FILENAME = 'CHECKPOINT.md';

/**
 * Replace filesystem-unsafe characters with a single dash. Used for branch
 * names that may contain slashes, colons, or shell glob metacharacters.
 *
 * Behaviour: any character that is not [A-Za-z0-9._-] becomes `-`. The result
 * is never empty for non-empty input.
 */
export function slugifyForCheckpointKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Compute a deterministic, filesystem-safe key for a git checkout, derived
 * from its absolute git-common-dir path. Truncates the slug for path-length
 * safety (255-byte limits on common filesystems) and appends an 8-char SHA-1
 * hash of the full path so that collisions between truncated paths cannot
 * happen.
 */
function repoKeyFor(gitCommonDir: string): string {
  const slug = slugifyForCheckpointKey(gitCommonDir).slice(0, REPO_KEY_MAX_SLUG_LEN);
  const hash = createHash('sha1').update(gitCommonDir).digest('hex').slice(0, REPO_KEY_HASH_LEN);
  return `${slug}-${hash}`;
}

interface ResolveCheckpointDirOptions {
  cwd: string;
  kookrDataDir: string;
}

/**
 * Resolve the per-(repo, branch) checkpoint directory for a task and
 * pre-create it. Returns null on any failure — the caller treats checkpoint
 * support as a strictly additive optimization that must never break task
 * launch.
 *
 * Failure modes (all return null, fail-open):
 *   - cwd is not in a git repo
 *   - cwd is on a detached HEAD (no symbolic branch name)
 *   - kookrDataDir contains shell glob metacharacters that would silently
 *     break the Claude Code permission allowlist matching
 *   - mkdir fails (disk full, permission denied, etc.)
 *
 * The directory is keyed on `(git-common-dir, branch)` so that two Kookr
 * tasks days apart on the same branch share the same checkpoint directory.
 * This is the v5 design — see docs/poc/005-checkpoint-cycle-mechanics.md.
 *
 * For a linked worktree, the **common dir** is shared with the main repo
 * (so two worktrees of the same repo on different branches both key under
 * the same `repoKey`) but the **branch name** is read from the worktree's
 * own gitdir — `<common>/worktrees/<name>/HEAD` — not the common dir's
 * HEAD. Reading from the common dir would return the main repo's branch
 * for every worktree.
 */
export async function resolveAndPrepareCheckpointDir(
  opts: ResolveCheckpointDirOptions,
): Promise<string | null> {
  if (containsShellMetacharacters(opts.kookrDataDir)) {
    return null;
  }

  const gitInfo = await resolveGitDirs(opts.cwd);
  if (!gitInfo) return null;

  const branch = await readBranchName(gitInfo.headDir);
  if (!branch) return null;

  const repoKey = repoKeyFor(gitInfo.commonDir);
  const branchSlug = slugifyForCheckpointKey(branch);
  const dir = join(opts.kookrDataDir, 'checkpoints', repoKey, branchSlug);

  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

function containsShellMetacharacters(path: string): boolean {
  return /[\s$(){}[\]*?"'`\\!]/.test(path);
}

interface GitDirs {
  /** The git common dir (shared across worktrees of the same repo). */
  commonDir: string;
  /** The dir that holds THIS worktree's HEAD file. Equals commonDir for the primary worktree. */
  headDir: string;
}

async function resolveGitDirs(cwd: string): Promise<GitDirs | null> {
  const gitPath = join(cwd, '.git');
  let gitStat;
  try {
    gitStat = await stat(gitPath);
  } catch {
    return null;
  }

  if (gitStat.isDirectory()) {
    // Primary worktree: .git is the common dir AND the head dir.
    const dir = resolve(gitPath);
    return { commonDir: dir, headDir: dir };
  }

  if (!gitStat.isFile()) return null;

  // Linked worktree: .git is a file containing `gitdir: <linked-git-dir>`.
  // The linked git dir is at `<common>/worktrees/<name>` and contains this
  // worktree's HEAD. The common dir is two levels up (`worktrees/..` →
  // common dir).
  let content: string;
  try {
    content = await readFile(gitPath, 'utf-8');
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;
  const linkedGitDir = resolve(match[1].trim());
  const commonDir = resolve(linkedGitDir, '..', '..');
  return { commonDir, headDir: linkedGitDir };
}

async function readBranchName(headDir: string): Promise<string | null> {
  // Read HEAD directly rather than shelling to git. This is faster, has no
  // dependency on `git` being on PATH, and the format is stable.
  //
  // `headDir` is the dir that holds this worktree's HEAD — for a linked
  // worktree that is the linked git dir, NOT the common dir.
  let head: string;
  try {
    head = await readFile(join(headDir, 'HEAD'), 'utf-8');
  } catch {
    return null;
  }
  const trimmed = head.trim();
  // Symbolic ref: "ref: refs/heads/<branch>"
  const m = trimmed.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (m) return m[1];
  // Detached HEAD (just a sha) — no branch
  return null;
}

export type SemanticCheckpointVerdict = 'in_progress' | 'blocked' | 'stalled' | 'complete';

export interface SemanticCheckpointV1 {
  schema_version: typeof SEMANTIC_CHECKPOINT_SCHEMA_VERSION;
  task_id: string;
  repo: string;
  worktree: string;
  branch: string;
  verdict: SemanticCheckpointVerdict;
  decisions: unknown[];
  evidence: unknown[];
  files_changed: unknown[];
  tests_run: unknown[];
  open_risks: unknown[];
  next_actions: unknown[];
  memory_write_candidates: unknown[];
}

export type SemanticCheckpointInspection =
  | { kind: 'json'; jsonPath: string; markdownPath: string }
  | {
      kind: 'markdown';
      markdownPath: string;
      reason: 'json_missing' | 'json_invalid' | 'json_unreadable';
      warning?: string;
    }
  | {
      kind: 'none';
      reason: 'no_checkpoint_files' | 'checkpoint_dir_unreadable' | 'json_invalid' | 'json_unreadable';
      warning?: string;
    };

const REQUIRED_ARRAY_FIELDS = [
  'decisions',
  'evidence',
  'files_changed',
  'tests_run',
  'open_risks',
  'next_actions',
  'memory_write_candidates',
] as const;

const VALID_VERDICTS = new Set<SemanticCheckpointVerdict>([
  'in_progress',
  'blocked',
  'stalled',
  'complete',
]);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function validateSemanticCheckpoint(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'root must be an object';
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== SEMANTIC_CHECKPOINT_SCHEMA_VERSION) {
    return `schema_version must be ${SEMANTIC_CHECKPOINT_SCHEMA_VERSION}`;
  }
  for (const field of ['task_id', 'repo', 'worktree', 'branch'] as const) {
    if (typeof record[field] !== 'string' || record[field].trim() === '') {
      return `${field} must be a non-empty string`;
    }
  }
  if (typeof record.verdict !== 'string' || !VALID_VERDICTS.has(record.verdict as SemanticCheckpointVerdict)) {
    return 'verdict must be one of in_progress, blocked, stalled, complete';
  }
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(record[field])) {
      return `${field} must be an array`;
    }
  }
  return null;
}

/**
 * Inspect checkpoint files in a fail-open way. JSON errors become warning
 * metadata and Markdown fallback; callers must never let checkpoint state
 * prevent an agent launch.
 */
export async function inspectSemanticCheckpoint(checkpointDir: string): Promise<SemanticCheckpointInspection> {
  const jsonPath = join(checkpointDir, CHECKPOINT_JSON_FILENAME);
  const markdownPath = join(checkpointDir, CHECKPOINT_MARKDOWN_FILENAME);

  const hasMarkdown = await fileExists(markdownPath);
  const hasJson = await fileExists(jsonPath);
  if (!hasJson) {
    return hasMarkdown
      ? { kind: 'markdown', markdownPath, reason: 'json_missing' }
      : { kind: 'none', reason: 'no_checkpoint_files' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(jsonPath, 'utf-8'));
  } catch (err) {
    const warning = `Invalid semantic checkpoint JSON at ${jsonPath}: ${err instanceof Error ? err.message : String(err)}`;
    return hasMarkdown
      ? { kind: 'markdown', markdownPath, reason: 'json_unreadable', warning }
      : { kind: 'none', reason: 'json_unreadable', warning };
  }

  const validationError = validateSemanticCheckpoint(parsed);
  if (validationError) {
    const warning = `Invalid semantic checkpoint JSON at ${jsonPath}: ${validationError}`;
    return hasMarkdown
      ? { kind: 'markdown', markdownPath, reason: 'json_invalid', warning }
      : { kind: 'none', reason: 'json_invalid', warning };
  }

  return { kind: 'json', jsonPath, markdownPath };
}

function maybeWarn(inspection: SemanticCheckpointInspection): void {
  if ('warning' in inspection && inspection.warning) {
    console.warn(`[checkpoint] ${inspection.warning}; falling back without breaking launch.`);
  }
}

/**
 * Instruction injected into spawned agents so they read checkpoint state on
 * resume. The instruction stays short because it sits in the system prompt
 * (Claude Code) or prompt prefix (Codex CLI) of checkpoint-enabled launches.
 *
 * Empirically validated post-`/compact` survival of system-prompt content in
 * `docs/poc/005-checkpoint-cycle-mechanics.md` (the `magic word?` sentinel).
 */
export async function buildCheckpointLoadInstruction(checkpointDir?: string): Promise<string> {
  if (!checkpointDir) return CHECKPOINT_LOAD_INSTRUCTION;

  const inspection = await inspectSemanticCheckpoint(checkpointDir);
  maybeWarn(inspection);

  const writeProtocol =
    `When a user message asks you to update checkpoints (Kookr sends this proactively before /compact), ` +
    `use the Write tool to refresh both $KOOKR_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} and ` +
    `$KOOKR_CHECKPOINT_DIR/${CHECKPOINT_JSON_FILENAME}. The JSON file must use ` +
    `${SEMANTIC_CHECKPOINT_SCHEMA_VERSION} with task_id, repo, worktree, branch, verdict, decisions, ` +
    `evidence, files_changed, tests_run, open_risks, next_actions, and memory_write_candidates.`;

  if (inspection.kind === 'json') {
    return `Kookr checkpoint protocol: valid ${CHECKPOINT_JSON_FILENAME} detected. Read $KOOKR_CHECKPOINT_DIR/${CHECKPOINT_JSON_FILENAME} as your very first action in this session; it is the durable semantic state from previous tasks on the same branch. ${CHECKPOINT_MARKDOWN_FILENAME} remains the human-readable companion. ${writeProtocol} See the oss-task-checkpointing skill for the full protocol.`;
  }

  if (inspection.kind === 'markdown') {
    if (inspection.reason === 'json_missing') {
      return `Kookr checkpoint protocol: ${CHECKPOINT_JSON_FILENAME} is not present. Read $KOOKR_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} as your very first action in this session; it carries durable state from previous tasks on the same branch. ${writeProtocol} See the oss-task-checkpointing skill for the full protocol.`;
    }
    return `Kookr checkpoint protocol: ${CHECKPOINT_JSON_FILENAME} is invalid. Warn that ${CHECKPOINT_JSON_FILENAME} was invalid, then Read $KOOKR_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} as your very first action in this session; Markdown is the fail-open fallback. ${writeProtocol} See the oss-task-checkpointing skill for the full protocol.`;
  }

  if (inspection.reason === 'json_invalid' || inspection.reason === 'json_unreadable') {
    return `Kookr checkpoint protocol: ${CHECKPOINT_JSON_FILENAME} is invalid and no ${CHECKPOINT_MARKDOWN_FILENAME} fallback is available. Warn that ${CHECKPOINT_JSON_FILENAME} was invalid, then continue without blocking launch. ${writeProtocol} See the oss-task-checkpointing skill for the full protocol.`;
  }

  return `Kookr checkpoint protocol: if the KOOKR_CHECKPOINT_DIR environment variable is set, prefer $KOOKR_CHECKPOINT_DIR/${CHECKPOINT_JSON_FILENAME} when it exists and validates as ${SEMANTIC_CHECKPOINT_SCHEMA_VERSION}; otherwise fall back to $KOOKR_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} when present. ${writeProtocol} See the oss-task-checkpointing skill for the full protocol.`;
}

export const CHECKPOINT_LOAD_INSTRUCTION =
  `Kookr checkpoint protocol: if the KOOKR_CHECKPOINT_DIR environment variable is set, prefer $KOOKR_CHECKPOINT_DIR/${CHECKPOINT_JSON_FILENAME} when it exists and validates as ${SEMANTIC_CHECKPOINT_SCHEMA_VERSION}; otherwise fall back to $KOOKR_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} when present. When a user message asks you to update checkpoints (Kookr sends this proactively before /compact), use the Write tool to refresh both $KOOKR_CHECKPOINT_DIR/${CHECKPOINT_MARKDOWN_FILENAME} and $KOOKR_CHECKPOINT_DIR/${CHECKPOINT_JSON_FILENAME}, then continue. See the oss-task-checkpointing skill for the full protocol.`;

// Test-only export: do not import this from production code.
export const __test__ = { repoKeyFor };
