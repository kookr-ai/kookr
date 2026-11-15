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
    ['exhausted budget with HIGH/MEDIUM never merges', /never merge on an exhausted budget/i],
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
    ['FINDINGS line parsed fail-closed', /missing, malformed or inconsistent line means findings are present/],
    // #3581: severity-aware stop rule and a fixed reviewer prompt.
    ['reviewer final line carries severity counts', /^FINDINGS: <n> HIGH:<h> MEDIUM:<m> LOW:<l>$/m],
    ['malformed or inconsistent line is blocking, never LOW', /means findings are present and all of them are blocking.*never LOW-only/],
    ['reviewer prompt is fixed text, copied verbatim', /fixed reviewer prompt below.*verbatim: add, remove or reword nothing/],
    ['test-claims category has a defined severity', /A test that does not test what it claims is MEDIUM when.*otherwise LOW/],
    ['HIGH/MEDIUM after round 2 is a Failure exit', /After round 2.*HIGH or MEDIUM.*remain -> \*\*Failure exit\*\*/],
    ['LOW-only after round 2 goes to the gate', /only LOW findings remain -> go to stage 4 on the final head/],
    ['gate block on the LOW-only path is a Failure exit', /LOW-only path.*`block`.*\*\*Failure exit\*\*/],
    ['unfixed LOW findings posted on the PR', /unfixed LOW findings/i],
    ['blocking = HIGH + MEDIUM', /blocking findings = HIGH \+ MEDIUM/],
    ['finding titles carry their severity', /Start each finding title with its severity/],
    ['counts that do not sum to n are inconsistent', /Inconsistent = the counts do not add up to `<n>`/],
    ['title prefixes that disagree with the counts are inconsistent', /differ from the severity prefixes of the finding titles/],
    ['finding title shape is fixed in the prompt', /as a heading line in exactly this shape: "### HIGH: <title>"/],
    ['prefix match tolerates heading marks, numbering and bold', /ignore any leading `#` heading marks, list numbering such as `1\.` and `\*\*` bold markers/],
    ['a title without a severity prefix is inconsistent', /finding title without one of these prefixes also makes the line inconsistent/],
    // The tier definitions decide what may reach the gate as LOW-only; pin each one.
    ['HIGH tier includes not doing what the issue asks', /^- HIGH: on a realistic input the change gives a wrong result, crashes, loses or corrupts data, or opens a security hole; or it does not do what the issue asks\.$/m],
    ['MEDIUM tier includes edge-case defects and untested changes', /^- MEDIUM: a real defect on an edge case or error path; or behaviour that the change adds or alters has no test that would fail if it broke\.$/m],
    ['LOW tier is limited to wording while behaviour is tested', /^- LOW: a test whose title, name or comment promises something other than what it checks, while the behaviour itself is tested; a misleading comment or doc line; a minor clarity problem in the changed code\.$/m],
    ['zero findings has an explicit line', /^With no findings the last line is: FINDINGS: 0 HIGH:0 MEDIUM:0 LOW:0$/m],
    ['preflight gates on server readiness, not kookr doctor', /`kookr status --require-ready` exits 0.*do NOT gate on `kookr doctor`/],
    ['helper files namespaced per issue', /directory `ocpipe-\{\{issueNumber\}\}\/`/],
    ['no prod actions', /Do not run `prod:update`, restart the server or flip `KOOKR_OPENCODE_ENABLED`/],
  ])('pins: %s', (_label, re) => {
    expect(pb.body).toMatch(re);
  });
});
