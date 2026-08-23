import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlaybook } from './playbook-parser.js';

/**
 * Contract tests for the parallel-issue-batch playbook's headless report-and-exit
 * behavior (issue #1714). A scheduled/parent-spawned batch has nobody to answer
 * an interactive prompt, so calling `AskUserQuestion` on an empty backlog strands
 * the task in `needs_input` for its whole lifetime while it holds a maxActiveTasks
 * slot (2026-07-30 incidents: batches 305a603d and 5c6ddf5c each ~8h). These
 * assertions pin the load-bearing wording so an edit that drops the headless gate,
 * the report-and-exit protocol, or the machine-readable outcome record fails CI
 * instead of quietly regressing to the stranding behavior.
 */
describe('parallel-issue-batch playbook: headless report-and-exit (#1714)', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'parallel-issue-batch.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'parallel-issue-batch.md', '/');

  test('parses with a name and description', () => {
    expect(pb.name).toBe('Parallel Issue Batch');
    expect(pb.description.length).toBeGreaterThan(0);
  });

  test('detects headless mode from the injected launch-provenance signals', () => {
    // The env vars the adapter injects (issue #1583/#1714) are the source of the
    // headless decision; the playbook must branch on them, not guess.
    expect(pb.body).toContain('KOOKR_LAUNCH_PROVENANCE');
    expect(pb.body).toContain('KOOKR_PARENT_TASK_ID');
    expect(pb.body).toContain('KOOKR_UNATTENDED');
    // schedule and parent provenance are both headless.
    expect(pb.body).toMatch(/schedule\|parent/);
  });

  test('forbids AskUserQuestion in headless runs regardless of onAmbiguity', () => {
    // The headline invariant: the `ask` default must be overridden when headless.
    expect(pb.body).toMatch(/forbidden regardless of `?\{\{onAmbiguity\}\}`?/i);
    expect(pb.body).toMatch(/never call `?AskUserQuestion`?/i);
    // Interactive runs keep the prompt — the fix must not disable it wholesale.
    expect(pb.body).toMatch(/Interactive.*`?\{\{onAmbiguity\}\}`? applies unchanged/i);
  });

  test('routes an empty backlog through report-and-exit, terminating completed not needs_input', () => {
    expect(pb.body).toContain('Report-and-exit protocol');
    expect(pb.body).toMatch(/`?completed`?, never `?needs_input`?/i);
    // The terminal marker for a drained backlog is a no-op completion, not BLOCKED.
    expect(pb.body).toContain('NO-ELIGIBLE-WORK');
  });

  test('cites the motivating stranding incidents so the regression stays visible', () => {
    expect(pb.body).toContain('305a603d');
    expect(pb.body).toContain('5c6ddf5c');
  });

  test('emits a machine-readable blocked-empty outcome record for the refill trigger', () => {
    expect(pb.body).toContain('$OUTCOME_FILE');
    expect(pb.body).toContain('outcome.json');
    expect(pb.body).toContain('blocked-empty');
    expect(pb.body).toContain('schemaVersion');
    // The report itemizes every open issue with its disqualifier (batch 74022030
    // did this correctly), not just a bare count.
    expect(pb.body).toContain('disqualified');
    expect(pb.body).toContain('74022030');
  });

  test('lists the headless report-and-exit contract in the checklist', () => {
    const checklistText = pb.checklist.join('\n');
    expect(checklistText).toMatch(/Headless runs.*never called AskUserQuestion/i);
    expect(checklistText).toContain('blocked-empty');
  });

  test('keeps onAmbiguity offering the interactive ask default', () => {
    const param = pb.parameters.find((p) => p.name === 'onAmbiguity');
    expect(param).toBeDefined();
    expect(param!.default).toBe('ask');
    const values = (param!.options ?? []).map((o) => o.value).sort();
    expect(values).toEqual(['ask', 'auto-safe-subset', 'auto-stop']);
  });
});

/**
 * Contract tests for the pipeline-starvation refill trigger (issue #1715).
 * After a blocked-empty outcome the batch MUST hand the record to the engine
 * so an on-demand idea-scout can refill the queue and a second consecutive
 * empty can raise a pipeline-starvation alert. These assertions pin the
 * call site so the playbook cannot silently drop the composition with the
 * engine endpoint.
 */
describe('parallel-issue-batch playbook: pipeline-starvation refill (#1715)', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'parallel-issue-batch.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'parallel-issue-batch.md', '/');

  test('invokes POST /api/pipeline-starvation/handle after blocked-empty', () => {
    expect(pb.body).toContain('/api/pipeline-starvation/handle');
    expect(pb.body).toContain('pipeline-starvation refill');
    expect(pb.body).toMatch(/starvation-trigger/);
  });

  test('records any spawned scout taskId in state.md for auditability', () => {
    expect(pb.body).toContain('starvationScoutTaskId');
    expect(pb.body).toMatch(/\$STATE_FILE/);
  });

  test('documents engine-side dedup and second-consecutive alert contract', () => {
    expect(pb.body).toMatch(/max 1 starvation-triggered scout per repo per 4h/i);
    expect(pb.body).toMatch(/second consecutive.*12h/i);
    expect(pb.body).toMatch(/first does not/i);
  });

  test('lists the starvation-refill contract in the checklist', () => {
    const checklistText = pb.checklist.join('\n');
    expect(checklistText).toMatch(/pipeline-starvation refill/i);
    expect(checklistText).toContain('starvation-trigger');
  });

  test('PR2: handle retries once and hard-fails after retry (not soft || true only)', () => {
    expect(pb.body).toMatch(/HANDLE_ATTEMPT|for HANDLE_ATTEMPT in 1 2/);
    expect(pb.body).toMatch(/failed after retry/);
    expect(pb.body).toMatch(/exit 1/);
    // Soft-only || true on the handle curl is no longer the sole policy.
    expect(pb.body).toContain('emptyClass');
    expect(pb.body).toContain('concurrent');
  });

  test('PR2: concurrent-batch NO-OP stamps emptyClass=concurrent', () => {
    expect(pb.body).toContain('Concurrent-batch NO-OP');
    expect(pb.body).toMatch(/emptyClass:\s*"concurrent"|emptyClass=concurrent/);
  });
});

/**
 * Contract tests for the merge follow-through hardening (2026-08-01 stranded-PR
 * incident: PRs #1830-#1833 opened and abandoned because a coordinator
 * paraphrased the child template and dropped every merge instruction, then died
 * before Phase 7 supervision could recover). These anchors pin the four layers
 * so an edit that drops any of them fails CI instead of quietly re-opening the
 * stranded-PR factory.
 */
describe('parallel-issue-batch playbook: merge follow-through hardening (2026-08-01)', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'parallel-issue-batch.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');

  test('child template opens with the terminal-state contract and forbids stopping at an open PR', () => {
    expect(content).toContain('TERMINAL-STATE CONTRACT');
    expect(content).toMatch(/an open PR is NOT a terminal state/i);
    expect(content).toMatch(/Ending your turn with an open PR and no\s+recorded blocker is a task failure/);
  });

  test('template must be copied verbatim and every child prompt passes the spawn-time contract check', () => {
    expect(content).toContain('Copy the template below VERBATIM');
    expect(content).toContain('check_child_prompt');
    // The check binds its own policy variable — it must not depend on an
    // earlier phase having exported it (the original review found $MERGE_AFTER
    // referenced but never assigned).
    expect(content).toContain('MERGE_AFTER="{{mergeAfterImplementation}}"');
    // The contract header is validated in RESOLVED form so an unsubstituted
    // <true|false> placeholder fails the check.
    expect(content).toContain('TERMINAL-STATE CONTRACT (mergeAfterImplementation=${merge_policy})');
    // The merge-bullet greps target the merge section itself, not strings that
    // happen to live elsewhere in the template.
    for (const anchor of ['classify the head-SHA check runs', 'local-verified', 'delete the head branch']) {
      expect(content).toContain(`"${anchor}"`);
    }
  });

  test('Phase 7 open-PR completion gate exists, is selection-scoped, and routes takeover through delivery ownership', () => {
    expect(content).toContain('Open-PR completion gate (hard rule)');
    expect(content).toMatch(/intersected with this batch's selection/);
    expect(content).toMatch(/stale-owner reclaim/);
  });

  test('stale-owner reclaim requires a verifiably dead child and never a merely idle one', () => {
    expect(content).toMatch(/verifiably DEAD/);
    expect(content).toMatch(/never merely idle or slow/);
    expect(content).toMatch(/when in doubt, treat it as alive/);
  });
});

describe('parallel-issue-batch playbook: queue-feeder claim recheck (#2757)', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'parallel-issue-batch.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');

  test('rechecks the durable owner immediately before Phase 4 spawn', () => {
    expect(content).toContain('check_spawn_issue_claim');
    expect(content).toMatch(/Re-read the durable owner immediately before Phase 4 spawn/);
    expect(content).toContain('kookr issue owner "$issue_number" --repo "$REPO" --json');
    expect(content).toContain('UNIT_ISSUES=$(jq -er --arg unit_id "$UNIT_ID"');
    expect(content).toContain('selection matrix issue list was not authoritative');
    expect(content).toContain('--claim-issue $PRIMARY_N --claim-repo $REPO');
  });

  test('fails closed for non-authoritative lookups and foreign live owners', () => {
    expect(content).toContain('issue-claim lookup failed');
    expect(content).toContain('non-authoritative issue-claim response');
    expect(content).toContain('claims[0].taskId | type == "string"');
    expect(content).toContain('live issue claim owned by task');
    expect(content).toContain('no child spawned');
    expect(content).toContain('.details.claims[0].taskId');
  });

  test('prevents the modeled spawn call for foreign, failed, and malformed lookups', () => {
    const helper = content.match(/   check_spawn_issue_claim\(\) \{[\s\S]*?\n   \}\n/)?.[0];
    expect(helper).toBeDefined();
    const tempDir = mkdtempSync(join(tmpdir(), 'queue-feeder-claim-test-'));
    const stateFile = join(tempDir, 'state.log');
    const script = `
set -u
PRIMARY_N=2757
UNIT_ISSUES="2757"
REPO=kookr-ai/kookr
STATE_FILE=${stateFile}
KOOKR_TASK_ID=local-task
kookr() {
  case "$CLAIM_RESULT" in
    foreign) printf '%s' '{"ok":true,"code":"OK","details":{"claims":[{"taskId":"sibling-task"}]}}' ;;
    failed) return 1 ;;
    malformed) printf '%s' '{"ok":true,"code":"OK","details":{"claims":{}}}' ;;
    unowned) printf '%s' '{"ok":true,"code":"OK","details":{"claims":[]}}' ;;
  esac
}
${helper}
run_case() {
  : > "$STATE_FILE"
  spawn_count=0
  for _ in 1; do
    if ! check_spawn_issue_claim; then
      continue
    fi
    spawn_count=$((spawn_count + 1))
  done
  printf '%s|%s|' "$CLAIM_RESULT" "$spawn_count"
  tr '\\n' ';' < "$STATE_FILE"
}
for CLAIM_RESULT in foreign failed malformed unowned; do
  run_case
done
`;
    try {
      const output = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      expect(output).toContain('foreign|0|SKIP issue #2757: live issue claim owned by task sibling-task');
      expect(output).toContain('failed|0|BLOCKER issue #2757: issue-claim lookup failed');
      expect(output).toContain('malformed|0|BLOCKER issue #2757: non-authoritative issue-claim response');
      expect(output).toContain('unowned|1|');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('checks every issue in a bundled unit before spawning', () => {
    const binding = content.match(/   if \[ -z "\$\{UNIT_ID:-\}" \][\s\S]*?\n   fi\n/)?.[0];
    const helper = content.match(/   check_spawn_issue_claim\(\) \{[\s\S]*?\n   \}\n/)?.[0];
    expect(binding).toBeDefined();
    expect(helper).toBeDefined();
    const tempDir = mkdtempSync(join(tmpdir(), 'queue-feeder-bundle-claim-test-'));
    const stateFile = join(tempDir, 'state.log');
    const script = `
set -u
PRIMARY_N=2757
UNIT_ID=u-2757-2758
SELECTION_FILE=${join(tempDir, 'selection.json')}
printf '%s' '[{"unit_id":"u-2757-2758","issues":[2757,2758]}]' > "$SELECTION_FILE"
REPO=kookr-ai/kookr
STATE_FILE=${stateFile}
KOOKR_TASK_ID=local-task
kookr() {
  case "$1" in
    issue)
      case "$3" in
        2757) printf '%s' '{"ok":true,"code":"OK","details":{"claims":[]}}' ;;
        2758) printf '%s' '{"ok":true,"code":"OK","details":{"claims":[{"taskId":"sibling-task"}]}}' ;;
      esac
      ;;
  esac
}
${binding}
${helper}
: > "$STATE_FILE"
spawn_count=0
if check_spawn_issue_claim; then
  spawn_count=$((spawn_count + 1))
fi
printf '%s|' "$spawn_count"
tr '\\n' ';' < "$STATE_FILE"
`;
    try {
      const output = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      expect(output).toContain('0|SKIP issue #2758: live issue claim owned by task sibling-task');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
