import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook } from './playbook-parser.js';
import { KB_LESSON_SKIP_MARKER } from './kb-lesson-classifier.js';

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

  test('Phase 0 skips non-automatable labels before implementation', () => {
    expect(pb.body).toContain('automation-blocked');
    expect(pb.body).toContain('question');
    // `architecture` marks design-document issues (RFCs, decision docs) that are
    // not one-PR implementation units — the selector must never auto-pick them (#1565).
    expect(pb.body).toMatch(/skip issues with labels.*automation-blocked.*architecture.*question/i);
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

  test('Phase 8.5 surfaces the post-task KB lesson decision before Phase 9', () => {
    // Issue #227 / #1538: agents must emit either a `kb remember` write or the
    // skip marker before the verdict is written (and before completion-ready),
    // so `pnpm kb:usage` can classify the task. The marker text MUST match the
    // classifier's constant verbatim — substring detection means any drift
    // breaks the metric silently.
    expect(pb.body).toMatch(/Phase 8\.5: Post-task KB lesson decision/);
    expect(pb.body).toContain('kb remember --kb=agent-task-lessons');
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
