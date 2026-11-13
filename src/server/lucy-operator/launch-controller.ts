/**
 * Holds Lucy's launch proposals and carries them out (issue #3676).
 *
 * What makes this safe, in the order a launch happens:
 * 1. A proposal is made only by `propose`, which is reached only through her `propose_launch`
 *    tool. The task description is written here, by a separate model call that is given the
 *    operator's own words and the project list and nothing else, then checked against the same
 *    strict schema the Telegram path uses and against the project list by exact name.
 * 2. At most one proposal is held per conversation, for two minutes.
 * 3. A proposal is launched only by `confirm`, called with the operator's "go" (the next turn,
 *    before any model is called), or by the confirm route (Enter or a click). The model has no
 *    way to call it.
 * 4. The level (`lucyAutonomy`) is read here, at the moment of launching. No request carries it.
 * 5. A launch the server would refuse anyway (no free slot, disk critical) is refused with a reason.
 *
 * Nothing in this file reads a task name or task output.
 */

import { randomUUID } from 'node:crypto';
import { TaskSpecSchema } from '../../integrations/telegram/types.js';
import {
  asksToChangeAutonomy,
  AUTONOMY_IN_SETTINGS_SENTENCE,
  buildReadBack,
  buildSpecWriterPrompt,
  buildTaskPrompt,
  classifyReply,
  ECHO_TAIL_MS,
  HANDS_OFF_CANCEL_WINDOW_MS,
  LAUNCH_PROPOSAL_TTL_MS,
  parseSpecDraft,
  resolveProject,
  type LaunchableProject,
} from '../../core/lucy-operator/launch-proposal.js';
import type { LucyProposeResult } from '../../core/lucy-operator/launch-tool.js';
import { isGenericTaskName, spokenTaskName } from '../../core/spoken-task-name.js';
import { redactSpeechSecrets, redactedTaskName } from '../../core/task-speech-summary.js';
import {
  LUCY_OPERATOR_ACTOR_ID,
  type LucyAutonomy,
  type LucyLaunchKind,
  type LucyLaunchOutcome,
  type LucyLaunchProposalView,
  type LucyLaunchReport,
} from '../../shared/contracts/lucy-launch.js';
import type { LaunchOpts } from '../../shared/contracts/launch.js';
import { DISABLED_LUCY_INTERACTION_LOG, type LucyInteractionLog, type LucyLaunchRecordInput } from '../lucy-interaction-log.js';

/** The part of a launch result this file reads. */
export interface LucyLaunchedTask {
  task: { id: string };
  queued?: boolean;
  duplicate?: boolean;
}

export interface LucyLaunchControllerDeps {
  /** Read at the moment of launching, never cached and never taken from a request. */
  getAutonomy(): LucyAutonomy;
  /** The projects she may launch in: name and folder. */
  getProjects(): Promise<readonly LaunchableProject[]> | readonly LaunchableProject[];
  /** One model call that returns text, with no tools. It is handed the system text and the operator's words only. */
  writeSpec(request: { system: string; operatorWords: readonly string[]; signal?: AbortSignal }): Promise<string>;
  /** A sentence saying why a launch would be refused right now (no free slot, disk critical), or null. */
  checkRoom(): string | null;
  /** The normal launch service. `bypassPermissions` is the per-launch override of the level. */
  launch(opts: LaunchOpts, server: { bypassPermissions?: boolean; deliveryPolicy?: 'ask-first' }): Promise<LucyLaunchedTask>;
  /** Called once for each task she launched, for the durable audit trail. A failure here never undoes the launch. */
  audit?(row: { taskId: string; proposalId: string; level: LucyAutonomy; via: LucyLaunchVia; project: string; kind: LucyLaunchKind; queued: boolean; duplicate: boolean }): void | Promise<void>;
  /** Told about every proposal and every outcome, so every open dashboard shows or clears the card. */
  emit?(message: LucyLaunchBroadcast): void;
  log?: LucyInteractionLog;
  now?: () => number;
  newId?: () => string;
  warn?: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export type LucyLaunchBroadcast =
  | { type: 'lucy_launch'; conversationId: string; proposal: LucyLaunchProposalView }
  | { type: 'lucy_launch'; conversationId: string; outcome: LucyLaunchOutcome }
  | { type: 'lucy_launch'; conversationId: string; report: LucyLaunchReport };

export type LucyLaunchVia = 'spoken' | 'typed' | 'click' | 'enter' | 'timer';

/** What the service does with the operator's sentence before calling any model. */
export type LucyReplyHandling =
  | { handled: false }
  /** Answer with `say` (may be empty: nothing is spoken) and the outcome, without calling the model. */
  | { handled: true; say: string; outcome?: LucyLaunchOutcome; ignored?: boolean };

interface Held {
  view: LucyLaunchProposalView;
  prompt: string;
  cwd: string;
  agentType?: 'claude-code' | 'codex-cli';
  kind: LucyLaunchKind;
  /** When she has finished saying the read-back, by estimate; spoken words that began before are ignored. */
  speakingUntil: number;
  timer?: unknown;
  /** The read-back was spoken by the browser (voice turn) and has been reported audible at least once. */
  heard: boolean;
  /** The proposal came from a spoken turn, so a hands-off launch waits until the read-back has been heard. */
  spoken: boolean;
}

/** Tasks she launched, remembered so their outcome can be told in the conversation that asked. */
const MAX_REMEMBERED_TASKS = 200;
/** How long a spoken hands-off proposal waits to be heard before it is dropped instead of launched. */
const HEARD_WAIT_MS = 60_000;
const LEVEL_RANK: Record<LucyAutonomy, number> = { careful: 0, balanced: 1, 'hands-off': 2 };
const MAX_OPERATOR_WORDS = 6;
/** The same task is not announced as needing the operator again within this time. */
const NEEDS_INPUT_REPEAT_MS = 5 * 60 * 1000;
const MAX_WORDS_CHARS = 2000;

/** Rough time to speak a sentence: about three words a second, plus a second for the voice to start. */
function estimateSpeechMs(sentence: string): number {
  const words = sentence.split(/\s+/).filter(Boolean).length;
  return Math.round((words / 3) * 1000) + 1000;
}

export interface LucyLaunchController {
  propose(input: { conversationId: string; operatorWords: readonly string[]; spoken?: boolean; signal?: AbortSignal }): Promise<LucyProposeResult>;
  /** Called with the operator's sentence at the start of a turn, before any model. */
  handleReply(conversationId: string, text: string, context?: { input?: 'voice' | 'typed'; overlapsReadBack?: boolean; speechStartedAt?: number }): Promise<LucyReplyHandling>;
  confirm(conversationId: string, proposalId: string, via: LucyLaunchVia): Promise<LucyLaunchOutcome>;
  decline(conversationId: string, proposalId: string): LucyLaunchOutcome;
  /** Stop a hands-off launch during its window. Only valid while it is held. */
  cancel(conversationId: string, proposalId: string): LucyLaunchOutcome;
  /**
   * Her voice is audible until `until` (server clock). Called as the read-back is sent to the browser, so the
   * echo guard and the hands-off cancel window start when she has really finished speaking, not when the card was made.
   */
  noteSpeaking(conversationId: string, until: number): void;
  /** The conversation ended (the voice socket closed): its pending proposal is dropped, never launched. */
  closeConversation(conversationId: string): void;
  /** The proposal currently held for a conversation, if it can still be confirmed. */
  pending(conversationId: string): LucyLaunchProposalView | undefined;
  /** A task ended or needs the operator: tell its conversation if she launched it. */
  onTaskOutcome(taskId: string, outcome: { kind: 'completion_ready' | 'completed' | 'failed' | 'cancelled' | 'needs_input' }, taskLabel?: string): void;
  /** The sentence last announced for a task she launched, or undefined. The speech route says only this. */
  reportText(taskId: string): string | undefined;
  /** Stop timers (shutdown, tests). */
  dispose(): void;
}

export function createLucyLaunchController(deps: LucyLaunchControllerDeps): LucyLaunchController {
  const log = deps.log ?? DISABLED_LUCY_INTERACTION_LOG;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const warn = deps.warn ?? ((m: string) => console.warn(`[lucy-launch] ${m}`));
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  const held = new Map<string, Held>();
  const launchedFrom = new Map<string, string>();
  const reports = new Map<string, string>();
  const lastNeeds = new Map<string, number>();

  const record = (conversationId: string, input: Omit<LucyLaunchRecordInput, 'conversationId'>): void => {
    try {
      log.recordLaunch?.({ conversationId, ...input });
    } catch {
      // A record keeper that throws must not undo a launch decision.
    }
  };
  const announce = (message: LucyLaunchBroadcast): void => {
    try {
      deps.emit?.(message);
    } catch (err) {
      warn(`could not announce: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const finish = (conversationId: string, outcome: LucyLaunchOutcome): LucyLaunchOutcome => {
    announce({ type: 'lucy_launch', conversationId, outcome });
    return outcome;
  };
  const drop = (conversationId: string): Held | undefined => {
    const entry = held.get(conversationId);
    if (!entry) return undefined;
    if (entry.timer !== undefined) clearTimer(entry.timer);
    held.delete(conversationId);
    return entry;
  };
  const live = (conversationId: string): Held | undefined => {
    const entry = held.get(conversationId);
    if (entry && now() >= entry.view.expiresAt) {
      drop(conversationId);
      record(conversationId, { event: 'expired', proposalId: entry.view.id, level: entry.view.level });
      announce({ type: 'lucy_launch', conversationId, outcome: { outcome: 'expired', proposalId: entry.view.id } });
      return undefined;
    }
    return entry;
  };

  async function doLaunch(conversationId: string, entry: Held, via: LucyLaunchVia): Promise<LucyLaunchOutcome> {
    const proposalId = entry.view.id;
    // The level is read now, on the server. Whatever the card said when it was made does not decide.
    const level = deps.getAutonomy();
    const base = { proposalId, level, via, project: entry.view.project, launchKind: entry.kind };
    // The card shows the level it was made under. A looser level now means the card no longer tells the truth.
    if (LEVEL_RANK[level] > LEVEL_RANK[entry.view.level]) {
      const reason = 'The permission level changed since I made that card. Ask me again and I will prepare it.';
      record(conversationId, { ...base, event: 'refused', reason });
      return finish(conversationId, { outcome: 'refused', proposalId, reason });
    }
    const room = deps.checkRoom();
    if (room) {
      record(conversationId, { ...base, event: 'refused', reason: room });
      return finish(conversationId, { outcome: 'refused', proposalId, reason: room });
    }
    try {
      const result = await deps.launch(
        {
          prompt: entry.prompt,
          cwd: entry.cwd,
          ...(entry.agentType ? { agentType: entry.agentType } : {}),
          launchSource: 'api',
          launchActorId: LUCY_OPERATOR_ACTOR_ID,
        },
        {
          // Careful forces prompts on, Hands-off bypasses everything, Balanced leaves it to the install, as the Launch tab does.
          ...(level === 'careful' ? { bypassPermissions: false } : level === 'hands-off' ? { bypassPermissions: true } : {}),
          // An investigation reports; Kookr's usual "push, open the pull request and merge" delivery wording would contradict that.
          ...(entry.kind === 'investigation' ? { deliveryPolicy: 'ask-first' as const } : {}),
        },
      );
      const taskId = result.task.id;
      launchedFrom.set(taskId, conversationId);
      while (launchedFrom.size > MAX_REMEMBERED_TASKS) {
        const oldest = launchedFrom.keys().next().value;
        if (oldest === undefined) break;
        launchedFrom.delete(oldest);
      }
      record(conversationId, { ...base, event: 'launched', taskId });
      try {
        void Promise.resolve(deps.audit?.({ taskId, proposalId, level, via, project: entry.view.project, kind: entry.kind, queued: result.queued === true, duplicate: result.duplicate === true }))
          .catch((err: unknown) => warn(`audit failed: ${err instanceof Error ? err.message : String(err)}`));
      } catch (err) {
        warn(`audit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return finish(conversationId, {
        outcome: 'launched',
        proposalId,
        taskId,
        project: entry.view.project,
        ...(result.queued ? { queued: true } : {}),
        ...(result.duplicate ? { duplicate: true } : {}),
      });
    } catch (err) {
      warn(redactSpeechSecrets(`launch failed: ${err instanceof Error ? err.message : String(err)}`));
      // The error text may quote a path or a prompt: the operator is told only that it failed.
      const reason = 'Kookr could not start the task.';
      record(conversationId, { ...base, event: 'refused', reason });
      return finish(conversationId, { outcome: 'refused', proposalId, reason });
    }
  }

  async function confirm(conversationId: string, proposalId: string, via: LucyLaunchVia): Promise<LucyLaunchOutcome> {
    const present = held.get(conversationId);
    if (!present || present.view.id !== proposalId) return { outcome: 'unknown', proposalId };
    const entry = live(conversationId);
    if (!entry) return { outcome: 'expired', proposalId };
    // Taken out before launching, so Enter and a click together cannot launch it twice.
    drop(conversationId);
    return doLaunch(conversationId, entry, via);
  }

  /**
   * Hands-off: hold the launch until `view.launchesAt`, then launch. Aborting a running task is not built here,
   * so the cancel window comes before the launch. Called again when the read-back turns out to end later.
   */
  function armHandsOff(conversationId: string, entry: Held): void {
    if (entry.timer !== undefined) clearTimer(entry.timer);
    const proposalId = entry.view.id;
    const fire = (): void => {
      const current = held.get(conversationId);
      if (!current || current.view.id !== proposalId) return;
      const due = Math.max(current.view.launchesAt ?? 0, current.speakingUntil + HANDS_OFF_CANCEL_WINDOW_MS);
      if (now() < due) {
        // Her voice turned out to run longer: keep waiting until the window after it has passed.
        current.timer = setTimer(fire, due - now());
        return;
      }
      if (current.spoken && !current.heard) {
        // Nothing reported her voice as audible (slow or failed speech): the operator may not have heard it.
        // Wait a while longer, then drop the proposal rather than launch something unheard.
        if (now() < (current.view.launchesAt ?? 0) + HEARD_WAIT_MS) {
          current.timer = setTimer(fire, 1000);
          return;
        }
        drop(conversationId);
        record(conversationId, { event: 'dropped', proposalId, level: current.view.level, reason: 'read-back never heard' });
        finish(conversationId, { outcome: 'cancelled', proposalId });
        return;
      }
      drop(conversationId);
      if (deps.getAutonomy() === 'hands-off') {
        void doLaunch(conversationId, current, 'timer');
      } else {
        // The level was lowered during the window: the launch is not made, and the operator is told.
        record(conversationId, { event: 'cancelled', proposalId, level: deps.getAutonomy(), reason: 'level lowered during the window' });
        finish(conversationId, { outcome: 'cancelled', proposalId });
      }
    };
    entry.timer = setTimer(fire, Math.max(0, (entry.view.launchesAt ?? now()) - now()));
  }

  function decline(conversationId: string, proposalId: string): LucyLaunchOutcome {
    const entry = held.get(conversationId);
    if (!entry || entry.view.id !== proposalId) return { outcome: 'unknown', proposalId };
    drop(conversationId);
    record(conversationId, { event: 'declined', proposalId, level: entry.view.level });
    return finish(conversationId, { outcome: 'declined', proposalId });
  }

  function cancel(conversationId: string, proposalId: string): LucyLaunchOutcome {
    const entry = held.get(conversationId);
    if (!entry || entry.view.id !== proposalId) return { outcome: 'unknown', proposalId };
    drop(conversationId);
    record(conversationId, { event: 'cancelled', proposalId, level: entry.view.level });
    return finish(conversationId, { outcome: 'cancelled', proposalId });
  }

  return {
    async propose({ conversationId, operatorWords, spoken, signal }) {
      const words = operatorWords.map((w) => redactSpeechSecrets(w).slice(0, MAX_WORDS_CHARS)).filter((w) => w.trim()).slice(-MAX_OPERATOR_WORDS);
      const none = (say: string, why: string): LucyProposeResult => {
        record(conversationId, { event: 'no_proposal', reason: why });
        return { ok: false, say, why };
      };
      if (words.length === 0) return none('What would you like me to start?', 'no words');
      const projects = await deps.getProjects();
      if (projects.length === 0) return none('Kookr has no project I may launch in yet.', 'no projects');

      let reply: string;
      try {
        reply = await deps.writeSpec({ system: buildSpecWriterPrompt(projects), operatorWords: words, signal });
      } catch (err) {
        warn(redactSpeechSecrets(`could not write the task: ${err instanceof Error ? err.message : String(err)}`));
        return none('I could not prepare that launch just now. Please try again.', 'writer failed');
      }
      const draft = parseSpecDraft(reply);
      if (!draft) return none('I could not make a task out of that. Could you say it again?', 'unreadable draft');
      if ('ambiguous' in draft) return none(draft.ambiguous, 'ambiguous');

      const project = resolveProject(draft.project, projects);
      if (!project) return none('Which project is that for?', 'unknown project');
      // The same strict schema as the Telegram path: length caps, no extra fields, a known agent.
      const checked = TaskSpecSchema.safeParse({
        prompt: draft.description,
        cwd: project.cwd,
        ...(draft.agentType ? { agentType: draft.agentType } : {}),
      });
      if (!checked.success) return none('I could not make a clear task out of that. Could you say it again?', 'schema');
      if (checked.data.cwd !== project.cwd) return none('Which project is that for?', 'cwd mismatch');

      const level = deps.getAutonomy();
      const createdAt = now();
      const handsOff = level === 'hands-off';
      const description = checked.data.prompt;
      const readBack = buildReadBack(draft.kind, project.name, description, handsOff);
      const view: LucyLaunchProposalView = {
        id: newId(),
        kind: draft.kind,
        project: project.name,
        description,
        agentType: checked.data.agentType ?? 'default',
        asked: words[words.length - 1]!,
        readBack,
        expiresAt: createdAt + LAUNCH_PROPOSAL_TTL_MS,
        level,
        // The window runs from the end of the read-back; `noteSpeaking` moves it when the sentence turns out to be long.
        ...(handsOff ? { launchesAt: createdAt + estimateSpeechMs(readBack) + HANDS_OFF_CANCEL_WINDOW_MS } : {}),
      };
      // A new proposal replaces any old one, in this conversation or another: there is one operator and one card on
      // screen, so "go" can only mean the proposal that is shown.
      for (const other of [...held.keys()]) {
        const replaced = drop(other);
        if (!replaced) continue;
        record(other, { event: 'dropped', proposalId: replaced.view.id, reason: 'replaced' });
        announce({ type: 'lucy_launch', conversationId: other, outcome: { outcome: 'cancelled', proposalId: replaced.view.id } });
      }
      const entry: Held = {
        view,
        prompt: buildTaskPrompt(draft.kind, description),
        cwd: project.cwd,
        ...(checked.data.agentType ? { agentType: checked.data.agentType } : {}),
        kind: draft.kind,
        speakingUntil: createdAt + estimateSpeechMs(readBack),
        heard: false,
        spoken: spoken === true,
      };
      held.set(conversationId, entry);
      record(conversationId, {
        event: 'proposed',
        proposalId: view.id,
        level,
        project: project.name,
        launchKind: draft.kind,
        asked: view.asked,
        description: redactSpeechSecrets(description),
      });
      if (handsOff) armHandsOff(conversationId, entry);
      announce({ type: 'lucy_launch', conversationId, proposal: view });
      return { ok: true, proposal: view, say: readBack };
    },

    async handleReply(askedIn, text, context = {}) {
      // The one proposal on screen is answered from whichever conversation the operator speaks or types in.
      const conversationId = held.keys().next().value ?? askedIn;
      // A request to change her freedom is never carried out here, whatever is pending.
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      if (wordCount <= 14 && asksToChangeAutonomy(text)) {
        const entry = drop(conversationId);
        if (entry) {
          record(conversationId, { event: 'dropped', proposalId: entry.view.id, reason: 'autonomy request' });
          announce({ type: 'lucy_launch', conversationId, outcome: { outcome: 'cancelled', proposalId: entry.view.id } });
        }
        return { handled: true, say: AUTONOMY_IN_SETTINGS_SENTENCE };
      }

      const hadOne = held.get(conversationId);
      const entry = live(conversationId);
      if (!entry) {
        if (hadOne && classifyReply(text) === 'confirm') {
          return { handled: true, say: 'That launch timed out. Ask me again and I will prepare it.', outcome: { outcome: 'expired', proposalId: hadOne.view.id } };
        }
        return { handled: false };
      }

      // Spoken words that began while she was still reading the proposal could be her own voice.
      // They neither confirm nor drop it.
      // Saying no is always safe, so a decline is heard even then; a confirmation is not.
      if (context.input === 'voice' && classifyReply(text) !== 'decline') {
        const startedAt = context.speechStartedAt ?? now();
        if (context.overlapsReadBack === true || startedAt < entry.speakingUntil) {
          record(conversationId, { event: 'ignored', proposalId: entry.view.id, level: entry.view.level, via: 'spoken', reason: 'began during the read-back' });
          return { handled: true, say: '', ignored: true };
        }
      }

      const via: LucyLaunchVia = context.input === 'voice' ? 'spoken' : 'typed';
      switch (classifyReply(text)) {
        case 'confirm': {
          const outcome = await confirm(conversationId, entry.view.id, via);
          return { handled: true, say: sayOutcome(outcome), outcome };
        }
        case 'decline': {
          // While a hands-off launch is held, "cancel" stops it; on a card it declines it.
          const outcome = entry.view.launchesAt !== undefined ? cancel(conversationId, entry.view.id) : decline(conversationId, entry.view.id);
          return { handled: true, say: outcome.outcome === 'unknown' ? '' : 'Okay, I will not launch it.', outcome };
        }
        case 'other': {
          // Anything else drops the proposal and is handled as a new request.
          drop(conversationId);
          record(conversationId, { event: 'dropped', proposalId: entry.view.id, level: entry.view.level, reason: 'operator said something else' });
          announce({ type: 'lucy_launch', conversationId, outcome: { outcome: 'declined', proposalId: entry.view.id } });
          return { handled: false };
        }
      }
    },

    confirm,

    decline,
    cancel,

    closeConversation(conversationId) {
      const entry = drop(conversationId);
      if (!entry) return;
      record(conversationId, { event: 'dropped', proposalId: entry.view.id, level: entry.view.level, reason: 'conversation closed' });
      announce({ type: 'lucy_launch', conversationId, outcome: { outcome: 'cancelled', proposalId: entry.view.id } });
    },

    noteSpeaking(conversationId, until) {
      const entry = live(conversationId);
      if (!entry) return;
      entry.heard = true;
      entry.speakingUntil = Math.max(entry.speakingUntil, until + ECHO_TAIL_MS);
      if (entry.view.launchesAt === undefined) return;
      const launchesAt = entry.speakingUntil + HANDS_OFF_CANCEL_WINDOW_MS;
      if (launchesAt <= entry.view.launchesAt) return;
      entry.view = { ...entry.view, launchesAt, expiresAt: Math.max(entry.view.expiresAt, launchesAt + LAUNCH_PROPOSAL_TTL_MS) };
      armHandsOff(conversationId, entry);
      announce({ type: 'lucy_launch', conversationId, proposal: entry.view });
    },

    pending: (conversationId) => live(conversationId)?.view,

    onTaskOutcome(taskId, outcome, taskLabel) {
      const conversationId = launchedFrom.get(taskId);
      if (!conversationId) return;
      // The name was written by an agent or pasted by the operator: it gets the same cleaning as on the board.
      const spoken = taskLabel ? spokenTaskName(redactedTaskName(taskLabel)) : '';
      const label = spoken && !isGenericTaskName(spoken) ? ` "${spoken}"` : '';
      const text = reportSentence(outcome.kind, label);
      if (outcome.kind === 'needs_input') {
        // The same finding is admitted again and again while a task waits: say it once.
        const last = lastNeeds.get(taskId);
        if (last !== undefined && now() - last < NEEDS_INPUT_REPEAT_MS) return;
        lastNeeds.set(taskId, now());
        while (lastNeeds.size > MAX_REMEMBERED_TASKS) {
          const oldest = lastNeeds.keys().next().value;
          if (oldest === undefined) break;
          lastNeeds.delete(oldest);
        }
      } else {
        launchedFrom.delete(taskId);
        lastNeeds.delete(taskId);
      }
      reports.set(taskId, text);
      while (reports.size > MAX_REMEMBERED_TASKS) {
        const oldest = reports.keys().next().value;
        if (oldest === undefined) break;
        reports.delete(oldest);
      }
      announce({ type: 'lucy_launch', conversationId, report: { taskId, conversationId, kind: outcome.kind === 'needs_input' ? 'needs_input' : 'finished', text } });
    },

    reportText: (taskId) => reports.get(taskId),

    dispose() {
      for (const conversationId of [...held.keys()]) drop(conversationId);
    },
  };
}

function sayOutcome(outcome: LucyLaunchOutcome): string {
  switch (outcome.outcome) {
    case 'launched':
      if (outcome.duplicate) return 'That task is already running, so I did not start another.';
      return outcome.queued ? 'It is queued and will start when a slot is free. I will tell you when it finishes.' : 'Started. I will tell you when it finishes.';
    case 'refused':
      return outcome.reason;
    case 'expired':
      return 'That launch timed out. Ask me again and I will prepare it.';
    default:
      return '';
  }
}

function reportSentence(kind: 'completion_ready' | 'completed' | 'failed' | 'cancelled' | 'needs_input', label: string): string {
  switch (kind) {
    case 'completion_ready':
      return `The task I started${label} says it is done and is waiting for you to look at it.`;
    case 'completed':
      return `The task I started${label} has finished.`;
    case 'failed':
      return `The task I started${label} failed.`;
    case 'cancelled':
      return `The task I started${label} was cancelled.`;
    case 'needs_input':
      return `The task I started${label} needs you.`;
  }
}

