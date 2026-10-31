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
// Idempotent: a second run is a no-op. Run with --dry-run to preview.
//
// Usage: node scripts/apply-shelf-descriptions.mjs [--dry-run] [--manifest <path>]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const manifestIdx = argv.indexOf('--manifest');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath =
  manifestIdx >= 0 && argv[manifestIdx + 1]
    ? argv[manifestIdx + 1]
    : join(repoRoot, 'plugin', 'notebooks', 'shelves.json');

/** Resolve the notebooks directory from the `nb` CLI (honors NB_DIR / the kookr shim). */
function notebooksDir() {
  try {
    return execFileSync('nb', ['path'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    console.error('apply-shelf-descriptions: `nb` is not on PATH — nothing applied (fail-open).');
    process.exit(0);
  }
}

function hasDescription(file) {
  // The `# desc:` line is a leading comment in the <shelf>.md file.
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (line.startsWith('# desc:')) return true;
    if (line.trim() !== '' && !line.startsWith('#')) break; // past the header block
  }
  return false;
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const shelves = manifest.shelves ?? {};
const dir = notebooksDir();

let described = 0;
let skippedAbsent = 0;
let skippedDescribed = 0;
for (const [shelf, desc] of Object.entries(shelves)) {
  const file = join(dir, `${shelf}.md`);
  if (!existsSync(file)) {
    // Pre-flight: never let `nb describe` create an orphan for a shelf that does
    // not exist yet. It will be described the next time this runs after the shelf
    // earns its first lesson.
    console.log(`  skip (absent)     ${shelf}`);
    skippedAbsent++;
    continue;
  }
  if (hasDescription(file)) {
    console.log(`  skip (has desc)   ${shelf}`);
    skippedDescribed++;
    continue;
  }
  if (dryRun) {
    console.log(`  would describe    ${shelf} :: ${desc}`);
  } else {
    execFileSync('nb', ['describe', shelf, desc], { stdio: ['ignore', 'ignore', 'inherit'] });
    console.log(`  described         ${shelf}`);
  }
  described++;
}

console.log(
  `\napply-shelf-descriptions: ${dryRun ? 'would describe' : 'described'} ${described}, ` +
    `skipped ${skippedDescribed} already-described, ${skippedAbsent} not-yet-created ` +
    `(of ${Object.keys(shelves).length} in the manifest) in ${dir}`,
);
