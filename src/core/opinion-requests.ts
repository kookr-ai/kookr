/**
 * Asynchronous opinion requests (issue #3920): turn the operator's GitHub reply
 * into work, without anyone waiting for it.
 *
 * An unattended task that needs the operator's eye (a UI mockup, a reversible
 * choice between options) does not stop. It posts one "opinion request"
 * comment on the issue or pull request, adds the `needs-operator-opinion`
 * label, carries on with its recommended option, and ends. The operator answers
 * later, from a phone, with an ordinary comment in their own words.
 *
 * Workers post on GitHub with the operator's own account, so the author of a
 * comment cannot tell an operator reply from an automation comment. Automation
 * is told apart by what it writes instead: every comment a task posts on an
 * item in this flow carries a Kookr HTML marker (`<!-- kookr:… -->`), and the
 * playbooks' own notes start with "Automation note:" or "Automation check:".
 * Any other comment by a repository member is a reply.
 *
 * This module is the pure decision step of `kookr opinion sweep`: given one
 * labelled issue or pull request and its comments, it says what to do with
 * each reply that has not been handled yet.
 *
 * - A short accepting reply ("ok", "lgtm", "looks good", or the recommended
 *   option's letter alone) removes the label without starting a task.
 * - Any other reply becomes exactly one follow-up task. The follow-up reads
 *   the reply in natural language and decides what it means (another option, a
 *   change, an accept in other words, or not an answer at all); this module
 *   does not interpret it.
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

/** Marker every other automation comment on an item in this flow starts with. */
export const AUTOMATION_MARKER = 'kookr:automation';

/** Marker of a comment that relays an answer the operator gave on Telegram: it is a reply. */
export const OPINION_RELAY_MARKER = 'kookr:opinion-relay';

/** One issue comment, as `gh api repos/<repo>/issues/<n>/comments` returns it (fields used here). */
export interface OpinionComment {
  id: number;
  body: string;
  createdAt: string;
  url: string;
  /**
   * GitHub `author_association` of the comment's author. When present, only
   * OWNER, MEMBER and COLLABORATOR comments count as requests or replies: on a
   * public repository anyone can comment, and a reply becomes a task prompt.
   */
  authorAssociation?: string;
}

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Whether a comment may act as a request or a reply (see `authorAssociation`). */
export function isTrustedComment(comment: OpinionComment): boolean {
  return comment.authorAssociation === undefined || TRUSTED_ASSOCIATIONS.has(comment.authorAssociation.toUpperCase());
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
  /** The comment body, trimmed, without a relay marker or a leading `/opinion`. */
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
const RELAY_RE = /<!--\s*kookr:opinion-relay\b[^>]*-->/gi;
const ANY_MARKER_RE = /<!--[\s\S]*?-->/;
const AUTOMATION_PREFIX_RE = /^\s*(?:\*\*)?automation (?:note|check)\b/i;
/** An optional `/opinion` prefix (the earlier reply convention) is still accepted and dropped. */
const OPINION_PREFIX_RE = /^\s*\/opinion(?=\s|$)[ \t]*/i;
/** Annotation a worker appends when it relays a Telegram answer (asking-the-operator skill). */
const TELEGRAM_NOTE_RE = /\n?\s*\(answered on telegram[^)]*\)\s*$/i;
const ACCEPT_PHRASES = new Set([
  'ok', 'okay', 'accept', 'accepted', 'yes', 'lgtm', 'approve', 'approved', 'go', 'go ahead', '👍', '+1',
  'looks good', 'sounds good', 'fine', 'agreed', 'ship it', 'good',
]);

export function parseOpinionRequest(comment: OpinionComment): OpinionRequest | undefined {
  if (!isTrustedComment(comment)) return undefined;
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
    // An outsider must not be able to hide a reply by posting a fake record.
    if (!isTrustedComment(c)) continue;
    for (const m of c.body.matchAll(HANDLED_RE)) ids.add(Number(m[1]));
  }
  return ids;
}

/**
 * A reply is any non-empty comment by a repository member, in any words,
 * except automation: a comment that carries an HTML marker (the request, the
 * sweep's records, `kookr:automation`, review verdicts) or starts with
 * "Automation note:" / "Automation check:". A relayed Telegram answer carries
 * `kookr:opinion-relay` and is a reply.
 */
export function parseOpinionReply(comment: OpinionComment): OpinionReply | undefined {
  if (!isTrustedComment(comment)) return undefined;
  const relayed = comment.body.replace(RELAY_RE, '');
  const isRelay = relayed !== comment.body;
  if (ANY_MARKER_RE.test(relayed)) return undefined;
  if (!isRelay && AUTOMATION_PREFIX_RE.test(relayed)) return undefined;
  const text = relayed.replace(OPINION_PREFIX_RE, '').trim();
  if (text.length === 0) return undefined;
  return { commentId: comment.id, url: comment.url, text };
}

/**
 * Whether a reply is a short, unambiguous accept that needs no task: a common
 * accept phrase alone ("ok", "lgtm", "looks good"), or the recommended
 * option's letter alone ("A", "option A", "go with A"). Anything longer goes
 * to a follow-up task, which may still read it as an accept. A trailing
 * `(answered on Telegram…)` note, added when a worker relays a Telegram
 * answer, is ignored.
 */
export function isAcceptingReply(text: string, recommended: string | undefined): boolean {
  const phrase = text
    .replace(TELEGRAM_NOTE_RE, '')
    .trim()
    .toLowerCase()
    .replace(/[.!,;:]+$/, '')
    .replace(/\s+/g, ' ');
  if (ACCEPT_PHRASES.has(phrase)) return true;
  if (recommended === undefined) return false;
  const letter = recommended.toLowerCase();
  return new RegExp(`^(?:(?:go with|keep|pick|choose)\\s+)?(?:option\\s+)?${letter}(?:\\s+(?:is fine|please))?$`).test(phrase);
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

/** Prompt for the follow-up task that reads a reply and applies it. */
export function followUpPrompt(input: {
  repo: string;
  number: number;
  itemUrl: string;
  isPullRequest: boolean;
  reply: OpinionReply;
}): string {
  const kind = input.isPullRequest ? 'pull request' : 'issue';
  return [
    `A repository member commented after an opinion request on ${input.repo} ${kind} #${input.number} (${input.itemUrl}).`,
    `The operator answers in their own words, in any language, with no required format.`,
    ``,
    `The comment (${input.reply.url}):`,
    ``,
    '```text',
    input.reply.text || '(empty reply)',
    '```',
    ``,
    `Read the opinion request comment and this comment on that ${kind}, then decide what the comment means:`,
    `- Not an answer to the request (an automation message, a status note, a remark about something else): do nothing and stop.`,
    `- It accepts the recommended option: remove the \`${OPINION_LABEL}\` label and stop.`,
    `- It picks another option or asks for a change: implement that on top of what is already merged (or on the open pull request, if it is still open).`,
    `Start every comment you post on that ${kind} with \`<!-- ${AUTOMATION_MARKER} -->\` on its own line, so it is not read as the operator's next reply.`,
    `If the request says the asking task stopped before a hard-to-undo choice, the reply is the go-ahead: remove the \`automation-blocked\` label and deliver the rest of the ${kind} with the chosen option.`,
    `Treat the reply as the operator's decision for this question only; keep the change limited to it.`,
    `If the reply is unclear, do not guess: post one comment on the ${kind} that asks what to change (after the automation marker line) and stop.`,
    `When your change is merged, remove the \`${OPINION_LABEL}\` label unless the change itself needs another opinion request.`,
  ].join('\n');
}
