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
 * THE PRINCIPLE. A rewrite may SUBSTITUTE (a URL becomes "a link", a path its file
 * name, a hash "an ID") or strip pure MARKUP characters (backticks, `**`, `#` heading
 * markers, `- `/`* `/`+ `/`• ` bullets, table pipes). It must never DELETE a word or a
 * number that carries content, because deleting one changes what a sentence says
 * ("No agent <uuid> is running" must not become "No agent is running"; "Every task
 * except <uuid> passed" must not lose the exception). The only places where the
 * output can hold fewer words than the input are listed here, each with its reason:
 *  - the language tag of a code-fence line goes with the fence marker (```ts);
 *  - the destination of a markdown link or image (one run with no space in it) goes, the text
 *    stays; a link with no text is "a link", an image with no alt text "an image". A link whose
 *    destination holds a space, as in `[t](url "title")`, is left as written: that is words;
 *  - the `:42` / `#L42` line suffix of a path goes with the rest of the path;
 *  - the `|---|---|` separator row of a table goes;
 *  - input beyond {@link MAX_INPUT_CHARS} characters is dropped (a length bound).
 * Everything else keeps every word: the property tests count them.
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
 *  3. Identifiers are never dropped. A commit hash is "a commit" after a git verb
 *     (on, at, onto, revert, ...); a UUID, a `sha256:<hex>` digest or a hex id of 12 or
 *     more characters is "an ID", and "ID" right after a label word, which stays
 *     ("commit 3f2a9c1" -> "commit ID", "No agent <uuid> is running" -> "No agent ID is
 *     running"; see {@link hashReplacement} and {@link spokenId}).
 *  4. snake_case identifiers -> words; kebab/camel only for known finding types.
 *  5. `#123` -> "number 123".
 *  6. Markdown: `[text](url)` -> text; backticks around a span that contains a
 *     letter or digit; `**bold**`, `__bold__`, `*em*`, `_em_` that open at a word
 *     start and close at a word end (a pair that wraps over a line break is
 *     recognised once the lines are joined); heading (`#`..`######`) and bullet
 *     (`-`, `*`, `+`, `•`) markers, only at a line start that follows a sentence end,
 *     a blank line or another marker line (see {@link stripMarkers}); code-fence
 *     lines; a table (a run of `| a | b |` lines that holds a `|---|---|` separator
 *     row): the separator row goes and each row becomes its cells joined with ", ", an
 *     empty cell being "blank". Numbered-list markers (`1.`) and quote markers (`>`)
 *     are NEVER stripped: "at most\n2. Older backups" and "the count\n> limit" are
 *     sentences that wrap onto a number or a comparison. A `|` anywhere else ("a | b",
 *     "x || y", "|x| + |y|") is never touched.
 *  7. ISO timestamps -> "a set time" ("A set time" where one opens a sentence), in
 *     EVERY position. Nothing around it is touched: lead words (at, on, as of, dated,
 *     @), labels, colons, brackets and punctuation all stay as written ("Do not deploy
 *     @ a set time", "Last seen: a set time.", "(a set time)"). Also: a standalone
 *     infix `->`/`=>`/`→` -> "to" and `&`/`&&` -> "and"; the speech pipeline's own
 *     `[redacted]` placeholder -> "redacted"; what is left of a redacted long path
 *     ("/[redacted].test.ts", "[redacted]/foo.ts") -> "a redacted path". An empty
 *     `()` or `[]` is content and stays.
 *  8. Whitespace: runs collapse; wrapped lines join with a space; a blank line,
 *     or a heading/bullet line, ends a sentence; the text ends with . ! or ?
 *     (a trailing "..." or "…" becomes "."); a space before , . ; : ! ? goes
 *     only where that punctuation clearly ends a clause (see
 *     {@link closeGapBeforePunctuation}).
 *
 * ONE PASS PER REWRITE. Every rewrite above completes in a single linear pass, nesting
 * included (`[[[redacted]]]`, `*a *b* c*`, `[[a](u)](v)`, ``` ``a `b` c`` ```). A text with no line
 * break is therefore settled by its first pass, and {@link settleSpeakable} only runs a second to
 * see that nothing changes; a pair that spans a line break (its halves meet when the lines are joined)
 * costs one more. That is two or three runs for any realistic text, never a run per nesting level.
 * (Two shapes of two rewrites that meet can cost one more still, and are the reason for the cap: a path whose
 * file name starts with `_` or `*`, which only then becomes an emphasis opener, and a URL glued to a backtick,
 * which swallows it and so changes how the other backticks pair.)
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
/** Words that name a git object. A hash right after one keeps the word and becomes "ID" ("commit 3f2a9c1" -> "commit ID"). */
const GIT_LABEL_WORDS = new Set(['commit', 'commits', 'sha', 'hash', 'rev', 'revision']);
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
/**
 * Words that name an identified thing ("agent <uuid>", "request id <hex>"). A UUID, a digest or a
 * hex id of 12 or more characters right after one keeps the word and becomes "ID". A SHORT hex word
 * after one of these is left as written, because "task deadbeef12" may name a task.
 */
const ID_LABEL_WORDS = new Set([
  'id', 'ids', 'identifier', 'uuid', 'guid', 'objectid', 'agent', 'task', 'session', 'request', 'job', 'run',
  'build', 'container', 'trace',
]);
/** Whole-token infix rewrites; the token must have a word on both sides. */
const INFIX_WORDS: ReadonlyMap<string, string> = new Map([
  ['->', 'to'], ['-->', 'to'], ['=>', 'to'], ['==>', 'to'], ['→', 'to'], ['⇒', 'to'],
  ['&', 'and'], ['&&', 'and'],
]);
/** One of those words standing alone between spaces, as in "` -> `": it will be spoken as a word, so it makes a code span one. */
const SPACED_INFIX = new RegExp(`\\s(?:${[...INFIX_WORDS.keys()].map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s`);

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
 * Articles, possessives and demonstratives, after which "an ID" would read as a stutter ("The an ID
 * task"): the id is just "ID" there. Quantifiers (no, every, any, some, each) are NOT here: "No <uuid>
 * was found" must not become "No ID was found", which claims that no id at all was found.
 */
const ID_DETERMINERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'its', 'their', 'my', 'our', 'your', 'his', 'her', 'which', 'whose',
]);

/**
 * What an identifier is spoken as. NEVER nothing: "No agent <uuid> is running" and "Every task
 * except <uuid> passed" say something different without the id. After a label word ({@link
 * GIT_LABEL_WORDS}, {@link ID_LABEL_WORDS}) or a determiner the word stays and the id is "ID" ("No
 * agent ID is running", "Request id ID", "The ID task failed"); anywhere else it is "an ID" ("Every
 * task except an ID passed").
 */
function spokenId(prevWord: string): string {
  return GIT_LABEL_WORDS.has(prevWord) || ID_LABEL_WORDS.has(prevWord) || ID_DETERMINERS.has(prevWord) ? 'ID' : 'an ID';
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
 * - the previous word is commit/sha/hash/rev/revision: the word stays and the hash is "ID";
 * - the previous word is at, on, onto, revert, cherry-pick or checkout: "a commit";
 * - it is {@link MIN_BARE_HASH_LENGTH} or more characters long: with no git word
 *   beside it, it may as well be a trace id or an ObjectId, so it is only "an ID"
 *   ("ID" after a label word such as "request id" or "task").
 * Anything else is left exactly as written. Returns null for "not a hash".
 */
function hashReplacement(core: string, prevWord: string): string | null {
  if (!HEX_ID.test(core) || !/\d/.test(core) || !/[a-fA-F]/.test(core) || DATE_LIKE.test(core)) return null;
  if (GIT_LABEL_WORDS.has(prevWord)) return 'ID';
  if (HASH_CONTEXT_WORDS.has(prevWord)) return 'a commit';
  if (core.length >= MIN_BARE_HASH_LENGTH) return spokenId(prevWord);
  return null;
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
  // The file name is what is spoken: "/a/-" or "/a/_" would leave a bare symbol behind.
  if (!/[A-Za-z0-9]/.test(last)) return false;
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
// Markdown (rewrite 6). Every scanner below is ONE left-to-right pass that finishes its
// job, nesting included. A scanner that peeled one layer per pass would need a pass per
// layer, and the fixed-point loop would run as long as the input is deep.
// ---------------------------------------------------------------------------

/**
 * A line holding only a code-fence marker and an optional language tag. The tag starts with a
 * letter, so a line such as "```42" is text, not a fence, and it cannot hold a `.`, `!` or `?`:
 * a finished sentence is never a fence line, so no pass can turn "```a :" into one by adding its period.
 */
const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,})(?:[A-Za-z][\w+#-]*)?[ \t]*$/;

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** A copy of `text` without the characters flagged in `drop`. */
function withoutDropped(text: string, drop: Uint8Array): string {
  let out = '';
  let from = 0;
  for (let k = 0; k <= text.length; k += 1) {
    if (k === text.length || drop[k] === 1) {
      if (k > from) out += text.slice(from, k);
      from = k + 1;
    }
  }
  return out;
}

/**
 * Remove the backticks around a code span whose content holds a letter or digit.
 * A span is a run of N backticks, text on the same line, and the next run of
 * exactly N backticks; the runs of one width pair up in order (first with second, third
 * with fourth), independently of the other widths, so a span inside a span of another
 * width is stripped in the same pass. A span with no letter or digit (`,` `;` `.` `::`)
 * is kept WITH its backticks, because without them the text would lose the very
 * symbol it is talking about; an unpaired backtick is left alone too. (A span that holds an
 * infix word such as a spaced "->" does count as one, because the token rewrite will turn that
 * word into "to" in this very pass; judging it by its letters now would strip the span only on
 * the next pass.)
 */
function stripCodeSpans(text: string): string {
  if (!text.includes('`')) return text;
  const n = text.length;
  // letters[k] = how many letters and digits text[0..k) holds, so a span is judged in O(1).
  const letters = new Int32Array(n + 1);
  let k = 0;
  for (const ch of text) {
    const here = LETTER_OR_DIGIT.test(ch) ? 1 : 0;
    for (let unit = 0; unit < ch.length; unit += 1) {
      letters[k + 1] = letters[k] + (unit === 0 ? here : 0);
      k += 1;
    }
  }
  const drop = new Uint8Array(n);
  const open = new Map<number, number>();
  let any = false;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') {
      open.clear();
      i += 1;
      continue;
    }
    if (ch !== '`') {
      i += 1;
      continue;
    }
    let end = i;
    while (end < n && text[end] === '`') end += 1;
    const width = end - i;
    const start = open.get(width);
    if (start === undefined) {
      open.set(width, i);
    } else {
      open.delete(width);
      if (letters[i] - letters[start + width] > 0 || SPACED_INFIX.test(text.slice(start + width, i))) {
        drop.fill(1, start, start + width);
        drop.fill(1, i, end);
        any = true;
      }
    }
    i = end;
  }
  return any ? withoutDropped(text, drop) : text;
}

/**
 * The characters inside the code spans that are still there once {@link stripCodeSpans} has run, which are the
 * spans that were kept because they hold no letter or digit (`...`, `*.*`). Code is literal: a `*` or a `[`
 * in one is not markdown, and treating it as markdown would change what the span holds (a `*` dropped from
 * "`-> *`" leaves a "->" that is then spoken as "to", a word the span's own check never saw).
 * Null when there are none.
 */
function keptCodeSpanContent(text: string): Uint8Array | null {
  if (!text.includes('`')) return null;
  const n = text.length;
  let mask: Uint8Array | null = null;
  const open = new Map<number, number>();
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') {
      open.clear();
      i += 1;
      continue;
    }
    if (ch !== '`') {
      i += 1;
      continue;
    }
    let end = i;
    while (end < n && text[end] === '`') end += 1;
    const width = end - i;
    const contentStart = open.get(width);
    if (contentStart === undefined) {
      open.set(width, end);
    } else {
      open.delete(width);
      if (!LETTER_OR_DIGIT.test(text.slice(contentStart, i))) {
        mask ??= new Uint8Array(n);
        mask.fill(1, contentStart, i);
      }
    }
    i = end;
  }
  return mask;
}

/**
 * The index just after the `)` that closes the link destination whose `(` is at `open`, or -1.
 * A destination is one run of characters with no whitespace, which may hold a `(...)` group that has no
 * whitespace or parenthesis in it either (`https://en.wikipedia.org/wiki/Foo_(bar)`). It is the hidden half
 * of a link and is dropped, so it must never be able to swallow words: one with a space in it, as in
 * `[text](url "title")` or `[text](see (this) note)`, is not recognised and the link is left as written.
 */
function linkDestinationEnd(text: string, open: number): number {
  const n = text.length;
  let k = open + 1;
  while (k < n) {
    const ch = text[k];
    if (ch === ')') return k + 1;
    if (ch === '(') {
      let close = k + 1;
      while (close < n && text[close] !== ')' && text[close] !== '(' && !/\s/.test(text[close])) close += 1;
      if (close >= n || text[close] !== ')') return -1;
      k = close + 1;
      continue;
    }
    if (/\s/.test(ch)) return -1;
    k += 1;
  }
  return -1;
}

/**
 * A link does not start right after a letter, a digit or a closing bracket: `handlers[0](event)`,
 * `items[i](args)` and `Stop![x](u)` are code and prose, and dropping the "(event)" would delete a word.
 * (`first` is the `[`, or the `!` of an image; `lastLinkEnd` is where a link just before ended.)
 */
function linkMayStartAt(text: string, first: number, lastLinkEnd: number): boolean {
  if (first === 0 || first === lastLinkEnd) return true;
  return !/[\p{L}\p{N})\]]/u.test(text[first - 1]);
}

/**
 * `[text](destination)` -> text and `![alt](destination)` -> alt. One pass with a stack of open
 * brackets, so a link inside a link's text (`[[a](u)](v)`) is resolved in the same pass. The
 * destination is the hidden half of a link and goes; a link with no text is "a link" and an image
 * with no alt text "an image", because a bare drop would leave a sentence without its object.
 */
function stripLinks(text: string): string {
  if (!text.includes('](')) return text;
  const n = text.length;
  const literal = keptCodeSpanContent(text);
  const drop = new Uint8Array(n);
  const inserts = new Map<number, string>();
  const stack: number[] = [];
  // Where the last link ended, so that a link right after it ("[a](u)[b](v)") is still a link.
  let lastLinkEnd = -1;
  let any = false;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (literal?.[i] === 1) {
      // The inside of a kept code span is not markdown.
    } else if (ch === '\n') {
      stack.length = 0;
    } else if (ch === '[') {
      stack.push(i);
    } else if (ch === ']') {
      const open = stack.pop();
      if (open !== undefined && text[i + 1] === '(') {
        const image = open > 0 && text[open - 1] === '!';
        const first = image ? open - 1 : open;
        const end = linkMayStartAt(text, first, lastLinkEnd) ? linkDestinationEnd(text, i + 1) : -1;
        if (end > 0) {
          if (text.slice(open + 1, i).trim() === '') {
            drop.fill(1, first, end);
            inserts.set(first, image ? 'an image' : 'a link');
          } else {
            drop.fill(1, first, open + 1);
            drop.fill(1, i, end);
          }
          any = true;
          lastLinkEnd = end;
          i = end;
          continue;
        }
      }
    }
    i += 1;
  }
  if (!any) return text;
  let out = '';
  for (let k = 0; k < n; k += 1) {
    const inserted = inserts.get(k);
    if (inserted !== undefined) out += inserted;
    if (drop[k] === 0) out += text[k];
  }
  return out;
}

/** What may follow an opening marker / precede a closing one ("*)" and "(*" never pair). */
const EMPHASIS_START_OK = /[\p{L}\p{N}([{"'“‘#$@/~.<-]/u;
const EMPHASIS_END_OK = /[\p{L}\p{N})\]}"'”’.!?:;,%>]/u;
const EMPHASIS_CLOSING_PUNCTUATION = '.,;:!?)]}"\'”’';

/**
 * Strip `**bold**`, `__bold__`, `*em*` and `_em_`, and nothing that merely looks
 * like them. A marker run (a maximal run of `*` or `_`, 1 or 2 long) OPENS only at
 * the start of the text or after whitespace or an opening bracket, with a word
 * character or opening punctuation right after it. It CLOSES an open marker of
 * the same kind on the SAME line only when it follows a word character or closing
 * punctuation and ends a word (whitespace, the end of the text, or only closing
 * punctuation before either). So `2**16`, `a*b*c`, `x * y * z`, `(*)`,
 * `snake_case_name`, `**kwargs`, `*.ts` and `__init__.py` stay as written.
 *
 * Two things make one pass enough for nested emphasis. The open markers of each kind form
 * a stack, so a closer takes the nearest opener and the outer ones keep theirs (`*a *b* c*`).
 * And the context of a run (what is before it, what is after it, whether a word ends there) is
 * read THROUGH every other `*` and `_`: a marker that this pass removes can never change how
 * another one is judged, so a second pass finds nothing new (`**_x_**`, `*(*x*)*`). The inside
 * of a kept code span has no markers at all.
 */
function stripEmphasis(text: string): string {
  if (!/[*_]/.test(text)) return text;
  const n = text.length;
  const literal = keptCodeSpanContent(text);
  // marker[k] is 1 where text[k] is a `*` or `_` that can act as emphasis.
  const marker = new Uint8Array(n);
  for (let k = 0; k < n; k += 1) marker[k] = (text[k] === '*' || text[k] === '_') && literal?.[k] !== 1 ? 1 : 0;
  // before[i]: the nearest character before i that is not a marker ('' at the start of the text).
  const before: string[] = new Array<string>(n + 1);
  before[0] = '';
  for (let k = 0; k < n; k += 1) before[k + 1] = marker[k] === 1 ? before[k] : text[k];
  // after[i]: the nearest character at or after i that is not a marker ('' at the end).
  const after: string[] = new Array<string>(n + 1);
  after[n] = '';
  for (let k = n - 1; k >= 0; k -= 1) after[k] = marker[k] === 1 ? after[k + 1] : text[k];
  // wordEnd[i]: from i on, only markers and closing punctuation come before whitespace or the end.
  const wordEnd = new Uint8Array(n + 1);
  wordEnd[n] = 1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (marker[k] === 1 || EMPHASIS_CLOSING_PUNCTUATION.includes(text[k])) wordEnd[k] = wordEnd[k + 1];
    else wordEnd[k] = /\s/.test(text[k]) ? 1 : 0;
  }
  const drop = new Uint8Array(n);
  // Open markers per kind: [*, **, _, __].
  const stacks: number[][] = [[], [], [], []];
  let any = false;
  let i = 0;
  while (i < n) {
    if (text[i] === '\n') {
      for (const stack of stacks) stack.length = 0;
      i += 1;
      continue;
    }
    if (marker[i] === 0) {
      i += 1;
      continue;
    }
    const ch = text[i];
    let end = i + 1;
    while (end < n && text[end] === ch && marker[end] === 1) end += 1;
    const width = end - i;
    if (width <= 2) {
      const stack = stacks[(ch === '_' ? 2 : 0) + width - 1];
      const prev = before[i];
      const next = after[end];
      const start = stack.length > 0 ? stack[stack.length - 1] : -1;
      if (start >= 0 && i > start + width && EMPHASIS_END_OK.test(prev) && wordEnd[end] === 1) {
        stack.pop();
        drop.fill(1, start, start + width);
        drop.fill(1, i, end);
        any = true;
      } else if ((prev === '' || /[\s([{]/.test(prev)) && next !== '' && EMPHASIS_START_OK.test(next)) {
        stack.push(i);
      }
    }
    i = end;
  }
  return any ? withoutDropped(text, drop) : text;
}

/**
 * Inline markdown, in the order that lets one pass finish: code spans first (their content is then
 * ordinary text for the rest), then links, then emphasis.
 */
function stripInlineMarkdown(input: string): string {
  return stripEmphasis(stripLinks(stripCodeSpans(input)));
}

interface Line {
  text: string;
  /** True when a heading or bullet marker was stripped, or the line is a table row: it is its own sentence. */
  block: boolean;
}

/**
 * What may follow a BULLET or heading marker: a letter, or something that is never a number or a
 * symbol the line is about: the start of a file path (`/src`, `~/x`, `./x`, `../x`, `.env`), a
 * `#12` reference, a UUID, a date-time, or the pipeline's own `[redacted]` placeholder.
 * "- /home/me/app/main.ts" and "- #12 fixed" are bullets, never a minus.
 */
const MARKER_CONTENT_START = String.raw`\p{L}|\/[\p{L}._~@-]|\/\[redacted\]|~\/|\.{1,2}\/|\.\p{L}|\[redacted\]|#\d|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-|\d{4}-\d{2}-\d{2}[T ]\d{2}:`;

/**
 * Heading and bullet markers (including stacked ones such as "- - x") are stripped only at a line
 * start, only when followed by a space and then a LETTER (a bullet or heading also before one of the
 * other starts in {@link MARKER_CONTENT_START}). Only `-`, `*`, `+`, `•` and `#`..`######` are markers.
 * A number ("2.") or a quote (">") is NEVER one: a line that wraps onto "2. Older backups get
 * deleted." or "> limit" is part of the sentence before it, and stripping that would delete a number or
 * a comparison. A marker before a digit, `=`, `<` or other punctuation is content too: "- 3 degrees",
 * "# 3 tests", "- [x] done". A lone `#` is a heading only before an UPPER-case letter ("# Summary"),
 * so a lower-case "# of tests" keeps its `#`; `##` and deeper are always headings. "Space" here is any
 * whitespace but a line break, so a no-break space after a marker is the space it looks like.
 */
const MARKER_CHAIN = /^[^\S\n]*(?:(?:[-*+•]|#{2,6})[^\S\n]+)+(?=\p{L})/u;
const BULLET_CHAIN = new RegExp(`^[^\\S\\n]*(?:(?:[-*+•]|#{2,6})[^\\S\\n]+)+(?=${MARKER_CONTENT_START})`, 'u');
const H1_CHAIN = /^[^\S\n]*(?:(?:[-*+•]|#{2,6})[^\S\n]+)*#[^\S\n]+(?=\p{Lu})/u;

function stripLineMarkers(line: Line): Line {
  const match = H1_CHAIN.exec(line.text) ?? MARKER_CHAIN.exec(line.text) ?? BULLET_CHAIN.exec(line.text);
  if (!match) return line;
  return { text: line.text.slice(match[0].length), block: true };
}

/** A line that ends a sentence or a lead-in: . ! ? : or ; (and a closing quote or bracket after it). */
const LINE_END = /[.!?:;]["')\]”’]?$/u;

/**
 * Strip the markers of the lines where a marker can only be one: the line is the first, or the line
 * before it is blank, is a marker or table line of its own, or ends with . ! ? : or ;. A "- x" or "## x"
 * after a line that stops mid-sentence is that sentence wrapping onto a dash or a heading mark, and
 * stays as written. A line counts as a marker line only if its marker was really stripped, so the bullets
 * that follow a stripped bullet are stripped too and those that follow a kept one are kept; a bullet whose
 * text wraps onto a second line ends the run, because the second line is neither a marker line nor a sentence
 * end ("- a long\n  item\n- b" is "a long. item - b").
 */
function stripMarkers(lines: readonly Line[]): Line[] {
  const result: Line[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const prev = i > 0 ? result[i - 1] : undefined;
    const atLineStart = prev === undefined || prev.block || prev.text.trim() === '' || LINE_END.test(prev.text.trimEnd());
    result.push(atLineStart ? stripLineMarkers(lines[i]) : lines[i]);
  }
  return result;
}

/**
 * Markdown tables. Only a run of consecutive lines that each start and end with
 * `|` (and hold no `||`) AND contain a separator row (`|---|:---:|`) is a table: the
 * separator row is dropped and every other row becomes its cells joined
 * with ", ", as a sentence of its own, an empty cell being "blank". A lone pipe line,
 * `|x| + |y|` in prose, `a | b`, `x || y` and `cat a | wc` have no separator row, so they
 * stay as written.
 */
const TABLE_SEPARATOR_CELL = /^:?-+:?$/;
const EMPTY_CELL = 'blank';

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
      result.push({ text: lines[i], block: false });
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
        const text = tableCells(row).map((cell) => (cell === '' ? EMPTY_CELL : cell)).join(', ');
        result.push({ text, block: true });
      }
    } else {
      for (const row of block) result.push({ text: row, block: false });
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
  return stripMarkers(convertTables(stripInlineMarkdown(unfenced).split('\n')));
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

/**
 * The spoken form of an ordinary (non-path, non-URL) token core, or null when it is plain prose.
 * Nothing here ever returns an empty string: a token is replaced, never dropped.
 */
function speakWord(core: string, prevWord: string): string | null {
  if (UUID.test(core)) return spokenId(prevWord);
  if (DIGEST.test(core)) return spokenId(prevWord);
  if (PR_REF.test(core)) return `number ${core.slice(1)}`;
  const hash = hashReplacement(core, prevWord);
  if (hash !== null) return hash;
  if (SNAKE_CASE.test(core)) {
    const bare = core.replace(/^_+|_+$/g, '');
    // Each word is a token of its own in the text that comes out: "task_3f2a9c1d8e0b" is "task" and a hex id.
    let previous = prevWord;
    return identifierToWords(canonicalizeAnomalyTypeKey(bare.toLowerCase()))
      .split(' ')
      .map((word) => {
        const spoken = speakWord(word, previous) ?? word;
        previous = lastWordOf(spoken);
        return spoken;
      })
      .join(' ');
  }
  if (KEBAB_OR_CAMEL.test(core)) {
    const asSnake = core.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
    if (lookupFindingPhrase(asSnake)) return identifierToWords(canonicalizeAnomalyTypeKey(asSnake));
  }
  return null;
}

/** The spoken form of one peeled token core, or null when the token is ordinary prose. */
function speakCore(core: string, prevWord: string): string | null {
  if (core.length === 0) return null;
  if (isUrl(core)) return speakUrl(core);
  if (isPathLike(core)) {
    // The file name is a token of its own once the path is gone: finish its rewrite in this pass
    // ("/a/b/__init__" -> "init", "/a/b/needs_input" -> "needs input", "/a/b/3f2a9c1d8e0b" -> "an ID"), not in the next.
    const file = stripEmphasis(speakPath(core));
    return file.includes(' ') ? file : (speakCore(file, prevWord) ?? file);
  }
  return speakWord(core, prevWord);
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

/** The last word of a spoken phrase, lower-cased: "an ID" -> "id", so the next token sees what the next pass will see. */
function lastWordOf(phrase: string): string {
  return phrase.slice(phrase.lastIndexOf(' ') + 1).toLowerCase();
}

/** Brackets around the speech pipeline's own placeholder: as many pairs as there are on both sides. */
function placeholderBracketPairs(lead: string, trail: string): number {
  let open = 0;
  while (open < lead.length && lead[lead.length - 1 - open] === '[') open += 1;
  let close = 0;
  while (close < trail.length && trail[close] === ']') close += 1;
  return Math.min(open, close);
}

function rewriteTokens(text: string): string {
  const parts = text.split(/(\s+)/);
  let wordCount = 0;
  for (const part of parts) if (part !== '' && !/^\s+$/.test(part)) wordCount += 1;
  const out: string[] = [];
  // The last word of what was written to `out`, lower-cased.
  let lastWord = '';
  let seen = 0;
  let prevPart = '';
  for (const part of parts) {
    if (part === '' || /^\s+$/.test(part)) {
      out.push(part);
      continue;
    }
    const position = seen;
    // The first word of a sentence ("Wait. 2025-11-10T10:00:00Z ERROR ...").
    const afterSentenceEnd = /[.!?]["')\]”’]?$/u.test(prevPart);
    prevPart = part;
    const infix = position > 0 && position < wordCount - 1;
    seen += 1;
    const prevWord = afterSentenceEnd ? '' : lastWord;

    const infixWord = infix ? INFIX_WORDS.get(part) : undefined;
    if (infixWord !== undefined) {
      out.push(infixWord);
      lastWord = infixWord;
      continue;
    }

    const remnant = redactedPathRemnant(part);
    if (remnant !== null) {
      out.push(`${remnant.lead}${REDACTED_PATH}${remnant.trail}`);
      lastWord = lastWordOf(REDACTED_PATH);
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
    if (core.toLowerCase() === 'redacted') {
      // The speech pipeline's own placeholder: "[redacted]" is spoken as "redacted". Every pair of
      // brackets around it goes in this one step ("[[redacted]]" would otherwise take a pass per pair).
      const pairs = placeholderBracketPairs(lead, trail);
      if (pairs > 0) {
        out.push(`${lead.slice(0, lead.length - pairs)}${core}${trail.slice(pairs)}`);
        lastWord = 'redacted';
        continue;
      }
    }

    // A timestamp is never dropped: it is "a set time" wherever it stands, and the text around it is left as written.
    const replacement = TIMESTAMP.test(core)
      ? (position === 0 || afterSentenceEnd ? SET_TIME_AT_START : SET_TIME)
      : speakCore(core, prevWord);
    if (replacement === null) {
      out.push(part);
      // A token that is only punctuation (the "," of "commit , 3f2a9c1", which the end of the pass closes up into
      // "commit,") leaves the word before it in place, as it will look in the next pass.
      if (core !== '') lastWord = core.toLowerCase();
      continue;
    }

    out.push(`${lead}${replacement}${trail}`);
    lastWord = lastWordOf(replacement);
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

/**
 * Most passes the fixed-point loop will run. Real text settles in two or three (see {@link settleSpeakable});
 * the cap only exists so that a bug can never turn into a long loop.
 */
const MAX_PASSES = 6;

/** The text without a heading or bullet marker at its very start (see {@link stripLineMarkers}). */
function stripHeadMarkers(text: string): string {
  return stripLineMarkers({ text, block: false }).text;
}

function speakableOnce(input: string): string {
  const text = input.length > MAX_INPUT_CHARS ? input.slice(0, MAX_INPUT_CHARS) : input;
  // A trailing "..." goes first, so the word it was glued to is a whole token for the rewrite below ("snake_case…").
  const joined = collapseTrailingEllipsis(stripHeadMarkers(joinLines(prepareLines(text))));
  // The text may still START with a marker the line rules could not see: a first line that is only a marker
  // ("-") joins with the line after it ("- fixed it"), and "- 3f2a9c1d8e0b" is "- an ID" only once the tokens are
  // rewritten, "• /" is "• /." only once the sentence end is added. So the head is stripped once more at the very
  // end of the pass: no output ever begins with a marker that the next pass would remove.
  return stripHeadMarkers(ensureSentenceEnd(tidy(rewriteTokens(joined))));
}

export interface SettleResult {
  text: string;
  /** How many times `once` ran, the last run being the one that found nothing left to change. */
  passes: number;
  /** False when the text had not settled after `maxPasses`: `text` is then the fallback answer (see {@link settleSpeakable}). */
  settled: boolean;
}

function runToFixedPoint(input: string, once: (text: string) => string, maxPasses: number): SettleResult {
  let current = input;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const next = once(current);
    if (next === current) return { text: next, passes: pass, settled: true };
    current = next;
  }
  return { text: current, passes: maxPasses, settled: false };
}

/**
 * Run `once` until its output stops changing: a rewrite can expose new work (a code span that
 * only pairs once two lines are joined), and running to a fixed point is what makes
 * {@link makeSpeakable} idempotent.
 *
 * If the text has not settled after `maxPasses`, the answer is the input with only its whitespace
 * collapsed, so a pathological input is never half-rewritten, and the result says `settled: false`.
 * That answer is idempotent too, by construction, not by luck: the collapsed text is run through the
 * same loop first. If it settles, its settled form is the answer (a fixed point, so calling again
 * returns it); if it does not, the collapsed text is the answer, and calling again collapses it again
 * (collapsing is idempotent) after the same failed loop. Either way `settle(settle(x)) === settle(x)`.
 *
 * Exported for the tests, which pass a `once` that never settles; not part of the module's contract.
 */
export function settleSpeakable(
  input: string,
  once: (text: string) => string = speakableOnce,
  maxPasses: number = MAX_PASSES,
): SettleResult {
  const first = runToFixedPoint(input, once, maxPasses);
  if (first.settled) return first;
  const collapsed = input.slice(0, MAX_INPUT_CHARS).replace(/\s+/g, ' ').trim();
  const second = runToFixedPoint(collapsed, once, maxPasses);
  // `settled` stays false: the cap was hit, and a caller (or a test) must be able to see that.
  return { text: second.settled ? second.text : collapsed, passes: maxPasses, settled: false };
}

/**
 * Rewrite `text` so it is short and pronounceable. Returns the empty string
 * for empty or non-string input and the (trimmed) input unchanged on any
 * internal error. Input beyond {@link MAX_INPUT_CHARS} characters is dropped.
 */
export function makeSpeakable(text: string): string {
  if (typeof text !== 'string') return '';
  try {
    return settleSpeakable(text).text;
  } catch {
    return text.trim();
  }
}
