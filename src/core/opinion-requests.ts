/**
 * Asynchronous opinion requests (issue #3920): turn the operator's GitHub reply
 * into work, without anyone waiting for it.
 *
 * An unattended task that needs the operator's eye (a UI mockup, a reversible
 * choice between options) does not stop. It posts one "opinion request"
 * comment on the issue or pull request, adds the `needs-operator-opinion`
 * label, carries on with its recommended option, and ends. The operator answers
 * later, from a phone, with a comment that starts with `/opinion`.
 *
 * Workers post on GitHub with the operator's own account, so the author of a
 * comment cannot tell an operator reply from an automation comment. The
 * `/opinion` prefix is what makes a comment a reply.
 *
 * This module is the pure decision step of `kookr opinion sweep`: given one
 * labelled issue or pull request and its comments, it says what to do with
 * each reply that has not been handled yet.
 *
 * - An accepting reply (`/opinion ok`, or the recommended option's letter)
 *   removes the label.
 * - Any other reply (another option, or a requested change in free text)
 *   becomes exactly one follow-up task. The follow-up reads the reply itself;
 *   this module does not interpret it.
 * - When the request says the task stopped before a hard-to-undo choice, every
 *   reply becomes a follow-up: even an accept means "go ahead".
 *
 * Each handled reply is recorded by a marker comment the sweep posts after
 * acting, so running the sweep again acts on nothing new.
 */

/** Label an item carries while its opinion request is open. */
export const OPINION_LABEL = 'needs-operator-opinion';

/** Marker the requesting task puts in its request comment. */
export const OPINION_REQUEST_MARKER = 'kookr:opinion-request';

/** Marker the sweep puts in the comment that records a handled reply. */
export const OPINION_HANDLED_MARKER = 'kookr:opinion-handled';

/** One issue comment, as `gh api repos/<repo>/issues/<n>/comments` returns it (fields used here). */
export interface OpinionComment {
  id: number;
  body: string;
  createdAt: string;
  url: string;
}

export interface OpinionRequest {
  commentId: number;
  /** Letter of the recommended option (`A`, `B`, …), when the request names one. */
  recommended?: string;
  /**
   * The asking task stopped before a hard-to-undo choice instead of carrying
   * on (marker attribute `stopped`). Every reply, an accept included, is then
   * work: the follow-up carries out the chosen option.
   */
  stopped?: boolean;
}

export interface OpinionReply {
  commentId: number;
  url: string;
  /** Text after `/opinion` on the first line, plus any following lines, trimmed. */
  text: string;
}

export type OpinionAction =
  | { kind: 'accept'; reply: OpinionReply }
  | { kind: 'follow-up'; reply: OpinionReply };

export interface OpinionPlan {
  /** The latest request comment, or undefined when the item has none (nothing is done then). */
  request?: OpinionRequest;
  /** One action per unhandled reply, oldest first. */
  actions: OpinionAction[];
}

const REQUEST_RE = /<!--\s*kookr:opinion-request\b([^>]*)-->/i;
const RECOMMENDED_RE = /\brecommended=([A-Za-z])\b/;
const STOPPED_RE = /(?:^|\s)stopped(?:\s|$)/;
const HANDLED_RE = /<!--\s*kookr:opinion-handled\b[^>]*\breply=(\d+)[^>]*-->/gi;
const REPLY_RE = /^\s*\/opinion\b[ \t]*(.*)$/i;
const ACCEPT_WORDS = new Set(['ok', 'okay', 'accept', 'accepted', 'yes', 'lgtm', 'approve', 'approved', 'go', '👍', '+1']);

export function parseOpinionRequest(comment: OpinionComment): OpinionRequest | undefined {
  const m = REQUEST_RE.exec(comment.body);
  if (!m) return undefined;
  const attrs = m[1] ?? '';
  const rec = RECOMMENDED_RE.exec(attrs);
  return {
    commentId: comment.id,
    ...(rec ? { recommended: rec[1].toUpperCase() } : {}),
    ...(STOPPED_RE.test(attrs) ? { stopped: true } : {}),
  };
}

/** Reply ids recorded as handled by earlier sweeps. */
export function handledReplyIds(comments: readonly OpinionComment[]): Set<number> {
  const ids = new Set<number>();
  for (const c of comments) {
    for (const m of c.body.matchAll(HANDLED_RE)) ids.add(Number(m[1]));
  }
  return ids;
}

/**
 * A reply is a comment whose first non-blank line starts with `/opinion`.
 * Comments that carry an opinion marker (the request, the sweep's own records)
 * are never replies, even if they quote the command.
 */
export function parseOpinionReply(comment: OpinionComment): OpinionReply | undefined {
  if (/<!--\s*kookr:opinion-/i.test(comment.body)) return undefined;
  const lines = comment.body.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim().length > 0);
  if (first < 0) return undefined;
  const m = REPLY_RE.exec(lines[first]);
  if (!m) return undefined;
  const text = [m[1], ...lines.slice(first + 1)].join('\n').trim();
  return { commentId: comment.id, url: comment.url, text };
}

/**
 * Whether a reply accepts the recommendation: an accept word alone, or the
 * recommended option's letter alone (`/opinion A`, `/opinion A.`). Anything
 * with more to say (`/opinion A but bigger`) is a requested change.
 */
export function isAcceptingReply(text: string, recommended: string | undefined): boolean {
  const word = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (ACCEPT_WORDS.has(word)) return true;
  return recommended !== undefined && word === recommended.toLowerCase();
}

/**
 * Decide what to do on one labelled item. Only replies posted after the first
 * request comment count; replies already recorded as handled are skipped.
 */
export function planOpinionSweep(comments: readonly OpinionComment[]): OpinionPlan {
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  const requests = sorted
    .map((c) => ({ c, r: parseOpinionRequest(c) }))
    .filter((x): x is { c: OpinionComment; r: OpinionRequest } => x.r !== undefined);
  if (requests.length === 0) return { actions: [] };
  const first = requests[0].c;
  const handled = handledReplyIds(sorted);
  const actions: OpinionAction[] = [];
  for (const c of sorted) {
    if (c.createdAt < first.createdAt || c.id === first.id || handled.has(c.id)) continue;
    const reply = parseOpinionReply(c);
    if (!reply) continue;
    // The recommendation in force when the reply was written is the latest request before it.
    const request = [...requests].reverse().find((x) => x.c.createdAt <= c.createdAt)?.r ?? requests[0].r;
    const accepts = !request.stopped && isAcceptingReply(reply.text, request.recommended);
    actions.push({ kind: accepts ? 'accept' : 'follow-up', reply });
  }
  return { request: requests[requests.length - 1].r, actions };
}

/** Body of the comment that records a handled reply. */
export function handledMarkerBody(action: OpinionAction, followUpTaskId?: string): string {
  const marker = `<!-- ${OPINION_HANDLED_MARKER} reply=${action.reply.commentId} action=${action.kind} -->`;
  const line = action.kind === 'accept'
    ? `Opinion accepted (${action.reply.url}); removed the \`${OPINION_LABEL}\` label.`
    : `Opinion received (${action.reply.url}); started a follow-up task${followUpTaskId ? ` \`${followUpTaskId}\`` : ''} to apply it.`;
  return `${marker}\n${line}`;
}

/** Prompt for the follow-up task that applies a non-accepting reply. */
export function followUpPrompt(input: {
  repo: string;
  number: number;
  itemUrl: string;
  isPullRequest: boolean;
  reply: OpinionReply;
}): string {
  const kind = input.isPullRequest ? 'pull request' : 'issue';
  return [
    `The operator answered an opinion request on ${input.repo} ${kind} #${input.number} (${input.itemUrl}).`,
    ``,
    `Their reply (${input.reply.url}):`,
    ``,
    '```text',
    input.reply.text || '(empty reply)',
    '```',
    ``,
    `Read the opinion request comment and the reply on that ${kind}, then apply the reply: implement the option the operator picked, or the change they asked for, on top of what is already merged (or on the open pull request, if it is still open).`,
    `If the request says the asking task stopped before a hard-to-undo choice, the reply is the go-ahead: remove the \`automation-blocked\` label and deliver the rest of the ${kind} with the chosen option.`,
    `Treat the reply as the operator's decision for this question only; keep the change limited to it.`,
    `If the reply is unclear, do not guess: post one comment on the ${kind} that asks what to change, starting with your question, and stop.`,
    `When your change is merged, remove the \`${OPINION_LABEL}\` label unless the change itself needs another opinion request.`,
  ].join('\n');
}
