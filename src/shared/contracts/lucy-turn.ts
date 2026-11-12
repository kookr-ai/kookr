/**
 * Wire contract for one turn of a typed (or transcribed) conversation with Lucy, the
 * dashboard's operator assistant: `POST /api/lucy/turn` (issue #3660).
 *
 * The request is one sentence from the operator plus a conversation id. The response is
 * a stream of newline-delimited JSON (`application/x-ndjson`): one {@link LucyTurnEvent}
 * per line, in the order things happen, always ending with exactly one `done` event.
 *
 * In this step Lucy can only look things up. No event ever reports a change to a task,
 * because no tool that changes one exists.
 */

export const LUCY_TURN_PATH = '/api/lucy/turn';
export const LUCY_TURN_CONTENT_TYPE = 'application/x-ndjson';

/** Longest sentence accepted from the operator, in characters. */
export const MAX_LUCY_TURN_TEXT_CHARS = 2000;
/** A conversation id is chosen by the client; this keeps it safe to log and to use as a map key. */
export const LUCY_CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface LucyTurnRequest {
  /** What the operator said or typed. */
  text: string;
  /** Groups turns into one conversation, so she remembers what was just said. */
  conversationId: string;
}

/** The look-only tools Lucy may call in this step. Nothing here changes a task. */
export const LUCY_LOOK_TOOL_NAMES = ['read_board', 'read_task', 'read_task_output', 'show_task', 'list_projects'] as const;
export type LucyLookToolName = (typeof LUCY_LOOK_TOOL_NAMES)[number];

/**
 * Why a turn ended:
 * - `answered`: she finished her reply.
 * - `step_cap` / `time_cap` / `token_cap`: a limit was reached; her last sentence says so.
 * - `aborted`: the client went away, or the server is shutting down.
 * - `error`: the model or a look-up failed; `reason` says what, in plain words.
 */
export type LucyTurnEnd = 'answered' | 'step_cap' | 'time_cap' | 'token_cap' | 'aborted' | 'error';

export type LucyTurnEvent =
  /** A piece of her reply, in the order it was generated. Concatenate them to get the whole reply. */
  | { type: 'text'; delta: string }
  /** She is looking something up. `args` are the arguments the model gave, already validated. */
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  /** The look-up finished. `ok: false` means it failed or was refused; `summary` is one short line for display. */
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  /** Something for the dashboard itself to do. `show_task` asks it to open that task. */
  | { type: 'screen'; command: 'show_task'; taskId: string }
  /** Always the last line. */
  | {
      type: 'done';
      end: LucyTurnEnd;
      /** Plain-words explanation when `end` is `error`. Never contains provider error bodies. */
      reason?: string;
      /** Milliseconds from the request arriving to the first piece of her reply; null if she said nothing. */
      firstTextMs: number | null;
      totalMs: number;
      /** How many times the model was called. */
      steps: number;
      inputTokens: number;
      outputTokens: number;
      /** What the provider charged for this turn, in US dollars; null when it did not say. */
      costUsd: number | null;
      /** Which provider served the last model call, as OpenRouter names it; absent when unknown. */
      provider?: string;
    };

export type LucyTurnDoneEvent = Extract<LucyTurnEvent, { type: 'done' }>;

/** Why a request was refused before any model call. Sent as `{ error: <code>, message }` with a 4xx/5xx status. */
export type LucyTurnErrorCode =
  | 'lucy_operator_disabled'
  | 'bad_request'
  | 'turn_in_progress'
  | 'lucy_operator_unavailable';
