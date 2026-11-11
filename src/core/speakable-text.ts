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
const TIMESTAMP_LEAD_WORDS = new Set(['at', 'on', 'since', 'until', 'from', 'by', 'as', 'of', '@']);

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

function isPathLike(core: string): boolean {
  if (!/[\\/]/.test(core)) return false;
  const rooted = /^[\\/]/.test(core);
  const anchored = rooted || /^(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])/.test(core);
  const segments = core.split(/[\\/]+/).filter((s) => s !== '' && s !== '.' && s !== '..');
  const withoutDrive = /^[A-Za-z]:$/.test(segments[0] ?? '') ? segments.slice(1) : segments;
  if (withoutDrive.length === 0) return false;
  if (!withoutDrive.every((s) => PATH_SEGMENT.test(s.replace(/:\d+(?::\d+)?$/, '')))) return false;
  if (!withoutDrive.some((s) => /[A-Za-z]/.test(s))) return false;
  // "/word" alone is more likely a slash command than a path.
  if (anchored) return withoutDrive.length >= (rooted ? 2 : 1);
  if (withoutDrive.length >= 3) return true;
  if (withoutDrive.length === 2) {
    return FILE_NAME.test(withoutDrive[1].replace(/:\d+(?::\d+)?$/, ''));
  }
  return false;
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

/** Split a whitespace-delimited token into leading punctuation, core, trailing punctuation. */
function peel(token: string): { lead: string; core: string; trail: string } {
  const lead = /^[("'<[{]*/.exec(token)?.[0] ?? '';
  const rest = token.slice(lead.length);
  const trail = /[.,;:!?)"'>\]}]*$/.exec(rest)?.[0] ?? '';
  return { lead, core: rest.slice(0, rest.length - trail.length), trail };
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
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]*[-*+•][ \t]+/gm, '');
  text = text.replace(/^[ \t]*>[ \t]?/gm, '');
  text = text.replace(/^[ \t]*[-=*_]{3,}[ \t]*$/gm, '');
  text = text.replace(/(?:^|[ \t])\|[ \t]|[ \t]\|(?:[ \t]|$)/g, ', ');
  return text;
}

function joinLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?]["')\]]?$/.test(line) ? line : `${line.replace(/[:;,]+$/, '')}.`))
    .join(' ');
}

function rewriteSymbols(text: string): string {
  return text
    .replace(/\s*(?:-{1,2}>|={1,2}>|→|⇒)\s*/g, ' to ')
    .replace(/(^|\s)&{1,2}(?=\s|$)/g, '$1and')
    .replace(/\[([^\]\n]*)\]/g, '$1')
    .replace(/(?<=[^\s\\/])(?:\.{2,}|…)+\s*$/g, '.')
    .replace(/(?<=[^\s\\/])(?:\.{2,}|…)+(?=\s)/g, ',')
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
  return `${text.replace(/[,;:\s]+$/, '')}.`;
}

const MAX_PASSES = 6;

function speakableOnce(text: string): string {
  const stripped = joinLines(stripMarkdown(text));
  const rewritten = rewriteTokens(rewriteSymbols(stripped));
  return ensureSentenceEnd(tidy(rewritten));
}

/**
 * Rewrite `text` so it is short and pronounceable. Returns the empty string
 * for empty or non-string input and the (trimmed) input unchanged on any
 * internal error.
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
