/**
 * Writes each line Lucy says on her own about a task (`store/lucy-says.ts`) into her thread, as a
 * finished message from her. The first task the line is about is stored on the entry, so the thread
 * can offer to open it. Written only, never spoken.
 *
 * Runs in the dock, which stays mounted while the panel is minimised, so a line that arrives while
 * the operator is not looking is in the thread when they open it.
 */
import { useEffect } from 'react';
import { appendConversationEntry } from '../store/lucy-conversation.js';
import { onLucySays } from '../store/lucy-says.js';

/** The thread entry id of a `lucy_says` message: the same in every tab that receives it. */
export function lucySaysEntryId(messageId: string): string {
  return `says:${messageId}`;
}

export function useLucySaysThreadSync(): void {
  useEffect(() => onLucySays((message) => {
    const taskId = message.taskIds[0];
    // Every open tab receives the same message: the entry's id comes from the message's, so a thread
    // shared between tabs gets the line once.
    appendConversationEntry({ id: lucySaysEntryId(message.id), kind: 'typed-lucy', status: 'done', text: message.text.trim(), ...(taskId ? { taskId } : {}) });
  }), []);
}
