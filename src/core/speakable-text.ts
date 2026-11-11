import {
  canonicalizeAnomalyTypeKey,
  type AnomalyType,
} from '../shared/contracts/anomalies.js';

/**
 * Turns developer-facing text (markdown, file paths, URLs, commit hashes,
 * snake_case identifiers, ...) into short text that a text-to-speech voice can
 * read naturally. The same string is shown as the avatar caption, so callers
 * must apply it BEFORE synthesis and caching.
 *
 * Contract: pure, never throws, idempotent
 * (`makeSpeakable(makeSpeakable(x)) === makeSpeakable(x)`), and conservative:
 * ordinary prose words are never rewritten.
 */

interface FindingPhrase {
  /** Predicate that follows a task name, e.g. "needs your input". */
  phrase: string;
  /** Used instead of `phrase` when severity is critical and that adds information. */
  critical?: string;
}

/**
 * Spoken predicates for every anomaly (finding) type. Typed as a full
 * `Record<AnomalyType, ...>` so adding a type to the union without a phrase
 * fails to compile.
 */
export const FINDING_PHRASES: Readonly<Record<AnomalyType, FindingPhrase>> = {
  needs_input: { phrase: 'needs your input', critical: 'urgently needs your input' },
  permission_blocked: {
    phrase: 'is waiting for your permission',
    critical: 'is urgently waiting for your permission',
  },
  repeated_error: { phrase: 'keeps hitting the same error' },
  merge_conflict: { phrase: 'has a merge conflict' },
  stale_agent: { phrase: 'has gone quiet', critical: 'has been quiet for a long time' },
  hook_disconnected: { phrase: 'lost its hook connection' },
  hook_missing: { phrase: 'is missing its hooks' },
  hook_parse_degraded: { phrase: 'is having trouble reading its hook events' },
  backend_unreachable: { phrase: 'cannot be reached' },
  api_error: { phrase: 'hit an API error' },
  budget_exceeded: { phrase: 'went over its budget' },
};

function lookupFindingPhrase(type: string): FindingPhrase | null {
  const key = canonicalizeAnomalyTypeKey(type.trim().toLowerCase());
  return Object.prototype.hasOwnProperty.call(FINDING_PHRASES, key)
    ? FINDING_PHRASES[key as AnomalyType]
    : null;
}

/**
 * Spoken predicate for a finding type, written to follow a task name
 * ("<task> needs your input"). Severity only changes the wording when it adds
 * information (critical on types where urgency matters). Returns null for an
 * unknown type so the caller can fall back to {@link identifierToWords}.
 */
export function spokenFindingPhrase(type: string, severity?: string): string | null {
  try {
    const entry = lookupFindingPhrase(type);
    if (!entry) return null;
    return severity === 'critical' && entry.critical ? entry.critical : entry.phrase;
  } catch {
    return null;
  }
}

/** snake_case / SCREAMING_CASE / kebab-case / camelCase identifier -> lower-case words. */
export function identifierToWords(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const SNAKE_CASE = /^_*[A-Za-z][A-Za-z0-9]*(?:_+[A-Za-z0-9]+)+_*$/;
const KEBAB_OR_CAMEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+|[A-Z][a-z0-9]+)+$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_ID = /^[0-9a-fA-F]{7,64}$/;
const PR_REF = /^#(\d+)$/;
const GITHUB_REF = /github\.com\/[^/\s]+\/[^/\s]+\/(pull|issues)\/(\d+)/i;
const DOMAIN_WITH_PATH = /^(?:[\w-]+\.)+(?:com|org|net|io|dev|ai|app|co|gov|edu)(?:[/:?#]|$)/i;
const PATH_SEGMENT = /^[\w.@~+-]+$/;
const FILE_NAME = /^[\w@~+-][\w.@~+-]*\.[A-Za-z][A-Za-z0-9]{0,4}$/;
const COMMIT_WORDS = new Set(['commit', 'commits', 'sha', 'hash', 'rev', 'revision']);
const TIMESTAMP_LEAD_WORDS = new Set(['at', 'on', 'since', 'until', 'from', 'to', 'by', 'as', 'of', '@']);

function isUrl(core: string): boolean {
  return (
    /^https?:\/\//i.test(core)
    || /^www\.[\w-]+\.\w+/i.test(core)
    || (DOMAIN_WITH_PATH.test(core) && core.includes('/'))
  );
}

function speakUrl(core: string): string {
  const gh = GITHUB_REF.exec(core);
  if (gh) return `${gh[1].toLowerCase() === 'pull' ? 'pull request' : 'issue'} ${gh[2]}`;
  return 'a link';
}

function looksLikeHexId(core: string): boolean {
  return HEX_ID.test(core) && /\d/.test(core) && /[a-fA-F]/.test(core);
}

/**
 * Path rule (never drop ordinary prose words):
 * - UNANCHORED token (no leading `/`, `~/`, `./`, `../` or drive letter): a path
 *   only when its LAST segment is a file name with an extension (`a/b.ts`,
 *   `src/core/foo.json`). `lint/typecheck/test`, `input/output/error`, `TCP/IP/UDP`
 *   and `yes/no/maybe` have no file-like tail, so they are left exactly as written.
 * - ANCHORED token: shortened to its last segment (file or directory name),
 *   EXCEPT API routes (`/api/...`) and tokens whose last segment is purely numeric
 *   (`/api/tasks/42`, `/tasks/42`): those read as routes, not locations, and the
 *   last segment alone would lose the meaning, so they are left unchanged.
 */
function isPathLike(core: string): boolean {
  if (!/[\\/]/.test(core)) return false;
  const rooted = /^[\\/]/.test(core);
  const anchored = rooted || /^(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])/.test(core);
  const segments = core.split(/[\\/]+/).filter((s) => s !== '' && s !== '.' && s !== '..');
  const withoutDrive = /^[A-Za-z]:$/.test(segments[0] ?? '') ? segments.slice(1) : segments;
  if (withoutDrive.length === 0) return false;
  if (!withoutDrive.every((s) => PATH_SEGMENT.test(stripLineSuffix(s)))) return false;
  if (!withoutDrive.some((s) => /[A-Za-z]/.test(s))) return false;
  const last = stripLineSuffix(withoutDrive[withoutDrive.length - 1]);
  if (anchored) {
    // "/word" alone is more likely a slash command than a path.
    if (withoutDrive.length < (rooted ? 2 : 1)) return false;
    if (/^\/api\//i.test(core)) return false;
    if (/^\d+$/.test(last)) return false;
    return true;
  }
  return withoutDrive.length >= 2 && FILE_NAME.test(last);
}

function stripLineSuffix(segment: string): string {
  return segment.replace(/:\d+(?::\d+)?$/, '');
}

function speakPath(core: string): string {
  const segments = core
    .split(/[\\/]+/)
    .filter((s) => s !== '' && s !== '.' && s !== '..')
    .map((s) => s.replace(/:\d+(?::\d+)?$/, ''));
  const last = segments[segments.length - 1] ?? '';
  const parent = segments[segments.length - 2];
  if (parent && !/^[A-Za-z]:$/.test(parent) && /^index\.[A-Za-z0-9]+$/.test(last)) return `${parent} ${last}`;
  return last;
}

const TRAIL_PUNCTUATION = '.,;:!?)"\'>]}';

/** Remove trailing characters found in `chars` (a linear scan, unlike `/[...]+$/`). */
function stripTrailing(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/** Split a whitespace-delimited token into leading punctuation, core, trailing punctuation. */
function peel(token: string): { lead: string; core: string; trail: string } {
  const lead = /^[("'<[{]*/.exec(token)?.[0] ?? '';
  const rest = token.slice(lead.length);
  let end = rest.length;
  while (end > 0 && TRAIL_PUNCTUATION.includes(rest[end - 1])) end -= 1;
  return { lead, core: rest.slice(0, end), trail: rest.slice(end) };
}

function stripMarkdown(input: string): string {
  let text = input.replace(/\r\n?/g, '\n');
  // Fence markers only; the code inside stays as plain text lines.
  text = text.replace(/^[ \t]*(?:`{3,}|~{3,})[\w-]*[ \t]*$/gm, '');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1');
  text = text.replace(/`+/g, '');
  text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1');
  text = text.replace(/(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1');
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  text = text.replace(/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1');
  // Heading, bullet and quote markers, including stacked ones ("- - x", "> # x"),
  // are stripped in one go so that a single pass reaches the fixed point.
  text = text.replace(/^(?:[ \t]{0,3}#{1,6}[ \t]+|[ \t]*[-*+•][ \t]+|[ \t]*>[ \t]?)+/gm, '');
  text = text.replace(/^[ \t]*[-=*_]{3,}[ \t]*$/gm, '');
  text = text.replace(/(?:^|[ \t])\|[ \t]|[ \t]\|(?:[ \t]|$)/g, ', ');
  return text;
}

function joinLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?]["')\]]?$/.test(line) ? line : `${stripTrailing(line, ':;,')}.`))
    .join(' ');
}

function isDotOrEllipsis(char: string): boolean {
  return char === '.' || char === '…';
}

/**
 * Unwrap standalone `[bracketed]` text but keep index-style `items[0]` and
 * `grid[1][2]` intact. One left-to-right scan; the next `]` is only searched
 * for again after the scan passes it, so the cost is linear.
 */
function unwrapBrackets(text: string): string {
  const n = text.length;
  let out = '';
  let last = 0;
  let close = -1;
  let newline = -1;
  for (let i = 0; i < n; i += 1) {
    if (text[i] !== '[') continue;
    if (i > 0 && /[\w\])]/.test(text[i - 1])) continue;
    if (close < i) {
      close = text.indexOf(']', i);
      if (close === -1) break;
    }
    if (newline < i) {
      const found = text.indexOf('\n', i);
      newline = found === -1 ? n : found;
    }
    if (newline < close) continue;
    out += text.slice(last, i) + text.slice(i + 1, close);
    last = close + 1;
    i = close;
  }
  return out + text.slice(last);
}

/**
 * A run of 2+ dots (or any "…") glued to the preceding word is a pause: at the
 * end of the text it becomes ".", before more text it becomes ",". Runs that
 * start the text or follow whitespace or a slash (`../x`) are left alone.
 * One scan over maximal runs, so there is no regex backtracking.
 */
function rewriteEllipses(text: string): string {
  const n = text.length;
  let out = '';
  let last = 0;
  let i = 0;
  while (i < n) {
    if (!isDotOrEllipsis(text[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && isDotOrEllipsis(text[j])) j += 1;
    const attached = i > 0 && !/[\s\\/]/.test(text[i - 1]);
    if (attached && (j - i >= 2 || text[i] === '…')) {
      let k = j;
      while (k < n && /\s/.test(text[k])) k += 1;
      if (k === n) {
        return `${out}${text.slice(last, i)}.`;
      }
      if (k > j) {
        out += `${text.slice(last, i)},`;
        last = j;
      }
    }
    i = j;
  }
  return out + text.slice(last);
}

function rewriteSymbols(text: string): string {
  const withSymbols = text
    // Whitespace around the arrow is collapsed later by tidy().
    .replace(/-{1,2}>|={1,2}>|→|⇒/g, ' to ')
    .replace(/(^|\s)&{1,2}(?=\s|$)/g, '$1and');
  return rewriteEllipses(unwrapBrackets(withSymbols))
    .replace(/[!?]{2,}/g, (run) => (run.includes('?') ? '?' : '!'))
    .replace(/([,;:])\1+/g, '$1');
}

function rewriteTokens(text: string): string {
  const parts = text.split(/(\s+)/);
  const out: string[] = [];
  let prevWord = '';
  for (const part of parts) {
    if (part === '' || /^\s+$/.test(part)) {
      out.push(part);
      continue;
    }
    const { lead, core, trail } = peel(part);
    let replacement: string | null = null;
    let dropLeadWord = false;

    if (core.length > 0) {
      if (isUrl(core)) {
        replacement = speakUrl(core);
      } else if (TIMESTAMP.test(core)) {
        replacement = '';
        dropLeadWord = TIMESTAMP_LEAD_WORDS.has(prevWord);
      } else if (UUID.test(core)) {
        replacement = '';
      } else if (PR_REF.test(core)) {
        replacement = `number ${core.slice(1)}`;
      } else if (isPathLike(core)) {
        replacement = speakPath(core);
      } else if (looksLikeHexId(core)) {
        replacement = COMMIT_WORDS.has(prevWord) ? '' : 'a commit';
      } else if (SNAKE_CASE.test(core)) {
        const bare = core.replace(/^_+|_+$/g, '');
        replacement = identifierToWords(canonicalizeAnomalyTypeKey(bare.toLowerCase()));
      } else if (KEBAB_OR_CAMEL.test(core)) {
        const asSnake = core.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
        if (lookupFindingPhrase(asSnake)) {
          replacement = identifierToWords(canonicalizeAnomalyTypeKey(asSnake));
        }
      }
    }

    if (replacement === null) {
      out.push(part);
      prevWord = core.toLowerCase();
      continue;
    }

    if (dropLeadWord) {
      // Remove the dangling lead word ("updated at <timestamp>") and its whitespace.
      while (out.length > 0 && /^\s*$/.test(out[out.length - 1])) out.pop();
      out.pop();
    }
    out.push(`${lead}${replacement}${trail}`);
    prevWord = replacement.toLowerCase();
  }
  return out.join('');
}

function tidy(text: string): string {
  return text
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(^|[.!?]\s)[,;:]+\s*/g, '$1')
    .replace(/([.!?]){2,}/g, '$1')
    .replace(/[,;:]+(?=\s*[.!?]$)/g, '')
    .trim();
}

function ensureSentenceEnd(text: string): string {
  if (!text) return text;
  if (/[.!?]["')\]]?$/.test(text)) return text;
  return `${stripTrailing(text, ',;: \t\n\r\f\v')}.`;
}

const MAX_PASSES = 6;
/** Longest input processed; bounds the worst-case cost of the regex passes. */
const MAX_INPUT_CHARS = 2000;

function speakableOnce(input: string): string {
  const text = input.length > MAX_INPUT_CHARS ? input.slice(0, MAX_INPUT_CHARS) : input;
  const stripped = joinLines(stripMarkdown(text));
  const rewritten = rewriteTokens(rewriteSymbols(stripped));
  return ensureSentenceEnd(tidy(rewritten));
}

/**
 * Rewrite `text` so it is short and pronounceable. Returns the empty string
 * for empty or non-string input and the (trimmed) input unchanged on any
 * internal error. Input beyond {@link MAX_INPUT_CHARS} characters is dropped.
 */
export function makeSpeakable(text: string): string {
  if (typeof text !== 'string') return '';
  try {
    // A rewrite can expose new work (a dropped token leaves a stray marker), so
    // run to a fixed point. This is what makes the function idempotent.
    let current = text;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const next = speakableOnce(current);
      if (next === current) return next;
      current = next;
    }
    return current;
  } catch {
    return text.trim();
  }
}
