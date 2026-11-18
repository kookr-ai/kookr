#!/usr/bin/env node
// SessionStart injector for the Agent Notebook — inject the notebook INDEX so
// the agent starts a task already seeing what experience exists, without
// spending a call.
//
// This follows the published agent-notebook harness recipe
// (examples/hooks/claude-code/nb-session-start.sh): inject the `nb list`
// index — each notebook (shelf) with its one-line "open me when…" description — and
// let the agent open the shelves that fit its task. It is deliberately
// role-agnostic: there is no NB_ROLE and the hook never opens a shelf for the agent.
// With a repo slug it only groups and filters the index by shelf name (see "Layered
// view" below). The same injection runs for every session, so a lesson the agent would never
// think to search for still reaches it by meeting a shelf's trigger in the index.
//
// The index is small by construction (one line per shelf), so we inject it directly
// — no retrieval needed (a size bound, below, covers a store that outgrows that).
// Output goes to stdout, which Claude Code adds to
// the session context for a SessionStart hook.
//
// Fail-open everywhere: a session start is never blocked and the exit code is always
// 0. Two failure shapes are told apart, because a broken store must not look empty:
//   - `nb` is not installed (spawn ENOENT): stay silent — hosts without it must not
//     get noise in every session.
//   - `nb` is present but times out or exits non-zero: print a one-line WARNING on
//     STDOUT. Only stdout reaches the agent; stderr from a SessionStart hook never does.
// The injected output is bounded (60 rows / 8 KB, the fixed instructions above the index
// included) so a large store cannot overflow the session context; the rest stays one
// `nb list` away.
//
// Layered view (RFC docs/rfc/rfc-notebook-memory-layers.md, issue #3592). Memory is
// layered project > domain > global, and a shelf's layer is derived from its NAME
// (plugin/hooks/lib/notebook-layers.mjs, the one place that decides it). When the
// repo's slug is known (`KOOKR_REPO_SLUG`, trimmed; empty = unset) and the kill switch
// `KOOKR_NB_LAYERS=0` is off, the index shows this repo's own shelves first (never
// truncated), then the domain shelves, then `fleet-global`, hides other repos' shelves
// behind a count, and states which layer wins and where a new lesson goes. Without a
// slug, with the kill switch on, or when the layers module cannot be loaded or `nb`
// answers in an unexpected shape, it prints today's flat index instead.
//
// Both views state the store problems `nb` reports only on stderr (files it skipped,
// shelves holding merge-conflict markers; see storeWarnings). The flat view reads its
// rows from the text `nb list`, so it gets those problems from one extra, best-effort
// `nb list --json` call (or reuses the JSON the layered attempt already fetched); if
// that call fails in any way the flat index is printed without them (issue #3836).
import { execFileSync } from 'node:child_process';

const TIMEOUT_MS = 4000;
const MAX_ROWS = 60;
const MAX_BYTES = 8 * 1024;
const TAIL_RESERVE = 96; // bytes kept free for the "N more" line
const DESC_WIDTH = 80; // `nb list` bounds a description column to 80 characters
const MAX_NAMED = 5; // shelves a store warning names before it says "and N more"
const NAME_WIDTH = 60; // characters of one shelf name a store warning shows
const WARN_TIMEOUT_MS = 2000; // the flat view's extra `nb list --json` call, best-effort only

// The fixed instructions printed above the index. The 8 KB bound is on everything the
// hook prints, so these bytes come out of the index's budget (the extra 1 is a byte of
// slack: the budget loops already charge one newline per line, the final one included).
const PREAMBLE =
  `## Your agent-notebook index\n` +
  `Below is an index of your notebooks. Each one is a "shelf": a short, bounded list of ` +
  `one-line lessons for one kind of task, written by you and other agents on past tasks. ` +
  `Each line shows the shelf name, how many lessons it holds, and when to open it.\n` +
  `Open the shelves that fit this task with \`nb show <shelf>\` (the shelf name is the first ` +
  `column) and apply what they say. If the work turns up a new kind of problem, check the ` +
  `index again and open another shelf.\n` +
  `At the end you will be asked for a short retrospective on the shelves you opened — vote the ` +
  `lessons that helped, \`nb rm\` any that were wrong, and \`nb add\` at most one new lesson (or none). ` +
  `Even if you opened no shelf, add it to a shelf from this index if one fits; create a new shelf only ` +
  `if none does. ` +
  `Vote by the \`<id>\` \`nb show\` prints at the start of each line, not a fuzzy text query (a ` +
  `non-unique query errors; the tool then prints the candidate ids). A new lesson is one line, ≤200 ` +
  `characters — an over-length \`nb add\` is rejected, not truncated.\n\n`;
const INDEX_BYTES = MAX_BYTES - Buffer.byteLength(PREAMBLE) - 1;

/**
 * Run `nb <args>` and return its trimmed stdout. A missing `nb` exits 0 silently; a
 * present-but-failing `nb` prints a one-line WARNING on STDOUT (the only stream that
 * reaches the agent) and exits 0, so a broken store is never mistaken for an empty one.
 */
function runNb(args) {
  try {
    return execFileSync('nb', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch (err) {
    const e = /** @type {{ code?: string, status?: number | null, signal?: string | null, stderr?: unknown }} */ (err ?? {});
    if (e.code === 'ENOENT') process.exit(0); // nb not installed — nothing to say
    const why =
      e.code === 'ETIMEDOUT'
        ? `timed out after ${TIMEOUT_MS / 1000}s`
        : e.status != null
          ? `exited with status ${e.status}`
          : e.signal
            ? `was killed by ${e.signal}`
            : `could not run (${e.code ?? 'unknown error'})`;
    const detail = String(e.stderr ?? '').trim().split('\n')[0].slice(0, 200);
    process.stdout.write(
      `## Your agent-notebook index\n` +
        `WARNING: \`nb list\` ${why}${detail ? `: ${detail}` : ''}. The notebook index is ` +
        `unavailable this session; that is not the same as an empty store. ` +
        `Run \`nb list\` yourself to see the error.\n`,
    );
    process.exit(0);
  }
}

// The layers module is loaded through a guarded dynamic import: a missing or broken file
// must degrade to the flat index, never fail the session start.
let layers = null;
try {
  layers = await import('./lib/notebook-layers.mjs');
} catch {
  /* flat index */
}

const slug = layers ? layers.repoSlugFromEnv() : undefined;
const layered = layers !== null && slug !== undefined && (process.env.KOOKR_NB_LAYERS ?? '').trim() !== '0';

let body = null;
let jsonRaw; // the layered attempt's `nb list --json` output, reused by the flat view
if (layered) {
  try {
    jsonRaw = runNb(['list', '--json', '--limit', '1000']);
    body = layeredIndex(jsonRaw, slug);
  } catch {
    body = null; // unexpected shape: fall back to the flat index below
  }
}
if (body === null) {
  // `nb list` shows 50 rows by default; ask for more so the cap applied below is ours.
  const index = runNb(['list', '--limit', '1000']);
  const listing = jsonListing(jsonRaw);
  const warnings = storeWarnings(listing);
  // Empty store → `nb list` leaves stdout empty (its "no notebooks yet" notice
  // goes to stderr). Nothing to surface → stay silent, unless the store has files
  // `nb` could not use: then it is not empty, and the warnings say why.
  if (!index && warnings.length === 0) process.exit(0);
  body = index ? boundIndex(index, warnings) : [emptyHeader(listing), ...warnings].join('\n');
}
if (body === '') process.exit(0);

/**
 * The parsed `nb list --json` listing for the flat view's store warnings: `raw` when
 * the layered attempt already fetched it, else one quiet call of its own. Any failure
 * (non-zero exit, timeout, output that is not JSON) gives null, so the flat index is
 * still printed, just without warnings; a broken `nb` is already reported by the text
 * call that ran first.
 */
function jsonListing(raw) {
  try {
    const text =
      raw ??
      execFileSync('nb', ['list', '--json', '--limit', '1000'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: WARN_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The index header for a store with no usable shelf (only warnings to show), in the
 * "N in <dir>" form of the `nb list` text header. Both views use it.
 */
function emptyHeader(listing) {
  return `agent-notebook notebooks — 0 in ${typeof listing?.dir === 'string' ? listing.dir : 'the notebook store'}`;
}

/**
 * Keep the header line plus at most MAX_ROWS rows and INDEX_BYTES bytes (whole rows
 * only; rows arrive richest-first, so the ones dropped are the thinnest). Adds a
 * "N more" tail when anything was dropped. `warnings` (store problems) go right under
 * the header and count against the byte budget.
 */
function boundIndex(text, warnings) {
  const lines = text.split('\n');
  const hasHeader = !/^\s/.test(lines[0]); // rows are indented; the header is not
  const header = hasHeader ? lines[0] : '';
  const rows = (hasHeader ? lines.slice(1) : lines).filter((l) => l.trim() !== '');
  // The header may itself say "50 of 75": nb knows the true total even if our
  // --limit cut the listing short.
  const totalFromHeader = Number(/ — (?:\d+ of )?(\d+) in /.exec(header)?.[1]);
  const total = Number.isFinite(totalFromHeader) && totalFromHeader >= rows.length ? totalFromHeader : rows.length;

  let used = [header, ...warnings].reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  const kept = [];
  for (const row of rows) {
    const cost = Buffer.byteLength(row) + 1;
    if (kept.length >= MAX_ROWS || used + cost > INDEX_BYTES - TAIL_RESERVE) break;
    kept.push(row);
    used += cost;
  }
  const out = (header ? [header] : []).concat(warnings, kept);
  if (kept.length < total) {
    const left = total - kept.length;
    out.push(`… ${left} more shel${left === 1 ? 'f' : 'ves'} not shown: run \`nb list --limit 1000\` (or \`nb list <prefix>\`) to see them`);
  }
  return out.join('\n');
}

/**
 * Warning lines for the parts of the store `nb list --json` reports as unusable. Since
 * agent-notebook 0.8.0 the listing carries two extra fields, present only when
 * non-empty: `skipped`, the `.md` files it could not use (unreadable, or not a valid
 * shelf name), which are missing from `rows`; and `conflicts`, the shelves holding git
 * merge-conflict markers, which are in `rows` but whose marker lines are counted as
 * lessons and to which every write is refused. `nb` reports both on stderr, which never
 * reaches the agent, so the index states them. Names come from disk: control
 * characters are shown as escapes, and each name and the number named are bounded.
 */
function storeWarnings(listing) {
  // The same escape as the one in scripts/lib/nb-client.mjs (snapshotStore). Keep the two
  // in step by hand: the plugin ships without the repository, so neither can import the other.
  const visible = (v) => {
    const text = String(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return text.length > NAME_WIDTH ? `${text.slice(0, NAME_WIDTH - 1)}…` : text;
  };
  const named = (items, label) => {
    const shown = items.slice(0, MAX_NAMED).map(label).join(', ');
    return items.length > MAX_NAMED ? `${shown} and ${items.length - MAX_NAMED} more` : shown;
  };
  const skipped = Array.isArray(listing?.skipped) ? listing.skipped : [];
  const conflicts = Array.isArray(listing?.conflicts) ? listing.conflicts : [];
  const out = [];
  if (skipped.length) {
    const one = skipped.length === 1;
    const why = (s) => (s?.code === 'INVALID_NAME' ? 'not a valid shelf name' : visible(s?.code ?? 'unreadable'));
    out.push(
      `WARNING: ${skipped.length} file${one ? '' : 's'} in the store could not be used and ${one ? 'is' : 'are'} missing from this index: ` +
        `${named(skipped, (s) => `${visible(s?.shelf ?? '?')}.md (${why(s)})`)}. Run \`nb list\` to see why.`,
    );
  }
  if (conflicts.length) {
    const one = conflicts.length === 1;
    out.push(
      `WARNING: ${conflicts.length} shel${one ? 'f holds' : 'ves hold'} git merge-conflict markers, so some of ${one ? 'its' : 'their'} lines ` +
        `are not lessons and every write to ${one ? 'it' : 'them'} is refused until the conflict is resolved: ` +
        `${named(conflicts, (c) => visible(c?.shelf ?? '?'))}.`,
    );
  }
  return out;
}

/** One row of the layered view, laid out like `nb list`'s own rows. */
function renderRow(r, nameWidth, countWidth) {
  const trigger = r.desc ?? r.auto;
  let text = typeof trigger === 'string' ? trigger.replace(/\s+/g, ' ').trim() : '';
  if (text.length > DESC_WIDTH) text = `${text.slice(0, DESC_WIDTH - 1)}…`;
  const descPart = text ? `  ${text}${r.desc == null ? '  (auto)' : ''}` : '';
  return `  ${r.shelf.padEnd(nameWidth)}  ${String(r.lessons).padStart(countWidth)}${descPart}`;
}

/**
 * Group `nb list --json` rows by layer for the repo `slug` and render the index block.
 * Returns '' for an empty store; throws on a shape it does not recognise (the caller
 * then falls back to the flat index).
 *
 * Caps: the project group is never truncated (it is the shelves most likely to apply
 * and is small). Domain and global rows fill what is left of the 60-row / INDEX_BYTES budget,
 * after the project rows and every fixed line; `fleet-global` is placed before the
 * domain rows so a long domain list can never push out the one host-wide shelf.
 */
function layeredIndex(raw, slug) {
  const listing = JSON.parse(raw);
  const rows = listing?.rows;
  if (!Array.isArray(rows) || rows.some((r) => typeof r?.shelf !== 'string')) throw new Error('unexpected nb list --json shape');
  const warnings = storeWarnings(listing);
  if (rows.length === 0) {
    return warnings.length ? [emptyHeader(listing), ...warnings].join('\n') : '';
  }

  const aliases = layers.loadSlugAliases();
  const mine = layers.canonicalSlug(slug, aliases);
  const project = [];
  const domain = [];
  const global = [];
  let hidden = 0;
  let malformed = 0;
  for (const r of rows) {
    const c = layers.classifyShelf(r.shelf, aliases);
    if (c.layer === 'global') global.push(r);
    else if (c.layer === 'domain') domain.push(r);
    else if (c.layer === 'project') {
      if (c.canonical === mine) project.push(r);
      else hidden++;
    } else malformed++; // an `@` with an empty base or slug belongs to no layer
  }

  const width = (group) => ({
    name: group.reduce((w, r) => Math.max(w, r.shelf.length), 0),
    count: group.reduce((w, r) => Math.max(w, String(r.lessons).length), 0),
  });
  const render = (group) => {
    const w = width(group);
    return group.map((r) => renderRow(r, w.name, w.count));
  };

  const noun = (n) => `${n} shel${n === 1 ? 'f' : 'ves'}`;
  const projectTitle = `Project shelves — true only in this repo (${slug}):`;
  const domainTitle = 'Domain shelves — true in any repo:';
  const globalTitle = 'Global — host-wide facts, written only by promotion:';
  const hiddenLine =
    (project.length
      ? `${noun(hidden)} for other projects hidden (slug: ${slug}); \`nb list --limit 1000\` shows all`
      : `No shelf is scoped to this project yet (slug: ${slug}); ${noun(hidden)} for other projects hidden; \`nb list --limit 1000\` shows all`) +
    (malformed ? `; ${noun(malformed)} with a malformed name skipped` : '');
  const precedence = 'Precedence: when shelves disagree, the more specific layer wins: project > domain > global.';
  const placement =
    `Placement: add to <situation>@<slug> (slug = $KOOKR_REPO_SLUG (here: ${slug})) unless the lesson ` +
    `would be true in another repo, then add it to the unscoped <situation> shelf instead. ` +
    `Never write fleet-global directly.`;
  const header = `agent-notebook notebooks — ${rows.length} of ${rows.length} in ${listing.dir ?? 'the notebook store'}`;
  const moreTail = `… ${rows.length} more shelves not shown: run \`nb list --limit 1000\` (or \`nb list <prefix>\`) to see them`;
  // Bytes every line that is always printed takes, plus the header and the "more" tail
  // at their longest, so the rows below can fill exactly what is left of the budget.
  const fixed = [projectTitle, domainTitle, globalTitle, hiddenLine, precedence, placement, header, moreTail, ...warnings];
  let used = fixed.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);

  const projectRows = render(project);
  for (const l of projectRows) used += Buffer.byteLength(l) + 1;
  let count = projectRows.length;
  const take = (group) => {
    const out = [];
    for (const l of render(group)) {
      const cost = Buffer.byteLength(l) + 1;
      if (count >= MAX_ROWS || used + cost > INDEX_BYTES) break; // the "more" tail is already in `fixed`
      out.push(l);
      used += cost;
      count++;
    }
    return out;
  };
  const globalRows = take(global);
  const domainRows = take(domain);
  const cut = domain.length + global.length - domainRows.length - globalRows.length;

  const out = [`agent-notebook notebooks — ${count} of ${rows.length} in ${listing.dir ?? 'the notebook store'}`, ...warnings];
  const section = (title, lines) => {
    if (lines.length) out.push(title, ...lines);
  };
  section(projectTitle, projectRows);
  section(domainTitle, domainRows);
  section(globalTitle, globalRows);
  if (cut > 0) out.push(`… ${cut} more shel${cut === 1 ? 'f' : 'ves'} not shown: run \`nb list --limit 1000\` (or \`nb list <prefix>\`) to see them`);
  out.push(hiddenLine, precedence, placement);
  return out.join('\n');
}

process.stdout.write(PREAMBLE + body + '\n');
process.exit(0);
