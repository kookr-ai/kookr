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
 * (`makeSpeakable(makeSpeakable(x)) === makeSpeakable(x)`), and DO NO HARM.
 *
 * The module performs only the rewrites in the list below, each matched
 * narrowly. Everything else is left byte for byte as written, apart from
 * whitespace collapsing and a closing sentence end. In particular there is NO
 * general punctuation clean-up: repeated dots, `::`, emoticons, clause-start
 * punctuation, `**`, `>=`, `|`, quotes and brackets are never "normalised",
 * because every such rule eventually changes the meaning of some ordinary
 * sentence ("1..10", "main..HEAD", "2**16", ":) done", "std::vector").
 *
 *  1. URLs -> "a link" (GitHub pull/issue URLs -> "pull request N" / "issue N").
 *  2. File paths -> the file name (see {@link isPathLike}).
 *  3. Commit hashes -> "a commit" after a git word, otherwise "an ID" (see
 *     {@link hashReplacement}); `sha256:<hex>` digests -> "an ID"; a UUID is
 *     dropped, or "an ID" where dropping would leave a dangling word ("for <uuid>").
 *  4. snake_case identifiers -> words; kebab/camel only for known finding types.
 *  5. `#123` -> "number 123".
 *  6. Markdown: `[text](url)` -> text; backticks around a span that contains a
 *     letter or digit; `**bold**`, `__bold__`, `*em*`, `_em_` that open at a word
 *     start and close at a word end (a pair that wraps over a line break is
 *     recognised once the lines are joined); heading, bullet, numbered and quote
 *     markers at a line start (followed by a letter); code-fence lines; a table
 *     (a run of `| a | b |` lines that holds a `|---|---|` separator row): the
 *     separator row goes and each row becomes its cells joined with ", ". A `|`
 *     anywhere else ("a | b", "x || y", "|x| + |y|") is never touched.
 *  7. ISO timestamps -> "a set time" ("A set time" where one opens a sentence), in
 *     EVERY position. Nothing around it is touched: lead words (at, on, as of, dated,
 *     @), labels, colons, brackets and punctuation all stay as written ("Do not deploy
 *     @ a set time", "Last seen: a set time.", "(a set time)"). A timestamp is never
 *     dropped, because dropping it can change what a sentence says ("No files were
 *     updated at <ts>" must not become "No files were updated"). Also: a standalone
 *     infix `->`/`=>`/`→` -> "to" and `&`/`&&` -> "and"; the speech pipeline's own
 *     `[redacted]` placeholder -> "redacted"; what is left of a redacted long path
 *     ("/[redacted].test.ts", "[redacted]/foo.ts") -> "a redacted path". An empty
 *     `()` or `[]` that was already in the text ("returns []") is content and stays.
 *  8. Whitespace: runs collapse; wrapped lines join with a space; a blank line,
 *     or a heading/bullet line, ends a sentence; the text ends with . ! or ?
 *     (a trailing "..." or "…" becomes "."); a space before , . ; : ! ? goes
 *     only where that punctuation clearly ends a clause (see
 *     {@link closeGapBeforePunctuation}).
 *
 * Any new rewrite must be added to this list with a regression test, and must
 * keep the "never loses or glues words" property test green.
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
const HEX_ID = /^[0-9a-fA-F]{7,40}$/;
/** A content digest such as `sha256:<hex>` (an image or file digest): spoken as an ID, never read out. */
const DIGEST = /^(?:sha(?:1|224|256|384|512)|md5):[0-9a-fA-F]{16,128}$/i;
const PR_REF = /^#(\d+)$/;
const GITHUB_REF = /github\.com\/[^/\s]+\/[^/\s]+\/(pull|issues)\/(\d+)/i;
const DOMAIN_WITH_PATH = /^(?:[\w-]+\.)+(?:com|org|net|io|dev|ai|app|co|gov|edu)(?:[/:?#]|$)/i;
const PATH_SEGMENT = /^[\w.@~+-]+$/;
const FILE_NAME = /^[\w@~+.-][\w.@~+-]*\.[A-Za-z][A-Za-z0-9]{0,4}$/;
const KNOWN_FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'py', 'rs', 'go', 'java', 'kt', 'rb',
  'php', 'css', 'scss', 'html', 'yml', 'yaml', 'toml', 'ini', 'txt', 'sh', 'sql', 'lock', 'xml', 'csv',
  'svg', 'png', 'jpg',
]);
/** A hash right after one of these words is dropped ("commit 3f2a9c1" -> "commit"). */
const COMMIT_WORDS = new Set(['commit', 'commits', 'sha', 'hash', 'rev', 'revision']);
/** A short hash right after one of these words is spoken as "a commit" ("Tests pass on abc1234"). */
const HASH_CONTEXT_WORDS = new Set([
  'at', 'on', 'onto', 'revert', 'reverted', 'reverts', 'cherry-pick', 'cherry-picked', 'checkout',
]);
/** A month name that happens to be hex (dec, feb) beside a year, with or without a day: "10dec2025", "dec2025", "2024dec10". */
const DATE_LIKE = /^(?:\d{0,2}(?:dec|feb)\d{2,4}|\d{4}(?:dec|feb)\d{0,2})$/i;
/** A hash this long, hex digits only, is never an ordinary word or a date. */
const MIN_BARE_HASH_LENGTH = 12;
/** What a timestamp becomes, wherever it is: it is never dropped, and nothing around it changes. */
const SET_TIME = 'a set time';
/** The same, for a timestamp that opens a sentence. */
const SET_TIME_AT_START = 'A set time';
/** Words after which a dropped id would leave a dangling word: "for <uuid>", "and <uuid>". */
const ID_FUNCTION_WORDS = new Set([
  'for', 'of', 'to', 'from', 'with', 'in', 'on', 'at', 'by', 'via', 'than', 'into', 'onto', 'per', 'about',
  'after', 'before', 'as', 'under', 'over', 'and', 'or', 'nor', 'vs', 'versus', 'then', 'is', 'was', 'are', 'were',
  'not', 'no', 'between', 'against', 'like', 'unlike', '-', '–', '—', '•', '*', '+',
]);
const ID_CONNECTORS = new Set(['and', 'or', 'nor', 'vs', 'versus']);
/** After one of these the id is simply dropped: "request id <hex>" -> "request id". */
const ID_LABEL_WORDS = new Set(['id', 'ids', 'identifier', 'uuid', 'guid', 'objectid']);
/** Whole-token infix rewrites; the token must have a word on both sides. */
const INFIX_WORDS: ReadonlyMap<string, string> = new Map([
  ['->', 'to'], ['-->', 'to'], ['=>', 'to'], ['==>', 'to'], ['→', 'to'], ['⇒', 'to'],
  ['&', 'and'], ['&&', 'and'],
]);
const EMPTIED_PAIRS: Readonly<Record<string, string>> = { '(': ')', '[': ']' };

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

/**
 * Commit-hash rule. A token is a hash candidate only when it is 7-40 hex digits
 * with at least one digit AND one letter a-f, and (because it is the whole
 * whitespace-delimited token) is delimited by non-alphanumerics: "deadbeef",
 * "20231110" and "xabc1234" are therefore not candidates, and a day-month-year
 * word such as "10dec2025" is excluded explicitly ({@link DATE_LIKE}).
 *
 * A candidate is then trusted when ANY of these holds, because a bare 7-11 digit
 * hex-looking token ("deadbeef12", "face2face") is too often a word:
 * - the previous word is commit/sha/hash/rev/revision: the hash is dropped;
 * - the previous word is at, on, onto, revert, cherry-pick or checkout: "a commit";
 * - it is {@link MIN_BARE_HASH_LENGTH} or more characters long: with no git word
 *   beside it, it may as well be a trace id or an ObjectId, so it is only "an ID"
 *   (dropped after an id label: "request id <hex>").
 * Anything else is left exactly as written. Returns null for "not a hash".
 */
function hashReplacement(core: string, prevWord: string): string | null {
  if (!HEX_ID.test(core) || !/\d/.test(core) || !/[a-fA-F]/.test(core) || DATE_LIKE.test(core)) return null;
  if (COMMIT_WORDS.has(prevWord)) return '';
  if (HASH_CONTEXT_WORDS.has(prevWord)) return 'a commit';
  if (core.length >= MIN_BARE_HASH_LENGTH) return ID_LABEL_WORDS.has(prevWord) ? '' : 'an ID';
  return null;
}

/**
 * A UUID is dropped, unless dropping would leave a dangling word: after a preposition
 * or a list dash ("for <uuid>", "- <uuid>"), before "and"/"or" ("Fixed <uuid> and
 * <uuid>"), or at the start of the text or of a sentence.
 */
function uuidReplacement(prevWord: string, startsClause: boolean, nextWord: string): string {
  if (ID_LABEL_WORDS.has(prevWord)) return '';
  return startsClause || ID_FUNCTION_WORDS.has(prevWord) || ID_CONNECTORS.has(nextWord) ? 'an ID' : '';
}

/**
 * Path rule (never drop ordinary prose words):
 * - UNANCHORED token (no leading `/`, `~/`, `./`, `../` or drive letter): a path
 *   only when its LAST segment is a file name with a known extension (`a/b.ts`,
 *   `src/core/foo.json`, `src/components/Avatar.tsx`) AND it is clearly a location
 *   ({@link looksLikeLocation}). With a single slash and no line number the file
 *   name must also look like a file, not a product (`frontend/Next.js` stays).
 *   `lint/typecheck/test`, `input/output/error`, `TCP/IP/UDP` and `yes/no/maybe`
 *   have no file-like tail, and library or word pairs such as `d3.js/three.js`,
 *   `react/next.js`, `npm/node.js` and `before/after.png` fail the location test,
 *   so all of them are left exactly as written.
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
  const rawLast = withoutDrive[withoutDrive.length - 1];
  const last = stripLineSuffix(rawLast);
  if (anchored) {
    // "/word" alone is more likely a slash command than a path.
    if (withoutDrive.length < (rooted ? 2 : 1)) return false;
    if (/^\/api\//i.test(core)) return false;
    if (/^\d+$/.test(last)) return false;
    return true;
  }
  if (withoutDrive.length < 2 || !FILE_NAME.test(last) || !hasKnownExtension(last)) return false;
  const dirs = withoutDrive.slice(0, -1);
  const hasLineSuffix = rawLast !== last;
  if (!looksLikeLocation(dirs, hasLineSuffix)) return false;
  // One slash and no line number is thin evidence: a CamelCase name (`frontend/Next.js`) stays a product name.
  return dirs.length >= 2 || hasLineSuffix || looksLikeFileBase(last);
}

/** Directory names that make a short unanchored `dir/file.ext` token a path, not a word pair. */
const COMMON_DIRS = new Set([
  'src', 'lib', 'dist', 'build', 'docs', 'doc', 'test', 'tests', 'spec', 'e2e', 'app', 'apps', 'pkg', 'packages',
  'scripts', 'bin', 'public', 'static', 'assets', 'components', 'hooks', 'utils', 'core', 'server', 'client',
  'frontend', 'backend', 'config', 'configs', 'plugin', 'plugins', 'types', 'node_modules',
]);

/**
 * Evidence that an unanchored `dir/.../file.ext` token is a location, not a pair of
 * words or libraries: three or more segments (two slashes), a `:line` suffix, a
 * first directory that is a common directory name, a dot-directory, an npm scope
 * (`@scope`), or a `-` or `_` in the first directory. And none of the directories
 * may itself end in a file extension, which is how `d3.js/three.js` and
 * `express.js/koa.js` look. Everything else is prose and stays as written.
 */
function looksLikeLocation(dirs: readonly string[], hasLineSuffix: boolean): boolean {
  if (dirs.some((dir) => hasKnownExtension(stripLineSuffix(dir)))) return false;
  if (dirs.length >= 2 || hasLineSuffix) return true;
  const first = dirs[0];
  return COMMON_DIRS.has(first.toLowerCase()) || first.startsWith('.') || first.startsWith('@') || /[-_]/.test(first);
}

/**
 * The base name looks like a file, not a product: it starts lower-case, with a digit,
 * `_` or `.`, or is ALL-CAPS like README (so `Next.js`, `Node.js` and `Express.js` are not).
 */
function looksLikeFileBase(name: string): boolean {
  const base = name.slice(0, name.lastIndexOf('.'));
  return /^[a-z0-9_.]/.test(base) || (/[A-Z]/.test(base) && !/[a-z]/.test(base));
}

function hasKnownExtension(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && KNOWN_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** A trailing line reference: `:42`, `:42:7`, `:42-50` or a GitHub `#L42` / `#L42-L50`. */
function stripLineSuffix(segment: string): string {
  return segment.replace(/(?::\d+(?:[:\-–]\d+)?|#L\d+(?:-L?\d+)?)$/, '');
}

function speakPath(core: string): string {
  const segments = core
    .split(/[\\/]+/)
    .filter((s) => s !== '' && s !== '.' && s !== '..')
    .map(stripLineSuffix);
  const last = segments[segments.length - 1] ?? '';
  const parent = segments[segments.length - 2];
  if (parent && !/^[A-Za-z]:$/.test(parent) && /^index\.[A-Za-z0-9]+$/.test(last)) return `${parent} ${last}`;
  return last;
}

const TRAIL_PUNCTUATION = '.,;:!?)"\'>]}';

/** Split a whitespace-delimited token into leading punctuation, core, trailing punctuation. */
function peel(token: string): { lead: string; core: string; trail: string } {
  const lead = /^[("'<[{]*/.exec(token)?.[0] ?? '';
  const rest = token.slice(lead.length);
  let end = rest.length;
  while (end > 0 && TRAIL_PUNCTUATION.includes(rest[end - 1])) end -= 1;
  return { lead, core: rest.slice(0, end), trail: rest.slice(end) };
}

// ---------------------------------------------------------------------------
// Markdown (rewrite 6). Every scanner below is a single left-to-right pass.
// ---------------------------------------------------------------------------

/** A line holding only a code-fence marker and an optional language tag. */
const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,})[\w-]*[ \t]*$/;

/**
 * Remove the backticks around a code span whose content holds a letter or digit.
 * A span is a run of N backticks, text on the same line, and the next run of
 * exactly N backticks. A span with no letter or digit (`,` `;` `.` `::`) is
 * kept WITH its backticks, because without them the text would lose the very
 * symbol it is talking about; an unpaired backtick is left alone too.
 */
function stripCodeSpans(text: string): string {
  const n = text.length;
  let out = '';
  let flushed = 0;
  let i = 0;
  while (i < n) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    let afterOpen = i;
    while (afterOpen < n && text[afterOpen] === '`') afterOpen += 1;
    const width = afterOpen - i;
    let close = -1;
    let j = afterOpen;
    while (j < n && text[j] !== '\n') {
      if (text[j] !== '`') {
        j += 1;
        continue;
      }
      let runEnd = j;
      while (runEnd < n && text[runEnd] === '`') runEnd += 1;
      if (runEnd - j === width) {
        close = j;
        break;
      }
      j = runEnd;
    }
    if (close < 0) {
      i = afterOpen;
      continue;
    }
    const content = text.slice(afterOpen, close);
    if (/[\p{L}\p{N}]/u.test(content)) {
      out += text.slice(flushed, i) + content;
      flushed = close + width;
    }
    i = close + width;
  }
  return out + text.slice(flushed);
}

/** What may follow an opening marker / precede a closing one ("*)" and "(*" never pair). */
const EMPHASIS_START_OK = /[\p{L}\p{N}([{"'“‘#$@/~.<-]/u;
const EMPHASIS_END_OK = /[\p{L}\p{N})\]}"'”’.!?:;,%>]/u;

/**
 * Strip `**bold**`, `__bold__`, `*em*` and `_em_`, and nothing that merely looks
 * like them. A marker run (a maximal run of `*` or `_`, 1 or 2 long) OPENS only at
 * the start of the text or after whitespace or an opening bracket, with a word
 * character or opening punctuation right after it. It CLOSES an open marker of
 * the same kind on the SAME line only when it follows a word character or closing
 * punctuation and ends a word (whitespace, the end of the text, or only closing
 * punctuation before either). So `2**16`, `a*b*c`, `x * y * z`, `(*)`,
 * `snake_case_name`, `**kwargs`, `*.ts` and `__init__.py` stay as written.
 */
/** True when `from` is a word end: the text ends, whitespace follows, or only closing punctuation does. */
function atWordEnd(text: string, from: number): boolean {
  let k = from;
  while (k < text.length && '.,;:!?)]}"\'”’'.includes(text[k])) k += 1;
  return k >= text.length || /\s/.test(text[k]);
}

function stripEmphasis(text: string): string {
  const n = text.length;
  const drop = new Uint8Array(n);
  // Most recent unmatched opener per kind: [*, **, _, __].
  const pending = [-1, -1, -1, -1];
  let any = false;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') {
      pending.fill(-1);
      i += 1;
      continue;
    }
    if (ch !== '*' && ch !== '_') {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < n && text[end] === ch) end += 1;
    const width = end - i;
    if (width <= 2) {
      const slot = (ch === '_' ? 2 : 0) + width - 1;
      const prev = i > 0 ? text[i - 1] : '';
      const next = end < n ? text[end] : '';
      const start = pending[slot];
      if (
        start >= 0
        && i > start + width
        && EMPHASIS_END_OK.test(prev)
        && atWordEnd(text, end)
      ) {
        drop.fill(1, start, start + width);
        drop.fill(1, i, end);
        pending[slot] = -1;
        any = true;
      } else if ((prev === '' || /[\s([{]/.test(prev)) && next !== '' && EMPHASIS_START_OK.test(next)) {
        pending[slot] = i;
      }
    }
    i = end;
  }
  if (!any) return text;
  let out = '';
  for (let k = 0; k < n; k += 1) if (drop[k] === 0) out += text[k];
  return out;
}

function stripInlineMarkdown(input: string): string {
  let text = input.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1');
  text = text.replace(/\[([^\]\n]+)\]\((?:[^()\s]|\([^)\n]*\))*(?:[ \t]+"[^"\n]*")?\)/g, '$1');
  return stripEmphasis(stripCodeSpans(text));
}

interface Line {
  text: string;
  /** True when a heading, bullet or numbered marker was stripped: the line is its own sentence. */
  block: boolean;
}

/**
 * What may follow a BULLET, number or heading marker (not a `>`): a letter, or something
 * that is never a number or a symbol the line is about: the start of a file path
 * (`/src`, `~/x`, `./x`, `../x`, `.env`), a `#12` reference, a UUID, a date-time, or
 * the pipeline's own `[redacted]` placeholder. "- /home/me/app/main.ts" and
 * "- #12 fixed" are bullets, never a minus. A `>` before a path is a shell
 * redirect ("> /tmp/out.log") and is left alone.
 */
const MARKER_CONTENT_START = String.raw`\p{L}|\/[\p{L}._~@-]|\/\[redacted\]|~\/|\.{1,2}\/|\.\p{L}|\[redacted\]|#\d|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-|\d{4}-\d{2}-\d{2}[T ]\d{2}:`;

/**
 * Heading, bullet, numbered and quote markers (including stacked ones such as
 * "- - x" or "> - x") are stripped only at a line start, only when followed by a
 * space and then a LETTER (a bullet, number or heading also before one of the other
 * starts in {@link MARKER_CONTENT_START}).
 * A marker before a digit, `=`, `<`, `>` or other punctuation is content:
 * "- 3 degrees", "> 5 tests", ">= 5", "# 3 tests", "- [x] done". A lone `#` is a
 * heading only before an UPPER-case letter ("# Summary"), so a lower-case "# of
 * tests" keeps its `#`; `##` and deeper are always headings.
 */
const MARKER_CHAIN = /^[ \t]*(?:(?:[-*+•>]|\d{1,2}\.|#{2,6})[ \t]+)+(?=\p{L})/u;
/** A chain of bullet, number and heading markers (never `>`: "> /tmp/out.log" is a shell redirect) before a path, id or date. */
const BULLET_CHAIN = new RegExp(`^[ \\t]*(?:(?:[-*+•]|\\d{1,2}\\.|#{2,6})[ \\t]+)+(?=${MARKER_CONTENT_START})`, 'u');
const H1_CHAIN = /^[ \t]*(?:(?:[-*+•>]|\d{1,2}\.|#{2,6})[ \t]+)*#[ \t]+(?=\p{Lu})/u;

function stripLineMarkers(line: string): Line {
  const match = H1_CHAIN.exec(line) ?? MARKER_CHAIN.exec(line) ?? BULLET_CHAIN.exec(line);
  if (!match) return { text: line, block: false };
  return { text: line.slice(match[0].length), block: /[^\s>]/.test(match[0]) };
}

/**
 * Markdown tables. Only a run of consecutive lines that each start and end with
 * `|` (and hold no `||`) AND contain a separator row (`|---|:---:|`) is a table: the
 * separator row is dropped and every other row becomes its non-empty cells joined
 * with ", ", as a sentence of its own. A lone pipe line, `|x| + |y|` in prose,
 * `a | b`, `x || y` and `cat a | wc` have no separator row, so they stay as written.
 */
const TABLE_SEPARATOR_CELL = /^:?-+:?$/;

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 3 && trimmed.startsWith('|') && trimmed.endsWith('|') && !trimmed.includes('||')
    && !trimmed.endsWith('\\|');
}

/** The cells of a row; an escaped pipe (`\\|`) is text inside a cell, not a cell border. */
function tableCells(line: string): string[] {
  return line.trim().slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isSeparatorRow(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell));
}

function convertTables(lines: readonly string[]): Line[] {
  const result: Line[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isTableLine(lines[i])) {
      result.push(stripLineMarkers(lines[i]));
      i += 1;
      continue;
    }
    let end = i;
    while (end < lines.length && isTableLine(lines[end])) end += 1;
    const block = lines.slice(i, end);
    if (block.some(isSeparatorRow)) {
      for (const row of block) {
        if (isSeparatorRow(row)) {
          result.push({ text: '', block: false });
          continue;
        }
        const text = tableCells(row).filter((cell) => cell !== '').join(', ');
        result.push({ text, block: text !== '' });
      }
    } else {
      for (const row of block) result.push(stripLineMarkers(row));
    }
    i = end;
  }
  return result;
}

function prepareLines(input: string): Line[] {
  const normalized = input.replace(/\r\n?/g, '\n');
  const unfenced = normalized
    .split('\n')
    .map((line) => (FENCE_LINE.test(line) ? '' : line))
    .join('\n');
  return convertTables(stripInlineMarkdown(unfenced).split('\n'));
}

// ---------------------------------------------------------------------------
// Sentence ends and line joining (rewrite 8)
// ---------------------------------------------------------------------------

const SENTENCE_END = /[.!?]["')\]”’]?$/u;
/** The character before a trailing ellipsis / before a gap: a word or a closing quote or bracket. */
const WORD_OR_CLOSER = /[\p{L}\p{N}"')\]”’]/u;

/** The last whitespace-delimited token of `text` (a backwards scan, so it is linear). */
function lastToken(text: string): string {
  let start = text.length;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  return text.slice(start);
}

/**
 * Give `sentence` a terminating "." unless it already ends a sentence. A single
 * trailing `,` `;` or `:` after a word ("Changes:") is replaced by the period;
 * anything else just gets the period appended: `::` ("std::"), and a mark that
 * closes its own token (":tada:", "10:30:") are content, not a trailing colon.
 */
function closeSentence(sentence: string): string {
  if (SENTENCE_END.test(sentence)) return sentence;
  const last = sentence[sentence.length - 1];
  if (
    ',;:'.includes(last)
    && sentence.length > 1
    && WORD_OR_CLOSER.test(sentence[sentence.length - 2])
    && !lastToken(sentence).slice(0, -1).includes(last)
  ) {
    return `${sentence.slice(0, -1)}.`;
  }
  return `${sentence}.`;
}

/**
 * Join lines with a space: a line break inside a sentence is NOT a sentence end
 * ("does not\nwork"). A sentence ends at a blank line, and around a heading or
 * bullet line, because each of those stands alone. A line that already ends with
 * . ! ? or : needs nothing added.
 */
function joinLines(lines: readonly Line[]): string {
  let out = '';
  let lastBlock = false;
  let paragraphBreak = false;
  for (const line of lines) {
    const text = line.text.trim();
    if (text === '') {
      paragraphBreak = out !== '';
      continue;
    }
    if (out !== '') {
      if ((paragraphBreak || line.block || lastBlock) && !out.endsWith(':')) out = closeSentence(out);
      out += ' ';
    }
    out += text;
    lastBlock = line.block;
    paragraphBreak = false;
  }
  return out;
}

/**
 * A trailing "..." (three or more dots) or "…" glued to a word is a trailing-off and
 * becomes ".". One or two dots ("etc.." "main..") are left as written.
 */
function collapseTrailingEllipsis(text: string): string {
  let start = text.length;
  while (start > 0 && (text[start - 1] === '.' || text[start - 1] === '…')) start -= 1;
  const run = text.slice(start);
  if (start === 0 || !WORD_OR_CLOSER.test(text[start - 1])) return text;
  if (run.length < 3 && !run.includes('…')) return text;
  return `${text.slice(0, start)}.`;
}

function ensureSentenceEnd(text: string): string {
  if (!text) return text;
  return closeSentence(collapseTrailingEllipsis(text));
}

/**
 * Remove ONE space before , . ; : ! ? only where that mark plainly closes a clause
 * ("done ." "first , then"): the mark is followed by whitespace or the end of the
 * text, and the character before the space is a letter, digit or closing quote
 * or bracket. Everything that merely contains such a mark is untouched: " .env",
 * ".314", ":)", ":tada:", "C++ .", "std::vector". Two more guards keep ordinary
 * text intact: "3 . 5" and "3 : 1" (digits on both sides), and a . ! ? : that is
 * followed by a lower-case word ("node . is", "x ? y : z", "if ! grep"), since
 * those are operators or arguments, not a sentence end.
 */
const GAP_BEFORE_PUNCTUATION = /([\p{L}\p{N}"')\]”’]) ([,.;:!?])(?=\s|$)/gu;

function closeGapBeforePunctuation(text: string): string {
  return text.replace(GAP_BEFORE_PUNCTUATION, (match, prev: string, mark: string, offset: number) => {
    let after = offset + match.length;
    while (after < text.length && text[after] === ' ') after += 1;
    const next = after < text.length ? text[after] : '';
    if (/\d/.test(prev) && /\d/.test(next)) return match;
    if ('.!?:'.includes(mark) && next !== '' && !/\p{Lu}/u.test(next)) return match;
    return `${prev}${mark}`;
  });
}

function tidy(text: string): string {
  return closeGapBeforePunctuation(text.replace(/\s+/g, ' ')).trim();
}

// ---------------------------------------------------------------------------
// Token rewrites (rewrites 1-5, 7)
// ---------------------------------------------------------------------------

function popWhitespace(out: string[]): void {
  while (out.length > 0 && /^\s*$/.test(out[out.length - 1])) out.pop();
}

/** The spoken form of one peeled token core, or null when the token is ordinary prose. */
function speakCore(core: string, prevWord: string, startsClause: boolean, nextWord: string): string | null {
  if (core.length === 0) return null;
  if (isUrl(core)) return speakUrl(core);
  if (UUID.test(core)) return uuidReplacement(prevWord, startsClause, nextWord);
  if (DIGEST.test(core)) return 'an ID';
  if (PR_REF.test(core)) return `number ${core.slice(1)}`;
  if (isPathLike(core)) return speakPath(core);
  const hash = hashReplacement(core, prevWord);
  if (hash !== null) return hash;
  if (SNAKE_CASE.test(core)) {
    const bare = core.replace(/^_+|_+$/g, '');
    return identifierToWords(canonicalizeAnomalyTypeKey(bare.toLowerCase()));
  }
  if (KEBAB_OR_CAMEL.test(core)) {
    const asSnake = core.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
    if (lookupFindingPhrase(asSnake)) return identifierToWords(canonicalizeAnomalyTypeKey(asSnake));
  }
  return null;
}

/**
 * What is left of a long path that the speech pipeline redacted ("/[redacted].test.ts",
 * "/[redacted]-routes.ts", "[redacted]/foo.ts", "/[redacted]use_speak_agent.ts"): the
 * path was cut, so naming the rest would only read out half a file name. The token must
 * hold `[redacted]` and path characters only, and be either slash-separated or end in a
 * known file extension; "key=[redacted]", "[redacted]" and "token-[redacted]" are not.
 * Returns the punctuation around it, or null when the token is not such a remnant.
 */
function redactedPathRemnant(part: string): { lead: string; trail: string } | null {
  if (!part.includes('[redacted]')) return null;
  const lead = /^[("'<{]*/.exec(part)?.[0] ?? '';
  let end = part.length;
  while (end > lead.length && '.,;:!?)"\'>}'.includes(part[end - 1])) end -= 1;
  const body = part.slice(lead.length, end);
  if (body === '[redacted]' || !/^(?:[\w.@~+/-]|\[redacted\])+$/.test(body)) return null;
  const extension = /\.([A-Za-z][A-Za-z0-9]{0,4})$/.exec(body)?.[1];
  if (!body.includes('/') && !(extension !== undefined && KNOWN_FILE_EXTENSIONS.has(extension.toLowerCase()))) return null;
  return { lead, trail: part.slice(end) };
}

const REDACTED_PATH = 'a redacted path';

function rewriteTokens(text: string): string {
  const parts = text.split(/(\s+)/);
  const wordParts = parts.filter((part) => part !== '' && !/^\s+$/.test(part));
  const wordCount = wordParts.length;
  const out: string[] = [];
  // The last word written to `out`, lower-cased ('' after a dropped token).
  let lastWord = '';
  let seen = 0;
  let prevPart = '';
  for (const part of parts) {
    if (part === '' || /^\s+$/.test(part)) {
      out.push(part);
      continue;
    }
    const position = seen;
    // The first word of the text or of a sentence ("Failed tasks: <uuid>").
    const startsClause = position === 0 || /[.!?:]["')\]”’]?$/u.test(prevPart);
    const afterSentenceEnd = /[.!?]["')\]”’]?$/u.test(prevPart);
    prevPart = part;
    const infix = position > 0 && position < wordCount - 1;
    seen += 1;
    const prevWord = afterSentenceEnd ? '' : lastWord;
    const nextWord: string | undefined = wordParts[position + 1];

    const infixWord = infix ? INFIX_WORDS.get(part) : undefined;
    if (infixWord !== undefined) {
      out.push(infixWord);
      lastWord = infixWord;
      continue;
    }

    const remnant = redactedPathRemnant(part);
    if (remnant !== null) {
      out.push(`${remnant.lead}${REDACTED_PATH}${remnant.trail}`);
      lastWord = REDACTED_PATH;
      continue;
    }

    const peeled = peel(part);
    let { core, trail } = peeled;
    const { lead } = peeled;
    // A token that ends in the placeholder ("https://app.example.[redacted]") keeps its closing bracket.
    if (core.endsWith('[redacted') && trail.startsWith(']')) {
      core += ']';
      trail = trail.slice(1);
    }
    if (core.toLowerCase() === 'redacted' && lead.endsWith('[') && trail.startsWith(']')) {
      // The speech pipeline's own placeholder: "[redacted]" is spoken as "redacted".
      out.push(`${lead.slice(0, -1)}${core}${trail.slice(1)}`);
      lastWord = 'redacted';
      continue;
    }

    // A timestamp is never dropped: it is "a set time" wherever it stands, and the text around it is left as written.
    const replacement = TIMESTAMP.test(core)
      ? (position === 0 || afterSentenceEnd ? SET_TIME_AT_START : SET_TIME)
      : speakCore(core, prevWord, startsClause, peel(nextWord ?? '').core.toLowerCase());
    if (replacement === null) {
      out.push(part);
      lastWord = core.toLowerCase();
      continue;
    }

    if (replacement === '') {
      // A dropped token (UUID, hash after "commit") leaves no gap behind it and takes any
      // `(...)` / `[...]` that held nothing else. An empty pair that was already in the
      // text is content ("returns []") and is never touched.
      let leading = lead;
      let trailing = trail;
      while (leading !== '' && trailing !== '' && EMPTIED_PAIRS[leading[leading.length - 1]] === trailing[0]) {
        leading = leading.slice(0, -1);
        trailing = trailing.slice(1);
      }
      if (leading === '' && /^[)\].,;:!?]/.test(trailing)) popWhitespace(out);
      out.push(`${leading}${trailing}`);
      lastWord = '';
      continue;
    }

    out.push(`${lead}${replacement}${trail}`);
    lastWord = replacement.toLowerCase();
  }
  return out.join('');
}

/**
 * Remove the phrases {@link makeSpeakable} itself generates ("a commit" for a
 * hash, "a link" for a URL, "pull request 7", "issue 7", "number 42"), so a
 * check run on spoken text does not mistake them for words the author wrote.
 * Words that come from identifiers ("run_tests" -> "run tests") are kept.
 */
export function stripGeneratedPhrases(text: string): string {
  return text
    .replace(/\ba (?:commit|link)\b/gi, ' ')
    .replace(/\b(?:pull request|issue|number) \d+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Longest input processed; bounds the worst-case cost of the passes. */
const MAX_INPUT_CHARS = 2000;

function speakableOnce(input: string): string {
  const text = input.length > MAX_INPUT_CHARS ? input.slice(0, MAX_INPUT_CHARS) : input;
  const joined = joinLines(prepareLines(text));
  return ensureSentenceEnd(tidy(rewriteTokens(joined)));
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
    // Real input settles in two or three passes; the cap (the capped input length) only
    // guards against a pathological ping-pong, and is far above any nesting depth.
    const maxPasses = Math.min(text.length, MAX_INPUT_CHARS) + 1;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const next = speakableOnce(current);
      if (next === current) return next;
      current = next;
    }
    return current;
  } catch {
    return text.trim();
  }
}
