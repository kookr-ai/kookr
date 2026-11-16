import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INDEPENDENT_REVIEW_MARKER,
  REVIEW_SKIPPED_TIMEOUT_LABEL,
  REQUIRE_REVIEW_ENV,
} from './independent-review.js';

/**
 * Contract tests for the distributed independent-merge-review skill.
 * Issue #3027: consuming repos such as Lucy document independent review as
 * advisory; the skill used to claim it was a merge gate on every repo.
 */
describe('independent-merge-review skill (issue #3027)', () => {
  const skillPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'skills',
    'independent-merge-review',
    'SKILL.md',
  );
  const skill = readFileSync(skillPath, 'utf-8');

  test('keeps the verdict-comment literals in sync with independent-review.ts', () => {
    expect(skill).toContain(INDEPENDENT_REVIEW_MARKER);
    expect(skill).toContain(REVIEW_SKIPPED_TIMEOUT_LABEL);
    expect(skill).toContain(REQUIRE_REVIEW_ENV);
  });

  test('documents the hard-gate vs advisory repo-policy split', () => {
    expect(skill).toMatch(/Repo policy split/i);
    expect(skill).toContain('kookr-ai/kookr');
    expect(skill).toMatch(/independent review is advisory/i);
    expect(skill).toMatch(/never become a task blocker/i);
    expect(skill).toMatch(/Do not weaken/);
    expect(skill).toMatch(/#3027/);
  });

  test('re-bases the rationale on fresh-context + exact-head + hard-gate, not cross-vendor (RFC #3415)', () => {
    // The value is independence + exact-head + the hard gate, NOT that a
    // different vendor catches more (that cross-vendor claim was falsified).
    expect(skill).toMatch(/fresh context \+ exact-head binding \+ the hard gate/i);
    expect(skill).toMatch(/cross-vendor guarantee/i);
    // Pin the load-bearing falsification evidence itself, not just its phrasing,
    // so corrupting the numbers fails the test (not only a harmless reword).
    expect(skill).toMatch(/591 verdicts/i);
    expect(skill).toMatch(/5\.6% vs 3\.1%/);
    expect(skill).toMatch(/p=0\.20/);
    // The correct positive rationale for Codex-primary is availability — pinning
    // this guards the intent better than a negative assertion could, since the
    // disclaimer sentence itself contains "different vendor catches more".
    expect(skill).toMatch(/primary only for \*\*availability\*\*/i);
    expect(skill).toMatch(/same-vendor fallback is therefore acceptable/i);
  });

  test('names a reviewer strength floor, placed in the spawn step, so the fallback is never silently weaker (RFC #3415)', () => {
    expect(skill).toMatch(/Strength floor/i);
    expect(skill).toMatch(/full reviewing strength/i);
    // Never a cheap/nit-tier model like the pre-push lint-like lane now uses —
    // pin the full referent, not the near-free bare "lint-like" token.
    expect(skill).toMatch(/cheap\/nit-tier model/i);
    expect(skill).toMatch(/`pre-pr-review` `lint-like` lane/i);
    // The floor's safety argument ("runs at the strength floor in §2") depends on
    // the floor living inside the spawn step — assert position, not just presence.
    const spawnStep = skill.indexOf('### 2. Spawn the reviewer');
    const floorIdx = skill.indexOf('Strength floor');
    expect(spawnStep).toBeGreaterThan(0);
    expect(floorIdx).toBeGreaterThan(spawnStep);
  });

  test('classifies kookr-ai/kookr as hard before the CLAUDE.md advisory grep', () => {
    const classifyStart = skill.indexOf('**Classify:**');
    expect(classifyStart).toBeGreaterThan(0);
    const classify = skill.slice(classifyStart, classifyStart + 600);
    expect(classify).toContain('if [ "$REPO" = "kookr-ai/kookr" ]; then');
    expect(classify).toContain('REVIEW_POLICY=hard');
    expect(classify).toContain("grep -qiE 'independent review is advisory'");
    expect(classify).toContain('REVIEW_POLICY=advisory');
    const hardIdx = classify.indexOf('REVIEW_POLICY=hard');
    const advisoryIdx = classify.indexOf('REVIEW_POLICY=advisory');
    const elseIdx = classify.lastIndexOf('REVIEW_POLICY=hard');
    expect(hardIdx).toBeGreaterThan(0);
    expect(advisoryIdx).toBeGreaterThan(hardIdx);
    expect(elseIdx).toBeGreaterThan(advisoryIdx);
  });
});

/**
 * Issue #3844: round 1 is the one full review; every later round is a short
 * fix check on the diff since the blocked head, a new non-critical finding on
 * an unchanged line never blocks, and the follow-ups go into one issue per PR.
 * The skill files that restate the round rules must say the same.
 */
describe('independent-merge-review round rules (issue #3844)', () => {
  const root = join(import.meta.dirname, '..', '..');
  const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf-8');
  const skill = read('plugin', 'skills', 'independent-merge-review', 'SKILL.md');
  const section = (start: string, end: string) => {
    const from = skill.indexOf(start);
    const to = skill.indexOf(end, from + start.length);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return skill.slice(from, to);
  };
  const spawn = () => section('### 2. Spawn the reviewer', '### 3. Post the verdict comment');
  const rules = () => section('### 4a. Round rules', '### 5. Latency budget');

  test('the reviewer brief gives round 1 an 8-minute budget and caps mutation checks to changed runtime lines', () => {
    const spawnStep = spawn();
    const roundRules = rules();
    expect(spawnStep).toMatch(/Round 1 \(no BLOCK on the PR yet\): the full review/);
    expect(spawnStep).toMatch(/Time budget: about 8 minutes/);
    expect(spawnStep).toMatch(/mutation\s+checks[^.]*only on runtime lines this PR\s+changes/);
  });

  test('round 2 and later are fix checks fed the previous BLOCK and the diff since its head', () => {
    const spawnStep = spawn();
    const roundRules = rules();
    expect(spawnStep).toMatch(/Round 2 and later \(the PR carries a BLOCK\): the fix check/);
    expect(spawnStep).toMatch(/Time budget: about 4 minutes/);
    expect(spawnStep).toMatch(/latest BLOCK comment and the \*\*fix diff\*\*/);
    expect(spawnStep).toContain('git merge-base --is-ancestor "$PREV" HEAD');
    expect(spawnStep).toContain('git diff "$PREV" HEAD');
    expect(spawnStep).toContain('git range-diff');
    expect(spawnStep).toContain('git cat-file -e "$PREV^{commit}" 2>/dev/null || git fetch --quiet origin "$PREV"');
    expect(spawnStep).toMatch(/fix diff comes out empty or a command fails, the round has no fix to\s+check: run the round-1 full review instead/);
    expect(spawnStep).toMatch(/confirm it is fixed/);
    expect(spawnStep).toMatch(/review only the lines the fix diff changes/);
    expect(spawnStep).toMatch(/Run no mutation checks\s+outside those lines/);
    // The after-PASS delta review only accepts comment/typo edits; the fix
    // check must say it is a different thing, or a reviewer would BLOCK a fix.
    expect(spawnStep).toMatch(/not the "delta review\s+after a PASS"/);
  });

  test('a later round cannot block on a new non-critical finding on an unchanged line; critical blocks in any round', () => {
    const spawnStep = spawn();
    const roundRules = rules();
    expect(roundRules).toContain(
      '| New, non-critical, on a line the fix diff does not change | follow-up | follow-up |',
    );
    expect(roundRules).toContain('| New, critical, anywhere in the PR | blocks | blocks |');
    expect(roundRules).toContain('| New, small `defect`, on a line the fix diff changes | blocks | follow-up |');
    expect(roundRules).toMatch(/it blocks in every round/);
    expect(spawnStep).toMatch(/A new critical finding\s+blocks wherever it is/);
  });

  test('keeps the two-BLOCK round cap as the backstop', () => {
    const spawnStep = spawn();
    const roundRules = rules();
    expect(roundRules).toMatch(/From round 3 on \(the PR already\s+carries two or more BLOCKs\) this is the round cap: only critical findings\s+block/);
  });

  test('files at most one follow-up issue per PR with a checklist, not one per finding', () => {
    const roundRules = rules();
    expect(roundRules).toMatch(/\*\*one\*\* issue for the whole PR, with one checklist\s+item per defect/);
    expect(roundRules).toContain('TITLE="Review follow-ups: $FILES (#$PR)"');
    expect(roundRules).toContain('- [ ] <file>:<line> <what is wrong> (round <n>)');
    expect(roundRules).not.toContain('Follow-ups from the review of #$PR"');
    // Defects listed by a BLOCK must be filed then, not only at the pass,
    // or a round-1 follow-up is lost when round 2 adds nothing.
    expect(roundRules).toMatch(/at \*\*every\*\* verdict that lists defect follow-ups, a BLOCK\s+included/);
    expect(roundRules).toMatch(/add the new\s+items to it \(`gh issue edit --body-file`/);
  });

  test('the worked example shows a round-2 fix check confirming the round-1 small defect', () => {
    const roundRules = rules();
    expect(roundRules).toMatch(/\*\*Review 2 on H2\*\* \(`c3d4…`\), a fix check on `git diff a1b2… c3d4…`/);
    expect(roundRules).toMatch(/`kookr merge 4100`\s+accepts this `pass`/);
  });
  test.each([
    ['plugin/skills/pre-pr-review/SKILL.md'],
    ['.claude/skills/kookr-pre-push/SKILL.md'],
    ['.claude/skills/kookr-post-push/SKILL.md'],
    ['plugin/playbooks/implement-github-issue.md'],
    ['plugin/playbooks/parallel-issue-batch.md'],
    ['plugin/skills/autonomous-review-loop/SKILL.md'],
  ])('%s restates the fix-check rule and points at §4a', (path) => {
    const text = read(...path.split('/')).replace(/\s+/g, ' ');
    expect(text).toMatch(/diff since the blocked head/);
    expect(text).toMatch(/fix check/);
    expect(text).toContain('§4a');
  });

  test.each([
    ['plugin/skills/pre-pr-review/SKILL.md'],
    ['.claude/skills/kookr-pre-push/SKILL.md'],
    ['plugin/playbooks/implement-github-issue.md'],
    ['plugin/playbooks/parallel-issue-batch.md'],
  ])('%s restates the unchanged-line and one-issue rules', (path) => {
    const text = read(...path.split('/')).replace(/\s+/g, ' ');
    expect(text).toMatch(/non-critical finding on (?:an unchanged line|a line that did not change) is a follow-up/);
    expect(text).toMatch(/one issue per PR/);
  });
});

/**
 * Issue #3903: review follow-ups were bypassing the issue-filing budget and
 * filling the backlog with nits. Nits stay in the verdict; small defects are
 * fixed inside the PR; only larger defects reach the one follow-up issue, and
 * only through `kookr emission plan` and the logged dedupe.
 */
describe('independent-merge-review follow-up classes and budget (issue #3903)', () => {
  const root = join(import.meta.dirname, '..', '..');
  const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf-8');
  const skill = read('plugin', 'skills', 'independent-merge-review', 'SKILL.md');
  const section = (start: string, end: string) => {
    const from = skill.indexOf(start);
    const to = skill.indexOf(end, from + start.length);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return skill.slice(from, to);
  };
  const spawn = () => section('### 2. Spawn the reviewer', '### 3. Post the verdict comment');
  const rules = () => section('### 4a. Round rules', '### 5. Latency budget');
  const example = () => section('**Worked example.**', '### 5. Latency budget');

  test('the reviewer brief defines critical, small defect, larger defect and nit', () => {
    const brief = spawn();
    expect(brief).toMatch(/Finding classes \(put this list in every reviewer brief/);
    expect(brief).toMatch(/\*\*`defect`, small:\*\* wrong or missing behaviour, a real test gap on new code,\s+or a doc that is now false/);
    expect(brief).toMatch(/fix stays within the files the PR already\s+touches \(plus their tests\), needs no design choice/);
    expect(brief).toMatch(/\*\*`defect`, larger:\*\*[^]*touches other\s+files, needs a design choice, or is a separate piece of work/);
    expect(brief).toMatch(/\*\*`nit`:\*\* style, wording, duplication, optional test polish/);
    expect(brief).toMatch(/never blocks, is never fixed\s+on request and is never filed/);
    // Both quoted briefs must ask for the class, since the reviewer sees only the brief.
    const quotedBriefs = brief.match(/Put this in the\s+brief: "[^"]*"|Put this in the brief: "[^"]*"/g) ?? [];
    expect(quotedBriefs).toHaveLength(2);
    for (const quoted of quotedBriefs) expect(quoted).toMatch(/small `defect`,\s+larger\s+`defect`\s+or\s+`nit`/);
    expect(brief).toMatch(/BLOCK on critical findings and\s+small defects/);
    // Round 2 blocks on a new small defect on a changed line (the §4a table); the
    // round-2 brief and the BLOCK rule must say so, or the reviewer passes it.
    expect(brief).toMatch(/In round 2, a new small defect on a line the fix diff\s+changes blocks\./);
    // The same brief serves round 3 and later, so it must carry the round cap too.
    expect(brief).toMatch(/From round 3 on \(the PR carries two or more BLOCKs\), only\s+critical findings block: a new small defect is a follow-up, and an unfixed\s+non-critical finding of the latest BLOCK no longer blocks/);
    expect(brief).toMatch(/small `defect` \(classes below\) in round 1, or in round 2\s+on a line the fix diff changes/);
  });

  test('round 1 blocks on small defects; nits never block', () => {
    const roundRules = rules();
    expect(roundRules).toMatch(/Critical\s+findings and small defects block\. Larger defects and nits are follow-ups/);
    expect(roundRules).toContain('| New, small `defect`, on a line the fix diff changes | blocks | follow-up |');
    expect(roundRules).toContain('| New, larger `defect`, on a line the fix diff changes | follow-up | follow-up |');
    expect(roundRules).toContain('| New `nit`, anywhere | follow-up | follow-up |');
    expect(roundRules).toMatch(/\*\*Nits stay in the verdict comment\.\*\* They are never filed as an issue\s+and never fixed on request/);
  });

  test('the filing runs the budget and dedupe before the only gh issue create, and never falls back to a bare create', () => {
    const roundRules = rules();
    const plan = roundRules.indexOf('kookr emission plan --repo "$REPO" --requested 1 --json');
    const dedupe = roundRules.indexOf('kookr emission dedupe --repo "$REPO" --title "$TITLE" --json');
    const create = roundRules.indexOf('gh issue create --repo');
    expect(plan).toBeGreaterThan(0);
    expect(dedupe).toBeGreaterThan(plan);
    expect(create).toBeGreaterThan(dedupe);
    // Exactly one create in the whole skill, inside the budgeted branch.
    expect(skill.match(/gh issue create --repo/g)).toHaveLength(1);
    expect(roundRules).toContain('elif [ -n "$DEDUPE" ] && [ "${ALLOWED:-0}" -ge 1 ]');
    expect(roundRules).toContain('gh issue comment "$MATCH" --repo "$REPO" --body-file');
    expect(roundRules).toContain('kookr emission defer --repo "$REPO" --title "$TITLE"');
    expect(roundRules).toMatch(/Never fall back to a bare `gh issue create`/);
    expect(roundRules).toMatch(/Follow-ups \(defects, not filed: issue\s+budget\)/);
    // The two lines that decide whether to file must read the fields the CLI really emits.
    expect(roundRules).toContain("jq -r '.plan.allowedBudget // 0'");
    expect(roundRules).toContain("jq -r 'select(.isDuplicate == true) | .match.number'");
    // Findings quote code in backticks: the checklist heredoc must be quoted.
    expect(roundRules).toContain("cat <<'BODY'");
    expect(roundRules).not.toMatch(/<<BODY\b/);
  });

  test('follow-up issues carry the review-followup label and name their files first', () => {
    const roundRules = rules();
    expect(roundRules).toContain('gh label create review-followup --repo "$REPO"');
    expect(roundRules).toContain('--label review-followup');
    expect(roundRules).toContain("printf 'Files: %s\\n");
    expect(read('plugin', 'skills', 'github-labels', 'SKILL.md')).toContain('| `review-followup` |');
  });

  test('the worked example: two nits in the comment, a small defect fixed in the PR, a larger defect filed once', () => {
    const ex = example();
    expect(ex).toMatch(/one small\s+defect, one larger defect and two nits/);
    expect(ex).toContain('kookr-review-verdict: block');
    expect(ex).toMatch(/1\. \[small defect\] src\/core\/task-archive\.ts:58/);
    expect(ex).toContain('Follow-ups (defects, one issue for this PR): #4101');
    expect(ex).toMatch(/- \[defect\] src\/cli\/tasks-prune\.ts/);
    const nits = ex.slice(ex.indexOf('Nits (this comment only, not filed):'));
    expect(nits.match(/^ {2}- src\//gm)?.slice(0, 2)).toHaveLength(2);
    expect(ex).toMatch(/adds the test in one commit \(H2\) and leaves both nits/);
    expect(ex).toMatch(/a fix check on `git diff a1b2… c3d4…`: the new\s+test covers the empty-history branch/);
    expect(ex).toMatch(/The PR filed one issue, for the one larger defect/);
  });

  test.each([
    ['plugin/skills/pre-pr-review/SKILL.md'],
    ['.claude/skills/kookr-pre-push/SKILL.md'],
    ['plugin/playbooks/implement-github-issue.md'],
    ['plugin/playbooks/parallel-issue-batch.md'],
  ])('%s restates the nit, small-defect and budget rules', (path) => {
    const text = read(...path.split('/')).replace(/\s+/g, ' ');
    expect(text).toMatch(/blocks on critical findings and small defects, and the small defects are fixed inside the PR/);
    expect(text).toMatch(/Nits stay in the verdict comment, never filed or fixed on request/);
    expect(text).toMatch(/only larger defects go into at most one issue per PR, with a checklist, filed through `kookr emission plan` and the logged dedupe/);
  });
});
