/**
 * Normalize a provider UserPromptSubmit body into the human-typed text that
 * should appear as a "You" message in the activity panel.
 *
 * Providers wrap or pad user input with in-band envelopes:
 * - Grok Build wraps the real query in `<user_query>…</user_query>` and may
 *   append `<system-reminder>` scaffolding (attached files, background-task
 *   notices). Those tags and appendices must not pollute the activity view.
 * - Claude Code re-enters the parent via a synthetic
 *   `<task-notification>…</task-notification>` body when a subagent completes.
 *
 * Returns `null` when the body is pure synthetic scaffolding with no
 * user-typed content (callers should drop the event, same as today's
 * task-notification path).
 */

const USER_QUERY_OPEN = '<user_query>';
const USER_QUERY_CLOSE = '</user_query>';
const TASK_NOTIFICATION_PREFIX = '<task-notification';
const SYSTEM_REMINDER_PREFIX = '<system-reminder';

export function unwrapProviderUserPrompt(prompt: string): string | null {
  if (typeof prompt !== 'string') return null;

  const trimmedStart = prompt.trimStart();
  if (trimmedStart.length === 0) return null;

  // Pure synthetic scaffolding — not something the user typed.
  if (trimmedStart.startsWith(TASK_NOTIFICATION_PREFIX)) return null;
  if (trimmedStart.startsWith(SYSTEM_REMINDER_PREFIX)) return null;

  let text = prompt;

  if (trimmedStart.startsWith(USER_QUERY_OPEN)) {
    // Drop leading whitespace and the open tag (and an optional following newline).
    const afterOpen = trimmedStart.slice(USER_QUERY_OPEN.length).replace(/^\r?\n/, '');
    const closeIdx = afterOpen.indexOf(USER_QUERY_CLOSE);
    if (closeIdx >= 0) {
      // Keep only the inner body; trailing system-reminder / attachment
      // scaffolding after the close tag is discarded.
      text = afterOpen.slice(0, closeIdx);
    } else {
      // Truncated payload with no close tag — still strip the open tag so the
      // visible activity text is not polluted by it.
      text = afterOpen;
    }
  }

  // Normalize trailing newlines; preserve internal whitespace/newlines.
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '');
  // Leading whitespace inside the envelope is almost always the newline after
  // the open tag (already stripped above); trim only a residual leading newline.
  text = text.replace(/^\n+/, '');

  if (text.trim().length === 0) return null;
  return text;
}
