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

export function useLucySaysThreadSync(): void {
  useEffect(() => onLucySays((message) => {
    const taskId = message.taskIds[0];
    appendConversationEntry({ kind: 'typed-lucy', status: 'done', text: message.text.trim(), ...(taskId ? { taskId } : {}) });
  }), []);
}
