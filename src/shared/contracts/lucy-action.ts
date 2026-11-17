/**
 * Wire contract for the three things Lucy can do to an existing task for the operator:
 * answer a question it asked (`kookr ask`), send it a reply, and close it once it says it is finished.
 *
 * Like a launch (`lucy-launch.ts`), none of these happens on her own reading of a conversation.
 * She *proposes* one, the server holds the proposal and shows a card that says exactly what will
 * happen, and only the operator confirms it: a click on the card, or "go" as their next sentence.
 * Unlike a launch, these always wait for that confirmation, at every `lucyAutonomy` level: there
 * is no countdown that carries one out by itself.
 */

export const LUCY_ACTION_KINDS = ['answer', 'reply', 'close'] as const;
export type LucyActionKind = (typeof LUCY_ACTION_KINDS)[number];

export const LUCY_ACTION_CONFIRM_PATH = '/api/lucy/action/confirm';
export const LUCY_ACTION_DECLINE_PATH = '/api/lucy/action/decline';

interface LucyActionProposalBase {
  id: string;
  /** The task the action is for. */
  taskId: string;
  /** The task's name as the card shows it; a description such as "an unnamed task" when it has none. */
  taskName: string;
  /** The card's heading: "Answer Billing migration", "Reply to Billing migration", "Close Billing migration". */
  title: string;
  /** The operator's own words that this proposal was made from. */
  asked: string;
  /** The sentence she says aloud. */
  readBack: string;
  /** Epoch milliseconds after which the proposal can no longer be confirmed. */
  expiresAt: number;
}

/**
 * The card the dashboard shows. Everything that will be sent is on it in full, never summarised:
 * the chosen option's label, or the whole text that will be typed into the task.
 */
export type LucyActionProposalView = LucyActionProposalBase & (
  | {
      kind: 'answer';
      askId: string;
      /** The question as the task asked it. */
      question: string;
      /** One of the question's listed choices, or the operator's own words when the question takes free text. */
      answer: { kind: 'option'; index: number; label: string } | { kind: 'text'; text: string };
    }
  /** `text` is exactly what will be typed into the task. */
  | { kind: 'reply'; text: string }
  | { kind: 'close' }
);

/** What happened to a proposal. Sent as a turn event, over the dashboard socket, and as the body of the confirm and decline routes. */
export type LucyActionOutcome =
  /** Carried out. `note` is one sentence when there is something to add (an answer recorded but not typed into an ended task). */
  | { outcome: 'done'; proposalId: string; kind: LucyActionKind; taskId: string; note?: string }
  /** Not carried out; `reason` is one sentence for the operator (the question was answered elsewhere, the task ended, ...). */
  | { outcome: 'refused'; proposalId: string; reason: string }
  | { outcome: 'declined'; proposalId: string }
  /** Dropped without the operator declining it: another card replaced it, or its conversation ended. */
  | { outcome: 'cancelled'; proposalId: string }
  | { outcome: 'expired'; proposalId: string }
  /** No pending proposal with that id (already used, replaced, or never made). */
  | { outcome: 'unknown'; proposalId: string };

export interface LucyActionRouteBody {
  conversationId: string;
  proposalId: string;
}
