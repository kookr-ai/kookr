#!/usr/bin/env node
// apply-shelf-descriptions — seed the well-known Agent Notebook shelves with
// their situational `# desc:` triggers from plugin/notebooks/shelves.json
// (RFC docs/rfc/rfc-notebook-shelf-reorg.md, Slice C).
//
// A shelf's description is the "open me when…" trigger an agent reads from the
// `nb list` index; without it the index row falls back to the shelf's top lesson
// (`(auto)`) and is hard to choose deliberately. This makes the injected index a
// situational menu.
//
// Safe by construction — the two hazards the RFC's failure-mode review named are
// both avoided:
//   1. `nb describe <typo>` CREATES a described, zero-lesson orphan (exit 0). So
//      we NEVER describe a shelf that does not already exist on disk — a typo or
//      a not-yet-created shelf is skipped with a warning, not created.
//   2. A human may have written a better description. So we describe only a shelf
//      that currently has NO `# desc:` line; an existing one is left untouched.
// Idempotent: a second run is a no-op. One failing `nb describe` is isolated and
// does not abort the rest of the run. Run with --dry-run to preview.
//
// Project shelves (RFC docs/rfc/rfc-notebook-memory-layers.md, D4). A project
// shelf is `<base>@<slug>` (true only in one repo). Instead of listing every such
// shelf in the manifest, any EXISTING undescribed `base@slug` whose bare `base`
// has a manifest trigger is described as `<base trigger> (only in <slug>)`. Two
// kinds of shelf are never described, whatever the manifest says:
//   * a legacy-slug shelf (an alias source in plugin/notebooks/slug-aliases.json,
//     e.g. `@agent-notebook`): the slug migration empties it, and `nb` keeps an
//     emptied *described* shelf as a 0-lesson row forever, whereas it reaps an
//     emptied undescribed one.
//   * a 0-byte file: `nb describe` would write a header into the leftover of a
//     moved-out shelf and bring it back to life.
//
// The seeding logic (`hasDescription`, `applyDescriptions`) is exported so it can
// be unit-tested against a temp store with a stubbed `describe`; the CLI block at
// the bottom runs only when this file is executed directly.
//
// Usage: node scripts/apply-shelf-descriptions.mjs [--dry-run] [--manifest <path>] [--map <path>]
//   --map  slug-aliases.json override (legacy slug -> canonical slug)
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyShelf, loadSlugAliases } from '../plugin/hooks/lib/notebook-layers.mjs';
import { blankNbDir, checkArgv } from './lib/nb-client.mjs';

/** `nb describe` rejects text over NB_MAX_CHARS (default 200). */
const MAX_DESC_CHARS = 200;

// Agent Notebook's own metadata-line grammar (agent-notebook notebook.js
// `META_RE`). Mirror it EXACTLY so "already described?" means the same thing to
// us as to `nb`: nb accepts `#desc:`, `#  desc:`, and `#\tdesc:` as the `desc`
// key, not only the canonical `# desc: `. Detecting with a bare
// `startsWith('# desc:')` would miss a human's non-canonically-spaced line and
// then overwrite it — the exact hazard property #2 forbids.
// The same goes for how nb splits the file into lines: since agent-notebook 0.8.0
// it strips one leading UTF-8 byte-order mark and accepts CRLF line ends, so a
// description in such a file is one nb reads, and must count as present here too.
const META_RE = /^#\s*([a-z][a-z0-9_-]*):\s?(.*)$/;

/** True if the <shelf>.md file already carries a non-empty `desc` metadata line. */
export function hasDescription(file) {
  // Scan the leading header block (metadata + blank lines); stop at the first
  // real lesson line. A `desc` key with a non-empty value means "described".
  const raw = readFileSync(file, 'utf-8');
  for (const line of (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).split(/\r?\n/)) {
    const m = META_RE.exec(line);
    if (m && m[1] === 'desc' && m[2].trim() !== '') return true;
    if (line.trim() === '' || line.startsWith('#')) continue; // blank or any header line
    break; // first non-blank, non-header line = a lesson → past the header block
  }
  return false;
}

/**
 * Apply `shelves` (name → trigger) into the notebook store at `dir`.
 * Describes only a shelf that already exists on disk and has no `# desc:` yet.
 * `describe(shelf, text)` performs the write (injectable for tests); `log` sinks
 * progress lines. Returns a summary of what happened.
 */
export function applyDescriptions({
  dir,
  shelves,
  dryRun = false,
  describe,
  log = () => {},
  aliases = loadSlugAliases(),
}) {
  let described = 0;
  let skippedAbsent = 0;
  let skippedDescribed = 0;
  let skippedLegacy = 0;
  let skippedEmpty = 0;
  const failed = [];
  for (const [shelf, desc] of Object.entries(shelves)) {
    const file = join(dir, `${shelf}.md`);
    if (!existsSync(file)) {
      // Pre-flight: never let `describe` create an orphan for a shelf that does
      // not exist yet. It is described the next run after it earns a first lesson.
      log(`  skip (absent)     ${shelf}`);
      skippedAbsent++;
      continue;
    }
    const cls = classifyShelf(shelf, aliases);
    if (cls.layer === 'project' && cls.legacy) {
      log(`  skip (legacy slug) ${shelf}`);
      skippedLegacy++;
      continue;
    }
    if (statSync(file).size === 0) {
      log(`  skip (empty file) ${shelf}`);
      skippedEmpty++;
      continue;
    }
    if (hasDescription(file)) {
      log(`  skip (has desc)   ${shelf}`);
      skippedDescribed++;
      continue;
    }
    if (dryRun) {
      log(`  would describe    ${shelf} :: ${desc}`);
      described++;
      continue;
    }
    try {
      describe(shelf, desc);
      log(`  described         ${shelf}`);
      described++;
    } catch (err) {
      // Isolate a single failure (e.g. a transient write) so the rest still run.
      log(`  FAILED            ${shelf}: ${err?.message ?? err}`);
      failed.push(shelf);
    }
  }
  return {
    described,
    skippedDescribed,
    skippedAbsent,
    skippedLegacy,
    skippedEmpty,
    failed,
    total: Object.keys(shelves).length,
  };
}

/**
 * Join a base trigger and a slug into `<trigger> (only in <slug>)`, shortening
 * the trigger (at a word boundary, with an ellipsis) when the whole line would
 * exceed `nb`'s description cap. Returns `null` if even the suffix cannot fit.
 */
export function composeProjectDescription(trigger, slug, max = MAX_DESC_CHARS) {
  const suffix = ` (only in ${slug})`;
  const room = max - suffix.length;
  if (room < 8) return null;
  let head = trigger.trim();
  if (head.length > room) {
    head = head.slice(0, room - 1);
    const lastSpace = head.lastIndexOf(' ');
    if (lastSpace > room / 2) head = head.slice(0, lastSpace);
    head = `${head.replace(/[\s,;:.\-]+$/, '')}…`;
  }
  return `${head}${suffix}`;
}

/**
 * Derive project-shelf descriptions for the shelves that exist in the store.
 * `manifestShelves` is the manifest's name -> trigger map; `shelfNames` are the
 * names on disk. A `base@slug` whose bare `base` has a trigger gets
 * `<trigger> (only in <slug>)` unless the manifest already lists that exact
 * shelf (an explicit entry wins). Legacy-slug shelves are skipped. Pure: it
 * creates nothing, so a derived name always refers to an existing shelf.
 */
export function deriveProjectDescriptions({ manifestShelves, shelfNames, aliases = loadSlugAliases() }) {
  const derived = {};
  for (const name of shelfNames) {
    if (Object.hasOwn(manifestShelves, name)) continue;
    const cls = classifyShelf(name, aliases);
    if (cls.layer !== 'project' || cls.legacy) continue;
    const trigger = Object.hasOwn(manifestShelves, cls.base) ? manifestShelves[cls.base] : undefined;
    if (typeof trigger !== 'string' || trigger.trim() === '') continue;
    const text = composeProjectDescription(trigger, cls.slug);
    if (text !== null) derived[name] = text;
  }
  return derived;
}

/** Shelf names (without `.md`) present in a notebooks directory, README excluded. */
export function listShelfFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => f.slice(0, -3))
    .sort();
}

/** Legacy-slug project shelves present on disk: the ones the seed deliberately leaves alone. */
export function legacyShelfNames({ dir, aliases = loadSlugAliases() }) {
  return listShelfFiles(dir).filter((name) => {
    const cls = classifyShelf(name, aliases);
    return cls.layer === 'project' && cls.legacy;
  });
}

/**
 * The full seed for a store: the manifest's entries plus project-shelf
 * descriptions derived for the shelves that exist. This is what the CLI applies,
 * and what the migration script re-applies after it creates new canonical shelves.
 */
export function buildSeed({ dir, manifestShelves, aliases = loadSlugAliases() }) {
  const derived = deriveProjectDescriptions({ manifestShelves, shelfNames: listShelfFiles(dir), aliases });
  return { ...manifestShelves, ...derived };
}

/** Resolve the notebooks directory from the `nb` CLI (honors NB_DIR / the kookr shim). */
function notebooksDir() {
  return execFileSync('nb', ['path'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function main(argv) {
  const argProblem = checkArgv(argv, { switches: ['--dry-run'], values: ['--manifest', '--map'] }) ?? blankNbDir();
  if (argProblem) {
    console.error(`apply-shelf-descriptions: ${argProblem}. Nothing was changed.`);
    process.exit(2);
  }
  const dryRun = argv.includes('--dry-run');
  const manifestIdx = argv.indexOf('--manifest');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath =
    manifestIdx >= 0 && argv[manifestIdx + 1]
      ? argv[manifestIdx + 1]
      : join(repoRoot, 'plugin', 'notebooks', 'shelves.json');

  const mapIdx = argv.indexOf('--map');
  let aliases;
  try {
    aliases = loadSlugAliases(mapIdx >= 0 ? argv[mapIdx + 1] : undefined, { strict: mapIdx >= 0 });
  } catch (err) {
    console.error(`apply-shelf-descriptions: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`);
    process.exit(2);
  }
  let dir;
  try {
    dir = notebooksDir();
  } catch {
    console.error('apply-shelf-descriptions: `nb` is not on PATH — nothing applied (fail-open).');
    process.exit(0);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const seed = buildSeed({ dir, manifestShelves: manifest.shelves ?? {}, aliases });
  for (const legacy of legacyShelfNames({ dir, aliases })) console.log(`  skip (legacy slug) ${legacy}`);
  const r = applyDescriptions({
    dir,
    shelves: seed,
    aliases,
    dryRun,
    describe: (shelf, desc) =>
      execFileSync('nb', ['describe', shelf, desc], { stdio: ['ignore', 'ignore', 'inherit'] }),
    log: (line) => console.log(line),
  });

  const legacyCount = legacyShelfNames({ dir, aliases }).length + r.skippedLegacy;
  console.log(
    `\napply-shelf-descriptions: ${dryRun ? 'would describe' : 'described'} ${r.described}, ` +
      `skipped ${r.skippedDescribed} already-described, ${r.skippedAbsent} not-yet-created, ` +
      `${legacyCount} legacy-slug, ${r.skippedEmpty} empty-file ` +
      `(of ${r.total} in the seed: manifest entries plus derived project shelves) in ${dir}`,
  );
  if (r.failed.length) {
    console.error(`apply-shelf-descriptions: ${r.failed.length} failed: ${r.failed.join(', ')}`);
    process.exit(1);
  }
}

// Run the CLI only when executed directly, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
