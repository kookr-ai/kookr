#!/usr/bin/env node
// apply-notebook-protocol — keep the "Notebook Protocol" section of every
// plugin/agents/*.md and plugin/reviewer-specialists/*.md identical to one shared template.
//
// Why this exists: a subagent gets no SessionStart index, so the only place it
// learns which Agent Notebook shelves to open, and where a new lesson belongs,
// is its own agent definition (RFC docs/rfc/rfc-notebook-memory-layers.md, D2b).
// Hand-edited copies in 23 files drift, so the text lives once, in
// plugin/skills/notebook-role-reuse/references/notebook-protocol.md, and this
// script stamps it into each agent doc. A test (src/plugin/notebook-protocol.test.ts)
// runs the same check and fails when any copy differs from the template.
//
// What it touches: only the `## Notebook Protocol` section (from that heading
// to the next `## ` heading or end of file) of an agent doc that already HAS
// one. A doc without the section (product-owner, user-test-simulator) is left
// alone: a role that never wrote the notebook must not start writing it.
// The shelf name is the doc's frontmatter `name`; the template's {{SHELF}}
// placeholder is replaced with it. It never touches the notebook store.
//
// Second target (issue #3598): plugin/reviewer-specialists/*.md. They are prompt
// bodies with no frontmatter, shared by every review lens, and all of them use
// the one `code-review` shelf, so their shelf is fixed (SPECIALIST_SHELF) instead
// of read from a `name`. Same template, same check.
//
// Usage: node scripts/apply-notebook-protocol.mjs [--check] [--agents-dir <dir>]
//          [--specialists-dir <dir>] [--template <file>]
//   (no flag)  rewrite drifted docs in place; idempotent
//   --check    write nothing; exit 1 and list the docs that differ from the template
//   Both directories are processed by default. Passing --agents-dir alone
//   (a test fixture, say) leaves the specialists alone; pass --specialists-dir too to include them.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
export const DEFAULT_AGENTS_DIR = join(repoRoot, 'plugin', 'agents');
export const DEFAULT_TEMPLATE = join(
  repoRoot,
  'plugin',
  'skills',
  'notebook-role-reuse',
  'references',
  'notebook-protocol.md',
);

export const DEFAULT_SPECIALISTS_DIR = join(repoRoot, 'plugin', 'reviewer-specialists');
/** The one shelf every reviewer specialist reads and writes (its project layer is `code-review@$KOOKR_REPO_SLUG`). */
export const SPECIALIST_SHELF = 'code-review';

export const SECTION_HEADING = '## Notebook Protocol';
const PLACEHOLDER = /\{\{SHELF\}\}/g;

/** The shelf an agent doc owns: its frontmatter `name`. Null when there is none. */
export function shelfNameOf(doc) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(doc);
  const m = fm && /^name:\s*(\S+)\s*$/m.exec(fm[1]);
  return m ? m[1] : null;
}

/** The template with this agent's shelf substituted, ending in exactly one newline. */
export function renderProtocol(template, shelf) {
  return template.replace(PLACEHOLDER, shelf).trimEnd() + '\n';
}

/** Bounds of the Notebook Protocol section: [start, end) offsets, or null if the doc has none. */
export function findSection(doc) {
  const start = doc.search(/^## Notebook Protocol\b.*$/m);
  if (start === -1) return null;
  const rest = doc.slice(start + SECTION_HEADING.length);
  const next = rest.search(/^## /m);
  return { start, end: next === -1 ? doc.length : start + SECTION_HEADING.length + next };
}

/**
 * The doc with its Notebook Protocol section replaced by the rendered template.
 * Returns the doc unchanged when it has no section.
 */
export function applyToDoc(doc, template, shelfOverride = null) {
  const span = findSection(doc);
  if (!span) return doc;
  const shelf = shelfOverride ?? shelfNameOf(doc);
  if (!shelf) throw new Error('agent doc has a Notebook Protocol section but no frontmatter `name`');
  const block = renderProtocol(template, shelf);
  const tail = doc.slice(span.end);
  // Keep one blank line between the block and a following section; none at end of file.
  return doc.slice(0, span.start) + block + (tail === '' ? '' : '\n' + tail.replace(/^\n+/, ''));
}

/**
 * Compare every agent doc against the template.
 * @returns {{ file: string, hasSection: boolean, drifted: boolean }[]}
 */
export function checkAgentDocs(agentsDir, template, shelfOverride = null) {
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const doc = readFileSync(join(agentsDir, f), 'utf-8');
      const hasSection = findSection(doc) !== null;
      return { file: f, hasSection, drifted: hasSection && applyToDoc(doc, template, shelfOverride) !== doc };
    });
}

/** Rewrite drifted docs in place. @returns the file names it changed. */
export function applyAgentDocs(agentsDir, template, shelfOverride = null) {
  const changed = [];
  for (const { file, drifted } of checkAgentDocs(agentsDir, template, shelfOverride)) {
    if (!drifted) continue;
    const path = join(agentsDir, file);
    writeFileSync(path, applyToDoc(readFileSync(path, 'utf-8'), template, shelfOverride));
    changed.push(file);
  }
  return changed;
}

function main(argv) {
  const opt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const template = readFileSync(opt('--template', DEFAULT_TEMPLATE), 'utf-8');
  // Each target: a directory plus the shelf override (null = read the doc's frontmatter `name`).
  const targets = [];
  const agentsDir = opt('--agents-dir', null);
  const specialistsDir = opt('--specialists-dir', null);
  if (agentsDir || !specialistsDir) targets.push({ dir: agentsDir ?? DEFAULT_AGENTS_DIR, shelf: null });
  // A bare --agents-dir (a fixture) must not rewrite the real specialists, so they join only by default or by name.
  if (specialistsDir || !agentsDir) {
    targets.push({ dir: specialistsDir ?? DEFAULT_SPECIALISTS_DIR, shelf: SPECIALIST_SHELF });
  }
  const label = (dir, file) => `${basename(dir)}/${file}`;
  if (argv.includes('--check')) {
    const drifted = targets.flatMap(({ dir, shelf }) =>
      checkAgentDocs(dir, template, shelf)
        .filter((r) => r.drifted)
        .map((r) => label(dir, r.file)),
    );
    if (drifted.length === 0) {
      console.log('notebook protocol: all docs match the template');
      return 0;
    }
    console.error(
      `notebook protocol: ${drifted.length} doc(s) differ from the template; run \`node scripts/apply-notebook-protocol.mjs\`:\n` +
        drifted.map((f) => `  ${f}`).join('\n'),
    );
    return 1;
  }
  const changed = targets.flatMap(({ dir, shelf }) =>
    applyAgentDocs(dir, template, shelf).map((f) => label(dir, f)),
  );
  console.log(`notebook protocol: updated ${changed.length} doc(s)`);
  for (const f of changed) console.log(`  ${f}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
