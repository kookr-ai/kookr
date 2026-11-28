/**
 * Interrupted tasks: ask the operator before resuming them (issue #4215).
 *
 * When a host crash or reboot kills running tasks, startup recovery used to
 * relaunch them at once and silently. Under the `ask` policy it parks them
 * instead: each task stays `terminated` (no capacity, no reaper acts on it)
 * and is recorded here in one durable batch. The batch raises one question
 * ("N tasks were interrupted: resume?") on every operator channel, and the
 * answer, or the deadline passing with no answer, decides what happens:
 *
 *  - `resume`:     tasks with a recoverable conversation continue it (reopen →
 *                  `claude --resume`); tasks without one stay stopped.
 *  - `resume_all`: as `resume`, and the tasks without a conversation restart
 *                  from their original prompt.
 *  - `leave`:      nothing is relaunched.
 *
 * The deadline always means `resume`, never `resume_all`: a restart from the
 * original prompt re-grants whatever that prompt authorized (a merge, say),
 * which the operator may have withdrawn since, so it needs an explicit yes.
 *
 * The batch file survives a restart: `start()` re-arms a pending batch, or
 * decides it at once when its deadline passed while the server was down. With
 * automatic relaunch off (`KOOKR_AUTO_RELAUNCH=false`), `start()` leaves such a
 * batch stopped instead, unless the operator already answered it.
 */
import { randomBytes } from 'node:crypto';
import { atomicWriteFile, readJsonFile } from '../../core/persistence-utils.js';

/** Whether the task would continue its conversation or restart from its prompt. */
export type InterruptedTaskMode = 'resume' | 'fresh';

export interface InterruptedTaskEntry {
  taskId: string;
  name: string;
  mode: InterruptedTaskMode;
  /** Why a `fresh` task cannot resume its conversation. */
  reason?: string;
  /**
   * The task as it was when chosen for parking: set by the caller when it chose the task, else
   * stamped by the service when parked. A decision acts on the task only while it
   * is still exactly this: if the operator acknowledged, cancelled or relaunched it meanwhile (even a
   * relaunch that has since ended again), it is skipped rather than relaunched behind their back.
   */
  parkedAs?: InterruptedTaskSnapshot;
}

/** What identifies a parked task's state: its status and how many sessions it has had. */
export interface InterruptedTaskSnapshot {
  status: string;
  sessions: number;
}

export type InterruptedBatchChoice = 'resume' | 'resume_all' | 'leave';

/**
 * Who decided a batch. `policy`: left stopped at start-up because automatic relaunch is off
 * (`KOOKR_AUTO_RELAUNCH=false`, issue #4295).
 */
export type InterruptedBatchDecisionBy = 'operator' | 'timeout' | 'policy';

export interface InterruptedTaskOutcome {
  taskId: string;
  outcome: 'resumed' | 'restarted' | 'left_stopped' | 'skipped' | 'failed';
  detail?: string;
}

export interface InterruptedBatch {
  id: string;
  /** `restart`: parked by startup recovery. `operator`: raised by `kookr interrupted ask`. */
  source: 'restart' | 'operator';
  createdAt: number;
  deadlineAt: number;
  state: 'pending' | 'decided';
  tasks: InterruptedTaskEntry[];
  /** The operator question raised for this batch, when one could be raised. */
  askId?: string;
  decision?: {
    choice: InterruptedBatchChoice;
    by: InterruptedBatchDecisionBy;
    at: number;
    outcomes: InterruptedTaskOutcome[];
    /**
     * Present while the decision is still being applied, cleared once every task has its outcome.
     * A process that dies part-way leaves it set, and the next `start()` finishes applying the same
     * choice to the tasks without an outcome (issue #4294). `fromAsk`: decided by answering the question.
     */
    applying?: { fromAsk: boolean };
  };
}

interface InterruptedTasksFile {
  batches: InterruptedBatch[];
}

/** Decided batches kept in the file for `kookr interrupted status`. */
const KEEP_DECIDED_BATCHES = 20;

/** The one operator question per batch, on whatever channels the host has. */
export interface InterruptedTasksAskPort {
  /** Raise the question for a pending batch; returns its id, or why it could not be raised. */
  raise(batch: InterruptedBatch): Promise<{ askId: string } | { error: string }>;
  /**
   * Close a still-open question once the batch was decided another way. `expiryOutcome` is given when
   * nobody answered and the default was applied: the question then ends as expired, with that sentence
   * for its card, instead of being withdrawn.
   */
  close(askId: string, outcomeText: string, expiryOutcome?: string): Promise<void>;
  /**
   * The choice an already-answered question stands for, else undefined. Used at start-up for an
   * answer given while this service could not yet hear it (during a restart).
   */
  answerOf?(askId: string): InterruptedBatchChoice | undefined;
}

export interface InterruptedTasksServiceDeps {
  filePath: string;
  /** How long the operator has to answer before `resume` is applied. */
  timeoutMs: number;
  /**
   * Reopen a terminal task (the dashboard's Reopen). It continues the task's
   * conversation when one is recoverable, else restarts from the prompt.
   */
  reopenTask: (taskId: string) => Promise<{ ok: boolean; mode?: string; detail?: string }>;
  /** The task's current status and session count, or undefined when the task is gone. */
  taskSnapshot: (taskId: string) => InterruptedTaskSnapshot | undefined;
  /**
   * Whether the task's conversation can still be resumed now. Checked before a `resume` decision
   * relaunches a task parked as resumable: if its conversation vanished meanwhile, Reopen would
   * restart it from the prompt, which only an explicit `resume_all` may do. Absent: not re-checked.
   */
  canResume?: (taskId: string) => Promise<boolean>;
  /**
   * A running or queued task with the same prompt, else undefined. Checked before a decision
   * relaunches a task: one started meanwhile (a schedule tick, say) must not get a twin (issue #4294).
   */
  liveDuplicateOf?: (taskId: string) => { taskId: string } | undefined;
  ask?: InterruptedTasksAskPort;
  /**
   * `false` when automatic relaunch is off (`KOOKR_AUTO_RELAUNCH=false`): a batch an earlier process
   * left pending is then left stopped at {@link InterruptedTasksService.start} instead of being
   * resumed at its deadline. An answer the operator already gave is still applied. Default `true`.
   */
  autoResume?: boolean;
  /** Told about every decided batch. */
  onDecided?: (batch: InterruptedBatch) => void;
  now?: () => number;
  log?: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export class InterruptedTasksService {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private file: InterruptedTasksFile = { batches: [] };
  private timer: NodeJS.Timeout | null = null;
  /** Serializes every read-modify-write of the batch file. */
  private chain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(private readonly deps: InterruptedTasksServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((message) => console.log(message));
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /**
   * Read the batch file. Every operation waits for it, so a batch an earlier process left pending is
   * never overwritten or missed, whatever runs first; call it early anyway, before the routes serve.
   */
  load(): Promise<void> {
    return this.serialize(() => this.ensureLoaded());
  }

  /**
   * Take up a batch an earlier process left pending, once the operator channels are up: apply an
   * answer given while this process could not hear it, ask the question if it was never asked, and
   * arm the deadline (deciding at once when it passed while Kookr was down).
   */
  start(): Promise<void> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      // A decision an earlier process died while applying: finish it with the choice it recorded.
      for (const unfinished of this.file.batches.filter((b) => b.decision?.applying)) {
        this.log(`[interrupted-tasks] finishing the decision on batch ${unfinished.id} that a restart interrupted`);
        await this.applyDecision(unfinished);
      }
      const batch = this.pending();
      if (!batch) return undefined;
      const answered = batch.askId !== undefined ? this.deps.ask?.answerOf?.(batch.askId) : undefined;
      if (answered) return { batchId: batch.id, choice: answered, by: 'operator' as const };
      // Automatic relaunch is off: nobody answering must not relaunch anything, so the batch is
      // settled now as "leave stopped" rather than re-armed for a deadline that would resume it.
      if (this.deps.autoResume === false) return { batchId: batch.id, choice: 'leave' as const, by: 'policy' as const };
      if (batch.askId === undefined && batch.deadlineAt > this.now()) await this.raiseAsk(batch);
      return undefined;
    }).then(async (answered) => {
      if (answered) await this.decide(answered.batchId, answered.choice, answered.by, { fromAsk: answered.by === 'operator' });
      this.armOrExpire();
    });
  }

  stop(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** The pending batch, if any. At most one is pending at a time. */
  pending(): InterruptedBatch | undefined {
    return this.file.batches.find((b) => b.state === 'pending');
  }

  list(): InterruptedBatch[] {
    return this.file.batches.map((b) => structuredClone(b));
  }

  /**
   * Park interrupted tasks and ask the operator. A batch already pending
   * absorbs the new tasks (a second restart before the answer), its question
   * is raised again listing all of them, and its deadline restarts.
   */
  park(entries: InterruptedTaskEntry[], source: InterruptedBatch['source']): Promise<InterruptedBatch | undefined> {
    if (entries.length === 0) return Promise.resolve(undefined);
    return this.serialize(async () => {
      await this.ensureLoaded();
      const now = this.now();
      // Keep a baseline the caller took when it chose the task (crash recovery does, before the
      // operator could touch it); otherwise take it now.
      const stamped = entries.map((entry) => ({ ...entry, parkedAs: entry.parkedAs ?? this.deps.taskSnapshot(entry.taskId) }));
      let batch = this.pending();
      const previousAskId = batch?.askId;
      if (batch) {
        const known = new Set(batch.tasks.map((t) => t.taskId));
        for (const entry of stamped) {
          if (known.has(entry.taskId)) continue;
          known.add(entry.taskId);
          batch.tasks.push(entry);
        }
        batch.deadlineAt = now + this.deps.timeoutMs;
        delete batch.askId;
      } else {
        batch = {
          id: randomBytes(6).toString('hex'),
          source,
          createdAt: now,
          deadlineAt: now + this.deps.timeoutMs,
          state: 'pending',
          tasks: dedupeEntries(stamped),
        };
        this.file.batches.push(batch);
      }
      await this.persist();
      if (previousAskId) await this.closeAsk(previousAskId, 'Replaced by a newer question listing more interrupted tasks.');
      await this.raiseAsk(batch);
      this.log(
        `[interrupted-tasks] parked ${batch.tasks.length} interrupted task(s) in batch ${batch.id}; ` +
          `resuming at ${new Date(batch.deadlineAt).toISOString()} unless the operator decides first`,
      );
      return structuredClone(batch);
    }).then((batch) => {
      this.armOrExpire();
      return batch;
    });
  }

  /** The operator answered the batch's question. Unknown or already-decided asks are ignored. */
  answerFromAsk(askId: string, choice: InterruptedBatchChoice): Promise<InterruptedBatch | undefined> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      return this.file.batches.find((b) => b.askId === askId)?.id;
    }).then((batchId) => (batchId ? this.decide(batchId, choice, 'operator', { fromAsk: true }) : undefined));
  }

  /**
   * Apply a decision to a pending batch, once: a second decision (the timer
   * racing an answer, two channels answering) finds it decided and does nothing.
   */
  decide(
    batchId: string,
    choice: InterruptedBatchChoice,
    by: InterruptedBatchDecisionBy,
    opts: { fromAsk?: boolean } = {},
  ): Promise<InterruptedBatch | undefined> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const batch = this.file.batches.find((b) => b.id === batchId);
      if (!batch || batch.state !== 'pending') return undefined;
      batch.state = 'decided';
      batch.decision = { choice, by, at: this.now(), outcomes: [], applying: { fromAsk: opts.fromAsk === true } };
      // Durable before any relaunch: a crash mid-way must not decide (and relaunch) twice. The
      // `applying` mark lets the next start() finish the tasks a crash left without an outcome.
      await this.persist();
      return this.applyDecision(batch);
    }).then((batch) => {
      this.armOrExpire();
      return batch;
    });
  }

  /**
   * Apply a recorded decision to every task without an outcome yet, persisting each outcome as it
   * lands, then close the question and tell the listener. Runs inside `serialize`.
   */
  private async applyDecision(batch: InterruptedBatch): Promise<InterruptedBatch> {
    const decision = batch.decision!;
    const fromAsk = decision.applying?.fromAsk === true;
    const done = new Set(decision.outcomes.map((o) => o.taskId));
    for (const entry of batch.tasks) {
      if (done.has(entry.taskId)) continue;
      decision.outcomes.push(await this.apply(entry, decision.choice, decision.by));
      await this.persist();
    }
    delete decision.applying;
    const { choice, by } = decision;
    this.pruneDecided();
    await this.persist();
    // Decided any way but by answering the question (the deadline, the CLI): close the question,
    // so Telegram, the dashboard and Lucy stop asking something already settled.
    if (batch.askId && !fromAsk) {
      await (by === 'timeout'
        ? this.closeAsk(batch.askId, `No answer in time: ${summarizeOutcomes(batch)}.`, expiryOutcomeOf(batch))
        : by === 'policy'
          ? this.closeAsk(batch.askId, `Automatic relaunch is off (KOOKR_AUTO_RELAUNCH=false), so the tasks were left stopped: ${summarizeOutcomes(batch)}. Reopen them from the dashboard to resume them.`)
          : this.closeAsk(batch.askId, `Decided from the terminal (${choice}): ${summarizeOutcomes(batch)}.`));
    }
    this.log(`[interrupted-tasks] batch ${batch.id} decided (${choice}, by ${by}): ${summarizeOutcomes(batch)}`);
    try {
      this.deps.onDecided?.(structuredClone(batch));
    } catch (err) {
      this.log(`[interrupted-tasks] onDecided listener failed: ${errorText(err)}`);
    }
    return structuredClone(batch);
  }

  private async apply(entry: InterruptedTaskEntry, choice: InterruptedBatchChoice, by: InterruptedBatchDecisionBy): Promise<InterruptedTaskOutcome> {
    const { taskId } = entry;
    if (choice === 'leave') return { taskId, outcome: 'left_stopped', detail: by === 'policy' ? 'automatic relaunch is off (KOOKR_AUTO_RELAUNCH=false)' : 'operator chose to leave it stopped' };
    if (entry.mode === 'fresh' && choice !== 'resume_all') {
      return { taskId, outcome: 'left_stopped', detail: `no conversation to resume (${entry.reason ?? 'unknown reason'})` };
    }
    const now = this.deps.taskSnapshot(taskId);
    if (!now) return { taskId, outcome: 'skipped', detail: 'task no longer exists' };
    if (entry.parkedAs && (now.status !== entry.parkedAs.status || now.sessions !== entry.parkedAs.sessions)) {
      return { taskId, outcome: 'skipped', detail: 'task changed since it was parked (relaunched, acknowledged or cancelled)' };
    }
    if (choice === 'resume' && this.deps.canResume && !(await this.deps.canResume(taskId).catch(() => false))) {
      return { taskId, outcome: 'left_stopped', detail: 'its conversation can no longer be resumed' };
    }
    const duplicate = this.deps.liveDuplicateOf?.(taskId);
    if (duplicate) {
      return { taskId, outcome: 'skipped', detail: `a task with the same prompt is already running or queued (${duplicate.taskId})` };
    }
    try {
      const result = await this.deps.reopenTask(taskId);
      if (!result.ok) return { taskId, outcome: 'failed', detail: result.detail ?? 'reopen refused' };
      return {
        taskId,
        outcome: result.mode === 'resume' ? 'resumed' : 'restarted',
        ...(result.detail ? { detail: result.detail } : {}),
      };
    } catch (err) {
      return { taskId, outcome: 'failed', detail: errorText(err) };
    }
  }

  private armOrExpire(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const batch = this.pending();
    if (!batch) return;
    const wait = Math.max(0, batch.deadlineAt - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.decide(batch.id, 'resume', 'timeout').catch((err: unknown) => {
        this.log(`[interrupted-tasks] timeout decision for batch ${batch.id} failed: ${errorText(err)}`);
      });
    }, wait);
    this.timer.unref?.();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const loaded = await readJsonFile<InterruptedTasksFile | undefined>(this.deps.filePath, undefined, {
      quarantineCorrupt: true,
      warningPrefix: 'interrupted-tasks',
    }).catch((err: unknown) => {
      this.log(`[interrupted-tasks] could not read ${this.deps.filePath}: ${errorText(err)}`);
      return undefined;
    });
    this.file = loaded && Array.isArray(loaded.batches) ? loaded : { batches: [] };
    this.loaded = true;
  }

  private async raiseAsk(batch: InterruptedBatch): Promise<void> {
    if (!this.deps.ask) {
      this.log(`[interrupted-tasks] no operator channel (Telegram not configured): batch ${batch.id} is decided at its deadline`);
      return;
    }
    const raised = await this.deps.ask.raise(batch).catch((err: unknown) => ({ error: errorText(err) }));
    if ('askId' in raised) {
      batch.askId = raised.askId;
      await this.persist();
    } else {
      this.log(`[interrupted-tasks] could not ask the operator about batch ${batch.id}: ${raised.error}; it is decided at its deadline`);
    }
  }

  private async closeAsk(askId: string, text: string, expiryOutcome?: string): Promise<void> {
    try {
      await this.deps.ask?.close(askId, text, expiryOutcome);
    } catch (err) {
      this.log(`[interrupted-tasks] could not close question ${askId}: ${errorText(err)}`);
    }
  }

  private pruneDecided(): void {
    const decided = this.file.batches.filter((b) => b.state === 'decided');
    const drop = new Set(decided.slice(0, Math.max(0, decided.length - KEEP_DECIDED_BATCHES)));
    this.file.batches = this.file.batches.filter((b) => !drop.has(b));
  }

  private persist(): Promise<void> {
    return atomicWriteFile(this.deps.filePath, `${JSON.stringify(this.file, null, 2)}\n`);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export interface InterruptedTasksPolicy {
  /** `ask`: park interrupted tasks and ask the operator. `auto`: relaunch them at once (the old behaviour). */
  mode: 'ask' | 'auto';
  timeoutMs: number;
  /**
   * `false` under `KOOKR_AUTO_RELAUNCH=false`: crash recovery parks nothing, and a batch an earlier
   * process left pending is left stopped at start-up instead of resuming at its deadline.
   */
  autoRelaunch: boolean;
}

const DEFAULT_TIMEOUT_MINUTES = 10;

/**
 * `KOOKR_INTERRUPTED_TASKS` (`ask`, the default, or `auto`) and
 * `KOOKR_INTERRUPTED_TASKS_TIMEOUT_MIN` (1..1440, default 10). `KOOKR_AUTO_RELAUNCH=false`
 * still turns crash recovery off altogether, before either applies, and also stops a batch an
 * earlier process left pending from resuming (`autoRelaunch`).
 */
export function resolveInterruptedTasksPolicy(env: NodeJS.ProcessEnv): InterruptedTasksPolicy {
  const mode = env.KOOKR_INTERRUPTED_TASKS?.trim().toLowerCase() === 'auto' ? 'auto' : 'ask';
  const raw = Number(env.KOOKR_INTERRUPTED_TASKS_TIMEOUT_MIN);
  const minutes = Number.isFinite(raw) && raw >= 1 && raw <= 1440 ? raw : DEFAULT_TIMEOUT_MINUTES;
  return { mode, timeoutMs: minutes * 60_000, autoRelaunch: env.KOOKR_AUTO_RELAUNCH !== 'false' };
}

function dedupeEntries(entries: InterruptedTaskEntry[]): InterruptedTaskEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.taskId) ? false : (seen.add(e.taskId), true)));
}

/** "2 resumed, 1 left stopped" — for logs and the closing note on the question. */
export function summarizeOutcomes(batch: InterruptedBatch): string {
  const counts = new Map<string, number>();
  for (const o of batch.decision?.outcomes ?? []) counts.set(o.outcome, (counts.get(o.outcome) ?? 0) + 1);
  if (counts.size === 0) return 'nothing to do';
  return [...counts].map(([outcome, n]) => `${n} ${outcome.replace('_', ' ')}`).join(', ');
}

/**
 * What the question's card says when nobody answered and the default was applied: what really
 * happened to the tasks, not what was meant to happen. Kookr's own words; no task name or text.
 */
export function expiryOutcomeOf(batch: InterruptedBatch): string {
  const outcomes = batch.decision?.outcomes ?? [];
  const total = outcomes.length;
  const done = outcomes.filter((o) => o.outcome === 'resumed' || o.outcome === 'restarted').length;
  const tasks = (n: number): string => (n === 1 ? 'the task' : `the ${n} tasks`);
  if (total === 0) return 'No answer, and no task was left to resume.';
  if (done === total) return `No answer, so ${tasks(total)} ${total === 1 ? 'was' : 'were'} resumed.`;
  if (done === 0) return (total === 1 ? 'No answer, but the task was not resumed.' : `No answer, but none of the ${total} tasks were resumed.`);
  return `No answer, so ${done} of the ${total} tasks ${done === 1 ? 'was' : 'were'} resumed and the rest stayed stopped.`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
