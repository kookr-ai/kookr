/**
 * Wire contract for one turn of a typed (or transcribed) conversation with Lucy, the
 * dashboard's operator assistant: `POST /api/lucy/turn` (issue #3660).
 *
 * The request is one sentence from the operator plus a conversation id. The response is
 * a stream of newline-delimited JSON (`application/x-ndjson`): one {@link LucyTurnEvent}
 * per line, in the order things happen, always ending with exactly one `done` event.
 *
 * Lucy's tools only look things up, with one exception when launching is on (issue #3676):
 * `propose_launch` makes a proposal, which the operator then confirms. A `proposal` event is a card
 * to show and changes no task; a `launch` event reports what became of a proposal.
 */

import type { LucyLaunchOutcome, LucyLaunchProposalView } from './lucy-launch.js';

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
  /**
   * Whether the words were spoken or typed. Absent means typed. Speech can be Lucy's own voice
   * coming back through the microphone, so a spoken "go" is held to a stricter rule (see `overlapsReadBack`).
   */
  input?: 'voice' | 'typed';
  /**
   * Set by the dashboard for spoken words that started while Lucy was still saying her read-back
   * of a proposal. Such words are ignored: they could be her own voice, so they neither confirm
   * the proposal nor drop it.
   */
  overlapsReadBack?: boolean;
}

/**
 * The look-only tools Lucy may call in this step. Nothing here changes a task. Reading a
 * task's terminal output is not among them yet: it needs the screen rendered first (issue #3683).
 */
export const LUCY_LOOK_TOOL_NAMES = ['read_board', 'read_task', 'show_task', 'list_projects'] as const;
export type LucyLookToolName = (typeof LUCY_LOOK_TOOL_NAMES)[number];

/** The one tool that leads to a change. It only makes a proposal; the operator's confirmation launches it. */
export const LUCY_PROPOSE_LAUNCH_TOOL = 'propose_launch';

/**
 * Why a turn ended:
 * - `answered`: she finished her reply.
 * - `ignored`: spoken words that could have been her own voice were left alone (she said nothing).
 * - `step_cap` / `time_cap` / `token_cap`: a limit was reached; her last sentence says so.
 * - `aborted`: the client went away, or the server is shutting down.
 * - `error`: the model or a look-up failed; `reason` says what, in plain words.
 */
export type LucyTurnEnd = 'answered' | 'ignored' | 'step_cap' | 'time_cap' | 'token_cap' | 'aborted' | 'error';

export type LucyTurnEvent =
  /** A piece of her reply, in the order it was generated. Concatenate them to get the whole reply. */
  | { type: 'text'; delta: string }
  /**
   * She is about to look something up. Sent before the look-up runs. `args` are the arguments
   * the model gave, reduced to plain values and shortened for display. A `tool_result` with
   * the same `id` follows, unless the turn ends first (a limit, or the client going away).
   */
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  /** The look-up finished. `ok: false` means it failed or was refused; `summary` is one short line for display. */
  | { type: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  /** Something for the dashboard itself to do. `show_task` asks it to open that task. */
  | { type: 'screen'; command: 'show_task'; taskId: string }
  /** She proposes launching a task: the dashboard shows the card. Nothing has been launched. */
  | { type: 'proposal'; proposal: LucyLaunchProposalView }
  /** What became of a proposal: launched, refused, declined, cancelled or expired. */
  | ({ type: 'launch' } & LucyLaunchOutcome)
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
  | 'too_many_turns'
  | 'lucy_operator_unavailable';
