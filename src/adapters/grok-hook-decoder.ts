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
 * not (yet) normalize into the AgentEvent union — `permission_denied`,
 * `pre_compact`, `post_compact` — are listed so the decoder can return a clean
 * `null` (a "dropped", known-but-unmapped event) rather than treating them as
 * malformed. `permission_denied` is intentionally NOT normalized: POC-A found
 * it does not fire reliably for rule/hook denials in headless `-p`, so Kookr
 * must detect blocks via PreToolUse-without-PostToolUse, not this event.
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
  // Notification
  notificationType?: unknown;
  message?: unknown;
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
    // Unknown or additive-but-unmapped event (permission_denied, pre_compact,
    // post_compact). Drop cleanly; the RFC forbids guessing it into an
    // existing event type.
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

    case 'user_prompt_submit':
      return {
        type: 'user_prompt',
        sessionId,
        prompt: str(parsed.prompt) ?? '',
        ...(cwd ? { cwd } : {}),
      };

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
      return {
        type: 'stop',
        sessionId,
        lastMessage: '',
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
        lastMessage: '',
        ...(cwd ? { cwd } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(str(parsed.promptId) ? { turnId: str(parsed.promptId) } : {}),
      };

    case 'notification':
      return {
        type: 'notification',
        sessionId,
        notificationType: str(parsed.notificationType) ?? '',
        message: str(parsed.message) ?? '',
        ...(cwd ? { cwd } : {}),
      };

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
        lastMessage: str(parsed.message) ?? '',
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
      // permission_denied / pre_compact / post_compact — recognized but not
      // normalized (see GROK_KNOWN_HOOK_EVENTS doc). Dropped, not guessed.
      return null;
  }
}

/** Narrow an unknown to a non-empty string, else undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
