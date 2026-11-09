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

export interface OpenCodeProfile {
  /** Agent Notebook shelves whose lessons are appended to the session's AGENTS.md (read with the session's NB_DIR). */
  shelves?: string[];
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
}

const shq = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

export function defaultKookrClaudeHooks(opts: DefaultKookrClaudeHooksOptions = {}): ClaudeHooksConfig | undefined {
  const cmd = (command: string, timeout: number) => ({ type: 'command' as const, command, timeout });
  const hooks: ClaudeHooksConfig['hooks'] = {};
  const env: Record<string, string> = {};
  const stop: ReturnType<typeof cmd>[] = [];

  // Order: notebook retrospective, then the completion nudge. A
  // `completion_ready` signal is dropped when the turn resumes, so the signal must be the LAST
  // thing the worker does: a retrospective re-prompt arriving after it would silently clear it.
  const dir = opts.pluginHooksDir;
  if (dir && existsSync(join(dir, 'nb-inject.sh')) && existsSync(join(dir, 'nb-retro.sh'))) {
    hooks.SessionStart = [{ matcher: '', hooks: [cmd(`bash ${shq(join(dir, 'nb-inject.sh'))}`, 15)] }];
    stop.push(cmd(`bash ${shq(join(dir, 'nb-retro.sh'))}`, 15));
    env.CLAUDE_PLUGIN_ROOT = dirname(dir);
  } else {
    console.warn(`[opencode-adapter] nb hooks skipped: ${dir ? `${dir}/nb-inject.sh missing` : 'no plugin hooks dir'}`);
  }

  const nudge = opts.binDir ? join(opts.binDir, 'kookr-stop-nudge.js') : undefined;
  if (nudge && existsSync(nudge)) {
    stop.push(cmd(buildStopNudgeCommand({ nudgePath: nudge, nodePath: opts.nodePath }), 10));
    // The nudge is the only thing that makes an unattended worker raise completion-ready, and these
    // workers routinely finish in well under its default 45 s "trivial first stop" age gate.
    env.KOOKR_NUDGE_MIN_TASK_AGE_MS = '0';
  }
  if (stop.length) hooks.Stop = [{ matcher: '', hooks: stop }];
  return Object.keys(hooks).length ? { env, hooks } : undefined;
}
