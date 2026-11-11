import { describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_AGENTS_DIR,
  DEFAULT_SPECIALISTS_DIR,
  DEFAULT_TEMPLATE,
  SPECIALIST_SHELF,
  applyToDoc,
  checkAgentDocs,
  findSection,
  renderProtocol,
  shelfNameOf,
} from '../../scripts/apply-notebook-protocol.mjs';

// Guards the shared "Notebook Protocol" block of the agent definitions
// (RFC docs/rfc/rfc-notebook-memory-layers.md, D2b / issue #3593) and, since issue #3598 (slice K5),
// of the reviewer specialists (plugin/reviewer-specialists/*.md, one shared `code-review` shelf) and the
// pre-pr-review skill step that launches them.
//
// A subagent gets no SessionStart index, so its agent doc is the only place it
// learns which shelves to open and where a new lesson belongs. That text has one
// source (plugin/skills/notebook-role-reuse/references/notebook-protocol.md),
// copied into each doc by scripts/apply-notebook-protocol.mjs. This file fails when:
//   - a doc's block differs from the source (hand edit, or source edited without rerunning the script);
//   - a doc hardcodes a bare shelf with no project line (`nb show X` without `nb show X@$KOOKR_REPO_SLUG`);
//   - a doc restates the notebook tool's own limits or eviction rules (they live only in
//     docs/reference/agent-notebook.md).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'apply-notebook-protocol.mjs');
const template = readFileSync(DEFAULT_TEMPLATE as string, 'utf-8');
const agentsDir = DEFAULT_AGENTS_DIR as string;
const specialistsDir = DEFAULT_SPECIALISTS_DIR as string;
const specialistShelf = SPECIALIST_SHELF as string;
const specialistFiles = readdirSync(specialistsDir).filter((f) => f.endsWith('.md')).sort();

/** Agent docs that deliberately have no notebook section (a role that never wrote the notebook must not start). */
const NO_NOTEBOOK = ['product-owner.md', 'user-test-simulator.md'];
const agentFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.md')).sort();
const withProtocol = agentFiles.filter((f) => !NO_NOTEBOOK.includes(f));

// ---- guard predicates (pure, so the tests below can prove they fire) -------------------

/** Shelves an agent doc commands via `nb show|add|vote|rm <shelf>` that name a literal shelf (not `<shelf>`). */
function literalShelves(doc: string): string[] {
  const names = new Set<string>();
  for (const m of doc.matchAll(/\bnb (?:show|add|vote|rm) +`?([a-z][a-z0-9-]*)(@[^\s`"]*)?/g)) names.add(m[1]);
  return [...names];
}

/** Bare shelves that have no `nb show <shelf>@$KOOKR_REPO_SLUG` line, plus any legacy `@<owner>-<repo>` placeholder. */
function layerViolations(doc: string): string[] {
  const out: string[] = [];
  for (const shelf of literalShelves(doc)) {
    if (!doc.includes(`nb show ${shelf}@$KOOKR_REPO_SLUG`)) {
      out.push(`bare shelf "${shelf}" has no \`nb show ${shelf}@$KOOKR_REPO_SLUG\` line`);
    }
  }
  if (doc.includes('@<owner>-<repo>')) out.push('legacy "@<owner>-<repo>" placeholder; use @$KOOKR_REPO_SLUG');
  return out;
}

// What `nb` owns: a hard character cap, a quoted-id vote, and the eviction mechanism. The
// ~150-character target is deliberately allowed (RFC D2); a "≤N chars" cap is not.
const CHAR_UNIT = String.raw`\d+[\s-]*char`;
const RESTATED_NB_RULES: [string, RegExp][] = [
  [
    'a hard character cap ("≤120 chars", "max 200 characters", "200 chars max", "no more than 200 chars")',
    new RegExp(
      [
        String.raw`[\u2264<]=?\s*${CHAR_UNIT}`,
        String.raw`\b(?:at most|no more than|under|up to|capped at|max(?:imum)?|hard cap|cap of|limit of)\b[^.\n]{0,16}${CHAR_UNIT}`,
        String.raw`${CHAR_UNIT}\w*\W{0,3}(?:max(?:imum)?|cap(?:ped)?|limit|or (?:fewer|less))\b`,
      ].join('|'),
      'i',
    ),
  ],
  [
    'the eviction mechanism ("evicts the lowest-scored", "is evicted")',
    /\bevict(?:s|ed)\b|\bevict(?:ion of)?\s+(?:the\s+)?(?:lowest|oldest|weakest|least)|lowest[- ]scored/i,
  ],
  ['"when the shelf is full" behavior', /\b(?:shelf|notebook)\s+(?:is|gets|becomes)\s+full\b|\bfull notebook\b/i],
  ['a quoted-id vote (`nb vote X "<id>"`); pass bare ids', /\bnb (?:vote|rm) +\S+ +"/],
];
function restatedRules(doc: string): string[] {
  return RESTATED_NB_RULES.filter(([, re]) => re.test(doc)).map(([label]) => label);
}

// ---- the single source ------------------------------------------------------------------

describe('notebook protocol source (plugin/skills/notebook-role-reuse/references/notebook-protocol.md)', () => {
  const block = renderProtocol(template, 'example-shelf') as string;

  test('carries the Start steps for both layers, with the project layer winning', () => {
    expect(block).toContain('nb show example-shelf`');
    expect(block).toContain('nb show example-shelf@$KOOKR_REPO_SLUG');
    expect(block).toMatch(/project shelf wins/i);
    expect(block).toMatch(/does not exist yet is fine/i);
  });

  test('carries the slug caveat (inherited slug, unset slug)', () => {
    expect(block).toMatch(/inherits it even when its task is in another repo/);
    expect(block).toMatch(/skip the project read and the project write, and say so/);
    expect(block).toMatch(/If it is unset, skip the project read/);
    expect(block).toMatch(/never build a name that ends in `@`/);
  });

  test('carries the End steps: batch vote by id, rm reason codes, one ~150-char add, placement rule', () => {
    expect(block).toContain('nb vote <shelf> <id1,id2,…> +1');
    expect(block).toContain('nb rm <shelf> <id> --reason wrong|obsolete');
    expect(block).toMatch(/about 150 characters/);
    expect(block).toContain('example-shelf@$KOOKR_REPO_SLUG` unless it would be true in another repo');
    expect(block).toContain('unscoped `example-shelf` shelf');
    expect(block).toMatch(/Never write `fleet-global` directly/);
  });

  test('points to the reference doc and restates no nb rule', () => {
    expect(block).toContain('docs/reference/agent-notebook.md');
    expect(restatedRules(block)).toEqual([]);
    expect(layerViolations(block)).toEqual([]);
  });

  test('uses the same placement wording as the retrospective hook (plugin/hooks/nb-retro.mjs)', () => {
    const hook = readFileSync(join(repoRoot, 'plugin', 'hooks', 'nb-retro.mjs'), 'utf-8');
    // Hook: "add to <situation>@<slug> ... unless the lesson would be true in another repo, then
    // add it to the unscoped <situation> shelf instead. Never write fleet-global directly."
    for (const phrase of ['unless', 'true in another repo', 'unscoped', 'Never write fleet-global directly']) {
      expect(hook).toContain(phrase);
    }
    expect(block).toContain('unless it would be true in another repo');
    expect(block).toContain('unscoped');
    expect(block).toContain('Never write `fleet-global` directly');
  });
});

// ---- the applied copies -----------------------------------------------------------------

describe('plugin/agents/*.md carry the shared Notebook Protocol', () => {
  test('every doc with a notebook section is covered, and the two read-only-by-design docs stay without one', () => {
    expect(withProtocol.length).toBeGreaterThan(0);
    expect(withProtocol.every((f) => !NO_NOTEBOOK.includes(f))).toBe(true);
    for (const f of NO_NOTEBOOK) {
      expect(agentFiles, `${f} moved or was renamed; update NO_NOTEBOOK`).toContain(f);
      const doc = readFileSync(join(agentsDir, f), 'utf-8');
      expect(findSection(doc), `${f} must not gain a notebook section`).toBeNull();
      expect(doc).not.toMatch(/\bnb (?:show|add|vote|rm)\b/);
    }
    // A new agent doc must carry the section, or be added to NO_NOTEBOOK on purpose; otherwise
    // it would silently dodge every check below.
    for (const f of withProtocol) {
      expect(findSection(readFileSync(join(agentsDir, f), 'utf-8')), `${f} has no Notebook Protocol section`).not.toBeNull();
    }
  });

  test('every doc matches the single source (the script finds nothing to change)', () => {
    const drifted = (checkAgentDocs(agentsDir, template) as { file: string; drifted: boolean }[])
      .filter((r) => r.drifted)
      .map((r) => r.file);
    expect(drifted, 'run `node scripts/apply-notebook-protocol.mjs` to resync these docs').toEqual([]);
  });

  for (const f of withProtocol) {
    describe(f, () => {
      const doc = readFileSync(join(agentsDir, f), 'utf-8');
      const shelf = shelfNameOf(doc) as string;

      test('its shelf is its frontmatter name and it opens both layers', () => {
        expect(shelf, 'frontmatter name').toBeTruthy();
        expect(doc).toContain(`nb show ${shelf}\``);
        expect(doc).toContain(`nb show ${shelf}@$KOOKR_REPO_SLUG`);
      });

      test('no bare shelf without a project line, no restated nb rule', () => {
        expect(layerViolations(doc)).toEqual([]);
        expect(restatedRules(doc)).toEqual([]);
      });
    });
  }
});

// ---- the reviewer specialists (issue #3598) ---------------------------------------------

describe('plugin/reviewer-specialists/*.md carry the shared Notebook Protocol for the code-review shelf', () => {
  test('the specialists share one fixed shelf, code-review', () => {
    expect(specialistShelf).toBe('code-review');
    // Pinned so deleting a lens file fails here instead of silently shrinking coverage.
    expect(specialistFiles).toEqual([
      'a11y-specialist.md',
      'conventions-specialist.md',
      'correctness-specialist.md',
      'deadcode-specialist.md',
      'docs-drift-specialist.md',
      'test-specialist.md',
    ]);
  });

  test('every specialist body is matched to the single source (the script finds nothing to change)', () => {
    const drifted = (checkAgentDocs(specialistsDir, template, specialistShelf) as { file: string; drifted: boolean }[])
      .filter((r) => r.drifted)
      .map((r) => r.file);
    expect(drifted, 'run `node scripts/apply-notebook-protocol.mjs` to resync these docs').toEqual([]);
  });

  for (const f of specialistFiles) {
    describe(f, () => {
      const doc = readFileSync(join(specialistsDir, f), 'utf-8');

      test('has the section (a new specialist cannot dodge the checks) and opens both layers', () => {
        expect(findSection(doc), `${f} has no Notebook Protocol section`).not.toBeNull();
        expect(doc).toContain(`nb show ${specialistShelf}\``);
        expect(doc).toContain(`nb show ${specialistShelf}@$KOOKR_REPO_SLUG`);
      });

      test('no bare shelf without a project line, no restated nb rule, no old single-shelf wording', () => {
        expect(layerViolations(doc)).toEqual([]);
        expect(restatedRules(doc)).toEqual([]);
        expect(doc).not.toContain('<that shelf>');
        expect(doc).not.toContain('code-review@<owner>-<repo>');
      });
    });
  }
});

describe('the pre-pr-review skill hands the specialists both layers and points at the protocol', () => {
  const skill = readFileSync(join(repoRoot, 'plugin', 'skills', 'pre-pr-review', 'SKILL.md'), 'utf-8');
  const headerLines = skill.split('\n').filter((l) => l.includes('\\nNotebook shelf:'));

  test('every launch example names the project and the domain shelf', () => {
    expect(headerLines.length).toBeGreaterThanOrEqual(3);
    for (const l of headerLines) {
      expect(l).toContain('code-review@<owner>-<repo> (project layer) and code-review (domain layer)');
    }
  });

  test('states the slug caveat and points at the single source instead of restating the rule', () => {
    expect(skill).toMatch(/only when the diff under review belongs to the session's own repo/);
    expect(skill).toMatch(/`code-review` alone/);
    expect(skill).toContain('plugin/skills/notebook-role-reuse/references/notebook-protocol.md');
    expect(skill).toContain('scripts/apply-notebook-protocol.mjs');
  });

  test('restates no nb rule and no longer teaches a single shelf', () => {
    expect(restatedRules(skill)).toEqual([]);
    // The skill's launch headers legitimately show the `@<owner>-<repo>` placeholder (the parent
    // substitutes the slug), so only the bare-shelf-without-project-line check applies here.
    expect(layerViolations(skill).filter((v) => !v.startsWith('legacy "@<owner>-<repo>"'))).toEqual([]);
    expect(skill).not.toMatch(/fall back to the bare global `code-review`/);
  });
});

// ---- the guards fail when they should ---------------------------------------------------

describe('the guards fail on drift (so a green run means something)', () => {
  const sample = readFileSync(join(agentsDir, 'change-verifier.md'), 'utf-8');

  test('applyToDoc is idempotent and leaves a doc with no section alone', () => {
    expect(applyToDoc(sample, template)).toBe(sample);
    const none = readFileSync(join(agentsDir, 'product-owner.md'), 'utf-8');
    expect(applyToDoc(none, template)).toBe(none);
  });

  test('a section followed by another heading keeps that heading', () => {
    const doc = '---\nname: x-shelf\n---\nbody\n\n## Notebook Protocol (old)\nold text\n\n## After\nkept\n';
    const out = applyToDoc(doc, template) as string;
    expect(out).toContain('nb show x-shelf@$KOOKR_REPO_SLUG');
    expect(out).not.toContain('old text');
    expect(out).toMatch(/\n\n## After\nkept\n$/);
  });

  test('check mode fails (exit 1, names the file) after one hand edit of one agent doc', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nb-protocol-'));
    try {
      cpSync(agentsDir, dir, { recursive: true });
      const target = join(dir, 'boundary-critic.md');
      writeFileSync(target, readFileSync(target, 'utf-8').replace('Never write `fleet-global` directly', 'Write fleet-global when sure'));
      const r = spawnSync('node', [scriptPath, '--check', '--agents-dir', dir], { encoding: 'utf-8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('boundary-critic.md');
      expect(r.stderr).not.toContain('change-verifier.md');
      // Without --check the script repairs it, and the next check is clean.
      execFileSync('node', [scriptPath, '--agents-dir', dir]);
      expect(spawnSync('node', [scriptPath, '--check', '--agents-dir', dir]).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('check mode also covers the specialists: a hand edit fails, the repair restores the block', () => {
    const specDir = mkdtempSync(join(tmpdir(), 'nb-protocol-spec-'));
    const agentsCopy = mkdtempSync(join(tmpdir(), 'nb-protocol-agents-'));
    try {
      cpSync(specialistsDir, specDir, { recursive: true });
      cpSync(agentsDir, agentsCopy, { recursive: true });
      const target = join(specDir, 'test-specialist.md');
      writeFileSync(target, readFileSync(target, 'utf-8').replace('about 150 characters', 'at most 120 chars'));
      const args = ['--agents-dir', agentsCopy, '--specialists-dir', specDir];
      const r = spawnSync('node', [scriptPath, '--check', ...args], { encoding: 'utf-8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('test-specialist.md');
      expect(r.stderr).not.toContain('correctness-specialist.md');
      // The repair stamps the fixed shelf (specialists have no frontmatter `name`) and the next check is clean.
      execFileSync('node', [scriptPath, ...args]);
      const repaired = readFileSync(target, 'utf-8');
      expect(repaired).toContain('about 150 characters');
      expect(repaired).not.toContain('at most 120 chars');
      expect(spawnSync('node', [scriptPath, '--check', ...args]).status).toBe(0);
    } finally {
      rmSync(specDir, { recursive: true, force: true });
      rmSync(agentsCopy, { recursive: true, force: true });
    }
  });

  test('check mode passes on the repo as committed', () => {
    expect(spawnSync('node', [scriptPath, '--check'], { encoding: 'utf-8' }).status).toBe(0);
  });

  test('layerViolations flags a bare shelf with no project line, and the old project-only placeholder', () => {
    expect(layerViolations('1. `nb show change-verifier` — run it.\n')).toHaveLength(1);
    expect(layerViolations('`nb show patch-author@<owner>-<repo>`')).not.toHaveLength(0);
    expect(layerViolations('`nb show a`\n`nb show a@$KOOKR_REPO_SLUG`')).toEqual([]);
  });

  test.each([
    '`nb add x "<one lesson, ≤120 chars>"`',
    'keep it ≤120-char',
    'a lesson is capped at a max of 200 characters',
    'at most 200 characters',
    '200 characters max',
    'no more than 200 chars',
    'keep each under 200 chars',
    'the notebook evicts the lowest-scored entry',
    'the oldest entry is evicted',
    'entries are evicted by score',
    'Full notebook → `nb merge` two entries',
    '`nb vote x "<id>" +1`',
  ])('restatedRules flags %j', (text) => {
    expect(restatedRules(text)).not.toHaveLength(0);
  });

  test.each([
    'about 150 characters',
    'at most one new lesson, about 150 characters',
    'size limits, eviction and voting rules are in the reference',
    '`nb vote x id1,id2 +1`',
    'see docs/reference/agent-notebook.md for the limits',
  ])(
    'restatedRules allows %j',
    (text) => {
      expect(restatedRules(text)).toEqual([]);
    },
  );
});
