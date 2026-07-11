/**
 * Grok Build launch-scoped monitoring instrumentation (issue #1343, RFC
 * "Hooks and normalization" + "Files Expected to Change").
 *
 * This is Kookr's INTERNAL, per-session monitoring hook surface for Grok — the
 * deliberate analog of the Claude/Codex `--settings` hook block. It lives under
 * the Grok adapter (never in the distributed `plugin/hooks`, which is reserved
 * for general-purpose toolkit content) and is injected via per-session
 * `GROK_HOME` composition, NEVER by mutating the operator's real `~/.grok`.
 * Because it is not part of the distributed toolkit, generating it does NOT bump
 * the plugin version.
 *
 * The hook-config shape is the one POC-A empirically wrote and verified
 * (docs/poc/009-grok-build-basic-supervision/run-poc.sh): Grok merges
 * `$GROK_HOME/hooks/*.json`, each shaped
 * `{"hooks":{"<EventName>":[{"hooks":[{"type":"command","command":"…","timeout":N}]}]}}`.
 * Config event names are PascalCase; the runtime `hookEventName` in the payload
 * is snake_case (decoded by {@link parseGrokHookEvent}).
 */
import { buildHookCommand } from '../../core/hook-writer-paths.js';

/**
 * PascalCase Grok hook-config event names Kookr subscribes for monitoring —
 * the exact set POC-A wrote (run-poc.sh). A superset of Claude's, including
 * `PermissionDenied`, `SubagentStart`/`SubagentStop`, and `StopFailure`. We
 * subscribe `PermissionDenied` for completeness even though POC-A found it
 * unreliable in headless `-p` (blocks are detected via PreToolUse-without-
 * PostToolUse instead) — it is additive and harmless when it does not fire.
 */
export const GROK_MONITORING_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Stop',
  'StopFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
] as const;

/** Per-command hook timeout (seconds). Matches the POC-A harness (10s). */
export const GROK_HOOK_TIMEOUT_SECONDS = 10;

interface GrokHookCommandEntry {
  type: 'command';
  command: string;
  timeout: number;
}
interface GrokHookMatcherGroup {
  hooks: GrokHookCommandEntry[];
}
export interface GrokMonitoringHooksConfig {
  hooks: Record<string, GrokHookMatcherGroup[]>;
}

export interface BuildGrokMonitoringHooksOptions {
  /** Kookr terminal session id (dtach socket name) — the correlation key. */
  tmuxName: string;
  /** Absolute path of the durable JSONL hook file for this session. */
  hookFile: string;
  /** Server port for the HTTP fan-out POST; omit to write JSONL only. */
  serverPort?: number;
  /** Resolved path of the bundled Kookr hook writer; falls back to awk when absent. */
  writerPath?: string;
  /** Node binary used to run the writer. Defaults to the current process. */
  nodePath?: string;
  timeoutSeconds?: number;
}

/**
 * Build the per-session Grok monitoring hooks config. The command is the shared
 * Kookr hook writer (JSONL append + fail-open HTTP fan-out), identical to the
 * one the Claude/Codex adapters wire — the payload it receives is Grok's
 * camelCase JSON on stdin, which {@link parseGrokHookEvent} decodes downstream.
 */
export function buildGrokMonitoringHooksConfig(
  opts: BuildGrokMonitoringHooksOptions,
): GrokMonitoringHooksConfig {
  const command = buildHookCommand({
    tmuxName: opts.tmuxName,
    hookFile: opts.hookFile,
    serverPort: opts.serverPort,
    writerPath: opts.writerPath,
    nodePath: opts.nodePath,
  });
  const timeout = opts.timeoutSeconds ?? GROK_HOOK_TIMEOUT_SECONDS;
  const entry: GrokHookCommandEntry = { type: 'command', command, timeout };

  const hooks: Record<string, GrokHookMatcherGroup[]> = {};
  for (const event of GROK_MONITORING_EVENTS) {
    hooks[event] = [{ hooks: [entry] }];
  }
  return { hooks };
}
