/**
 * Links in a `kookr ask` question, as the dashboard shows and opens them.
 *
 *  - {@link splitLinks} cuts a question or its background into plain text and http(s) URLs, so the
 *    card can render each URL as a real link instead of text the operator has to copy.
 *  - {@link openAskLink} opens a link in a new tab for Lucy's voice ("show me the mockups"). A tab
 *    opened from a voice command has no click behind it, so the browser often blocks it; the
 *    caller is told, so Lucy can say so instead of staying silent.
 */

export type TextSegment = { kind: 'text'; text: string } | { kind: 'url'; url: string };

// Up to the first space or a character that rarely belongs to a URL in prose.
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
// Punctuation that usually ends the sentence around a URL rather than the URL itself.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/** Split `text` into plain-text and URL segments, in order. Only http and https URLs are recognised. */
export function splitLinks(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let url = match[0];
    const trailing = TRAILING_PUNCTUATION.exec(url)?.[0] ?? '';
    // Keep a closing parenthesis that has its opening one inside the URL (Wikipedia-style paths).
    const keepParen = trailing.startsWith(')') && url.slice(0, -trailing.length).includes('(');
    if (trailing && !keepParen) url = url.slice(0, -trailing.length);
    if (!isOpenableUrl(url)) continue;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    out.push({ kind: 'url', url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Whether `url` parses as an http(s) URL with a host. Anything else is never opened. */
export function isOpenableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

export type OpenLinkOutcome = 'opened' | 'blocked';

/**
 * Open `url` in a new tab without giving it a handle on this page.
 *
 * `noopener` is not passed to `window.open`: with it the call returns null even when the tab
 * opened, so a blocked tab could not be told apart. The opener is cut by hand instead.
 */
export function openAskLink(url: string, open: typeof window.open = window.open.bind(window)): OpenLinkOutcome {
  if (!isOpenableUrl(url)) return 'blocked';
  let opened: Window | null = null;
  try {
    opened = open(url, '_blank');
  } catch {
    return 'blocked';
  }
  if (!opened) return 'blocked';
  try {
    opened.opener = null;
  } catch {
    // A cross-origin tab may refuse the write; it was opened, which is what matters.
  }
  return 'opened';
}
