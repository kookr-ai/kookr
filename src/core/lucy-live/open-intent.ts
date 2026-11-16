/**
 * "Show me" by voice: while a task's question (`kookr ask`) is waiting, the operator can ask Lucy to
 * open the page the question links to, or the task that asked, without leaving her.
 *
 * Pure parts only: the matcher that recognises the request, and the sentences Lucy says. The
 * session decides which question is meant (the newest waiting one), asks the browser to open the
 * target, and picks a sentence from what the browser reports, so she never claims a tab opened when
 * the browser blocked it.
 *
 * The matcher works on the whole sentence, not on keywords inside it: "show me the status of the
 * build" is an ordinary question for the model, not a request to open a link.
 */

import type { AskLink, OperatorAskView } from '../../shared/contracts/asks.js';

/** What the operator asked to see. `any`: "show me", "open it", with nothing to tell a link from the task. */
export type OpenRequest =
  | { target: 'any' }
  | { target: 'task' }
  /** `index`: the link whose label the operator named; absent means the first one. */
  | { target: 'link'; index?: number };

/** A waiting question as the "show me" flow needs it. */
export interface VoiceOpenableAsk {
  askId: string;
  taskId: string;
  links: readonly AskLink[];
}

/** What the browser did with an open request. `unavailable`: there was nothing it could open (no such task in the dashboard). */
export type OpenOutcome = 'opened' | 'blocked' | 'unavailable';

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // é -> e, so French words survive the next step
    .replace(/['’]/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEADING = /^(ok|okay|hey|lucy|please|so|and|now|can you|could you|would you|will you|peux tu|tu peux|stp|s il te plait)\s+/;
const TRAILING = /\s+(please|for me|lucy|now|then|stp|s il te plait)$/;
const VERB = /^(show me|show|open up|open|display|bring up|pull up|let me see|montre moi|montre|ouvre moi|ouvre|affiche moi|affiche)(?:\s+(.*))?$/;
const PRONOUNS = new Set(['', 'it', 'that', 'this', 'them', 'those', 'that one', 'this one', 'le', 'la', 'les', 'ca', 'ceci', 'cela']);
const ARTICLE = /^(the|a|my|le|la|les|l|ma|mon)\s+/;
const TASK_WORDS = new Set(['task', 'tache', 'task that asked', 'asking task', 'agent', 'session']);
const LINK_WORDS = new Set([
  'link', 'links', 'page', 'url', 'artifact', 'artefact', 'mockup', 'mockups', 'mock up', 'mock ups', 'mock', 'mocks',
  'write up', 'writeup', 'doc', 'docs', 'document', 'design', 'designs', 'pr', 'pull request', 'preview', 'demo',
  'lien', 'maquette', 'maquettes', 'apercu',
]);

/** The words of a link label that name its content ("Open mockups" -> "mockups"). */
function labelWords(label: string | undefined): string {
  return normalize(label ?? '').replace(/^(open|see|view|show|read)\s+(the\s+)?/, '');
}

/**
 * Whether `transcript` is a request to open something, and what. `labels` are the link labels of the
 * question, so "show me the variants" works when a link is labelled "Open variants".
 */
export function matchOpenRequest(transcript: string, labels: readonly (string | undefined)[] = []): OpenRequest | null {
  let n = normalize(transcript);
  for (let previous = ''; previous !== n;) {
    previous = n;
    n = n.replace(LEADING, '').replace(TRAILING, '');
  }
  const verb = VERB.exec(n);
  if (!verb) return null;
  const rest = (verb[2] ?? '').trim();
  if (PRONOUNS.has(rest)) return { target: 'any' };
  const object = rest.replace(ARTICLE, '');
  if (TASK_WORDS.has(object)) return { target: 'task' };
  const named = labels.findIndex((label) => {
    const words = labelWords(label);
    return words.length > 0 && (object === words || object === `${words} link`);
  });
  if (named >= 0) return { target: 'link', index: named };
  if (LINK_WORDS.has(object)) return { target: 'link' };
  // "show me the second link", "open the other one" and the like are not guessed at.
  return null;
}

/** The newest waiting question, as the "show me" flow sees it. `asks` is the dashboard list (newest first). */
export function openableVoiceAsks(asks: readonly OperatorAskView[]): VoiceOpenableAsk[] {
  return asks
    .filter((a) => a.state === 'pending')
    .map((a) => ({ askId: a.id, taskId: a.taskId, links: a.links ?? [] }));
}

export const OPEN_NOTHING_WAITING = 'No question is waiting, so there is nothing for me to open.';
/** Deliberately not phrased as "open the task": her own words must not read as a new request if they echo back. */
export const OPEN_NO_LINK = 'That question has no link to open. I can show you the task that asked instead, if you want.';
export const OPEN_LINK_OPENED = 'It is open in a new tab.';
export const OPEN_LINK_BLOCKED = 'Your browser blocked the new tab. Press the link on the question card, or allow pop-ups for Kookr.';
export const OPEN_TASK_OPENED = 'Here is the task that asked.';
export const OPEN_TASK_UNAVAILABLE = 'I cannot show that task: it is not in the dashboard right now.';
export const OPEN_NO_REPLY = 'I could not open it from here. Use the buttons on the question card.';

/** What she says once the browser has answered (or not, `undefined`). */
export function sayOpenOutcome(kind: 'link' | 'task', outcome: OpenOutcome | undefined): string {
  if (outcome === undefined) return OPEN_NO_REPLY;
  if (kind === 'task') return outcome === 'opened' ? OPEN_TASK_OPENED : OPEN_TASK_UNAVAILABLE;
  if (outcome === 'opened') return OPEN_LINK_OPENED;
  return outcome === 'blocked' ? OPEN_LINK_BLOCKED : OPEN_NO_REPLY;
}
