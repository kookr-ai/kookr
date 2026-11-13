/**
 * Wire contract for Lucy launching a task for the operator (issue #3676).
 *
 * Lucy never launches on her own reading of a conversation. She *proposes* a launch,
 * the server holds the proposal, and the operator confirms it. How much confirmation is
 * needed is the operator's `lucyAutonomy` setting, read on the server when the launch
 * happens: nothing in these messages carries it in, so a browser cannot choose its own level.
 */

/** The three levels of the `lucyAutonomy` setting. Absent in settings means `balanced`. */
export const LUCY_AUTONOMY_LEVELS = ['careful', 'balanced', 'hands-off'] as const;
export type LucyAutonomy = (typeof LUCY_AUTONOMY_LEVELS)[number];
export const DEFAULT_LUCY_AUTONOMY: LucyAutonomy = 'balanced';

export function isLucyAutonomy(value: unknown): value is LucyAutonomy {
  return typeof value === 'string' && (LUCY_AUTONOMY_LEVELS as readonly string[]).includes(value);
}

/** An investigation reports findings (and may file issues); an implementation may open a pull request. */
export type LucyLaunchKind = 'investigation' | 'implementation';

/** The name `launchActorId` carries for every launch Lucy makes; it is what the audit trail shows. */
export const LUCY_OPERATOR_ACTOR_ID = 'lucy-operator';

export const LUCY_LAUNCH_CONFIRM_PATH = '/api/lucy/launch/confirm';
export const LUCY_LAUNCH_DECLINE_PATH = '/api/lucy/launch/decline';
export const LUCY_LAUNCH_CANCEL_PATH = '/api/lucy/launch/cancel';
/**
 * `POST` `{ taskId }`: Lucy's voice for the report of a task she launched, as a `SpeakAudioResponse`
 * (the same clip shape `POST /api/asks/:id/speak` returns). The sentence is the one the server
 * kept when it announced the report; the browser cannot supply text to be spoken.
 */
export const LUCY_LAUNCH_REPORT_SPEAK_PATH = '/api/lucy/launch/report/speak';

/** The card the dashboard shows. `description` is the whole task description, never a summary. */
export interface LucyLaunchProposalView {
  id: string;
  kind: LucyLaunchKind;
  /** Short project name from Kookr's project list. */
  project: string;
  /** Exactly what the task will be asked to do (before Kookr's own delivery wording is added). */
  description: string;
  agentType: string;
  /** The operator's own words that this proposal was built from. */
  asked: string;
  /** The sentence she says aloud. */
  readBack: string;
  /** Epoch milliseconds after which the proposal can no longer be confirmed. */
  expiresAt: number;
  /** The level in force when the card was made, shown on the card. */
  level: LucyAutonomy;
  /**
   * Hands-off only: the launch happens at `launchesAt` unless cancelled before then.
   * Absent for a card that waits for the operator.
   */
  launchesAt?: number;
}

/** What happened to a proposal. Sent as a turn event and as the body of the confirm/decline/cancel routes. */
export type LucyLaunchOutcome =
  | { outcome: 'launched'; proposalId: string; taskId: string; project: string; queued?: boolean; duplicate?: boolean }
  /** Launch refused (no free slot, disk critical, ...); `reason` is one sentence for the operator. */
  | { outcome: 'refused'; proposalId: string; reason: string }
  | { outcome: 'declined'; proposalId: string }
  | { outcome: 'cancelled'; proposalId: string }
  | { outcome: 'expired'; proposalId: string }
  /** No pending proposal with that id (already used, replaced, or never made). */
  | { outcome: 'unknown'; proposalId: string };

/** A task Lucy launched has finished or needs the operator; she says so in the conversation that launched it. */
export interface LucyLaunchReport {
  taskId: string;
  conversationId: string;
  kind: 'finished' | 'needs_input';
  /** One or two sentences, ready to be spoken. */
  text: string;
}

export interface LucyLaunchRouteBody {
  conversationId: string;
  proposalId: string;
}
