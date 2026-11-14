import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook } from './playbook-parser.js';
import { KB_LESSON_SKIP_MARKER } from './kb-lesson-classifier.js';
import { LESSON_WRITE_TEMPLATE } from './lesson-decision.js';

/**
 * Contract tests for the implement-github-issue playbook. The author-filter
 * gate is a security boundary, so its presence is asserted explicitly — a
 * casual edit that drops the parameter or short-circuits the check should
 * fail this suite.
 */
describe('implement-github-issue playbook', () => {
  const playbookPath = join(import.meta.dirname, '..', '..', 'plugin', 'playbooks', 'implement-github-issue.md');
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'implement-github-issue.md', '/');
  const claudeMdPath = join(import.meta.dirname, '..', '..', 'CLAUDE.md');
  const claudeMd = readFileSync(claudeMdPath, 'utf-8');

  test('exposes allowOtherAuthors as a required select with safe default', () => {
    const param = pb.parameters.find((p) => p.name === 'allowOtherAuthors');
    expect(param).toBeDefined();
    expect(param!.required).toBe(true);
    expect(param!.default).toBe('false');
    expect(param!.type).toBe('select');
    const values = (param!.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(['false', 'true']);
  });

  test('defaults mergeAfterImplementation to true (autonomous merge when safe)', () => {
    const param = pb.parameters.find((p) => p.name === 'mergeAfterImplementation');
    expect(param).toBeDefined();
    expect(param!.required).toBe(true);
    expect(param!.default).toBe('true');
    expect(param!.type).toBe('select');
    const values = (param!.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(['false', 'true']);
  });

  test('Phase 0d enforces the author check before reading the issue body', () => {
    expect(pb.body).toMatch(/Author check/);
    expect(pb.body).toContain('CURRENT_USER');
    expect(pb.body).toContain('{{allowOtherAuthors}}');
    // The check must precede Phase 1's body read — assert relative ordering.
    const authorCheckIdx = pb.body.indexOf('Author check');
    const phase1Idx = pb.body.indexOf('Phase 1: Read the target issue');
    expect(authorCheckIdx).toBeGreaterThan(0);
    expect(phase1Idx).toBeGreaterThan(authorCheckIdx);
  });

  test('Step 0b resolves CURRENT_USER from gh', () => {
    expect(pb.body).toMatch(/CURRENT_USER=\$\(gh api user -q \.login\)/);
  });

  test('documents required and skipped KB lookup policy separately from memory writes', () => {
    expect(claudeMd).toContain('## KB-First Task Policy');
    expect(claudeMd).toContain('Run `kb search "<2-line gist of the task>"` before designing or implementing');
    expect(claudeMd).toContain('Non-trivial research, architecture, RFC, issue-synthesis, or requirements work');
    expect(claudeMd).toContain('Machine-specific operations, production/deployment work, Kookr runtime behavior');
    expect(claudeMd).toContain('You may skip the KB lookup for purely mechanical edits');
    expect(claudeMd).toContain('KB lookup skipped: <reason>');

    const kbPolicyIdx = claudeMd.indexOf('## KB-First Task Policy');
    const persistenceIdx = claudeMd.indexOf('## Persistence Mechanism Picker');
    expect(kbPolicyIdx).toBeGreaterThan(0);
    expect(persistenceIdx).toBeGreaterThan(kbPolicyIdx);
  });

  test('prompts GitHub issue agents to report KB hits, misses, and stale warnings', () => {
    expect(pb.dependencies).toEqual(['kb']);
    expect(pb.body).toContain('Phase 2.5: Apply KB-First Task Policy');
    expect(pb.body).toContain('kb search "<2-line gist of the issue and intended work>"');
    expect(pb.body).toContain('KB hits: ...');
    expect(pb.body).toContain('KB miss: ...');
    expect(pb.body).toContain('KB stale warning: ...');
    expect(pb.body).toContain('This lookup policy is separate from memory-write governance');
  });

  describe('Phase 0 label handling in blank shape', () => {
    const SKIP_LABELS = ['automation-blocked', 'wontfix', 'not planned', 'invalid', 'question'];
    const section = (from: string, to: string): string => {
      const start = pb.body.indexOf(from);
      const end = pb.body.indexOf(to, start + 1);
      expect(start, `missing heading ${from}`).toBeGreaterThan(0);
      expect(end, `missing heading ${to}`).toBeGreaterThan(start);
      return pb.body.slice(start, end);
    };
    const backticked = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const step0d = section('### Step 0d:', '### Step 0e:');
    const triage = section('### Phase 2.7:', '## Phase 3:');
    const skipRow = step0d.split('\n').find((line) => line.includes('**Skip.**'));
    const triageRow = step0d.split('\n').find((line) => line.includes('**Triage candidate.**'));

    test('the Skip row names exactly the decided "not now" / "not code" labels', () => {
      expect(skipRow).toBeDefined();
      expect(backticked(skipRow!.split('|')[1]).sort()).toEqual([...SKIP_LABELS].sort());
    });

    test('architecture is an ordinary label (Architecture Health Check files implementable work under it)', () => {
      expect(backticked(skipRow!.split('|')[1])).not.toContain('architecture');
      expect(step0d).toMatch(/`architecture` included, is ordinary/);
    });

    test('duplicate and blocked are triage candidates that Phase 0 neither reads nor writes', () => {
      expect(triageRow).toBeDefined();
      expect(backticked(triageRow!.split('|')[1]).sort()).toEqual(['blocked', 'duplicate']);
      expect(triageRow).toContain('Phase 0 makes no read or write');
      expect(triageRow).toMatch(/ranks \*\*after\*\* every ordinary candidate/);
      // Phase 0 must not contain the triage write commands; they belong after the claim.
      expect(step0d).not.toContain('gh issue close');
      expect(step0d).not.toContain('--remove-label');
    });

    test('triage writes run only in Phase 2.7, after the claim, and never without it', () => {
      const claimPhase = pb.body.indexOf('## Phase 2: Acquire or Resume Claim');
      expect(claimPhase).toBeGreaterThan(0);
      expect(pb.body.indexOf('### Phase 2.7:')).toBeGreaterThan(claimPhase);
      expect(triage).toMatch(/If `CLAIM_OWNED` is not `1`.*make no write/s);
      expect(triage).toContain('--duplicate-of "$M"');
      expect(triage).toContain('--remove-label duplicate');
      expect(triage).toContain('--remove-label blocked');
    });

    test('both "made ordinary" branches route back through Phase 2.6 quarantine before Phase 3', () => {
      const removals = triage.split('\n').filter((line) => /--remove-label (duplicate|blocked)/.test(line));
      expect(removals).toHaveLength(2);
      for (const line of removals) {
        expect(line).toContain('Set `TRIAGE_TARGET=0` and go back to Phase 2.6, then Phase 3');
        expect(line).not.toMatch(/Continue to Phase 3/);
      }
    });

    test('duplicate closes only against a valid original and only when closeUnworthyIssues allows it', () => {
      expect(triage).toContain('It is an issue, not a PR');
      expect(triage).toContain('It is not itself labelled `duplicate`');
      expect(triage).toContain('Its author passes the same author check');
      expect(triage).toMatch(/Same work, and `\{\{closeUnworthyIssues\}\}` is `true`/);
    });

    test('blocked is removed only for resolved same-repo blockers and never re-removed after a human re-adds it', () => {
      expect(triage).toContain('gives no other reason');
      expect(triage).toContain('a PR `MERGED`');
      expect(triage).toContain('a closed unmerged PR');
      expect(triage).toContain('never remove it again');
      // A target with both labels must clear both rules before it is implemented.
      expect(triage).toContain('it becomes ordinary only when both rules below resolve it');
      expect(triage).toContain('names **at least one** blocker');
      expect(triage).toContain('A bare `blocked` label with no stated reason is unresolved');
      expect(triage).not.toMatch(/`after #M`/);
    });

    test('references come only from trusted text', () => {
      expect(triage).toContain('comments written by `$CURRENT_USER`');
      // The original's body is fetched only after its author check passes.
      expect(triage).toContain('--json url,state,stateReason,author,labels`, without its body');
      expect(triage.indexOf('Only after #M passes every check, fetch its body')).toBeGreaterThan(
        triage.indexOf('Its author passes the same author check'),
      );
    });

    test('an unresolved triage target is not re-picked, so an all-skipped run reaches Step 0e and lists what it skipped', () => {
      expect(triage).toContain('Add `TARGET` to `TRIAGE_UNRESOLVED`');
      expect(triageRow).toContain('`TRIAGE_UNRESOLVED`');
      expect(section('### Step 0e:', '### Step 0f:')).toContain('skipped #');
    });

    test('the self-continuation handoff uses the same Skip labels and makes no writes', () => {
      const handoff = pb.body.slice(pb.body.indexOf('1. Re-derive the eligible-candidate set'));
      const line = handoff.slice(0, handoff.indexOf('\n'));
      expect(line).toContain('without making any GitHub writes');
      for (const label of SKIP_LABELS) expect(line).toContain(`\`${label}\``);
      // Explicit lists keep their informational semantics in the handoff too.
      expect(line).toContain('In blank shape only, also remove every issue carrying another Step 0d **Skip** label');
      expect(line).toContain('`TRIAGE_UNRESOLVED`');
    });
  });

  test('uses the deployed issue-claim API contract', () => {
    const phase2 = pb.body.slice(pb.body.indexOf('Phase 2: Acquire or Resume Claim'), pb.body.indexOf('Phase 2.5:'));
    const quarantine = pb.body.slice(pb.body.indexOf('Phase 2.6:'), pb.body.indexOf('Phase 3:'));
    const release = pb.body.slice(pb.body.indexOf('Release completed claims when possible'), pb.body.indexOf('If no further action is possible'));
    const claimBody = '-d "{\\"repo\\":\\"$REPO\\",\\"number\\":$TARGET,\\"taskId\\":\\"$KOOKR_TASK_ID\\"}"';

    expect(phase2).toContain('$KOOKR_API_BASE_URL/api/issue-claims?repo=$REPO&number=$TARGET');
    expect(phase2).toContain("CLAIM_OWNER_TASK_ID=$(jq -r '.[0].taskId // empty'");
    expect(phase2).toContain('if [ "$CLAIM_OWNER_TASK_ID" = "$KOOKR_TASK_ID" ]; then\n        CLAIM_OWNED=1\n      fi');
    expect(phase2).toContain('-X POST "$KOOKR_API_BASE_URL/api/issue-claims"');
    expect(phase2).toContain(claimBody);
    expect(phase2).toContain('404)\n      echo "issue-claims API not deployed (HTTP 404); proceeding without claim coordination."');
    expect(phase2).toContain('CLAIM_OWNED=1');
    expect(phase2).toContain('409)');
    expect(phase2).toContain('stop_for_claim_blocker "Issue is already claimed by another task" "claim_contended" 0');
    expect(phase2).toContain('stop_for_claim_blocker "Issue claims probe failed with HTTP $PROBE_STATUS" "claims_api_unavailable" 1');
    expect(phase2).toContain('stop_for_claim_blocker "Issue claim acquisition failed with HTTP $CLAIM_STATUS" "claims_api_unavailable" 1');
    expect(phase2).toContain('--argjson iteration "$RALPH_ITERATION"');
    expect(phase2).toContain('--arg target "$TARGET"');
    expect(phase2).toContain('--argjson targetTitle "$TARGET_TITLE_JSON"');
    expect(phase2).toContain("'{verdict:\"stalled\",iteration:$iteration,target:$target,targetTitle:$targetTitle,reason:$reason,blockers:[$blocker]}'");
    expect(phase2).toContain('> "${RALPH_VERDICT_FILE}.tmp"');
    expect(phase2).toContain('mv "${RALPH_VERDICT_FILE}.tmp" "$RALPH_VERDICT_FILE"');
    expect(phase2).toContain('exit "$exit_code"');
    for (const section of [quarantine, release]) {
      expect(section).toContain('CLAIMS_API_AVAILABLE:-0');
      expect(section).toContain('CLAIM_OWNED:-0');
      expect(section).toContain('-X DELETE "$KOOKR_API_BASE_URL/api/issue-claims"');
      expect(section).toContain(claimBody);
    }
    expect(pb.body).not.toContain('/api/issue-claims/acquire');
    expect(pb.body).not.toContain('/api/issue-claims/heartbeat');
    expect(pb.body).not.toContain('/api/issue-claims/release');
  });

  test('defines an automation-quarantine path for trusted non-implementable issues', () => {
    expect(pb.body).toMatch(/automation-quarantine/i);
    expect(pb.body).toContain('gh issue comment "$TARGET"');
    expect(pb.body).toContain('gh issue edit "$TARGET"');
    expect(pb.body).toContain('"permanent":true');
  });

  test('renames the Kookr task and preserves issue title in Ralph verdicts after target resolution', () => {
    const targetIdx = pb.body.indexOf('The first candidate passing all three checks is the target');
    const metadataIdx = pb.body.indexOf('Step 0f: Record resolved issue metadata');
    const phase1Idx = pb.body.indexOf('Phase 1: Read the target issue');
    expect(metadataIdx).toBeGreaterThan(targetIdx);
    expect(phase1Idx).toBeGreaterThan(metadataIdx);

    expect(pb.body).toContain('ISSUE_TITLE=$(gh issue view "$TARGET" --repo "$REPO" --json title -q .title)');
    expect(pb.body).toContain('PATCH "$KOOKR_API_BASE_URL/api/tasks/$KOOKR_TASK_ID/name"');
    expect(pb.body).toContain('TARGET_TITLE_JSON=$(jq -Rn --arg title "$ISSUE_TITLE"');
    expect(pb.body).toContain('"targetTitle":${TARGET_TITLE_JSON}');
  });

  test('Phase 8 requires the independent merge-review gate before pnpm merge (issue #1717)', () => {
    const phase8Start = pb.body.indexOf('Phase 8: Merge Policy and Claim Release');
    const gateIdx = pb.body.indexOf('Independent merge-review gate', phase8Start);
    const mergeIdx = pb.body.indexOf('pnpm merge <PR_NUMBER>', phase8Start);
    expect(gateIdx).toBeGreaterThan(phase8Start);
    // The gate instruction must precede the merge command.
    expect(mergeIdx).toBeGreaterThan(gateIdx);
    // Fresh-context reviewer + Codex→Claude fallback + explicit timeout telemetry are load-bearing pieces.
    const gateText = pb.body.slice(gateIdx, mergeIdx);
    expect(gateText).toMatch(/fresh-context/i);
    expect(gateText).toContain('independent-merge-review');
    expect(gateText).toMatch(/rate-limited/i);
    expect(gateText).toContain('review-skipped-timeout');
  });

  test('Phase 8 splits independent-review hard-gate vs advisory repo policy (issue #3027)', () => {
    // Lucy #3606 made independent review advisory on consuming repos; the
    // playbook used to claim it was a merge gate everywhere, so Lucy agents
    // stalled at an open PR. kookr-ai/kookr must keep the hard wrapper.
    const phase8Start = pb.body.indexOf('Phase 8: Merge Policy and Claim Release');
    const gateIdx = pb.body.indexOf('Independent merge-review gate', phase8Start);
    const mergeIdx = pb.body.indexOf('pnpm merge <PR_NUMBER>', phase8Start);
    const gateText = pb.body.slice(gateIdx, mergeIdx);
    expect(gateText).toContain('kookr-ai/kookr');
    expect(gateText).toMatch(/independent review is advisory/i);
    expect(gateText).toMatch(/never become a task blocker/i);
    expect(gateText).toMatch(/#3027/);
    // Hard-gate enforcement on this repo is unchanged.
    expect(gateText).toMatch(/exit code 4|exit 4/);
    expect(gateText).toContain('if `"$REPO"` is `kookr-ai/kookr` → hard');
    expect(gateText).toContain("grep -qiE 'independent review is advisory'");
    expect(gateText).toMatch(/else hard/);
  });

  test('incident-labeled issues use Refs not Closes so merge cannot auto-close (issue #1750)', () => {
    // Close-out gate: fix-merged ≠ incident-resolved. The playbook must detect
    // incident labels in Phase 1 and use Refs (never Closes) in the PR body.
    expect(pb.body).toMatch(/Incident close-out gate \(issue #1750\)/);
    expect(pb.body).toContain('IS_INCIDENT=1');
    expect(pb.body).toContain('prod-incident');
    expect(pb.body).toMatch(/Refs #<TARGET>/);
    expect(pb.body).toMatch(/Incident closing keyword \(issue #1750\)/);
    // Ordinary issues still use Closes; incidents must not auto-close on merge.
    expect(pb.body).toContain('Closes #<TARGET>');
    expect(pb.body).toMatch(/must \*\*not\*\* contain `Closes #<TARGET>`/);
    // Phase 1 detection must precede Phase 7 PR creation.
    const gateIdx = pb.body.indexOf('Incident close-out gate (issue #1750)');
    const phase7Idx = pb.body.indexOf('Phase 7: Create or Update Pull Request');
    expect(gateIdx).toBeGreaterThan(0);
    expect(phase7Idx).toBeGreaterThan(gateIdx);
  });

  test('Phase 8.5 surfaces the post-task KB lesson decision before Phase 9', () => {
    // Issue #227 / #1538: agents must emit either a `kb remember` write or the
    // skip marker before the verdict is written (and before completion-ready),
    // so `pnpm kb:usage` can classify the task. The marker text MUST match the
    // classifier's constant verbatim — substring detection means any drift
    // breaks the metric silently.
    expect(pb.body).toMatch(/Phase 8\.5: Post-task KB lesson decision/);
    // Issue #3695: the playbook shows the exact template the stop nudge and
    // the 409 hint show, so the first write passes `--lesson` validation.
    expect(pb.body).toContain(LESSON_WRITE_TEMPLATE.split('\n')[0]);
    for (const heading of ['## Mistake', '## Why it happened', '## Better next time']) {
      expect(pb.body).toContain(heading);
    }
    expect(pb.body).toContain(KB_LESSON_SKIP_MARKER);
    expect(pb.body).toContain('lesson_decision_required');
    expect(pb.body).toMatch(/before.*completion-ready/i);
    const phase85Idx = pb.body.indexOf('Phase 8.5: Post-task KB lesson decision');
    const phase9Idx = pb.body.indexOf('Phase 9: Report verdict to the engine');
    expect(phase85Idx).toBeGreaterThan(0);
    expect(phase9Idx).toBeGreaterThan(phase85Idx);
  });

  test('self-continuation handoff is terminal-agnostic with a mandatory pre-completion gate', () => {
    // Regression guard: a self-continuation chain must not die on the first
    // non-implementable / low-value / stalled target. The handoff must fire on
    // ANY durable terminal outcome (not merge-only), and a completion gate must
    // force the agent to hand off (or record no-eligible-candidates) before it
    // completes — the failure that stranded a live chain after one merged PR.
    expect(pb.body).toContain('Self-continuation handoff');
    expect(pb.body).toContain('on **every** terminal outcome for this target');
    expect(pb.body).toContain('Self-continuation completion gate (mandatory)');
    expect(pb.body).toContain('MUST NOT signal completion-ready / complete this task until');
    expect(pb.body).toContain('must **never** end the chain while other eligible issues remain');
    // The handoff lives in Phase 8, before the Phase 8.5 lesson decision / completion-ready.
    const handoffIdx = pb.body.indexOf('Self-continuation handoff');
    const phase85Idx = pb.body.indexOf('Phase 8.5: Post-task KB lesson decision');
    expect(handoffIdx).toBeGreaterThan(0);
    expect(phase85Idx).toBeGreaterThan(handoffIdx);
  });

  test('propagates Idea Scout provenance labels onto the PR (issue #1587)', () => {
    // The scouted-idea -> merged-PR conversion must be computable from labels
    // alone, so a PR implementing a scouted issue inherits its idea-scout /
    // idea:<n> labels. It must be a guarded no-op for non-scouted issues.
    expect(pb.body).toMatch(/provenance labels/i);
    expect(pb.body).toContain('gh issue view <TARGET> -R "$REPO" --json labels');
    expect(pb.body).toMatch(/select\(\. == "idea-scout" or startswith\("idea:"\)\)/);
    expect(pb.body).toMatch(/if \[ -n "\$IDEA_LABELS" \]; then/);
    expect(pb.body).toMatch(/no-op for issues that were not scouted/i);
  });
});
