import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Task, TaskStore } from '../../core/tasks.js';
import type { LaunchOpts } from '../launch-service.js';
import { resolvePluginDir } from '../../adapters/claude-code-adapter.js';

const execFile = promisify(execFileCb);

/**
 * Expected `skillSchemaVersion` in the task-feedback-reflect skill frontmatter.
 * Bumped when the skill's contract with the spawn use-case changes.
 */
const EXPECTED_SKILL_SCHEMA_VERSION = 1;

/** Identity file marking a reflect worktree. Cleanup keys off file presence. */
export const REFLECT_IDENTITY_FILE = '.kookr-reflect.json';
export const REFLECT_IDENTITY_SCHEMA = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RequestTaskReflectDeps {
  taskStore: TaskStore;
  /** Where ephemeral reflect worktrees live. Typically `<kookrDir>/reflect-worktrees`. */
  reflectWorktreesDir: string;
  /**
   * Launches a task via the standard launch flow. Injected so the use-case
   * stays free of the full LaunchServiceDeps surface.
   */
  launchTask: (opts: LaunchOpts) => Promise<{ task: Task; queued: boolean }>;
  /** Override resolved plugin dir (for tests). Defaults to resolvePluginDir(undefined). */
  pluginDirOverride?: string;
}

export interface RequestTaskReflectInput {
  sourceTaskId: string;
  /** Path to the immutable feedback bundle dir (from write-feedback-bundle). */
  bundlePath: string;
  /** 'down' triggers fix-proposal branch in the skill; 'up' triggers reinforcement. */
  direction: 'up' | 'down';
}

export interface RequestTaskReflectResult {
  spawned: boolean;
  reason?: string;
  reflectTaskId?: string;
}

/**
 * Spawn a sandboxed reflect task to analyze a single completed source task.
 *
 * Preconditions checked in order — all must pass or the spawn aborts:
 *   1. Kill switch (`KOOKR_AUTO_REFLECT_DISABLE=1`) is not set.
 *   2. Source task exists in the store.
 *   3. Bundle dir exists at the supplied path.
 *   4. Plugin dir resolves and contains the task-feedback-reflect skill at the
 *      expected schema version.
 *
 * Each abort logs a clear reason; the caller can surface it to the user.
 *
 * On success: allocates an ephemeral worktree from `main`, builds a 5-line
 * spawn prompt that points at the bundle and tells the agent to load the skill,
 * launches via `launchTask` with `sandboxProfile: 'reflect'`. Persists
 * `reflectMeta` on the spawned task so cleanup logic can identify it.
 */
export async function requestTaskReflect(
  input: RequestTaskReflectInput,
  deps: RequestTaskReflectDeps,
): Promise<RequestTaskReflectResult> {
  // 1. Kill switch — read inline at call time (no caching) so the operator
  //    can flip it without restarting the server.
  if (process.env.KOOKR_AUTO_REFLECT_DISABLE === '1') {
    return { spawned: false, reason: 'kill_switch_set' };
  }

  // 2. Source task exists
  const sourceTask = deps.taskStore.getTask(input.sourceTaskId);
  if (!sourceTask) {
    return { spawned: false, reason: 'source_task_not_found' };
  }

  // 3. Bundle dir exists
  try {
    await access(input.bundlePath);
  } catch {
    return { spawned: false, reason: 'bundle_path_missing' };
  }

  // 4. Plugin dir + skill resolve, content + schema version match expected.
  const pluginDir = deps.pluginDirOverride ?? resolvePluginDir(undefined);
  if (!pluginDir) {
    return { spawned: false, reason: 'plugin_dir_unresolved' };
  }
  const skillPath = join(pluginDir, 'skills', 'task-feedback-reflect', 'SKILL.md');
  const skillCheck = await verifySkill(skillPath);
  if (!skillCheck.ok) {
    return { spawned: false, reason: `skill_verification_failed: ${skillCheck.reason}` };
  }

  // Allocate ephemeral worktree from main of the source task's repo.
  const sourceRepoRoot = await resolveRepoRoot(sourceTask.cwd);
  if (!sourceRepoRoot) {
    return { spawned: false, reason: 'source_repo_root_unresolved' };
  }
  const worktreeId = `${input.sourceTaskId}-${nowSlug()}`;
  const worktreePath = join(deps.reflectWorktreesDir, worktreeId);
  await mkdir(deps.reflectWorktreesDir, { recursive: true });

  try {
    await execFile('git', ['-C', sourceRepoRoot, 'worktree', 'add', '--detach', worktreePath, 'main']);
  } catch (err) {
    return { spawned: false, reason: `worktree_create_failed: ${(err as Error).message}` };
  }

  try {
    const identity = {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: input.sourceTaskId,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(worktreePath, REFLECT_IDENTITY_FILE), JSON.stringify(identity, null, 2));
  } catch (err) {
    await execFile('git', ['worktree', 'remove', '--force', worktreePath]).catch(() => {});
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    return { spawned: false, reason: `identity_write_failed: ${(err as Error).message}` };
  }

  // 5-line spawn prompt — the skill owns all the workflow logic.
  const prompt = [
    `You are running a per-task self-reflect.`,
    ``,
    `Bundle: ${join(input.bundlePath, 'bundle.json')}`,
    `Source agent type: ${sourceTask.agentType}`,
    `Source task project root: ${sourceRepoRoot}`,
    ``,
    `Load the \`task-feedback-reflect\` skill and follow it.`,
  ].join('\n');

  let result: { task: Task; queued: boolean };
  try {
    result = await deps.launchTask({
      prompt,
      cwd: worktreePath,
      agentType: 'claude-code',
      disableDedup: true,
      launchSource: 'api',
      sandboxProfile: 'reflect',
    });
  } catch (err) {
    // Clean up worktree on launch failure
    await execFile('git', ['worktree', 'remove', '--force', worktreePath]).catch(() => {});
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    return { spawned: false, reason: `launch_failed: ${(err as Error).message}` };
  }

  // Mark the spawned task so cleanup can recognize it as a reflect task
  deps.taskStore.setReflectMeta(result.task.id, {
    sourceTaskId: input.sourceTaskId,
    bundlePath: input.bundlePath,
    direction: input.direction,
  });

  return { spawned: true, reflectTaskId: result.task.id };
}

interface SkillCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Verify the task-feedback-reflect skill is present, non-empty, and at the
 * expected schema version. Strict — any missing field fails closed.
 */
async function verifySkill(skillPath: string): Promise<SkillCheck> {
  if (!existsSync(skillPath)) return { ok: false, reason: 'file_missing' };
  let content: string;
  try {
    content = await readFile(skillPath, 'utf-8');
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
  if (content.length < 100) return { ok: false, reason: 'content_too_short' };
  if (!content.startsWith('---')) return { ok: false, reason: 'no_frontmatter' };

  // Find frontmatter block
  const lines = content.split(/\r?\n/);
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return { ok: false, reason: 'frontmatter_unclosed' };
  const fmLines = lines.slice(1, closeIdx);

  const nameLine = fmLines.find((l) => /^name\s*:/.test(l));
  const versionLine = fmLines.find((l) => /^skillSchemaVersion\s*:/.test(l));
  if (!nameLine) return { ok: false, reason: 'name_missing' };
  if (!versionLine) return { ok: false, reason: 'skillSchemaVersion_missing' };

  const name = nameLine.replace(/^name\s*:\s*/, '').trim();
  if (name !== 'task-feedback-reflect') return { ok: false, reason: `name_mismatch:${name}` };

  const versionStr = versionLine.replace(/^skillSchemaVersion\s*:\s*/, '').trim();
  const version = Number(versionStr);
  if (version !== EXPECTED_SKILL_SCHEMA_VERSION) {
    return { ok: false, reason: `version_mismatch:${versionStr}!=${EXPECTED_SKILL_SCHEMA_VERSION}` };
  }
  return { ok: true };
}

async function resolveRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    return resolve(stdout.trim());
  } catch {
    return null;
  }
}

function nowSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Resolve the sourceTaskId for a candidate reflect worktree directory.
 *
 * Classification is keyed off `.kookr-reflect.json` presence: that file is the
 * marker that a directory is a reflect worktree. If the file is missing, fall
 * back to basename parsing for legacy worktrees created before identity files,
 * and only when the parsed segment is a UUID — manually-named directories
 * shaped `*-*` must not be misclassified.
 */
async function readReflectIdentity(
  dirPath: string,
  dirName: string,
): Promise<{ sourceTaskId: string; legacy: boolean } | null> {
  const identityPath = join(dirPath, REFLECT_IDENTITY_FILE);
  let raw: string;
  try {
    raw = await readFile(identityPath, 'utf-8');
  } catch {
    // File missing — try legacy basename parse, but only accept UUIDs.
    const candidate = dirName.split('-', 5).join('-');
    if (UUID_RE.test(candidate)) {
      console.warn('[reflect-sweep] legacy worktree without identity file', {
        dir: dirPath,
        sourceTaskId: candidate,
      });
      return { sourceTaskId: candidate, legacy: true };
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[reflect-sweep] identity file parse error', {
      dir: dirPath,
      error: (err as Error).message,
    });
    return null;
  }
  const sourceTaskId =
    parsed && typeof parsed === 'object' && 'sourceTaskId' in parsed
      ? (parsed as { sourceTaskId?: unknown }).sourceTaskId
      : undefined;
  if (typeof sourceTaskId !== 'string' || !UUID_RE.test(sourceTaskId)) {
    console.warn('[reflect-sweep] identity file missing valid sourceTaskId', {
      dir: dirPath,
    });
    return null;
  }
  return { sourceTaskId, legacy: false };
}

/**
 * Startup sweep: remove any ephemeral reflect worktree whose linked task is
 * no longer present in the task store, plus a 7-day TTL backstop. Called from
 * startup recovery so crashes between worktree creation and reflect-task
 * completion don't accumulate dirs.
 */
export async function sweepReflectWorktrees(deps: {
  reflectWorktreesDir: string;
  taskStore: TaskStore;
}): Promise<{ removed: number; kept: number }> {
  if (!existsSync(deps.reflectWorktreesDir)) {
    return { removed: 0, kept: 0 };
  }
  let removed = 0;
  let kept = 0;
  const { readdir, stat } = await import('node:fs/promises');
  const entries = await readdir(deps.reflectWorktreesDir, { withFileTypes: true });
  const now = Date.now();
  const TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // Build a set of source task IDs that have a live reflect task
  const liveReflectSourceTaskIds = new Set<string>();
  for (const t of deps.taskStore.listTasks()) {
    if (t.reflectMeta?.sourceTaskId) {
      liveReflectSourceTaskIds.add(t.reflectMeta.sourceTaskId);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(deps.reflectWorktreesDir, entry.name);
    const identity = await readReflectIdentity(dirPath, entry.name);
    if (!identity) {
      // Not a reflect worktree (or unparseable identity). Leave it alone.
      kept++;
      continue;
    }
    const linkedTaskAlive = liveReflectSourceTaskIds.has(identity.sourceTaskId);

    let stale = !linkedTaskAlive;
    if (!stale) {
      // TTL backstop
      try {
        const st = await stat(dirPath);
        if (now - st.mtimeMs > TTL_MS) stale = true;
      } catch {
        stale = true;
      }
    }

    if (stale) {
      // Try git worktree remove first; fall back to rm -rf
      try {
        await execFile('git', ['worktree', 'remove', '--force', dirPath]);
      } catch {
        await rm(dirPath, { recursive: true, force: true }).catch(() => {});
      }
      removed++;
    } else {
      kept++;
    }
  }
  return { removed, kept };
}
