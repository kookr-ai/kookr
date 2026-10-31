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
// The seeding logic (`hasDescription`, `applyDescriptions`) is exported so it can
// be unit-tested against a temp store with a stubbed `describe`; the CLI block at
// the bottom runs only when this file is executed directly.
//
// Usage: node scripts/apply-shelf-descriptions.mjs [--dry-run] [--manifest <path>]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Agent Notebook's own metadata-line grammar (agent-notebook notebook.js
// `META_RE`). Mirror it EXACTLY so "already described?" means the same thing to
// us as to `nb`: nb accepts `#desc:`, `#  desc:`, and `#\tdesc:` as the `desc`
// key, not only the canonical `# desc: `. Detecting with a bare
// `startsWith('# desc:')` would miss a human's non-canonically-spaced line and
// then overwrite it — the exact hazard property #2 forbids.
const META_RE = /^#\s*([a-z][a-z0-9_-]*):\s?(.*)$/;

/** True if the <shelf>.md file already carries a non-empty `desc` metadata line. */
export function hasDescription(file) {
  // Scan the leading header block (metadata + blank lines); stop at the first
  // real lesson line. A `desc` key with a non-empty value means "described".
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
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
export function applyDescriptions({ dir, shelves, dryRun = false, describe, log = () => {} }) {
  let described = 0;
  let skippedAbsent = 0;
  let skippedDescribed = 0;
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
  return { described, skippedDescribed, skippedAbsent, failed, total: Object.keys(shelves).length };
}

/** Resolve the notebooks directory from the `nb` CLI (honors NB_DIR / the kookr shim). */
function notebooksDir() {
  return execFileSync('nb', ['path'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const manifestIdx = argv.indexOf('--manifest');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath =
    manifestIdx >= 0 && argv[manifestIdx + 1]
      ? argv[manifestIdx + 1]
      : join(repoRoot, 'plugin', 'notebooks', 'shelves.json');

  let dir;
  try {
    dir = notebooksDir();
  } catch {
    console.error('apply-shelf-descriptions: `nb` is not on PATH — nothing applied (fail-open).');
    process.exit(0);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const r = applyDescriptions({
    dir,
    shelves: manifest.shelves ?? {},
    dryRun,
    describe: (shelf, desc) =>
      execFileSync('nb', ['describe', shelf, desc], { stdio: ['ignore', 'ignore', 'inherit'] }),
    log: (line) => console.log(line),
  });

  console.log(
    `\napply-shelf-descriptions: ${dryRun ? 'would describe' : 'described'} ${r.described}, ` +
      `skipped ${r.skippedDescribed} already-described, ${r.skippedAbsent} not-yet-created ` +
      `(of ${r.total} in the manifest) in ${dir}`,
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
