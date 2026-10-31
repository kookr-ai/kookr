import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guard for RFC docs/rfc/rfc-notebook-shelf-reorg.md, Slice B (FR-1): the
// Agent Notebook's tool-owned facts — the per-shelf line cap and the deprecated
// word "role" for the unit — must live in ONE place (docs/reference/agent-notebook.md),
// never restated in the agent-facing prompt docs. Restating them is how the cap
// drifted to a stale "200 lines" across ~30 files after the package default
// dropped to 50. These docs must POINT to the reference, not copy it.
//
// Scope note: this scans only the agent-facing prompt docs. It deliberately does
// NOT scan docs/reference/agent-notebook.md (the single source, which correctly
// states "50 lines" / "200 characters") or the `notebookRole` TS field name (an
// internal identifier; the field rename is deferred by the RFC).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Agent-facing docs that must not restate tool-owned facts. */
function targetDocs(): string[] {
  const files: string[] = [];
  const agentsDir = join(repoRoot, 'plugin', 'agents');
  const specialistsDir = join(repoRoot, 'plugin', 'reviewer-specialists');
  for (const dir of [agentsDir, specialistsDir]) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.md')) files.push(join(dir, name));
    }
  }
  for (const skill of ['notebook-role-reuse', 'pre-pr-review']) {
    files.push(join(repoRoot, 'plugin', 'skills', skill, 'SKILL.md'));
  }
  // The plugin README describes the notebook to readers and is just as prone to
  // restating the cap (it carried a stale "≤200 one-line lessons" before this).
  files.push(join(repoRoot, 'plugin', 'README.md'));
  return files;
}

// A restated shelf line cap. The number belongs only in
// docs/reference/agent-notebook.md; any copy of it in an agent-facing doc is the
// drift this guard forbids. Four forms, all anchored so a legitimate code-size
// mention ("> 400 lines of logic", "200-line harness") does NOT trip them:
//   1. a comparator form — `≤200 lines`, `<=200 lines`, `≤200 one-line`
//   2. the `200 lines × 200 chars` couplet
//   3. `<n>(-)line(s)` within 24 chars BEFORE a cap word (`50-line cap`, `200 lines max`)
//   4. a cap word within 24 chars before `<n> line(s)` (`up to 50 lines`, `max 50 lines`)
const CAP_WORD = 'cap|limit|budget|evict|ceiling|max';
const LINE_CAP_RESTATEMENT = new RegExp(
  [
    `[\\u2264<]=?\\s*\\d+\\s*(?:one-)?lines?\\b`,
    `\\d+\\s*lines?\\s*[\\u00D7x]\\s*\\d+`,
    `\\d+\\s*-?\\s*lines?\\b[^.\\n]{0,24}\\b(?:${CAP_WORD})\\b`,
    `\\b(?:${CAP_WORD}|up to)\\b[^.\\n]{0,24}\\d+\\s*-?\\s*lines?\\b`,
  ].join('|'),
  'i',
);
// The deprecated framing "your notebook role is …" / "notebook role".
const ROLE_FRAMING = /notebook\s+role/i;

describe('LINE_CAP_RESTATEMENT recognises cap restatements, not code-size mentions', () => {
  test.each([
    '≤200 lines',
    '<=200 lines',
    '≤200 one-line lessons',
    '200 lines × 200 chars',
    'the 50-line cap will evict',
    '200 lines max',
    'up to 50 lines',
    'max 50 lines',
  ])('flags %j', (s) => {
    expect(LINE_CAP_RESTATEMENT.test(s)).toBe(true);
  });

  test.each([
    '> 400 lines of logic is suspect',
    'invalidate 500 lines of design',
    'a 200-line harness',
    'files over 400 lines are a smell',
    'keep new lessons ≤120 chars',
  ])('does not flag %j', (s) => {
    expect(LINE_CAP_RESTATEMENT.test(s)).toBe(false);
  });
});

describe('agent-facing notebook docs do not restate tool-owned facts (RFC Slice B / FR-1)', () => {
  const docs = targetDocs();

  test('a non-trivial set of docs is actually scanned', () => {
    // Guards against the glob silently matching nothing and the test passing vacuously.
    expect(docs.length).toBeGreaterThan(20);
  });

  for (const file of docs) {
    const rel = file.slice(repoRoot.length + 1);
    test(`${rel} restates no line cap and no "notebook role"`, () => {
      const text = readFileSync(file, 'utf-8');
      const lineCapHit = text.match(LINE_CAP_RESTATEMENT);
      expect(
        lineCapHit,
        `${rel} restates the shelf line cap ("${lineCapHit?.[0]}"). State caps only in ` +
          `docs/reference/agent-notebook.md and point to it instead.`,
      ).toBeNull();
      const roleHit = text.match(ROLE_FRAMING);
      expect(
        roleHit,
        `${rel} uses the deprecated framing "${roleHit?.[0]}". A notebook is a *shelf* ` +
          `(co-access grouping); "role" is a deprecated alias.`,
      ).toBeNull();
    });
  }
});
