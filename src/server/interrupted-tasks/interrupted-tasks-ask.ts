/**
 * The operator question for a batch of interrupted tasks (issue #4215), posed
 * through the ask service as a system ask ("Kookr asks"), so it reaches
 * Telegram, the dashboard card and Lucy like any other question.
 */
import { ASK_LIMITS, type AskRecord, type CreateAskResult, type CreateSystemAskInput } from '../../shared/contracts/asks.js';
import type { InterruptedBatch, InterruptedBatchChoice, InterruptedTasksAskPort } from './interrupted-tasks-service.js';

/** The `system` name the batch's asks carry. */
export const INTERRUPTED_TASKS_SYSTEM = 'interrupted-tasks';

/** Option labels, in the order the question offers them. */
export const INTERRUPTED_CHOICE_LABELS: Record<InterruptedBatchChoice, string> = {
  resume: 'Resume',
  resume_all: 'Resume + restart the rest',
  leave: 'Leave stopped',
};

export interface InterruptedTasksAskService {
  createSystem(input: CreateSystemAskInput): Promise<CreateAskResult>;
  cancel(id: string, note?: string): Promise<unknown>;
  /** Close the question as expired, recording what Kookr did when nobody answered. */
  expireWithOutcome(id: string, outcome: string): Promise<unknown>;
  all(): AskRecord[];
}

export function createInterruptedTasksAskPort(
  asks: InterruptedTasksAskService,
  now: () => number = Date.now,
): InterruptedTasksAskPort {
  return {
    async raise(batch) {
      const { question, context, options } = buildInterruptedTasksQuestion(batch, now());
      const timeoutSec = Math.min(
        ASK_LIMITS.maxTimeoutSec,
        Math.max(ASK_LIMITS.minTimeoutSec, Math.ceil((batch.deadlineAt - now()) / 1000)),
      );
      const result = await asks.createSystem({
        system: INTERRUPTED_TASKS_SYSTEM,
        question,
        context,
        options,
        allowText: false,
        timeoutSec,
        // When nobody answers, the batch's deadline resumes the tasks that have a conversation; the card says so.
        ...(batch.tasks.some((t) => t.mode === 'resume') ? { defaultOption: INTERRUPTED_CHOICE_LABELS.resume } : {}),
      });
      if (result.ok) return { askId: result.ask.id };
      return { error: 'message' in result.error && result.error.message ? `${result.error.code}: ${result.error.message}` : result.error.code };
    },
    async close(askId, outcomeText, expiryOutcome) {
      if (expiryOutcome !== undefined) await asks.expireWithOutcome(askId, expiryOutcome);
      else await asks.cancel(askId, outcomeText);
    },
    answerOf(askId) {
      const ask = asks.all().find((a) => a.id === askId);
      return ask ? interruptedChoiceFromAsk(ask) : undefined;
    },
  };
}

/** The question, its context (one line per task) and the options offered. */
export function buildInterruptedTasksQuestion(
  batch: Pick<InterruptedBatch, 'tasks' | 'deadlineAt' | 'source'>,
  nowMs: number,
): { question: string; context: string; options: string[] } {
  const resumable = batch.tasks.filter((t) => t.mode === 'resume');
  const fresh = batch.tasks.filter((t) => t.mode === 'fresh');
  const n = batch.tasks.length;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const why = batch.source === 'restart' ? 'Kookr restarted and found' : 'You asked about';
  const question = `${why} ${plural(n, 'interrupted task')}. Resume ${n === 1 ? 'it' : 'them'}?`;

  const minutes = Math.max(1, Math.round((batch.deadlineAt - nowMs) / 60_000));
  const lines: string[] = [];
  for (const t of resumable) lines.push(`• ${t.name}: continues its conversation`);
  for (const t of fresh) lines.push(`• ${t.name}: no conversation to resume (${t.reason ?? 'unknown'}), restarts from its prompt only on "${INTERRUPTED_CHOICE_LABELS.resume_all}"`);
  lines.push('');
  lines.push(
    resumable.length > 0
      ? `With no answer in ${minutes} min, ${resumable.length === 1 ? 'the task with a conversation resumes' : `the ${resumable.length} tasks with a conversation resume`}.`
      : `With no answer in ${minutes} min, nothing is restarted.`,
  );
  const options = [INTERRUPTED_CHOICE_LABELS.resume];
  if (fresh.length > 0) options.push(INTERRUPTED_CHOICE_LABELS.resume_all);
  options.push(INTERRUPTED_CHOICE_LABELS.leave);
  return { question, context: fitContext(lines), options };
}

/** The batch decision an answered ask stands for, or undefined when it is not one of ours. */
export function interruptedChoiceFromAsk(ask: Pick<AskRecord, 'system' | 'state' | 'answer'>): InterruptedBatchChoice | undefined {
  if (ask.system !== INTERRUPTED_TASKS_SYSTEM || ask.state !== 'answered' || ask.answer?.kind !== 'option') return undefined;
  const label = ask.answer.label;
  const entry = (Object.entries(INTERRUPTED_CHOICE_LABELS) as Array<[InterruptedBatchChoice, string]>).find(([, l]) => l === label);
  return entry?.[0];
}

/** Keep the context within the ask limit, dropping task lines from the middle with a count. */
function fitContext(lines: string[]): string {
  const text = lines.join('\n');
  if (text.length <= ASK_LIMITS.maxContextChars) return text;
  const footer = lines.slice(-2);
  const tasks = lines.slice(0, -2);
  const kept: string[] = [];
  let used = footer.join('\n').length + 40;
  for (const line of tasks) {
    if (used + line.length + 1 > ASK_LIMITS.maxContextChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  return [...kept, `• … and ${tasks.length - kept.length} more`, ...footer].join('\n');
}
