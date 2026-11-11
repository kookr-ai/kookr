/**
 * Standard Kookr Claude-hook set for opencode sessions (RFC
 * rfc-opencode-agent-integration §5). The generated plugin runs these with
 * Claude semantics: SessionStart stdout becomes system context, Stop exit 2 (or
 * a `{"decision":"block"}` JSON line) re-prompts the session.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildStopNudgeCommand } from '../core/hook-writer-paths.js';
import type { ClaudeHooksConfig } from './opencode-instrumentation/kookr-plugin-source.js';

/** What a profile must have produced before its worker may stop (enforced by `bin/kookr-opencode-gate.js`). */
export type OpenCodeDeliverableSpec =
  | { kind: 'none' }
  | { kind: 'commit-and-pr-body' }
  | { kind: 'file'; name: string };

export interface OpenCodeProfile {
  /** Profile id (set for profiles loaded from `plugin/opencode-profiles/`). */
  id?: string;
  description?: string;
  /** Tool-permission posture requested by the profile. */
  permission?: 'allow' | 'ask';
  deliverable?: OpenCodeDeliverableSpec;
  /** Agent Notebook shelves the profile recommends (informational; the instructions tell the worker to use `nb`). */
  shelves?: string[];
  /** Optional model pin (`provider/model` or bare model id) when the task does not pin one. */
  model?: string;
  /** Written to the session's AGENTS.md. */
  instructions?: string;
  claudeHooks?: ClaudeHooksConfig;
  /** Extra env for hook commands only (merged over `claudeHooks.env`). */
  hookEnv?: Record<string, string>;
}

const moduleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

/** `<repo>/plugin/hooks` when present (works from src/adapters and dist/adapters). */
export function resolveDefaultPluginHooksDir(env: NodeJS.ProcessEnv = process.env, baseDir: string = moduleDir): string | undefined {
  const explicit = env.KOOKR_OPENCODE_HOOKS_DIR?.trim();
  const candidate = explicit || resolve(baseDir, '..', '..', 'plugin', 'hooks');
  return existsSync(join(candidate, 'nb-inject.sh')) ? candidate : undefined;
}

/** `<repo>/bin` when it holds the stop nudge (works from src/adapters and dist/adapters). */
export function resolveDefaultBinDir(env: NodeJS.ProcessEnv = process.env, baseDir: string = moduleDir): string | undefined {
  const candidate = env.KOOKR_OPENCODE_BIN_DIR?.trim() || resolve(baseDir, '..', '..', 'bin');
  return existsSync(join(candidate, 'kookr-stop-nudge.js')) ? candidate : undefined;
}

export interface DefaultKookrClaudeHooksOptions {
  /** Directory holding nb-inject.sh / nb-retro.sh. Omitted/missing => nb hooks skipped with a warning. */
  pluginHooksDir?: string;
  /** Directory holding kookr-stop-nudge.js. Omitted/missing => nudge skipped. */
  binDir?: string;
  nodePath?: string;
  /** Profile deliverable. Adds the gate as the FIRST Stop command (before retrospective and nudge). */
  deliverable?: OpenCodeDeliverableSpec;
  /**
   * Container mode (RFC #3541 S2d): existence is still checked against the host dirs above, but the generated
   * commands name the paths the worker sees (node in the image, the per-task immutable copy at `/kookr-hooks`).
   * A command that points at a host path would exit 127 in the container, which the plugin reads as "pass".
   */
  containerPaths?: { node: string; pluginHooksDir: string; binDir: string };
}

/** Gate (and its retries) may run a PR-body lint, so it gets a generous hook timeout. */
const GATE_TIMEOUT_SEC = 120;
/** The push guard only parses a command string. */
const PUSH_GUARD_TIMEOUT_SEC = 5;

export function gateKindArg(d: OpenCodeDeliverableSpec): string | undefined {
  if (d.kind === 'none') return undefined;
  return d.kind === 'file' ? `file:${d.name}` : d.kind;
}

const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

export function defaultKookrClaudeHooks(opts: DefaultKookrClaudeHooksOptions = {}): ClaudeHooksConfig | undefined {
  const cmd = (command: string, timeout: number) => ({ type: 'command' as const, command, timeout });
  const hooks: ClaudeHooksConfig['hooks'] = {};
  const env: Record<string, string> = {};
  const stop: ReturnType<typeof cmd>[] = [];
  const cp = opts.containerPaths;

  const gateKind = opts.deliverable ? gateKindArg(opts.deliverable) : undefined;
  if (gateKind) {
    const gate = opts.binDir ? join(opts.binDir, 'kookr-opencode-gate.js') : undefined;
    if (gate && existsSync(gate)) {
      const node = cp ? cp.node : opts.nodePath ?? process.execPath;
      const gatePath = cp ? join(cp.binDir, 'kookr-opencode-gate.js') : gate;
      stop.push(cmd(`${shq(node)} ${shq(gatePath)} --kind ${shq(gateKind)}`, GATE_TIMEOUT_SEC));
    } else {
      console.warn(`[opencode-adapter] deliverable gate skipped: ${gate ?? 'no bin dir'} missing`);
    }
  }

  // Profiled workers deliver a LOCAL commit/file for the operator to review: block `git push` and
  // PR merge/create from the Bash tool. Needs a deliverable (an unprofiled worker keeps Kookr's
  // generic worktree/PR guidance, which may legitimately publish).
  const preToolUse: Array<{ matcher: string; hooks: ReturnType<typeof cmd>[] }> = [];
  if (gateKind) {
    const guard = opts.binDir ? join(opts.binDir, 'kookr-opencode-push-guard.js') : undefined;
    if (guard && existsSync(guard)) {
      const node = cp ? cp.node : opts.nodePath ?? process.execPath;
      const guardPath = cp ? join(cp.binDir, 'kookr-opencode-push-guard.js') : guard;
      preToolUse.push({ matcher: 'Bash', hooks: [cmd(`${shq(node)} ${shq(guardPath)}`, PUSH_GUARD_TIMEOUT_SEC)] });
    } else {
      console.warn(`[opencode-adapter] push guard skipped: ${guard ?? 'no bin dir'} missing`);
    }
  }
  if (preToolUse.length) hooks.PreToolUse = preToolUse;

  // Order: deliverable gate, then the notebook retrospective, then the completion nudge. A
  // `completion_ready` signal is dropped when the turn resumes, so the signal must be the LAST
  // thing the worker does: a retrospective re-prompt arriving after it would silently clear it.
  const dir = opts.pluginHooksDir;
  if (dir && existsSync(join(dir, 'nb-inject.sh')) && existsSync(join(dir, 'nb-retro.sh'))) {
    const runDir = cp ? cp.pluginHooksDir : dir;
    hooks.SessionStart = [{ matcher: '', hooks: [cmd(`bash ${shq(join(runDir, 'nb-inject.sh'))}`, 15)] }];
    stop.push(cmd(`bash ${shq(join(runDir, 'nb-retro.sh'))}`, 15));
    env.CLAUDE_PLUGIN_ROOT = dirname(runDir);
  } else {
    console.warn(`[opencode-adapter] nb hooks skipped: ${dir ? `${dir}/nb-inject.sh missing` : 'no plugin hooks dir'}`);
  }

  const nudge = opts.binDir ? join(opts.binDir, 'kookr-stop-nudge.js') : undefined;
  if (nudge && existsSync(nudge)) {
    stop.push(cmd(buildStopNudgeCommand({
      nudgePath: cp ? join(cp.binDir, 'kookr-stop-nudge.js') : nudge,
      nodePath: cp ? cp.node : opts.nodePath,
    }), 10));
    // The nudge is the only thing that makes an unattended worker raise completion-ready, and these
    // workers routinely finish in well under its default 45 s "trivial first stop" age gate.
    env.KOOKR_NUDGE_MIN_TASK_AGE_MS = '0';
  }
  if (stop.length) hooks.Stop = [{ matcher: '', hooks: stop }];
  return Object.keys(hooks).length ? { env, hooks } : undefined;
}
