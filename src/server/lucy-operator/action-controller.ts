/**
 * Holds Lucy's proposals to act on an existing task, and carries them out: answer a question it
 * asked, send it a reply, close it once it says it is finished.
 *
 * What makes this safe, in the order an action happens (the same shape as a launch,
 * `launch-controller.ts`):
 * 1. A proposal is made only by `propose`, reached only through her `propose_answer`,
 *    `propose_reply` and `propose_close` tools. The request it receives holds ids and a choice
 *    number, nothing else: every one is checked here against the real task and question.
 * 2. Text that will be sent (a reply, a free-text answer) is written here, by a separate model call
 *    that is given the operator's own words and nothing else. The model that read task text never
 *    supplies it.
 * 3. The card says exactly what will happen: the task, the question and the chosen choice, or the
 *    whole text. What is confirmed is what is sent.
 * 4. A proposal is carried out only by `confirm`, called with the operator's "go" (the next turn,
 *    before any model is called) or by the confirm route (a click). The model has no way to call it.
 * 5. Everything is checked again at that moment: the question is still waiting with the same
 *    choices, the task is still in a state that allows it, the session is still the live one.
 *    If anything changed, nothing is done and the operator is told why.
 * 6. There is no timer here. Whatever the `lucyAutonomy` level, these actions wait for the operator.
 * 7. One card is on screen for all of her proposals: making one here drops a pending launch card
 *    (`onHeld`), and a new launch card drops the one held here (`dropPending`).
 *
 * The only task text this file reads is the task's name, the question and its choices, to put them
 * on the card and in the read-back. None of it is ever sent to a model from here.
 */

import { randomUUID } from 'node:crypto';
import { AgentInputRefusedError } from '../../core/choice-dialog-guard.js';
import {
  ACTION_NOT_DONE,
  ACTION_PROPOSAL_TTL_MS,
  ACTION_TIMED_OUT,
  buildActionReadBack,
  buildActionTitle,
  buildAnswerWriterPrompt,
  buildReplyWriterPrompt,
  cleanTextToSend,
  MAX_REPLY_CHARS,
  parseTextDraft,
  sayActionOutcome,
} from '../../core/lucy-operator/action-proposal.js';
import type { LucyActionProposeResult, LucyActionRequest } from '../../core/lucy-operator/action-tool.js';
import { boardText, spokenLabel } from '../../core/lucy-operator/board.js';
import { classifyReply, ECHO_TAIL_MS, estimateSpeechMs, mayBeOwnVoice, type LucyReplyContext } from '../../core/lucy-operator/launch-proposal.js';
import { redactSpeechSecrets } from '../../core/task-speech-summary.js';
import { ASK_LIMITS, type AnswerResult, type DashboardAnswerInput, type OperatorAskView } from '../../shared/contracts/asks.js';
import type { LucyActionKind, LucyActionOutcome, LucyActionProposalView } from '../../shared/contracts/lucy-action.js';
import { isTerminalStatus, type TaskStatus } from '../../shared/contracts/task-status.js';
import { DISABLED_LUCY_INTERACTION_LOG, type LucyActionRecordInput, type LucyInteractionLog } from '../lucy-interaction-log.js';

/** The facts about a task this file decides on. The server reads them from its task store at the moment they are needed. */
export interface LucyActionTask {
  id: string;
  name?: string;
  /** Display name of the project, for a task that has no name of its own. */
  project?: string;
  status: TaskStatus;
  /** It raised "finished, please review", and has not been given new work since. */
  saysFinished: boolean;
  /** It runs as a loop that owns its own completion; completing it would only end one iteration. */
  loop?: boolean;
  /** The live session a reply is typed into; absent when the task has none. */
  liveSessionId?: string;
}

export type LucyCloseResult = { ok: true } | { ok: false; reason: string };

export type LucyActionVia = 'spoken' | 'typed' | 'click';

export type LucyActionBroadcast =
  | { type: 'lucy_action'; conversationId: string; proposal: LucyActionProposalView }
  | { type: 'lucy_action'; conversationId: string; outcome: LucyActionOutcome };

export interface LucyActionAuditRow {
  action: LucyActionKind;
  proposalId: string;
  via: LucyActionVia;
  taskId: string;
  askId?: string;
  /** For an answer: `option:<index>` or `text`. The text itself is never written to the audit log. */
  choice?: string;
  outcome: 'done' | 'refused';
  reason?: string;
}

export interface LucyActionControllerDeps {
  /** The task as it is now, or undefined when it no longer exists. Read at propose time and again at confirm time. */
  getTask(taskId: string): LucyActionTask | undefined;
  /** The questions tasks asked the operator, as the panel lists them. */
  getAsks(): readonly OperatorAskView[];
  /** One model call that returns text, with no tools. It is handed the system text and the operator's words only. */
  writeText(request: { system: string; operatorWords: readonly string[]; signal?: AbortSignal }): Promise<string>;
  /** Records the operator's answer through the audited entry point the panel's buttons use. Absent: questions are not available. */
  answerAsk?(input: DashboardAnswerInput): Promise<AnswerResult>;
  /** Types a reply into a live session, as the dashboard's reply box does. Throws `AgentInputRefusedError` on a choice prompt. */
  sendReply?(sessionId: string, text: string): Promise<void>;
  /** Completes a task, as the dashboard's Complete button does. */
  closeTask?(taskId: string): Promise<LucyCloseResult>;
  /** Called once for each action she carried out or was refused at confirm time, for the durable audit trail. */
  audit?(row: LucyActionAuditRow): void | Promise<void>;
  /** Told about every proposal and every outcome, so every open dashboard shows or clears the card. */
  emit?(message: LucyActionBroadcast): void;
  /** Called when a new proposal is about to be held: the holder of her launch card drops its own. */
  onHeld?(): void;
  log?: LucyInteractionLog;
  now?: () => number;
  newId?: () => string;
  warn?: (message: string) => void;
}

/** What the service does with the operator's sentence before calling any model. */
export type LucyActionReplyHandling =
  | { handled: false }
  /** Answer with `say` (may be empty: nothing is spoken) and the outcome, without calling the model. */
  | { handled: true; say: string; outcome?: LucyActionOutcome; ignored?: boolean };

export interface LucyActionController {
  propose(input: { conversationId: string; request: LucyActionRequest; operatorWords: readonly string[]; spoken?: boolean; signal?: AbortSignal }): Promise<LucyActionProposeResult>;
  /** Called with the operator's sentence at the start of a turn, before any model. */
  handleReply(conversationId: string, text: string, context?: LucyReplyContext): Promise<LucyActionReplyHandling>;
  confirm(conversationId: string, proposalId: string, via: LucyActionVia): Promise<LucyActionOutcome>;
  decline(conversationId: string, proposalId: string): LucyActionOutcome;
  /** Her voice is audible until `until` (server clock): the echo guard runs to the real end of the read-back. */
  noteSpeaking(conversationId: string, until: number): void;
  /** The conversation ended (the voice socket closed): its pending proposal is dropped, never carried out. */
  closeConversation(conversationId: string): void;
  /**
   * The proposal currently held for a conversation, if it can still be confirmed. Without an id: the one card
   * held in any conversation, which is the one a "yes" from any conversation answers (see `handleReply`).
   */
  pending(conversationId?: string): LucyActionProposalView | undefined;
  /** Another kind of card took the screen: every held proposal is dropped, never carried out, and its card is cleared. */
  dropPending(): void;
  /** Forget everything held (shutdown, tests). */
  dispose(): void;
}

interface Held {
  view: LucyActionProposalView;
  /** When she has finished saying the read-back, by estimate; spoken words that began before are ignored. */
  speakingUntil: number;
  /** A reply: the session the text will be typed into. If the task has another live session at confirm time, nothing is sent. */
  sessionId?: string;
  /** An answer: the question's choices when the card was made. If they differ at confirm time, nothing is sent. */
  options?: readonly string[];
}

const MAX_OPERATOR_WORDS = 6;
const MAX_WORDS_CHARS = 2000;
const QUESTION_NOT_WAITING = 'That question is not waiting any more, so I did not send anything.';

function capitalised(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The task's name as the card shows it: cleaned like the board, or a description when it has none. */
function cardName(task: Pick<LucyActionTask, 'name' | 'project'> | undefined, fallback?: string): string {
  const name = boardText(task?.name, 80);
  if (name) return name;
  if (fallback) return boardText(fallback, 80);
  const project = boardText(task?.project, 40);
  return project ? `an unnamed task in ${project}` : 'an unnamed task';
}

function sameOptions(a: readonly string[], b: readonly string[] | undefined): boolean {
  return b !== undefined && a.length === b.length && a.every((option, index) => option === b[index]);
}

/** Why the ask service refused an answer, in one sentence for the operator. */
function answerRefusal(reason: string | undefined): string {
  switch (reason) {
    case 'already_answered': return 'That question was already answered, so I did not send anything.';
    case 'expired': return 'That question expired, so I did not send anything.';
    case 'cancelled':
    case 'not_found': return QUESTION_NOT_WAITING;
    case 'task_gone': return 'The session that asked has ended, so I did not send anything.';
    case 'bad_option': return 'That question no longer has that choice, so I did not send anything.';
    case 'text_not_allowed': return 'That question takes one of its choices only, so I did not send anything.';
    default: return 'Kookr could not record that answer, so nothing was sent.';
  }
}

/** Why a task cannot be closed by her right now, or null when it can. `who` starts the sentence. */
function closeProblem(task: LucyActionTask, who: string): string | null {
  if (task.status === 'completed' || task.status === 'cancelled') return `${who} is already closed.`;
  if (task.loop) return `${who} runs as a loop, and I cannot close a loop.`;
  if (task.status !== 'inProgress' && task.status !== 'terminated') return `${who} has not started yet, so there is nothing to close.`;
  if (!task.saysFinished) {
    return task.status === 'terminated'
      ? `${who} stopped without saying it was finished, so I will not close it.`
      : `${who} is still working: it has not said it is finished, so I will not close it.`;
  }
  return null;
}

export function createLucyActionController(deps: LucyActionControllerDeps): LucyActionController {
  const log = deps.log ?? DISABLED_LUCY_INTERACTION_LOG;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const warn = deps.warn ?? ((m: string) => console.warn(`[lucy-action] ${m}`));

  const held = new Map<string, Held>();

  const record = (conversationId: string, input: Omit<LucyActionRecordInput, 'conversationId'>): void => {
    try {
      log.recordAction?.({ conversationId, ...input });
    } catch {
      // A record keeper that throws must not undo a decision.
    }
  };
  const announce = (message: LucyActionBroadcast): void => {
    try {
      deps.emit?.(message);
    } catch (err) {
      warn(`could not announce: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const audit = (row: LucyActionAuditRow): void => {
    try {
      void Promise.resolve(deps.audit?.(row)).catch((err: unknown) => warn(`audit failed: ${err instanceof Error ? err.message : String(err)}`));
    } catch (err) {
      warn(`audit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const finish = (conversationId: string, outcome: LucyActionOutcome): LucyActionOutcome => {
    announce({ type: 'lucy_action', conversationId, outcome });
    return outcome;
  };
  const drop = (conversationId: string): Held | undefined => {
    const entry = held.get(conversationId);
    if (entry) held.delete(conversationId);
    return entry;
  };
  /** What a card is about, for the records: never the text. */
  const facts = (view: LucyActionProposalView): Pick<LucyActionAuditRow, 'action' | 'proposalId' | 'taskId' | 'askId' | 'choice'> => ({
    action: view.kind,
    proposalId: view.id,
    taskId: view.taskId,
    ...(view.kind === 'answer' ? { askId: view.askId, choice: view.answer.kind === 'option' ? `option:${view.answer.index}` : 'text' } : {}),
  });
  /** The text a card will send, with secrets hidden, for the interaction log only. */
  const sentText = (view: LucyActionProposalView): { text?: string } => {
    if (view.kind === 'reply') return { text: redactSpeechSecrets(view.text) };
    if (view.kind === 'answer' && view.answer.kind === 'text') return { text: redactSpeechSecrets(view.answer.text) };
    return {};
  };
  /** The held proposal if it can still be confirmed; one that ran out of time is dropped here and its card cleared. */
  const live = (conversationId: string): Held | undefined => {
    const entry = held.get(conversationId);
    if (entry && now() >= entry.view.expiresAt) {
      drop(conversationId);
      record(conversationId, { ...facts(entry.view), event: 'expired' });
      announce({ type: 'lucy_action', conversationId, outcome: { outcome: 'expired', proposalId: entry.view.id } });
      return undefined;
    }
    return entry;
  };

  function dropPending(): void {
    for (const other of [...held.keys()]) {
      const replaced = drop(other);
      if (!replaced) continue;
      record(other, { ...facts(replaced.view), event: 'dropped', reason: 'replaced' });
      announce({ type: 'lucy_action', conversationId: other, outcome: { outcome: 'cancelled', proposalId: replaced.view.id } });
    }
  }

  /** The text that will be sent, written from the operator's words alone; or what she says instead. */
  async function writeText(system: string, words: readonly string[], maxChars: number, askAgain: string, signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; say: string; why: string }> {
    if (words.length === 0) return { ok: false, say: askAgain, why: 'no words' };
    let reply: string;
    try {
      reply = await deps.writeText({ system, operatorWords: words, signal });
    } catch (err) {
      warn(redactSpeechSecrets(`could not write the text: ${err instanceof Error ? err.message : String(err)}`));
      return { ok: false, say: 'I could not prepare that just now. Please try again.', why: 'writer failed' };
    }
    const draft = parseTextDraft(reply);
    if (!draft) return { ok: false, say: 'I could not make that out. Could you say it again?', why: 'unreadable draft' };
    if ('ambiguous' in draft) return { ok: false, say: draft.ambiguous, why: 'ambiguous' };
    const text = cleanTextToSend(draft.text, maxChars);
    if (!text) return { ok: false, say: askAgain, why: 'empty or too long' };
    return { ok: true, text };
  }

  /** Do what a confirmed card says, after checking again that it still describes the task and the question. */
  async function carryOut(conversationId: string, entry: Held, via: LucyActionVia): Promise<LucyActionOutcome> {
    const { view } = entry;
    const proposalId = view.id;
    // The same facts go to the interaction log and to the audit row; only the log also holds the text.
    const base = { ...facts(view), via };
    const refuse = (reason: string): LucyActionOutcome => {
      record(conversationId, { ...base, event: 'refused', reason });
      audit({ ...base, outcome: 'refused', reason });
      return finish(conversationId, { outcome: 'refused', proposalId, reason });
    };
    const done = (note?: string): LucyActionOutcome => {
      record(conversationId, { ...base, event: 'done', ...sentText(view) });
      audit({ ...base, outcome: 'done' });
      return finish(conversationId, { outcome: 'done', proposalId, kind: view.kind, taskId: view.taskId, ...(note ? { note } : {}) });
    };

    try {
      if (view.kind === 'answer') {
        if (!deps.answerAsk) return refuse('Answering questions is not available on this server.');
        const ask = deps.getAsks().find((a) => a.id === view.askId);
        if (!ask || ask.state !== 'pending' || ask.expiresAt <= now()) return refuse(answerRefusal(ask?.state === 'answered' ? 'already_answered' : ask?.state === 'expired' ? 'expired' : 'not_found'));
        // The card showed a question and a choice: if either reads differently now, the card no longer tells the truth.
        if (ask.question !== view.question || !sameOptions(ask.options, entry.options) || (view.answer.kind === 'text' && !ask.allowText)) {
          return refuse('That question changed since I prepared the answer, so I did not send anything. Ask me again.');
        }
        const result = await deps.answerAsk(view.answer.kind === 'option' ? { askId: view.askId, optionIndex: view.answer.index } : { askId: view.askId, text: view.answer.text });
        return result.ok ? done(result.notTyped) : refuse(answerRefusal(result.reason));
      }

      const task = deps.getTask(view.taskId);
      if (!task) return refuse('That task is gone, so I did nothing.');
      const who = capitalised(spokenLabel(task));

      if (view.kind === 'reply') {
        if (!deps.sendReply) return refuse('Replying to tasks is not available on this server.');
        if (isTerminalStatus(task.status) || !task.liveSessionId || !entry.sessionId) return refuse(`${who} is not running any more, so I did not send anything.`);
        // A relaunched task has a new session that never saw what the operator was replying to.
        if (task.liveSessionId !== entry.sessionId) return refuse(`${who} was restarted since I prepared that, so I did not send anything. Ask me again.`);
        try {
          await deps.sendReply(entry.sessionId, view.text);
        } catch (err) {
          if (err instanceof AgentInputRefusedError) return refuse(`${who} is showing a choice prompt, so I did not type anything. Answer that on the task.`);
          warn(redactSpeechSecrets(`reply failed: ${err instanceof Error ? err.message : String(err)}`));
          // The error text may quote the terminal: the operator is told only that it failed.
          return refuse('Kookr could not type that into the task.');
        }
        return done();
      }

      if (!deps.closeTask) return refuse('Closing tasks is not available on this server.');
      const problem = closeProblem(task, who);
      if (problem) return refuse(problem);
      const result = await deps.closeTask(view.taskId);
      return result.ok ? done() : refuse(result.reason);
    } catch (err) {
      warn(redactSpeechSecrets(`action failed: ${err instanceof Error ? err.message : String(err)}`));
      return refuse('Kookr could not do that.');
    }
  }

  async function confirm(conversationId: string, proposalId: string, via: LucyActionVia): Promise<LucyActionOutcome> {
    const present = held.get(conversationId);
    if (!present || present.view.id !== proposalId) return { outcome: 'unknown', proposalId };
    const entry = live(conversationId);
    if (!entry) return { outcome: 'expired', proposalId };
    // Taken out before acting, so a click and a spoken "go" together cannot send it twice.
    drop(conversationId);
    return carryOut(conversationId, entry, via);
  }

  function decline(conversationId: string, proposalId: string): LucyActionOutcome {
    const entry = held.get(conversationId);
    if (!entry || entry.view.id !== proposalId) return { outcome: 'unknown', proposalId };
    drop(conversationId);
    record(conversationId, { ...facts(entry.view), event: 'declined' });
    return finish(conversationId, { outcome: 'declined', proposalId });
  }

  return {
    async propose({ conversationId, request, operatorWords, signal }) {
      const words = operatorWords.map((w) => redactSpeechSecrets(w).slice(0, MAX_WORDS_CHARS)).filter((w) => w.trim()).slice(-MAX_OPERATOR_WORDS);
      const none = (say: string, why: string): LucyActionProposeResult => {
        record(conversationId, { event: 'no_proposal', action: request.kind, reason: why, ...('taskId' in request ? { taskId: request.taskId } : { askId: request.askId }) });
        return { ok: false, say, why };
      };

      // What the card will say and do, decided from the real task and question. Nothing is held until all of it is known.
      let proposed: { taskId: string; taskName: string; who: string; body: LucyActionBody; sessionId?: string; options?: readonly string[] };

      if (request.kind === 'answer') {
        if (!deps.answerAsk) return none('Answering questions is not available on this server.', 'no asks port');
        const ask = deps.getAsks().find((a) => a.id === request.askId);
        if (!ask || ask.state !== 'pending' || ask.expiresAt <= now()) return none('That question is not waiting any more.', 'question not waiting');
        const task = deps.getTask(ask.taskId);
        const who = task ? spokenLabel(task) : ask.taskName ? `"${boardText(ask.taskName, 40)}"` : 'a task';
        let answer: Extract<LucyActionBody, { kind: 'answer' }>['answer'];
        if (request.optionIndex !== undefined) {
          const label = Number.isInteger(request.optionIndex) ? ask.options[request.optionIndex] : undefined;
          if (label === undefined) return none('That question does not have that choice. Which one do you want?', 'no such choice');
          answer = { kind: 'option', index: request.optionIndex, label };
        } else {
          if (!ask.allowText) return none('That question takes one of its choices only. Which one do you want?', 'text not allowed');
          const written = await writeText(buildAnswerWriterPrompt(), words, ASK_LIMITS.maxAnswerTextChars, 'What should I answer?', signal);
          if (!written.ok) return none(written.say, written.why);
          answer = { kind: 'text', text: written.text };
        }
        proposed = { taskId: ask.taskId, taskName: cardName(task, ask.taskName), who, body: { kind: 'answer', askId: ask.id, question: ask.question, answer }, options: [...ask.options] };
      } else {
        const task = deps.getTask(request.taskId);
        if (!task) return none('I cannot find that task any more.', 'no such task');
        const who = spokenLabel(task);
        if (request.kind === 'reply') {
          if (!deps.sendReply) return none('Replying to tasks is not available on this server.', 'no reply port');
          if (isTerminalStatus(task.status) || !task.liveSessionId) return none(`${capitalised(who)} is not running, so there is nothing to type a reply into.`, 'no live session');
          const written = await writeText(buildReplyWriterPrompt(), words, MAX_REPLY_CHARS, 'What should I tell it?', signal);
          if (!written.ok) return none(written.say, written.why);
          proposed = { taskId: task.id, taskName: cardName(task), who, body: { kind: 'reply', text: written.text }, sessionId: task.liveSessionId };
        } else {
          if (!deps.closeTask) return none('Closing tasks is not available on this server.', 'no close port');
          const problem = closeProblem(task, capitalised(who));
          if (problem) return none(problem, 'cannot close');
          proposed = { taskId: task.id, taskName: cardName(task), who, body: { kind: 'close' } };
        }
      }

      const createdAt = now();
      const readBack = buildActionReadBack(proposed.who, proposed.body);
      const view: LucyActionProposalView = {
        id: newId(),
        taskId: proposed.taskId,
        taskName: proposed.taskName,
        title: buildActionTitle(proposed.body.kind, proposed.taskName),
        asked: words[words.length - 1] ?? '',
        readBack,
        expiresAt: createdAt + ACTION_PROPOSAL_TTL_MS,
        ...proposed.body,
      };
      // One card on screen for all of her proposals: a new one replaces any old one, here and among the launch
      // cards, in this conversation or another, so "go" can only mean the card that is shown.
      dropPending();
      try {
        deps.onHeld?.();
      } catch (err) {
        warn(`could not clear another card: ${err instanceof Error ? err.message : String(err)}`);
      }
      held.set(conversationId, {
        view,
        speakingUntil: createdAt + estimateSpeechMs(readBack),
        ...(proposed.sessionId ? { sessionId: proposed.sessionId } : {}),
        ...(proposed.options ? { options: proposed.options } : {}),
      });
      record(conversationId, { ...facts(view), event: 'proposed', asked: view.asked, ...sentText(view) });
      announce({ type: 'lucy_action', conversationId, proposal: view });
      return { ok: true, proposal: view, say: readBack };
    },

    async handleReply(askedIn, text, context = {}) {
      // The one card on screen is answered from whichever conversation the operator speaks or types in.
      const conversationId = held.keys().next().value ?? askedIn;
      const hadOne = held.get(conversationId);
      const entry = live(conversationId);
      if (!entry) {
        if (hadOne && classifyReply(text, 'action') === 'confirm') {
          return { handled: true, say: ACTION_TIMED_OUT, outcome: { outcome: 'expired', proposalId: hadOne.view.id } };
        }
        return { handled: false };
      }

      // The echo rule every card of hers shares: spoken words that began during the read-back neither confirm nor drop it.
      if (mayBeOwnVoice(text, context, entry.speakingUntil, now(), 'action')) {
        record(conversationId, { ...facts(entry.view), event: 'ignored', via: 'spoken', reason: 'began during the read-back' });
        return { handled: true, say: '', ignored: true };
      }

      switch (classifyReply(text, 'action')) {
        case 'confirm': {
          const outcome = await confirm(conversationId, entry.view.id, context.input === 'voice' ? 'spoken' : 'typed');
          return { handled: true, say: sayActionOutcome(outcome), outcome };
        }
        case 'decline': {
          const outcome = decline(conversationId, entry.view.id);
          return { handled: true, say: outcome.outcome === 'unknown' ? '' : ACTION_NOT_DONE, outcome };
        }
        case 'other': {
          // Anything else drops the proposal and is handled as a new request.
          drop(conversationId);
          record(conversationId, { ...facts(entry.view), event: 'dropped', reason: 'operator said something else' });
          announce({ type: 'lucy_action', conversationId, outcome: { outcome: 'declined', proposalId: entry.view.id } });
          return { handled: false };
        }
      }
    },

    confirm,
    decline,

    noteSpeaking(conversationId, until) {
      const entry = live(conversationId);
      if (entry) entry.speakingUntil = Math.max(entry.speakingUntil, until + ECHO_TAIL_MS);
    },

    closeConversation(conversationId) {
      const entry = drop(conversationId);
      if (!entry) return;
      record(conversationId, { ...facts(entry.view), event: 'dropped', reason: 'conversation closed' });
      announce({ type: 'lucy_action', conversationId, outcome: { outcome: 'cancelled', proposalId: entry.view.id } });
    },

    pending: (conversationId) => {
      const id = conversationId ?? held.keys().next().value;
      return id === undefined ? undefined : live(id)?.view;
    },

    dropPending,

    dispose() {
      held.clear();
    },
  };
}

/** The part of a card that depends on its kind. */
type LucyActionBody =
  | { kind: 'answer'; askId: string; question: string; answer: { kind: 'option'; index: number; label: string } | { kind: 'text'; text: string } }
  | { kind: 'reply'; text: string }
  | { kind: 'close' };
