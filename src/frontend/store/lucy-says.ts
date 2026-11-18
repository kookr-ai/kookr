/**
 * The lines Lucy writes on her own about tasks she did not launch (`lucy_says`): a task failed,
 * went quiet, lost contact, went over its budget, or says it is finished and wants a review. The
 * kind is not checked here: a line of a kind this bundle does not know yet is still written.
 *
 * The server decides what is worth a line and words it; this store only passes each line on, once,
 * to whoever listens. The avatar panel listens and writes it into her thread
 * (`avatar/useLucySays.ts`); with the panel off nobody listens and the line is dropped, like the
 * other things she says on her own. Nothing is kept: the server never sends a line again, so there
 * is nothing to converge on after a reload.
 */
import type { LucySaysMessage } from '../../shared/contracts/lucy-says.js';

/** How many message ids are remembered, to write a line that arrives twice only once. */
const MAX_SEEN = 100;

const listeners = new Set<(message: LucySaysMessage) => void>();
const seen = new Set<string>();

/** Apply a `lucy_says` socket message. A malformed one, or one already received, is ignored. */
export function handleLucySays(message: LucySaysMessage): void {
  if (typeof message.id !== 'string' || !message.id || typeof message.text !== 'string' || !message.text.trim()) return;
  if (seen.has(message.id)) return;
  seen.add(message.id);
  if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value as string);
  const taskIds = Array.isArray(message.taskIds) ? message.taskIds.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  for (const listener of listeners) listener({ ...message, taskIds });
}

/** A line arrived. Returns the unsubscribe function. */
export function onLucySays(listener: (message: LucySaysMessage) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function __resetLucySaysForTests(): void {
  listeners.clear();
  seen.clear();
}
