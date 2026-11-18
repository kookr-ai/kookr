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
 * decides it at once when its deadline passed while the server was down.
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
}

export type InterruptedBatchChoice = 'resume' | 'resume_all' | 'leave';

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
    by: 'operator' | 'timeout';
    at: number;
    outcomes: InterruptedTaskOutcome[];
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
  /** Close a still-open question once the batch was decided another way. */
  close(askId: string, outcomeText: string): Promise<void>;
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
  /** True while the task is still terminal, i.e. nobody relaunched it meanwhile. */
  isTaskTerminal: (taskId: string) => boolean;
  ask?: InterruptedTasksAskPort;
  /** Told about every decided batch (log line, interaction log, alert). */
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

  constructor(private readonly deps: InterruptedTasksServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((message) => console.log(message));
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /**
   * Load the batch file and re-arm (or decide) a batch left pending by an earlier process. A pending
   * batch with no question yet (its question could not be raised, or was lost) gets one now.
   */
  start(): Promise<void> {
    return this.serialize(async () => {
      const loaded = await readJsonFile<InterruptedTasksFile | undefined>(this.deps.filePath, undefined, {
        quarantineCorrupt: true,
        warningPrefix: 'interrupted-tasks',
      }).catch((err: unknown) => {
        this.log(`[interrupted-tasks] could not read ${this.deps.filePath}: ${errorText(err)}`);
        return undefined;
      });
      this.file = loaded && Array.isArray(loaded.batches) ? loaded : { batches: [] };
      const batch = this.pending();
      if (batch && batch.askId === undefined && batch.deadlineAt > this.now()) await this.raiseAsk(batch);
    }).then(() => this.armOrExpire());
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
      const now = this.now();
      let batch = this.pending();
      const previousAskId = batch?.askId;
      if (batch) {
        const known = new Set(batch.tasks.map((t) => t.taskId));
        for (const entry of entries) if (!known.has(entry.taskId)) batch.tasks.push(entry);
        batch.deadlineAt = now + this.deps.timeoutMs;
        delete batch.askId;
      } else {
        batch = {
          id: randomBytes(6).toString('hex'),
          source,
          createdAt: now,
          deadlineAt: now + this.deps.timeoutMs,
          state: 'pending',
          tasks: dedupeEntries(entries),
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
    const batch = this.file.batches.find((b) => b.askId === askId);
    if (!batch) return Promise.resolve(undefined);
    return this.decide(batch.id, choice, 'operator');
  }

  /**
   * Apply a decision to a pending batch, once: a second decision (the timer
   * racing an answer, two channels answering) finds it decided and does nothing.
   */
  decide(batchId: string, choice: InterruptedBatchChoice, by: 'operator' | 'timeout'): Promise<InterruptedBatch | undefined> {
    return this.serialize(async () => {
      const batch = this.file.batches.find((b) => b.id === batchId);
      if (!batch || batch.state !== 'pending') return undefined;
      batch.state = 'decided';
      batch.decision = { choice, by, at: this.now(), outcomes: [] };
      // Durable before any relaunch: a crash mid-way must not decide (and relaunch) twice.
      await this.persist();
      for (const entry of batch.tasks) {
        batch.decision.outcomes.push(await this.apply(entry, choice));
      }
      this.pruneDecided();
      await this.persist();
      if (by === 'timeout' && batch.askId) {
        await this.closeAsk(batch.askId, `No answer in time: ${summarizeOutcomes(batch)}.`);
      }
      this.log(`[interrupted-tasks] batch ${batch.id} decided (${choice}, by ${by}): ${summarizeOutcomes(batch)}`);
      try {
        this.deps.onDecided?.(structuredClone(batch));
      } catch (err) {
        this.log(`[interrupted-tasks] onDecided listener failed: ${errorText(err)}`);
      }
      return structuredClone(batch);
    }).then((batch) => {
      this.armOrExpire();
      return batch;
    });
  }

  private async apply(entry: InterruptedTaskEntry, choice: InterruptedBatchChoice): Promise<InterruptedTaskOutcome> {
    const { taskId } = entry;
    if (choice === 'leave') return { taskId, outcome: 'left_stopped', detail: 'operator chose to leave it stopped' };
    if (entry.mode === 'fresh' && choice !== 'resume_all') {
      return { taskId, outcome: 'left_stopped', detail: `no conversation to resume (${entry.reason ?? 'unknown reason'})` };
    }
    if (!this.deps.isTaskTerminal(taskId)) {
      return { taskId, outcome: 'skipped', detail: 'task is no longer stopped (already relaunched or removed)' };
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

  private async closeAsk(askId: string, text: string): Promise<void> {
    try {
      await this.deps.ask?.close(askId, text);
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
}

const DEFAULT_TIMEOUT_MINUTES = 10;

/**
 * `KOOKR_INTERRUPTED_TASKS` (`ask`, the default, or `auto`) and
 * `KOOKR_INTERRUPTED_TASKS_TIMEOUT_MIN` (1..1440, default 10). `KOOKR_AUTO_RELAUNCH=false`
 * still turns crash recovery off altogether, before either applies.
 */
export function resolveInterruptedTasksPolicy(env: NodeJS.ProcessEnv): InterruptedTasksPolicy {
  const mode = env.KOOKR_INTERRUPTED_TASKS?.trim().toLowerCase() === 'auto' ? 'auto' : 'ask';
  const raw = Number(env.KOOKR_INTERRUPTED_TASKS_TIMEOUT_MIN);
  const minutes = Number.isFinite(raw) && raw >= 1 && raw <= 1440 ? raw : DEFAULT_TIMEOUT_MINUTES;
  return { mode, timeoutMs: minutes * 60_000 };
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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
