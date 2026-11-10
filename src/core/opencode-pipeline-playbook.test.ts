import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook } from './playbook-parser.js';

/**
 * Wording contract for the opencode scoped-fix pipeline playbook
 * (docs/rfc/rfc-opencode-scoped-fix-pipeline.md). The playbook is a prompt, so
 * the load-bearing safety rules are pinned here: an edit that drops one fails CI.
 */
describe('opencode-scoped-fix-pipeline playbook', () => {
  const file = 'opencode-scoped-fix-pipeline.md';
  const content = readFileSync(join(import.meta.dirname, '..', '..', '.kookr', 'playbooks', file), 'utf-8');
  const pb = parsePlaybook(content, file, '/');

  test('parses with required issueNumber and optional merge flag defaulting off', () => {
    expect(pb.name).toBe('opencode scoped-fix pipeline');
    const byName = Object.fromEntries((pb.parameters ?? []).map((p) => [p.name, p]));
    expect(byName.issueNumber?.required).toBe(true);
    expect(byName.mergeEnabled?.default).toBe('false');
    expect(byName.usdCap?.default).toBe('3');
  });

  test.each([
    ['gate is mandatory on every repo', /never merge without a `pass` verdict.*on every repo/i],
    ['verdict bound to exact head', /exact final head sha/i],
    ['reviewer PASS never substitutes', /opencode reviewer's result never substitutes/i],
    ['worker never pushes', /worker never pushes or merges/i],
    ['issue text is untrusted data', /UNTRUSTED ISSUE TEXT/],
    ['fix rounds bounded at 2', /`round < 2`/],
    ['fresh worker per fix round', /FRESH `scoped-fix` task/],
    ['exhausted budget never merges', /never merge on an exhausted budget/i],
    ['children stopped before gate', /no child is live/i],
    ['non-zero wait exit stops child', /ANY non-zero exit: `kookr stop <child>`/],
    ['pause checked before every spawn', /kookr orchestration status --json/],
    ['usd cap enforced', /usdSpent >= \{\{usdCap\}\}/],
    ['head re-checked before merge', /MUST equal the sha in the latest `pass` verdict/],
    ['merge opt-in', /\{\{mergeEnabled\}\}` is `true`/],
    ['non-true leaves PR open', /not `true`: leave the PR open/],
    ['state written every transition', /EVERY transition/],
    ['claim held by orchestrator only', /Never pass `--claim-issue`/],
    ['claim released on every terminal path', /Every terminal path releases the claim/],
    ['FINDINGS line parsed fail-closed', /missing\/malformed = findings present/],
    ['preflight gates on server readiness, not kookr doctor', /`kookr status --require-ready` exits 0.*do NOT gate on `kookr doctor`/],
    ['helper files namespaced per issue', /directory `ocpipe-\{\{issueNumber\}\}\/`/],
    ['no prod actions', /Do not run `prod:update`, restart the server or flip `KOOKR_OPENCODE_ENABLED`/],
  ])('pins: %s', (_label, re) => {
    expect(pb.body).toMatch(re);
  });
});
