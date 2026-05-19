// RFC 018 M2 (#373) — Kookr context-injection hook logic.
//
// `runHook` processes one Claude Code `UserPromptSubmit` hook event: when
// enabled, it runs the RFC §11 relevance-gated KB search and returns any
// context to inject (Claude Code feeds a UserPromptSubmit hook's stdout into
// the agent's turn) plus the `gate_verdict` debug echo for stderr.
//
// OFF BY DEFAULT. The hook is inert unless `KOOKR_KB_CONTEXT_INJECT` is
// truthy — RFC 018 M1 returned a NO-GO for defaulting the gate on
// (`docs/rfcs/018-m1-canary-report.md` in knowledge-base-mcp-server), and
// `kb search --gate` invokes an LLM judge that adds latency to every turn.
// M2 ships the mechanism; M3 decides default-on.
//
// This module is pure with respect to process I/O — stdin in, result out —
// so it is unit-testable. The thin runnable that wires real stdin/stdout is
// `kb-context-injection-hook-run.ts`.

import {
  runKbContextInjection,
  type KbContextInjectionDeps,
} from './kb-context-injection.js';

/** Env var that opts the hook in. Inert (exit 0, no injection) unless truthy. */
export const KB_CONTEXT_INJECT_ENV = 'KOOKR_KB_CONTEXT_INJECT';

export interface HookRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Whether the context-injection hook is opted in via the environment. */
export function isHookEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = (env[KB_CONTEXT_INJECT_ENV] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

/**
 * Process one `UserPromptSubmit` hook event. Pure with respect to process
 * I/O — stdin is passed in, the result is returned — so it is unit-testable
 * without spawning anything.
 */
export async function runHook(
  rawStdin: string,
  deps: KbContextInjectionDeps,
): Promise<HookRunResult> {
  const inert: HookRunResult = { stdout: '', stderr: '', exitCode: 0 };
  if (!isHookEnabled(deps.env)) return inert;

  let payload: unknown;
  try {
    payload = JSON.parse(rawStdin);
  } catch {
    return { stdout: '', stderr: '[kb-context-inject] malformed hook payload; skipping.', exitCode: 0 };
  }
  if (typeof payload !== 'object' || payload === null) return inert;

  const event = payload as Record<string, unknown>;
  if (event.hook_event_name !== 'UserPromptSubmit') return inert;

  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  const sessionId = typeof event.session_id === 'string' ? event.session_id : 'unknown';

  // Claude Code re-enters the parent agent via UserPromptSubmit with a
  // synthetic <task-notification> body when a subagent completes — that is
  // not a user turn, so skip it (mirrors hook-parser.ts).
  if (prompt.trimStart().startsWith('<task-notification')) return inert;

  const result = await runKbContextInjection({ prompt, sessionId }, deps);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
}
