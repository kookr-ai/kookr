// RFC 018 M2 (#373) — Kookr context-injection hook logic.
//
// `runHook` processes one Claude Code `UserPromptSubmit` hook event: when
// enabled, it runs the RFC §11 relevance-gated KB search and returns any
// context to inject (Claude Code feeds a UserPromptSubmit hook's stdout into
// the agent's turn) plus the `gate_verdict` debug echo for stderr.
//
// OFF BY DEFAULT. The hook is inert unless `KOOKR_KB_CONTEXT_INJECT` selects a
// mode. Two modes are supported:
//
//   nudge  — run ONE fast, ungated `kb search` on substantive turns and, when
//            the top hit is clearly close, append a one-line non-blocking
//            suggestion that the agent run `kb` itself. No LLM judge, no injected
//            content, fast. This is the default useful behavior to turn on.
//   inject — the original RFC 018 M2 path: `kb search --gate` (Stage-B LLM
//            judge) and inject the gated context. Slower and judge-dependent;
//            RFC 018 M1 returned a NO-GO for defaulting it on.
//
// Back-compat: the legacy truthy values (1/true/on/yes) select `inject`.
//
// This module is pure with respect to process I/O — stdin in, result out —
// so it is unit-testable. The thin runnable that wires real stdin/stdout is
// `kb-context-injection-hook-run.ts`.

import {
  runKbContextInjection,
  type KbContextInjectionDeps,
} from './kb-context-injection.js';
import { runKbNudge } from './kb-relevance-nudge.js';

/** Env var that selects the hook mode. Inert (exit 0) unless it names a mode. */
export const KB_CONTEXT_INJECT_ENV = 'KOOKR_KB_CONTEXT_INJECT';

export type HookMode = 'off' | 'nudge' | 'inject';

export interface HookRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Resolve the hook mode from the environment. */
export function hookMode(env: NodeJS.ProcessEnv): HookMode {
  const value = (env[KB_CONTEXT_INJECT_ENV] ?? '').trim().toLowerCase();
  if (value === 'nudge') return 'nudge';
  // Legacy truthy values and the explicit `inject` select the injection path.
  if (value === '1' || value === 'true' || value === 'on' || value === 'yes' || value === 'inject') {
    return 'inject';
  }
  return 'off';
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
  const mode = hookMode(deps.env);
  if (mode === 'off') return inert;

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

  const result =
    mode === 'nudge'
      ? await runKbNudge({ prompt, sessionId }, deps)
      : await runKbContextInjection({ prompt, sessionId }, deps);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
}
