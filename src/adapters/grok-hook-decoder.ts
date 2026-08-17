/**
 * Grok Build hook decoder (issue #1343, RFC "Hooks and normalization").
 *
 * A PURE helper — NOT a `ClaudeCodeAdapter` subclass — that decodes Grok Build's
 * hook payloads and normalizes them into Kookr's existing {@link AgentEvent}
 * union. POC-A (docs/poc/009-grok-build-basic-supervision.md) established that
 * Grok's payloads diverge from Claude Code's, so Kookr's snake_case
 * `parseHookEvent()` cannot be reused unchanged:
 *
 *   - Field NAMES are camelCase: `sessionId`, `hookEventName`, `toolName`,
 *     `toolInput`, `toolUseId`, `transcriptPath`, `promptId`, `subagentId`,
 *     `subagentType`, `workspaceRoot`, `notificationType`, `reason`.
 *   - The `hookEventName` VALUE is snake_case: `pre_tool_use`, `session_start`,
 *     `stop`, `subagent_start`, … (Claude uses PascalCase `PreToolUse`).
 *   - Grok's event vocabulary is a SUPERSET of Claude's: it adds
 *     `permission_denied`, `subagent_start`/`subagent_stop`, `session_end`,
 *     `stop_failure`, and `pre_compact`/`post_compact`.
 *   - `stop` carries a semantic `reason` (`end_turn` | `error` | `cancelled` |
 *     `shutdown`) — load-bearing for the RFC outcome truth table.
 *   - Tool names are Grok-native (`run_terminal_command`, `list_dir`,
 *     `read_file`, `search_replace`, `spawn_subagent`, …). We keep them verbatim
 *     rather than re-mapping to Claude names — the RFC forbids normalizing every
 *     Grok-native concept into Claude semantics, and inventing a `Bash` label
 *     would fabricate a mapping the POC did not observe on the payload. The
 *     documented Claude→Grok aliases live in {@link GROK_TOOL_ALIASES} for
 *     callers (e.g. hook matchers) that need them.
 *
 * Payload shapes are pinned by the redacted POC-A fixtures
 * (docs/poc/009-grok-build-basic-supervision/fixtures/hook-payloads.redacted.json)
 * and the characterization test scripts/grok-build-hook-shapes.test.ts.
 */
import { HookParseError } from '../core/hook-parser.js';
import type { AgentEvent } from '../core/agent-events.js';
import { unwrapProviderUserPrompt } from '../shared/contracts/user-prompt-text.js';

/**
 * Documented Claude→Grok tool-name aliases (POC-A constraint 2). Grok accepts
 * the Claude names in hook matchers and imported agent definitions, but its
 * hook payloads report the Grok-native name. Exposed for matcher construction
 * and tests; the decoder does NOT rewrite `toolName` with these.
 */
export const GROK_TOOL_ALIASES: Readonly<Record<string, string>> = {
  Bash: 'run_terminal_command',
  Read: 'read_file',
  Edit: 'search_replace',
  Write: 'search_replace',
  Task: 'spawn_subagent',
};

/**
 * Grok runtime `hookEventName` values (snake_case) recognized by the decoder.
 * A superset of Claude's set (POC-A "Hook schema"). Events we recognize but do
 * not (yet) normalize into the AgentEvent union — `pre_compact`,
 * `post_compact` — are listed so the decoder can return a clean `null` (a
 * "dropped", known-but-unmapped event) rather than treating them as malformed.
 *
 * `permission_denied` IS normalized (issue #1526 Phase C4): it decodes into
 * `permission_request`, the same AgentEvent the Claude Code `PermissionRequest`
 * hook produces, so the anomaly detector / watchdog classify the session as
 * `permission_blocked` and Phase B's `stuckReason: 'permission_blocked'` fires
 * for Grok tasks. POC-A found the event unreliable for rule/hook denials in
 * headless `-p`, so it must never be the ONLY block signal — the
 * `notification(permission_prompt)` mapping below and the watchdog's pane-
 * semantics rescan (`analyzePaneSemantics` → `permission_dialog`) are the
 * belt-and-braces paths — but when it DOES fire, dropping it made a
 * permission-stuck Grok task read as "running" (2026-07-24 incident, task
 * 20e2ddbd: 33h hung mid-`write` right after a dropped `permission_denied`).
 *
 * Exception: when the payload carries `permissionMode: "bypassPermissions"`
 * the session is not waiting on a human. Grok still emits `permission_prompt`
 * ("Tool permission requested") and occasional `permission_denied` while
 * tools continue — mapping those to `permission_request` flickers a
 * `permission_blocked` finding (and "permission required" / "needs input"
 * alerts) on every such hook. Bypass payloads stay notifications / tool
 * errors; a real menu is still caught by pane semantics.
 */
export const GROK_KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'session_start',
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
  'post_tool_use_failure',
  'permission_denied',
  'stop',
  'stop_failure',
  'notification',
  'subagent_start',
  'subagent_stop',
  'session_end',
  'pre_compact',
  'post_compact',
]);

/** Live Grok hook payloads set this under `--permission-mode bypassPermissions`. */
export const GROK_BYPASS_PERMISSION_MODE = 'bypassPermissions';

export function isGrokBypassPermissionMode(mode: string | undefined): boolean {
  return mode === GROK_BYPASS_PERMISSION_MODE;
}

/** Raw Grok hook payload (camelCase). All fields optional — validated per event. */
interface RawGrokHookPayload {
  hookEventName?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  workspaceRoot?: unknown;
  transcriptPath?: unknown;
  promptId?: unknown;
  // SessionStart
  source?: unknown;
  model?: unknown;
  // Tool events
  toolName?: unknown;
  toolInput?: unknown;
  toolUseId?: unknown;
  toolResult?: unknown;
  // Failure events
  error?: unknown;
  isInterrupt?: unknown;
  // Stop / SessionEnd
  reason?: unknown;
  /** Final assistant text on stop / subagent_stop (live Grok ≥0.2.x). */
  lastAssistantMessage?: unknown;
  // Notification
  notificationType?: unknown;
  message?: unknown;
  // Present on every live Grok hook; used to suppress false permission waits.
  permissionMode?: unknown;
  // UserPromptSubmit
  prompt?: unknown;
  // Subagent
  subagentId?: unknown;
  subagentType?: unknown;
  description?: unknown;
}

/**
 * Header-only inspector, the Grok analog of {@link extractRawHookHeader}. Pulls
 * the correlation keys Kookr's ingestion pipeline needs (`sessionId`, the
 * per-turn `promptId`, `hookEventName`, `transcriptPath`) without requiring the
 * event to be one the decoder normalizes. Throws {@link HookParseError} on
 * malformed JSON so the adapter can record a diagnostic ledger row.
 */
export interface RawGrokHookHeader {
  rawSessionId?: string;
  rawTurnId?: string;
  rawHookEventName?: string;
  rawTranscriptPath?: string;
}

export function extractGrokHookHeader(raw: string): RawGrokHookHeader {
  let parsed: RawGrokHookPayload;
  try {
    parsed = JSON.parse(raw) as RawGrokHookPayload;
  } catch {
    throw new HookParseError(`Malformed JSON: ${raw.slice(0, 100)}`);
  }
  return {
    rawSessionId: str(parsed.sessionId),
    // Grok's per-turn identifier is `promptId` (links user_prompt_submit → stop).
    rawTurnId: str(parsed.promptId),
    rawHookEventName: str(parsed.hookEventName),
    rawTranscriptPath: str(parsed.transcriptPath),
  };
}

/**
 * Decode a raw Grok hook payload line into an {@link AgentEvent}, or `null` when
 * the event is recognized but not normalized (a "dropped" event). Throws
 * {@link HookParseError} only on malformed JSON — an unknown `hookEventName`
 * returns `null`, never throws, mirroring `parseHookEvent()`.
 *
 * Never guesses: an unrecognized event or one missing its required correlation
 * key is dropped rather than coerced into an adjacent event type.
 */
export function parseGrokHookEvent(raw: string): AgentEvent | null {
  let parsed: RawGrokHookPayload;
  try {
    parsed = JSON.parse(raw) as RawGrokHookPayload;
  } catch {
    throw new HookParseError(`Malformed JSON: ${raw.slice(0, 100)}`);
  }

  const hookName = str(parsed.hookEventName);
  if (!hookName || !GROK_KNOWN_HOOK_EVENTS.has(hookName)) {
    // Unknown or additive-but-unmapped event (pre_compact, post_compact).
    // Drop cleanly; the RFC forbids guessing it into an existing event type.
    return null;
  }

  const sessionId = str(parsed.sessionId);
  if (!sessionId) return null; // Every Grok event carries sessionId; without it we cannot correlate.
  const cwd = str(parsed.cwd) ?? str(parsed.workspaceRoot);
  const transcriptPath = str(parsed.transcriptPath);

  switch (hookName) {
    case 'session_start':
      return {
        type: 'session_start',
        sessionId,
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(str(parsed.model) ? { model: str(parsed.model) } : {}),
        ...(cwd ? { cwd } : {}),
      };

    case 'user_prompt_submit': {
      // Grok wraps every typed prompt in <user_query>…</user_query> and may
      // append <system-reminder> scaffolding. Unwrap so the activity panel
      // and delivery-match path see the human-typed text, not the tags.
      const prompt = unwrapProviderUserPrompt(str(parsed.prompt) ?? '');
      if (prompt === null) return null;
      return {
        type: 'user_prompt',
        sessionId,
        prompt,
        ...(cwd ? { cwd } : {}),
      };
    }

    case 'pre_tool_use':
      return {
        type: 'tool_use',
        sessionId,
        toolName: str(parsed.toolName) ?? '',
        toolInput: parsed.toolInput,
        ...(str(parsed.toolUseId) ? { toolUseId: str(parsed.toolUseId) } : {}),
        ...(cwd ? { cwd } : {}),
      };

    case 'post_tool_use':
      return {
        type: 'tool_result',
        sessionId,
        toolName: str(parsed.toolName) ?? '',
        toolResponse: parsed.toolResult,
        ...(str(parsed.toolUseId) ? { toolUseId: str(parsed.toolUseId) } : {}),
        ...(cwd ? { cwd } : {}),
      };

    case 'post_tool_use_failure':
      return {
        type: 'tool_error',
        sessionId,
        toolName: str(parsed.toolName) ?? '',
        toolInput: parsed.toolInput,
        ...(str(parsed.toolUseId) ? { toolUseId: str(parsed.toolUseId) } : {}),
        error: str(parsed.error) ?? '',
        isInterrupt: parsed.isInterrupt === true,
        ...(cwd ? { cwd } : {}),
      };

    case 'stop':
      // Live Grok stop payloads carry `lastAssistantMessage` (camelCase) with
      // the final assistant turn — that is what the activity panel renders as
      // the agent reply. Older POC-A fixtures lacked the field; when missing,
      // leave '' so GrokBuildAdapter can fall back to a bounded pane tail
      // (issue #1526 Phase C4) for completion-signal classification (#1324).
      return {
        type: 'stop',
        sessionId,
        lastMessage: str(parsed.lastAssistantMessage) ?? '',
        ...(cwd ? { cwd } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(str(parsed.promptId) ? { turnId: str(parsed.promptId) } : {}),
        // Carried verbatim; drives the outcome truth table downstream.
        ...(str(parsed.reason) ? { stopReason: str(parsed.reason) } : {}),
      };

    case 'stop_failure':
      return {
        type: 'stop_failure',
        sessionId,
        error: str(parsed.error) ?? 'unknown',
        lastMessage: str(parsed.lastAssistantMessage) ?? '',
        ...(cwd ? { cwd } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(str(parsed.promptId) ? { turnId: str(parsed.promptId) } : {}),
      };

    case 'permission_denied':
      // Normalized into the same AgentEvent Claude Code's PermissionRequest
      // hook produces, so the shared anomaly detector / watchdog mark the
      // session `permission_blocked` (see GROK_KNOWN_HOOK_EVENTS doc). No
      // POC-A payload capture exists for this event (it did not fire in the
      // headless runs), so every field is decoded defensively with the same
      // camelCase keys the other tool events carry.
      //
      // Bypass mode is the exception: the tool was rejected (hook/policy)
      // and the agent continues. That is a completed deny, not a wait.
      if (isGrokBypassPermissionMode(str(parsed.permissionMode))) {
        return {
          type: 'tool_error',
          sessionId,
          toolName: str(parsed.toolName) ?? '',
          toolInput: parsed.toolInput,
          ...(str(parsed.toolUseId) ? { toolUseId: str(parsed.toolUseId) } : {}),
          error: 'permission_denied',
          isInterrupt: false,
          ...(cwd ? { cwd } : {}),
        };
      }
      return {
        type: 'permission_request',
        sessionId,
        toolName: str(parsed.toolName) ?? '',
        toolInput: parsed.toolInput,
        ...(cwd ? { cwd } : {}),
      };

    case 'notification': {
      const notificationType = str(parsed.notificationType) ?? '';
      // Grok's interactive permission prompt surfaces as
      // `notification{notificationType:"permission_prompt"}` (POC-A capture:
      // hook-payloads.redacted.json, message "Tool permission requested") and
      // Grok has NO PermissionRequest hook event, so this notification is the
      // only reliable structured signal that the agent is parked on a
      // permission menu. Normalize it to `permission_request` — Claude Code
      // emits its permission_prompt notification IN ADDITION to a structured
      // PermissionRequest hook, Grok does not.
      //
      // In bypass mode Grok still emits the same notification while
      // auto-allowing the tool, so treating it as a wait is a false
      // `permission_blocked` flash. Keep it as a plain notification.
      if (notificationType === 'permission_prompt') {
        if (isGrokBypassPermissionMode(str(parsed.permissionMode))) {
          return {
            type: 'notification',
            sessionId,
            notificationType,
            message: str(parsed.message) ?? '',
            ...(cwd ? { cwd } : {}),
          };
        }
        return {
          type: 'permission_request',
          sessionId,
          toolName: str(parsed.toolName) ?? '',
          toolInput: parsed.toolInput,
          ...(cwd ? { cwd } : {}),
        };
      }
      return {
        type: 'notification',
        sessionId,
        notificationType,
        message: str(parsed.message) ?? '',
        ...(cwd ? { cwd } : {}),
      };
    }

    case 'subagent_start':
      return {
        type: 'subagent_start',
        sessionId,
        agentId: str(parsed.subagentId) ?? '',
        agentType: str(parsed.subagentType) ?? '',
        ...(cwd ? { cwd } : {}),
      };

    case 'subagent_stop':
      return {
        type: 'subagent_stop',
        sessionId,
        agentId: str(parsed.subagentId) ?? '',
        agentType: str(parsed.subagentType) ?? '',
        // Live Grok uses lastAssistantMessage; keep `message` as a secondary
        // key for older shapes that may have used it.
        lastMessage: str(parsed.lastAssistantMessage) ?? str(parsed.message) ?? '',
        ...(transcriptPath ? { agentTranscriptPath: transcriptPath } : {}),
        ...(cwd ? { cwd } : {}),
      };

    case 'session_end':
      return {
        type: 'session_end',
        sessionId,
        reason: str(parsed.reason) ?? 'other',
      };

    default:
      // pre_compact / post_compact — recognized but not normalized (see
      // GROK_KNOWN_HOOK_EVENTS doc). Dropped, not guessed.
      return null;
  }
}

/** Narrow an unknown to a non-empty string, else undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
