/**
 * `/brief` on Telegram (issue #3931): what is waiting on the operator, across
 * every project, oldest first, as one message.
 *
 * The inbox comes from the server (`src/server/operator-inbox.ts`), the same
 * one `GET /api/operator/inbox` and `kookr brief` show. This module only lays
 * it out for a phone:
 *
 * - Items in projects not enabled for Telegram (`KOOKR_REMOTE_CHAT_PROJECTS`)
 *   are counted but not named, with the same directory rule as `/tasks`. An
 *   item whose task has no known directory is counted, not named. The
 *   integration train is not a project item and is always named.
 * - A line is built only from the item's fixed summary, tool name, task name,
 *   project, age, question text and link, never from the command, so no
 *   command text reaches Telegram. Task names and question text are passed
 *   through the secret redactor again.
 */

import { redactSecrets } from '../../core/redact-secrets.js';
import { formatInboxAge, type OperatorInbox, type OperatorInboxItem } from '../../shared/contracts/operator-inbox.js';
import { dashboardTaskUrl } from '../../shared/dashboard-task-url.js';
import { isWithinAllowedProject } from './tasks-command.js';

/** Stay under Telegram's 4096-character limit, with room for the footer. */
export const BRIEF_REPLY_MAX_CHARS = 3500;

const KIND_ICON: Record<OperatorInboxItem['kind'], string> = {
  permission: '🔐',
  question: '❓',
  flagged: '⚠️',
  review: '✅',
  train: '🚂',
};

/** `/brief`, with the `@botname` suffix Telegram adds in groups. Takes no arguments. */
export function isBriefCommand(text: string): boolean {
  return /^\/brief(@\w+)?\s*$/.test(text);
}

export interface BriefReplyOptions {
  /** Project directories enabled for Telegram. Empty: no project filter, as for `/tasks`. */
  allowedCwds: string[];
  dashboardBaseUrl: string;
  now: number;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isNamedHere(item: OperatorInboxItem, allowedCwds: string[]): boolean {
  if (item.kind === 'train') return true;
  if (allowedCwds.length === 0) return true;
  return isWithinAllowedProject(item.cwd, allowedCwds);
}

function itemLines(item: OperatorInboxItem, opts: BriefReplyOptions): string[] {
  const age = formatInboxAge(opts.now - Date.parse(item.since));
  if (item.kind === 'train') {
    return [`${KIND_ICON.train} ${age} · ${item.summary}`, `   → ${item.howToAnswer}`];
  }
  const name = item.taskName ? `"${clip(redactSecrets(item.taskName), 80)}"` : `task ${(item.taskId ?? '').slice(0, 8)}`;
  const project = item.project ? ` (${clip(item.project, 40)})` : '';
  const lines = [`${KIND_ICON[item.kind]} ${age} · ${name}${project} ${item.summary}`];
  if (item.kind === 'question' && item.question) {
    lines.push(`   "${clip(redactSecrets(item.question), 160)}"`);
  }
  lines.push(`   → ${item.howToAnswer}`);
  if (item.taskId) lines.push(`   ${dashboardTaskUrl(opts.dashboardBaseUrl, item.taskId)}`);
  return lines;
}

export interface BriefReply {
  text: string;
  /** Items in projects enabled here (the train included). */
  namedCount: number;
  /** Items counted but not named. */
  hiddenCount: number;
}

/** The `/brief` reply. */
export function formatBriefReply(inbox: OperatorInbox, opts: BriefReplyOptions): BriefReply {
  if (inbox.items.length === 0) return { text: inbox.summary, namedCount: 0, hiddenCount: 0 };

  const named = inbox.items.filter((item) => isNamedHere(item, opts.allowedCwds));
  const hidden = inbox.items.length - named.length;
  const footer: string[] = [];
  if (hidden > 0) footer.push(`And ${hidden} in projects not enabled here.`);

  const blocks: string[] = [];
  let length = inbox.summary.length + 2 + footer.join('\n').length + 80;
  let shown = 0;
  for (const item of named) {
    const block = itemLines(item, opts).join('\n');
    if (length + block.length + 2 > BRIEF_REPLY_MAX_CHARS) break;
    blocks.push(block);
    length += block.length + 2;
    shown += 1;
  }
  if (shown < named.length) {
    footer.unshift(`…and ${named.length - shown} more here: kookr brief lists them all.`);
  }
  const text = [inbox.summary, ...blocks, ...(footer.length > 0 ? [footer.join('\n')] : [])].join('\n\n');
  return { text, namedCount: named.length, hiddenCount: hidden };
}
