import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import type { Task, TaskStore } from '../../core/tasks.js';
// Import LaunchOpts from the shared contract — not launch-service — so this
// use-case does not close a cycle with agent-lifecycle → request-task-reflect
// → launch-service → agent-lifecycle (#1466).
import type { LaunchOpts } from '../../shared/contracts/launch.js';
import { resolvePluginDir } from '../../adapters/claude-code-adapter.js';
import { gitExecEnv } from '../../core/git-helpers.js';
import { looksLikeLinkedWorktree, removeRegisteredWorktree } from '../../adapters/worktree-safety.js';

const execFile = promisify(execFileCb);

function execGit(args: string[]) {
  return execFile('git', args, { env: gitExecEnv() });
}

/**
 * Expected `skillSchemaVersion` values in reflect skill frontmatter.
 * Bumped when the skill's contract with the spawn use-case changes.
 */
const REFLECT_SKILLS = {
  feedback: { name: 'task-feedback-reflect', schemaVersion: 1 },
  snapshot: { name: 'task-snapshot-reflect', schemaVersion: 1 },
} as const;

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
  launchTask: (
    opts: LaunchOpts,
    serverOpts?: { deliveryPolicy?: 'pre-authorized' | 'ask-first' },
  ) => Promise<{ task: Task; queued: boolean }>;
  /** Override resolved plugin dir (for tests). Defaults to resolvePluginDir(undefined). */
  pluginDirOverride?: string;
}

export interface RequestTaskReflectInput {
  sourceTaskId: string;
  /** Path to the immutable bundle dir. */
  bundlePath: string;
  /** Completed-feedback reflect is rating-directed; snapshot reflect starts in review mode. */
  direction: 'up' | 'down' | 'review';
  /** Defaults to `feedback` for backwards compatibility. */
  kind?: keyof typeof REFLECT_SKILLS;
}

export interface RequestTaskReflectResult {
  spawned: boolean;
  reason?: string;
  reflectTaskId?: string;
}

/**
 * Spawn a sandboxed reflect task to analyze a single source task snapshot.
 *
 * Preconditions checked in order — all must pass or the spawn aborts:
 *   1. Kill switch (`KOOKR_AUTO_REFLECT_DISABLE=1`) is not set.
 *   2. Source task exists in the store.
 *   3. Bundle dir exists at the supplied path.
 *   4. Plugin dir resolves and contains the requested reflect skill at the
 *      expected schema version.
 *
 * Each abort logs a clear reason; the caller can surface it to the user.
 *
 * On success: allocates an ephemeral worktree from the source repo baseline,
 * builds a concise spawn prompt that points at the bundle and tells the agent
 * to load the skill, launches via `launchTask`. Persists
 * `reflectMeta` on the spawned task so cleanup logic can identify it.
 */
export async function requestTaskReflect(
  input: RequestTaskReflectInput,
  deps: RequestTaskReflectDeps,
): Promise<RequestTaskReflectResult> {
  const reflectKind = input.kind ?? 'feedback';
  const skill = REFLECT_SKILLS[reflectKind];

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
  const skillPath = join(pluginDir, 'skills', skill.name, 'SKILL.md');
  const skillCheck = await verifySkill(skillPath, skill.name, skill.schemaVersion);
  if (!skillCheck.ok) {
    return { spawned: false, reason: `skill_verification_failed: ${skillCheck.reason}` };
  }

  // Allocate ephemeral worktree from the best available baseline of the source
  // task's repo. CI checkouts can be detached and lack a local `main` branch.
  const sourceRepoRoot = await resolveRepoRoot(sourceTask.cwd);
  if (!sourceRepoRoot) {
    return { spawned: false, reason: 'source_repo_root_unresolved' };
  }
  const baselineRef = await resolveReflectBaselineRef(sourceRepoRoot);
  if (!baselineRef) {
    return { spawned: false, reason: 'source_repo_baseline_unresolved' };
  }
  const worktreeId = `${input.sourceTaskId}-${nowSlug()}`;
  const worktreePath = join(deps.reflectWorktreesDir, worktreeId);
  await mkdir(deps.reflectWorktreesDir, { recursive: true });

  try {
    await execGit(['-C', sourceRepoRoot, 'worktree', 'add', '--detach', worktreePath, baselineRef]);
  } catch (err) {
    return { spawned: false, reason: `worktree_create_failed: ${(err as Error).message}` };
  }

  try {
    const identity = {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: input.sourceTaskId,
      kind: reflectKind,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(worktreePath, REFLECT_IDENTITY_FILE), JSON.stringify(identity, null, 2));
  } catch (err) {
    await removeRegisteredWorktree(worktreePath, { force: true }).catch(() => {});
    return { spawned: false, reason: `identity_write_failed: ${(err as Error).message}` };
  }

  const prompt = [
    reflectKind === 'snapshot'
      ? `You are running an anytime task snapshot reflection.`
      : `You are running a per-task feedback self-reflect.`,
    ``,
    `Bundle: ${join(input.bundlePath, 'bundle.json')}`,
    `Source agent type: ${sourceTask.agentType}`,
    `Source task project root: ${sourceRepoRoot}`,
    ``,
    `Load the \`${skill.name}\` skill and follow it.`,
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
      // Reflect skills carry their own human confirmation gates; ask-first
      // keeps the server gate consistent with the skill's designed flow.
    }, { deliveryPolicy: 'ask-first' });
  } catch (err) {
    // Clean up worktree on launch failure
    await removeReflectWorktree(worktreePath, deps.reflectWorktreesDir).catch(() => {});
    return { spawned: false, reason: `launch_failed: ${(err as Error).message}` };
  }

  // Mark the spawned task so cleanup can recognize it as a reflect task.
  // Record the worktree path so the terminal-state cleanup can remove exactly
  // this worktree (the startup sweep remains the crash backstop).
  deps.taskStore.setReflectMeta(result.task.id, {
    sourceTaskId: input.sourceTaskId,
    bundlePath: input.bundlePath,
    direction: input.direction,
    worktreePath,
    ...(reflectKind !== 'feedback' ? { kind: reflectKind } : {}),
  });

  return { spawned: true, reflectTaskId: result.task.id };
}

interface SkillCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Verify the reflect skill is present, non-empty, and at the
 * expected schema version. Strict — any missing field fails closed.
 */
async function verifySkill(skillPath: string, expectedName: string, expectedVersion: number): Promise<SkillCheck> {
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
  if (name !== expectedName) return { ok: false, reason: `name_mismatch:${name}` };

  const versionStr = versionLine.replace(/^skillSchemaVersion\s*:\s*/, '').trim();
  const version = Number(versionStr);
  if (version !== expectedVersion) {
    return { ok: false, reason: `version_mismatch:${versionStr}!=${expectedVersion}` };
  }
  return { ok: true };
}

async function resolveRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(['-C', cwd, 'rev-parse', '--show-toplevel']);
    return resolve(stdout.trim());
  } catch {
    return null;
  }
}

async function resolveReflectBaselineRef(repoRoot: string): Promise<string | null> {
  const candidates = ['main', 'origin/main', 'master', 'origin/master', 'HEAD'];
  for (const ref of candidates) {
    try {
      await execGit(['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {
      // Try the next conventional baseline; HEAD is the final detached-checkout fallback.
    }
  }
  return null;
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
    if (!lstatSync(identityPath).isFile()) return null;
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
  const schema =
    parsed && typeof parsed === 'object' && 'schema' in parsed
      ? (parsed as { schema?: unknown }).schema
      : undefined;
  const sourceTaskId =
    parsed && typeof parsed === 'object' && 'sourceTaskId' in parsed
      ? (parsed as { sourceTaskId?: unknown }).sourceTaskId
      : undefined;
  if (schema !== REFLECT_IDENTITY_SCHEMA || typeof sourceTaskId !== 'string' || !UUID_RE.test(sourceTaskId)) {
    console.warn('[reflect-sweep] identity file missing valid sourceTaskId', {
      dir: dirPath,
    });
    return null;
  }
  return { sourceTaskId, legacy: false };
}

/**
 * Reflect worktree orphan sweep: remove any ephemeral reflect worktree whose
 * linked source task is no longer present in the task store, plus a 7-day TTL
 * backstop. Safe for concurrent use — worktrees still linked to a live reflect
 * task are kept unless the 7-day mtime TTL fires.
 *
 * Called once at startup recovery and on the lifecycle-timer schedule
 * (issue #1860) so long-lived production instances do not accumulate dirs
 * from crashes between worktree creation and reflect-task completion.
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
      const didRemove = await removeReflectWorktree(dirPath, deps.reflectWorktreesDir, { allowLegacy: true });
      if (didRemove) removed++;
      else kept++;
    } else {
      kept++;
    }
  }
  return { removed, kept };
}

/** Default periodic reflect-worktree sweep cadence (issue #1860). */
export const DEFAULT_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS = 1;

/** Config for the scheduled reflect-worktree orphan sweep (issue #1860). */
export interface ReflectWorktreeSweepScheduleConfig {
  /** Absolute path to the reflect-worktrees directory. */
  reflectWorktreesDir: string;
  /** Live task store — used to skip worktrees whose source task is still active. */
  taskStore: TaskStore;
  /** Interval between sweeps, in hours. `<= 0` disables the timer entirely. */
  intervalHours: number;
  /** Test seam for the sweep core. */
  run?: typeof sweepReflectWorktrees;
}

/**
 * Resolve the reflect-worktree sweep interval (hours) from the environment.
 *
 * Default is {@link DEFAULT_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS} (1h) so
 * long-lived production instances reclaim crash orphans without an env knob.
 * Set `KOOKR_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS=0` to disable; a positive
 * number overrides the cadence.
 */
export function resolveReflectWorktreeSweepIntervalHours(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.KOOKR_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS?.trim();
  if (!raw) return DEFAULT_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS;
  return value;
}

/**
 * Run one scheduled reflect-worktree orphan sweep (issue #1860). Errors are
 * caught and logged so a failed sweep can never bubble into the interval
 * callback and crash the process. Always logs removed/kept counts.
 */
export async function runScheduledReflectWorktreeSweep(
  config: ReflectWorktreeSweepScheduleConfig,
): Promise<{ removed: number; kept: number } | null> {
  try {
    const run = config.run ?? sweepReflectWorktrees;
    const result = await run({
      reflectWorktreesDir: config.reflectWorktreesDir,
      taskStore: config.taskStore,
    });
    console.log(
      `[reflect-sweep] scheduled sweep removed ${result.removed} orphaned reflect worktree(s), kept ${result.kept}`,
    );
    return result;
  } catch (err) {
    console.error('[reflect-sweep] scheduled sweep failed:', err);
    return null;
  }
}

/**
 * Remove a single reflect worktree on demand — called when a reflect task
 * reaches a terminal state so its worktree is reclaimed immediately rather than
 * lingering until the next startup sweep.
 *
 * Self-guarding: normal cleanup removes `worktreePath` only when it still
 * carries the `.kookr-reflect.json` identity marker. Startup sweeps may also
 * opt into the documented legacy UUID-directory format through `allowLegacy`;
 * malformed or unrelated paths remain untouched. Best-effort and never throws
 * — cleanup must not fail a task transition. Returns true when `worktreePath`
 * was an eligible reflect worktree we attempted to reclaim, false when
 * skipped (absent path, invalid identity, or failed root validation).
 */
function isDirectChildDirectory(reflectWorktreesDir: string, worktreePath: string): boolean {
  try {
    const root = realpathSync(reflectWorktreesDir);
    const target = realpathSync(worktreePath);
    const rel = relative(root, target);
    return rel !== ''
      && !rel.startsWith('..')
      && !rel.startsWith('/')
      && !rel.startsWith('\\')
      && !/[\\/]/.test(rel)
      && lstatSync(worktreePath).isDirectory();
  } catch {
    return false;
  }
}

function hasGitMetadata(worktreePath: string): boolean {
  try {
    const gitPath = lstatSync(join(worktreePath, '.git'));
    return gitPath.isFile() || gitPath.isDirectory() || gitPath.isSymbolicLink();
  } catch {
    return false;
  }
}

function looksLikeBareRepository(worktreePath: string): boolean {
  try {
    const head = lstatSync(join(worktreePath, 'HEAD'));
    const objects = lstatSync(join(worktreePath, 'objects'));
    const config = lstatSync(join(worktreePath, 'config'));
    return head.isFile() && objects.isDirectory() && config.isFile();
  } catch {
    return false;
  }
}

export async function removeReflectWorktree(
  worktreePath: string | undefined,
  reflectWorktreesDir?: string,
  options: { allowLegacy?: boolean } = {},
): Promise<boolean> {
  if (!worktreePath || !reflectWorktreesDir) return false;
  if (!isDirectChildDirectory(reflectWorktreesDir, worktreePath)) return false;

  const identity = await readReflectIdentity(worktreePath, worktreePath.split(/[\\/]/).pop() ?? '');
  if (!identity || (identity.legacy && !options.allowLegacy)) return false;

  const removal = await removeRegisteredWorktree(worktreePath, { force: true });
  if (removal.removed) return true;

  // Only markerless UUID directories from the documented legacy format may
  // use the filesystem fallback. A current identity marker is expected to be
  // a Git worktree; context, identity, primary, and Git-removal failures all
  // fail closed. Bare repositories are also rejected even without `.git`.
  if (
    !identity.legacy
    || !options.allowLegacy
    || removal.reason !== 'not-a-linked-worktree'
    || hasGitMetadata(worktreePath)
    || looksLikeLinkedWorktree(worktreePath)
    || looksLikeBareRepository(worktreePath)
  ) return false;

  try {
    try {
      if (lstatSync(join(worktreePath, REFLECT_IDENTITY_FILE)).isSymbolicLink()) return false;
    } catch {
      // Markerless legacy directories are authorized by their UUID basename.
    }
    await rm(worktreePath, { recursive: true, force: true });
    return !existsSync(worktreePath);
  } catch {
    return false;
  }
}
