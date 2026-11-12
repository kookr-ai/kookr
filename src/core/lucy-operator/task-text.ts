/**
 * Cleans text that came from a task (a request, a closing summary, terminal output)
 * before it is sent to the model provider: the codes a terminal uses to draw are
 * removed, and secret-looking tokens are hidden.
 *
 * The two jobs cannot be done one after the other, because a terminal code sits
 * exactly where a word boundary should be, and the secret patterns rely on word
 * boundaries:
 *
 * - `Bearer` + cursor-jump code + `ghp_…`: on screen there is a gap. Delete the code
 *   first and the text reads `Bearerghp_…`, which no longer looks like a token.
 * - `sk-abc` + colour code + `def…`: on screen it is one token. Hide secrets first
 *   and neither half is long enough to be recognised.
 *
 * So each code is first replaced by a one-character mark that remembers what was
 * there, secrets are looked for under both readings of the marks, and only then are
 * the marks turned into what the operator would see: nothing for a colour, a space
 * for anything that moves the cursor.
 */

import { redactSpeechSecrets, speechSecretSpans } from '../task-speech-summary.js';

/** Stands for something that takes no room on screen: a colour code, a window title. */
const ZERO = '';
/** Stands for something that moves the cursor, or a stray control character: on screen, a gap. */
const GAP = '';

/** Replace every terminal code with its mark. All patterns are linear in the length of the text. */
function markTerminalControl(text: string): string {
  return text
    .replace(/[]/g, '') // the marks themselves must not arrive from outside
    .replace(/\r\n/g, '\n')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, ZERO) // window title, hyperlink
    .replace(/\u001b\[[0-9;?]*[ -/]*m/g, ZERO) // colour and text style
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, GAP) // cursor movement, erasing
    .replace(/\u001b[@-Z\\-_]/g, GAP) // two-character codes
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, GAP); // other control characters, except tab and newline
}

/** Turn the marks into what the operator would see on screen. */
function renderMarks(marked: string): string {
  return marked.replace(//g, '').replace(//g, ' ');
}

/** Hide secret-looking tokens in marked text, under both readings of the marks. */
function hideSecrets(marked: string): string {
  // Reading 1: every mark separates words. Catches a token that a code stands in front of.
  const text = redactSpeechSecrets(marked);

  // Reading 2: a zero-width mark joins what is on either side of it. Catches a token that a
  // colour code runs through. Gap marks still separate: joining across them would make one
  // long "token" out of ordinary words that a terminal placed with cursor jumps.
  if (!text.includes(ZERO)) return text;
  const joined: string[] = [];
  const origin: number[] = []; // origin[i] = where the i-th character of the joined text sits in `text`
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ZERO) continue;
    joined.push(text[i]!);
    origin.push(i);
  }
  const spans = speechSecretSpans(joined.join(''));
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    const from = origin[start]!;
    const to = origin[end - 1]! + 1;
    out += `${text.slice(cursor, from)}[redacted]`;
    cursor = to;
  }
  return out + text.slice(cursor);
}

/**
 * Task text made safe to send to the model provider: terminal codes removed, secrets
 * hidden. Line breaks and tabs are kept.
 */
export function cleanTaskText(text: string): string {
  return renderMarks(hideSecrets(markTerminalControl(text)));
}

/**
 * Only the first half of {@link cleanTaskText}: the words as the operator would see them,
 * with no secret hiding. For display and tests; text bound for the provider must go
 * through `cleanTaskText`.
 */
export function stripTerminalControl(text: string): string {
  return renderMarks(markTerminalControl(text));
}
