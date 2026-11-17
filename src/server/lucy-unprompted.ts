/**
 * The server's record of what Lucy said or wrote to the operator without being asked (issue #4143):
 * a permission notice, a task's question she read out, a line about a task that failed or went quiet,
 * the report of a task she launched.
 *
 * There is one record for the whole server, not one per conversation. A notice is said to the
 * operator, not to a conversation: the operator who hears it in one tab may answer by typing in
 * another, or by voice, and several conversations are alive at once (one typed per browser, one per
 * Talk connection). Each turn of any conversation reads this record and shows it to the model next to
 * the board (`core/lucy-operator/unprompted.ts`); nothing is copied into a conversation's history.
 *
 * It is small on purpose: at most {@link MAX_UNPROMPTED_ITEMS} items, none older than
 * {@link MAX_UNPROMPTED_AGE_MS}, and an item goes as soon as what it was about is over (the prompt was
 * answered, the question closed), so a later "make it proceed" cannot point at something already
 * dealt with. It lives in process memory and is empty after a restart.
 */

import { MAX_UNPROMPTED_AGE_MS, MAX_UNPROMPTED_ITEMS, type LucyUnpromptedSaid } from '../core/lucy-operator/unprompted.js';

export interface LucyUnpromptedEntry {
  /**
   * What the item is, so the same thing recorded twice (a clip fetched again, a question both read
   * by Talk and fetched as a clip) is one item: `permission:<notice id>`, `ask:<question id>`,
   * `says:<line id>`, `launch:<task id>`.
   */
  key: string;
  /** The sentence the server wrote. It may quote a task name or a task's question. */
  text: string;
  tasks: ReadonlyArray<{ id: string; name?: string }>;
  /** Asked on every read; false drops the item (the prompt was answered, the question closed). Absent: only its age ends it. */
  stillOpen?: () => boolean;
  /**
   * A conversation that already holds this sentence in its own history (Talk read the question out
   * in it and noted it, `noteUnprompted`). That conversation is not shown the item a second time.
   */
  inConversation?: string;
}

/** An item as a turn reads it. `inHistory`: this conversation already has it in its history. */
export type LucyUnpromptedRead = LucyUnpromptedSaid & { inHistory?: true };

export interface LucyUnpromptedLog {
  /** She said or wrote this now. Never throws. */
  record(entry: LucyUnpromptedEntry): void;
  /** The items still worth showing, newest first, for a turn of `conversationId`. Never throws. */
  recent(conversationId?: string): LucyUnpromptedRead[];
}

interface Stored {
  key: string;
  text: string;
  tasks: Array<{ id: string; name?: string }>;
  at: number;
  stillOpen?: () => boolean;
  conversations: Set<string>;
}

export function createLucyUnpromptedLog(options: { now?: () => number } = {}): LucyUnpromptedLog {
  const now = options.now ?? Date.now;
  /** Oldest first. */
  let items: Stored[] = [];

  const open = (item: Stored): boolean => {
    try {
      return item.stillOpen?.() !== false;
    } catch {
      return true;
    }
  };
  const prune = (at: number): void => {
    items = items.filter((item) => at - item.at <= MAX_UNPROMPTED_AGE_MS && open(item)).slice(-MAX_UNPROMPTED_ITEMS);
  };

  return {
    record(entry) {
      try {
        const text = entry.text.trim();
        if (!entry.key || !text) return;
        const at = now();
        const previous = items.find((item) => item.key === entry.key);
        // Said again: one item, at its first time, known to every conversation that noted it.
        const conversations = new Set(previous?.conversations ?? []);
        if (entry.inConversation) conversations.add(entry.inConversation);
        items = items.filter((item) => item.key !== entry.key);
        items.push({
          key: entry.key,
          text,
          tasks: entry.tasks.map((task) => ({ id: task.id, ...(task.name ? { name: task.name } : {}) })),
          at: previous?.at ?? at,
          ...(entry.stillOpen ?? previous?.stillOpen ? { stillOpen: entry.stillOpen ?? previous?.stillOpen } : {}),
          conversations,
        });
        items.sort((a, b) => a.at - b.at);
        prune(at);
      } catch (err) {
        console.warn('[lucy-unprompted] could not record (ignored):', err instanceof Error ? err.message : String(err));
      }
    },

    recent(conversationId) {
      try {
        prune(now());
        return [...items].reverse().map((item) => ({
          text: item.text,
          at: item.at,
          tasks: item.tasks,
          ...(conversationId !== undefined && item.conversations.has(conversationId) ? { inHistory: true as const } : {}),
        }));
      } catch (err) {
        console.warn('[lucy-unprompted] could not read (ignored):', err instanceof Error ? err.message : String(err));
        return [];
      }
    },
  };
}
