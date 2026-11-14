/**
 * Shell-contract coverage for scripts/kookr-merge.sh.
 *
 * Zero-check merge eligibility (#2148): on repos with no configured status
 * checks (every PR targeting `main` here), the poll fallback used to spin
 * until KOOKR_MERGE_CHECK_TIMEOUT and exit 3. The fix returns success
 * immediately for a zero-check PR — but ONLY once GitHub confirms
 * mergeStateStatus=CLEAN (or mergeable=MERGEABLE on a gh old enough to omit
 * mergeStateStatus), so a branch-protected repo whose required checks have
 * not yet registered is not merged prematurely.
 *
 * Branch preservation (#3222): paired delivery can still need the source
 * branch after merge. `--preserve-branch` must skip wrapper-owned deletion
 * on both the CLI merge path and the pinned REST fallback, including forks,
 * without skipping review, exact-head pinning, checks, or the post-merge
 * confirmation (CLI: state=MERGED / non-null mergedAt; REST: .merged == true).
 *
 * Never-executed check waiver (#3396): a GitHub Actions billing/quota block
 * "completes" every job as failure in seconds without running the code. That is
 * a non-code blocker, not a failing check. watch_checks reuses the
 * check-verification classifier to tell an EXTERNAL never-executed block from a
 * check that RAN and failed, and waives the former ONLY when the PR records the
 * local gate on the current head (the `local-verified` label AND a local-gate
 * comment with a `local-gate-head-sha:` line equal to the head). executed-red is
 * never waived, and the exact-head independent-review PASS is still required.
 *
 * Acceptance (#2148):
 * - zero checks + CLEAN         → merges immediately, exit 0, no hang
 * - zero checks + BLOCKED→CLEAN → polls, then merges once state settles
 * - zero checks stays BLOCKED   → times out exit 3, never merges
 * - no mergeStateStatus field   → falls back to mergeable (MERGEABLE merges,
 *                                  CONFLICTING keeps waiting)
 * - real checks all green       → merges (existing behavior preserved)
 * - real check failed           → exit 3, never merges (existing behavior)
 *
 * Acceptance (#3222):
 * - CLI and REST paths both pin the exact reviewed commit
 * - preservation omits `--delete-branch` and the source-ref DELETE
 * - REST fallback covers same-repo and fork source branches
 * - default mode still requests deletion
 * - unknown and conflicting options fail before any GitHub request
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts/kookr-merge.sh');

/**
 * Write a fake `gh` onto PATH. It dispatches on the `--json` field list and
 * serves check responses from a numbered sequence so a test can model a merge
 * state that changes across polls. A merge marker file records whether the
 * script reached `gh pr merge`.
 */
function makeStubDir(opts: {
  stateJson?: string;
  // Ordered check-view responses; poll N serves checks[min(N, len)-1].
  checksResponses: string[];
  reviewJson?: object;
  modernGh?: boolean;
  headOwner?: string;
  mergeResponse?: string;
  // CLI post-merge `gh pr view --json state,mergedAt` body (issue #3403).
  // Separate from mergeResponse: the REST merge endpoint uses `.merged`, the
  // CLI schema does not.
  verificationJson?: string;
  mergeExit?: number;
  verificationExit?: number;
  // Never-executed classifier (#3396) inputs. When set, the stub serves the
  // `gh api` surface scripts/check-verification.mjs reads: the head SHA, the
  // head-SHA check runs, each failing run's annotations, and the commit status.
  headSha?: string;
  checkRunsJson?: string;
  // Page 2 of the check-runs endpoint, served for `page=2` when the classifier
  // paginates past a full first page. Models a real red hiding beyond page 1.
  checkRunsPage2Json?: string;
  // Page 1 as served on the classifier's SECOND (verify) pass. When set, the
  // second page-1 read returns this instead of checkRunsJson — models the
  // check-run set drifting mid-pagination.
  checkRunsVerifyJson?: string;
  // Page 2 as served on the classifier's SECOND (verify) pass — models a later
  // page's run flipping conclusion (e.g. success -> failure) mid-scan.
  checkRunsPage2VerifyJson?: string;
  annotationsJson?: string;
  // The combined commit-status response (/commits/<sha>/status). Defaults to no
  // statuses.
  statusJson?: string;
  // When advertising `--watch` (GH_HAS_WATCH=1), the exit code the stubbed
  // `gh pr checks --watch` returns (non-zero models a failing/never-run check).
  watchExit?: number;
  // Models `gh pr merge --delete-branch` run from a linked worktree while the
  // base branch is checked out in another worktree (#3641): the remote merge
  // lands, then the local branch cleanup fails and gh exits 1.
  linkedWorktree?: boolean;
  // `gh api --method DELETE .../git/refs/heads/<ref>` outcome (#3641).
  deleteExit?: number;
  deleteStderr?: string;
  // `gh pr view --json closingIssuesReferences` body, and its exit code (a
  // non-zero exit models a gh too old to know the field).
  closingIssuesJson?: string;
  closingIssuesExit?: number;
  // Issue states served by `gh api repos/<owner>/<name>/issues/<n> --jq .state`,
  // keyed "owner/name#n". Read k serves states[min(k, len)-1], so ['open',
  // 'closed'] models GitHub closing the issue a moment after the merge. A key
  // with an empty list makes the lookup fail.
  issueStates?: Record<string, string[]>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'kookr-merge-stub-'));
  writeFileSync(
    join(dir, 'state.json'),
    opts.stateJson ?? '{"state":"OPEN","isDraft":false,"reviewDecision":""}',
  );
  opts.checksResponses.forEach((body, i) => {
    writeFileSync(join(dir, `checks.${i + 1}.json`), body);
  });
  writeFileSync(join(dir, 'checks.count'), String(opts.checksResponses.length));
  writeFileSync(join(dir, 'review.json'), JSON.stringify(opts.reviewJson ?? {}));
  writeFileSync(join(dir, 'merge.json'), opts.mergeResponse ?? '{"merged":true}');
  writeFileSync(
    join(dir, 'verification.json'),
    opts.verificationJson ?? '{"state":"MERGED","mergedAt":"2026-10-01T00:00:00Z"}',
  );
  // Defaults keep the classifier surface valid even for tests that never reach
  // it: an empty check-runs set classifies as none-required (exit 0), which the
  // caller treats as "no waiver", the safe direction.
  writeFileSync(join(dir, 'head.sha'), opts.headSha ?? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  writeFileSync(join(dir, 'check-runs.json'), opts.checkRunsJson ?? '{"check_runs":[]}');
  writeFileSync(join(dir, 'check-runs.p2.json'), opts.checkRunsPage2Json ?? '{"check_runs":[]}');
  if (opts.checkRunsVerifyJson !== undefined) {
    writeFileSync(join(dir, 'check-runs.verify.json'), opts.checkRunsVerifyJson);
  }
  if (opts.checkRunsPage2VerifyJson !== undefined) {
    writeFileSync(join(dir, 'check-runs.p2.verify.json'), opts.checkRunsPage2VerifyJson);
  }
  writeFileSync(join(dir, 'annotations.json'), opts.annotationsJson ?? '[]');
  writeFileSync(join(dir, 'status.json'), opts.statusJson ?? '{"state":"pending","total_count":0,"statuses":[]}');
  writeFileSync(join(dir, 'closing.json'), opts.closingIssuesJson ?? '{"closingIssuesReferences":[]}');
  writeFileSync(join(dir, 'delete.stderr'), opts.deleteStderr ?? '');
  for (const [key, states] of Object.entries(opts.issueStates ?? {})) {
    // "owner/name#7" -> issue.owner_name_7.states, one state per line.
    writeFileSync(join(dir, `issue.${key.replace(/[/#]/g, '_')}.states`), states.join('\n'));
  }

  const gh = join(dir, 'gh');
  // The stub is intentionally POSIX-plain so it runs under /usr/bin/env bash.
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -eu
DIR=${JSON.stringify(dir)}
args="$*"
printf '%s\\n' "$args" >> "$DIR/calls.log"
case "$args" in
  *"--json state,mergedAt"*|*"--json mergedAt,state"*|*"--json mergedAt"*)
    [ ${opts.verificationExit ?? 0} -eq 0 ] || exit ${opts.verificationExit ?? 0}
    cat "$DIR/verification.json"; exit 0 ;;
  *"--json merged "*|*"--json merged,"*|*"--json merged")
    # Real gh (including current 2.x) has no \`merged\` field on \`pr view\`.
    # Match a field boundary so \`mergedAt\` is not treated as \`merged\`.
    echo 'Unknown JSON field: "merged"' >&2
    echo 'Available fields: mergedAt, mergeCommit, state, mergedBy' >&2
    exit 1 ;;
  *"--json comments,labels,commits"*)
    cat "$DIR/review.json"; exit 0 ;;
  *"--json headRefName,headRepository,headRepositoryOwner"*)
    echo '{"headRefName":"paired/change","headRepository":{"name":"repo"},"headRepositoryOwner":{"login":"${opts.headOwner ?? 'owner'}"}}'; exit 0 ;;
  "repo view "*)
    echo 'owner/repo'; exit 0 ;;
  "api --method PUT "*)
    [ ${opts.mergeExit ?? 0} -eq 0 ] || exit ${opts.mergeExit ?? 0}
    printf 'merged\\n' > "$DIR/merged.marker"
    cat "$DIR/merge.json"; exit 0 ;;
  "api --method DELETE "*)
    if [ ${opts.deleteExit ?? 0} -ne 0 ]; then cat "$DIR/delete.stderr" >&2; exit ${opts.deleteExit ?? 0}; fi
    exit 0 ;;
  *"--json closingIssuesReferences"*)
    [ ${opts.closingIssuesExit ?? 0} -eq 0 ] || { echo 'Unknown JSON field: "closingIssuesReferences"' >&2; exit ${opts.closingIssuesExit ?? 0}; }
    cat "$DIR/closing.json"; exit 0 ;;
  "api repos/"*"/issues/"*)
    # "api repos/<owner>/<name>/issues/<n> --jq .state" -> issue.<owner>_<name>_<n>.states
    path="\${2#repos/}"
    key=$(printf '%s' "$path" | sed 's#/issues/#_#; s#/#_#g')
    f="$DIR/issue.$key.states"
    [ -s "$f" ] || { echo "HTTP 404: Not Found" >&2; exit 1; }
    c=0; [ -f "$f.count" ] && c=$(cat "$f.count"); c=$((c + 1)); printf '%s' "$c" > "$f.count"
    total=$(wc -l < "$f"); total=$((total + 1))
    [ "$c" -le "$total" ] || c="$total"
    sed -n "\${c}p" "$f"; exit 0 ;;
  "api repos/"*"/pulls/"*"head.sha"*)
    cat "$DIR/head.sha"; exit 0 ;;
  "api repos/"*"/check-runs/"*"/annotations"*)
    cat "$DIR/annotations.json"; exit 0 ;;
  "api repos/"*"/commits/"*"/check-runs"*"page=2"*)
    m=0; [ -f "$DIR/cr2.count" ] && m=$(cat "$DIR/cr2.count"); m=$((m + 1)); printf '%s' "$m" > "$DIR/cr2.count"
    if [ "$m" -ge 2 ] && [ -f "$DIR/check-runs.p2.verify.json" ]; then
      cat "$DIR/check-runs.p2.verify.json"
    else
      cat "$DIR/check-runs.p2.json"
    fi
    exit 0 ;;
  "api repos/"*"/commits/"*"/check-runs"*)
    # Page 1. Count reads so the classifier's second (verify) pass can be served
    # a drifted set when check-runs.verify.json is present.
    n=0; [ -f "$DIR/cr1.count" ] && n=$(cat "$DIR/cr1.count"); n=$((n + 1)); printf '%s' "$n" > "$DIR/cr1.count"
    if [ "$n" -ge 2 ] && [ -f "$DIR/check-runs.verify.json" ]; then
      cat "$DIR/check-runs.verify.json"
    else
      cat "$DIR/check-runs.json"
    fi
    exit 0 ;;
  "api repos/"*"/commits/"*"/status"*)
    cat "$DIR/status.json"; exit 0 ;;
  *"pr checks "*"--watch"*)
    exit ${opts.watchExit ?? 0} ;;
  *"--json state,isDraft,reviewDecision"*)
    cat "$DIR/state.json"; exit 0 ;;
  *"--json statusCheckRollup,mergeStateStatus,mergeable"*)
    n=0
    [ -f "$DIR/poll.count" ] && n=$(cat "$DIR/poll.count")
    n=$((n + 1)); printf '%s' "$n" > "$DIR/poll.count"
    max=$(cat "$DIR/checks.count")
    if [ "$n" -gt "$max" ]; then n="$max"; fi
    cat "$DIR/checks.$n.json"; exit 0 ;;
  *"pr checks --help"*)
    # No --watch flag (mirrors gh 2.4.0) unless GH_HAS_WATCH=1.
    if [ "\${GH_HAS_WATCH:-0}" = "1" ]; then echo "  --watch  Watch checks"; fi
    exit 0 ;;
  *"pr merge --help"*)
    echo '${opts.modernGh ? '  --match-head-commit SHA' : '  --squash  Squash and merge'}'; exit 0 ;;
  *"pr merge"*)
    [ ${opts.mergeExit ?? 0} -eq 0 ] || exit ${opts.mergeExit ?? 0}
    printf 'merged\\n' > "$DIR/merged.marker"
    case "$args" in
      *"--delete-branch"*)
        if [ "${opts.linkedWorktree ? 1 : 0}" = "1" ]; then
          echo "failed to run git: fatal: 'main' is already used by worktree at '/elsewhere'" >&2
          exit 1
        fi ;;
    esac
    exit 0 ;;
  *)
    echo "gh-stub: unhandled: $args" >&2; exit 99 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  return dir;
}

function runMerge(
  stubDir: string,
  env: Record<string, string> = {},
  args: string[] = ['123'],
): {
  status: number | null;
  stdout: string;
  stderr: string;
  merged: boolean;
  pollCount: number;
  calls: string[];
} {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      // Isolate watch_checks from the independent-review gate.
      KOOKR_MERGE_REQUIRE_REVIEW: '0',
      // Keep the poll loop snappy for the time-bounded tests.
      KOOKR_MERGE_CHECK_INTERVAL_SECONDS: '1',
      KOOKR_MERGE_CHECK_TIMEOUT_SECONDS: '30',
      ...env,
    },
  });
  const pollFile = join(stubDir, 'poll.count');
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    merged: existsSync(join(stubDir, 'merged.marker')),
    // How many statusCheckRollup reads the script made (pre-flight + polls).
    pollCount: existsSync(pollFile) ? Number(readFileSync(pollFile, 'utf8').trim()) : 0,
    calls: existsSync(join(stubDir, 'calls.log'))
      ? readFileSync(join(stubDir, 'calls.log'), 'utf8').trim().split('\n')
      : [],
  };
}

const CLEAN = '{"statusCheckRollup":[],"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE"}';
const BLOCKED = '{"statusCheckRollup":[],"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE"}';

describe('kookr-merge.sh zero-check eligibility (#2148)', () => {
  it('merges immediately when there are no checks and merge state is CLEAN', () => {
    const dir = makeStubDir({ checksResponses: [CLEAN] });
    try {
      const { status, stdout, merged } = runMerge(dir);
      expect(status).toBe(0);
      expect(stdout).toContain('no status checks reported and merge state is clean');
      expect(merged).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not merge on the first look while BLOCKED, then merges once CLEAN', () => {
    // Read 1 (pre-flight) + read 2 (first poll) → BLOCKED (checks still
    // registering), read 3 → CLEAN. The pre-flight consumes the first
    // response, so two BLOCKED reads are needed before one poll iteration
    // observes the not-clean state and logs the wait.
    const dir = makeStubDir({ checksResponses: [BLOCKED, BLOCKED, CLEAN] });
    try {
      const { status, stdout, stderr, merged, pollCount } = runMerge(dir);
      expect(status).toBe(0);
      expect(merged).toBe(true);
      // Wording-independent proof it did NOT merge on the first (BLOCKED) look:
      // reaching CLEAN required a 3rd read (pre-flight + one waiting poll + the
      // clean poll). A premature merge would have stopped at 1.
      expect(pollCount).toBeGreaterThanOrEqual(3);
      // And the human-facing wait message is emitted.
      expect(stdout + stderr).toContain('no checks yet and merge state not clean');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times out (exit 3) and never merges when merge state stays BLOCKED', () => {
    const dir = makeStubDir({ checksResponses: [BLOCKED] });
    try {
      const { status, stderr, merged } = runMerge(dir, {
        KOOKR_MERGE_CHECK_TIMEOUT_SECONDS: '1',
      });
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toContain('timed out');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to mergeable=MERGEABLE when mergeStateStatus is absent (old gh)', () => {
    const dir = makeStubDir({
      checksResponses: ['{"statusCheckRollup":null,"mergeable":"MERGEABLE"}'],
    });
    try {
      const { status, merged } = runMerge(dir);
      expect(status).toBe(0);
      expect(merged).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not merge when mergeStateStatus is absent and mergeable is CONFLICTING', () => {
    const dir = makeStubDir({
      checksResponses: ['{"statusCheckRollup":null,"mergeable":"CONFLICTING"}'],
    });
    try {
      const { status, merged } = runMerge(dir, {
        KOOKR_MERGE_CHECK_TIMEOUT_SECONDS: '1',
      });
      expect(status).toBe(3);
      expect(merged).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waits through the pre-registration window, then merges once a real check registers and passes', () => {
    // The distinct branch the fix guards: the pre-flight sees zero checks +
    // BLOCKED (checks not registered yet), the loop keeps polling, and once a
    // real check appears and succeeds the poll path (fresh `total`) merges.
    const dir = makeStubDir({
      checksResponses: [
        BLOCKED,
        BLOCKED,
        '{"statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}],"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE"}',
      ],
    });
    try {
      const { status, stdout, merged, pollCount } = runMerge(dir);
      expect(status).toBe(0);
      expect(merged).toBe(true);
      expect(pollCount).toBeGreaterThanOrEqual(3);
      // It printed the check result, not the zero-check success line.
      expect(stdout).toContain('ci: SUCCESS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes case: lowercase mergeStateStatus "clean" is still eligible', () => {
    // Guards the ascii_upcase normalization in zero_check_merge_eligible.
    const dir = makeStubDir({
      checksResponses: ['{"statusCheckRollup":[],"mergeStateStatus":"clean","mergeable":"mergeable"}'],
    });
    try {
      const { status, merged } = runMerge(dir);
      expect(status).toBe(0);
      expect(merged).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still merges when real checks are all green (behavior preserved)', () => {
    const dir = makeStubDir({
      checksResponses: [
        '{"statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}],"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE"}',
      ],
    });
    try {
      const { status, merged } = runMerge(dir);
      expect(status).toBe(0);
      expect(merged).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 3 and never merges when a real check failed (behavior preserved)', () => {
    const dir = makeStubDir({
      checksResponses: [
        '{"statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"FAILURE"}],"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE"}',
      ],
    });
    try {
      const { status, stderr, merged } = runMerge(dir);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toContain('ci: FAILURE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const REVIEWED_SHA = '156a44e29b7fa89495134fee4b35e6c60603d169';
const REVIEW_VIEW = {
  commits: [{ oid: 'older-commit' }, { oid: REVIEWED_SHA }],
  labels: [],
  comments: [{
    body: `<!-- kookr-independent-review -->\nkookr-review-verdict: pass\nreview-head-sha: ${REVIEWED_SHA}`,
  }],
};
const BRANCH_MODES = [
  { name: 'default deletion', args: [] as string[], preserve: false },
  { name: 'explicit deletion', args: ['--delete-branch'], preserve: false },
  { name: 'preservation', args: ['--preserve-branch'], preserve: true },
];

describe.each([true, false])('guarded branch policy (modern gh: %s)', (modernGh) => {
  describe.each(BRANCH_MODES)('$name', ({ args, preserve }) => {
    it.each(['owner', 'forker'])('merges the reviewed head with source owner %s', (headOwner) => {
      const dir = makeStubDir({
        checksResponses: [CLEAN],
        reviewJson: REVIEW_VIEW,
        modernGh,
        headOwner,
      });
      try {
        const result = runMerge(dir, { KOOKR_MERGE_REQUIRE_REVIEW: '1' }, [
          '123', '--repo', 'owner/repo', ...args,
        ]);
        expect(result.status, result.stderr).toBe(0);
        const mergeCalls = result.calls.filter((call) => call.startsWith('pr merge 123'));
        const putCalls = result.calls.filter((call) => call.startsWith('api --method PUT'));
        const deleteCalls = result.calls.filter((call) => call.startsWith('api --method DELETE'));
        if (modernGh) {
          // No --delete-branch on the CLI merge: the branch goes through the API (#3641).
          expect(mergeCalls).toEqual([
            `pr merge 123 --repo owner/repo --squash --match-head-commit ${REVIEWED_SHA}`,
          ]);
          expect(putCalls).toEqual([]);
          expect(result.calls.some((call) => call.includes('--json state,mergedAt'))).toBe(true);
          expect(result.calls.some((call) => /--json merged(?:\s|$)/.test(call))).toBe(false);
        } else {
          expect(mergeCalls).toEqual([]);
          expect(putCalls).toEqual([
            `api --method PUT repos/owner/repo/pulls/123/merge --raw-field sha=${REVIEWED_SHA} --raw-field merge_method=squash`,
          ]);
        }
        // Both paths delete the source ref in the HEAD repo (the fork on a
        // cross-repo PR), and only after the merge call.
        expect(deleteCalls).toEqual(preserve ? [] : [
          `api --method DELETE repos/${headOwner}/repo/git/refs/heads/paired/change`,
        ]);
        if (!preserve) {
          const mergeIndex = result.calls.findIndex(
            (call) => call.startsWith('pr merge 123') || call.startsWith('api --method PUT'),
          );
          const deleteIndex = result.calls.findIndex((call) => call.startsWith('api --method DELETE'));
          expect(deleteIndex).toBeGreaterThan(mergeIndex);
        }
        expect(result.calls.join('\n')).not.toContain('--delete-branch');
        if (preserve) {
          expect(result.stdout).toMatch(/source-branch deletion skipped/i);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each(['{"merged":false}', '{}', 'not-json', '{"state":"OPEN","mergedAt":null}'])(
      'rejects an unconfirmed merge: %s',
      (unconfirmed) => {
        const dir = makeStubDir({
          checksResponses: [CLEAN],
          reviewJson: REVIEW_VIEW,
          modernGh,
          mergeResponse: unconfirmed,
          verificationJson: unconfirmed,
        });
        try {
          const result = runMerge(dir, { KOOKR_MERGE_REQUIRE_REVIEW: '1' }, ['123', ...args]);
          expect(result.status).toBe(1);
          expect(result.stderr).toMatch(/did not merge|could not verify/i);
          expect(result.calls.join('\n')).not.toContain('--method DELETE');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    it('refuses a merge rejected by GitHub, including a moved head', () => {
      const dir = makeStubDir({
        checksResponses: [CLEAN],
        reviewJson: REVIEW_VIEW,
        modernGh,
        mergeExit: 1,
      });
      try {
        const result = runMerge(dir, { KOOKR_MERGE_REQUIRE_REVIEW: '1' }, ['123', ...args]);
        expect(result.status).toBe(1);
        expect(result.merged).toBe(false);
        expect(result.calls.join('\n')).not.toContain('--method DELETE');
        expect(result.calls.join('\n')).toContain(REVIEWED_SHA);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      {
        name: 'missing independent review',
        reviewJson: { ...REVIEW_VIEW, comments: [] },
        checks: CLEAN,
        status: 4,
      },
      {
        name: 'stale independent review',
        reviewJson: { ...REVIEW_VIEW, commits: [{ oid: 'later-push' }] },
        checks: CLEAN,
        status: 4,
      },
      { name: 'blocked mergeability', reviewJson: REVIEW_VIEW, checks: BLOCKED, status: 3 },
      {
        name: 'failed checks',
        reviewJson: REVIEW_VIEW,
        checks: '{"statusCheckRollup":[{"name":"ci","status":"COMPLETED","conclusion":"FAILURE"}],"mergeStateStatus":"BLOCKED"}',
        status: 3,
      },
    ])('keeps the gate for $name', ({ reviewJson, checks, status }) => {
      const dir = makeStubDir({ checksResponses: [checks], reviewJson, modernGh });
      try {
        const result = runMerge(dir, {
          KOOKR_MERGE_REQUIRE_REVIEW: '1',
          KOOKR_MERGE_CHECK_TIMEOUT_SECONDS: '0',
        }, ['123', ...args]);
        expect(result.status).toBe(status);
        expect(result.merged).toBe(false);
        expect(
          result.calls.some((call) => call.startsWith('pr merge 123') || call.startsWith('api --method')),
        ).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// --- never-executed check waiver (#3396) fixtures ---
const NE_HEAD = '1f1b1b9817a03767d52e32d95456e6d1f36e1ecc';
// A rollup that LOOKS failed: a never-executed billing block still reports each
// job's conclusion as FAILURE, so watch_checks must consult the classifier
// rather than exit 3 on the rollup alone.
const FAILED_ROLLUP =
  '{"statusCheckRollup":[{"name":"unittest","status":"COMPLETED","conclusion":"FAILURE"}],"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE"}';
// A billing/quota block: the job "failed" in ~5s carrying the spending-limit
// annotation — the classifier returns never-executed (exit 10).
const BILLING_CHECK_RUNS =
  '{"check_runs":[{"id":111,"name":"unittest","status":"completed","conclusion":"failure","started_at":"2026-09-30T00:00:00Z","completed_at":"2026-09-30T00:00:05Z","output":{"annotations_count":1}}]}';
const BILLING_ANNOTATIONS =
  '[{"message":"The job was not started because recent account payments have failed or your spending limit needs to be increased."}]';
// A real unittest failure: the job ran for minutes and failed on the code, with
// a non-billing annotation — the classifier returns executed-red (exit 20).
const REAL_FAILURE_CHECK_RUNS =
  '{"check_runs":[{"id":222,"name":"unittest","status":"completed","conclusion":"failure","started_at":"2026-09-30T00:00:00Z","completed_at":"2026-09-30T00:03:00Z","output":{"annotations_count":1}}]}';
const REAL_FAILURE_ANNOTATIONS =
  '[{"message":"2 tests failed: AssertionError in scripts/foo.test.ts"}]';

// A never-executed run via the `started_at: null` signal (GitHub refused to
// dispatch) — no annotation fetch needed, so a full page of them is cheap.
function noStartRun(id: number): string {
  return `{"id":${id},"name":"check-${id}","status":"completed","conclusion":"failure","started_at":null,"completed_at":"2026-09-30T00:00:03Z","output":{"annotations_count":0}}`;
}
// A full first page (100 runs) forces the classifier to fetch page 2. total_count
// of 101 means the set is complete only once page 2's single run is included.
const FULL_PAGE1_NEVER_EXECUTED = `{"total_count":101,"check_runs":[${Array.from(
  { length: 100 },
  (_, i) => noStartRun(i + 1),
).join(',')}]}`;
const PAGE2_REAL_RED =
  '{"total_count":101,"check_runs":[{"id":999,"name":"integration","status":"completed","conclusion":"failure","started_at":"2026-09-30T00:00:00Z","completed_at":"2026-09-30T00:03:00Z","output":{"annotations_count":0}}]}';

function localGateComment(sha: string) {
  return { body: `<!-- kookr-local-gate -->\npnpm verify: pass (3537 tests)\nlocal-gate-head-sha: ${sha}` };
}
function independentPassComment(sha: string) {
  return { body: `<!-- kookr-independent-review -->\nkookr-review-verdict: pass\nreview-head-sha: ${sha}` };
}
function localGateReview(overrides: {
  labels?: unknown[];
  comments?: unknown[];
  commits?: unknown[];
} = {}) {
  return {
    commits: overrides.commits ?? [{ oid: NE_HEAD }],
    labels: overrides.labels ?? [{ name: 'local-verified' }],
    comments: overrides.comments ?? [localGateComment(NE_HEAD)],
  };
}

describe('never-executed check waiver (#3396)', () => {
  it('merges a never-executed billing failure when local-verified + a head-bound local-gate comment are present', () => {
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: BILLING_CHECK_RUNS,
      annotationsJson: BILLING_ANNOTATIONS,
      reviewJson: localGateReview(),
    });
    try {
      const { status, stdout, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(0);
      expect(merged).toBe(true);
      expect(stdout).toContain('proceeding on the local verification gate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still exits 3 on an executed-red failure even when the local gate is present', () => {
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: REAL_FAILURE_CHECK_RUNS,
      annotationsJson: REAL_FAILURE_ANNOTATIONS,
      reviewJson: localGateReview(),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      // The classifier's verdict is surfaced for the run log.
      expect(stderr).toMatch(/EXECUTED-RED|never merge/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a never-executed failure when no local gate is recorded', () => {
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: BILLING_CHECK_RUNS,
      annotationsJson: BILLING_ANNOTATIONS,
      reviewJson: localGateReview({ labels: [], comments: [] }),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toContain('local gate is not recorded on the current head');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a never-executed failure when the local-gate comment is bound to a stale head', () => {
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: BILLING_CHECK_RUNS,
      annotationsJson: BILLING_ANNOTATIONS,
      // Label present, but the local-gate comment binds an earlier push.
      reviewJson: localGateReview({
        comments: [localGateComment('0000000000000000000000000000000000000000')],
      }),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      // Refused specifically by the head-binding check on a confirmed
      // never-executed classification — not an accidental classifier error path.
      expect(stderr).toContain('local gate is not recorded on the current head');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a never-executed failure when the local-verified label is missing', () => {
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: BILLING_CHECK_RUNS,
      annotationsJson: BILLING_ANNOTATIONS,
      // Head-bound comment present, but the label is absent.
      reviewJson: localGateReview({ labels: [] }),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toContain('local gate is not recorded on the current head');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours the started_at=null never-executed signal (no billing annotation)', () => {
    // The classifier's other authoritative never-executed signal: GitHub refused
    // to dispatch the job, so started_at is an explicit null — no annotation.
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson:
        '{"check_runs":[{"id":333,"name":"unittest","status":"completed","conclusion":"failure","started_at":null,"completed_at":"2026-09-30T00:00:03Z","output":{"annotations_count":0}}]}',
      annotationsJson: '[]',
      reviewJson: localGateReview(),
    });
    try {
      const { status, stdout, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(0);
      expect(merged).toBe(true);
      expect(stdout).toContain('proceeding on the local verification gate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an unavailable classifier as a real failure (fails safe to exit 3)', () => {
    // Even with a never-executed-looking rollup and a valid local gate, an
    // inability to classify must never waive — the documented safe direction.
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: BILLING_CHECK_RUNS,
      annotationsJson: BILLING_ANNOTATIONS,
      reviewJson: localGateReview(),
    });
    try {
      const { status, stderr, merged } = runMerge(
        dir,
        { KOOKR_MERGE_CLASSIFIER: join(dir, 'does-not-exist.mjs') },
        ['123', '--repo', 'owner/repo'],
      );
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toContain('check classifier not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not waive when a real red hides beyond page 1 of the check runs', () => {
    // Safety: the waiver may only fire once the classifier has seen EVERY run. A
    // full first page (100 never-executed runs) forces pagination; a real
    // executed-red sits on page 2. The classifier must fetch it, see the red,
    // and refuse — never merge on the truncated first page.
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: FULL_PAGE1_NEVER_EXECUTED,
      checkRunsPage2Json: PAGE2_REAL_RED,
      reviewJson: localGateReview(),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toMatch(/EXECUTED-RED|never merge/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the check-run fetch is incomplete (total_count unmet)', () => {
    // Fail closed: page 1 is a short page (so the last page) yet advertises
    // total_count=2, so the classifier saw only 1 of 2 runs. A partial view must
    // NOT be waived — an unseen run could be a real red.
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson:
        '{"total_count":2,"check_runs":[{"id":111,"name":"unittest","status":"completed","conclusion":"failure","started_at":null,"completed_at":"2026-09-30T00:00:05Z","output":{"annotations_count":0}}]}',
      annotationsJson: BILLING_ANNOTATIONS,
      reviewJson: localGateReview(),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toContain('incomplete check-runs fetch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the check-run set drifts during pagination (TOCTOU)', () => {
    // Fail closed: the count is met, but re-reading page 1 reveals a run id the
    // scan never collected — the set changed under us and a new run could be a
    // real red. A stable count over a changed set must not be trusted.
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      // First pass: one never-executed run, count consistent.
      checkRunsJson:
        '{"total_count":1,"check_runs":[{"id":111,"name":"unittest","status":"completed","conclusion":"failure","started_at":null,"completed_at":"2026-09-30T00:00:05Z","output":{"annotations_count":0}}]}',
      // Verify pass sees a different run id (a run arrived after the scan).
      checkRunsVerifyJson:
        '{"total_count":1,"check_runs":[{"id":222,"name":"integration","status":"completed","conclusion":"failure","started_at":"2026-09-30T00:00:00Z","completed_at":"2026-09-30T00:03:00Z","output":{"annotations_count":0}}]}',
      reviewJson: localGateReview(),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toContain('verdict changed during pagination');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the verify pass itself is incomplete (later run appears)', () => {
    // Fail closed even when the FIRST pass looked whole: the verify pass now
    // advertises total_count=2 with only one run in hand, so it too must be held
    // to the completeness bar — a run appeared and we did not see it.
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson:
        '{"total_count":1,"check_runs":[{"id":111,"name":"unittest","status":"completed","conclusion":"failure","started_at":null,"completed_at":"2026-09-30T00:00:05Z","output":{"annotations_count":0}}]}',
      checkRunsVerifyJson:
        '{"total_count":2,"check_runs":[{"id":111,"name":"unittest","status":"completed","conclusion":"failure","started_at":null,"completed_at":"2026-09-30T00:00:05Z","output":{"annotations_count":0}}]}',
      reviewJson: localGateReview(),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toContain('incomplete check-runs fetch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when a later-page run flips conclusion mid-scan (success -> failure)', () => {
    // Fail closed on the exact TOCTOU where a page-2 run is updated between the
    // two passes: page 1 and the count are unchanged, but the run's conclusion
    // flips. Comparing full set fingerprints (not just page 1 / the count) must
    // catch it — otherwise the first pass's stale `success` would be classified.
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: FULL_PAGE1_NEVER_EXECUTED,
      checkRunsPage2Json:
        '{"total_count":101,"check_runs":[{"id":999,"name":"integration","status":"completed","conclusion":"success","output":{"annotations_count":0}}]}',
      checkRunsPage2VerifyJson:
        '{"total_count":101,"check_runs":[{"id":999,"name":"integration","status":"completed","conclusion":"failure","output":{"annotations_count":0}}]}',
      reviewJson: localGateReview(),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toContain('verdict changed during pagination');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when a run\'s started_at flips mid-scan (never-executed -> executed-red)', () => {
    // The verdict-comparison must catch a classification-relevant change even
    // when id, status, and conclusion are identical: the same failing run with
    // started_at null (never-executed) vs a timestamp (executed-red). Comparing
    // hand-picked fields would miss started_at; comparing the verdict does not.
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson:
        '{"total_count":1,"check_runs":[{"id":111,"name":"unittest","status":"completed","conclusion":"failure","started_at":null,"completed_at":"2026-09-30T00:00:05Z","output":{"annotations_count":0}}]}',
      checkRunsVerifyJson:
        '{"total_count":1,"check_runs":[{"id":111,"name":"unittest","status":"completed","conclusion":"failure","started_at":"2026-09-30T00:00:00Z","completed_at":"2026-09-30T00:03:00Z","output":{"annotations_count":0}}]}',
      reviewJson: localGateReview(),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toContain('verdict changed during pagination');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not waive when the combined commit status is a failure', () => {
    // A red legacy commit status is a real executed failure with no billing
    // concept. Even with a billing-blocked check run and the local gate present,
    // a failed combined status must classify executed-red and refuse — the
    // classifier reads the aggregate `state`, so a failed context on any page
    // (not just the first 100) is caught.
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: BILLING_CHECK_RUNS,
      annotationsJson: BILLING_ANNOTATIONS,
      statusJson: '{"state":"failure","total_count":101,"statuses":[{"state":"success","context":"legacy-ci"}]}',
      reviewJson: localGateReview(),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toMatch(/EXECUTED-RED|never merge/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not waive a check that ran and failed then was re-run into a billing block', () => {
    // filter=all: a rerun keeps the SHA, so the failed original attempt and the
    // never-executed rerun coexist (distinct ids). The executed-red attempt must
    // win — "ran and failed on this head" is never waived by a later billing rerun.
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson:
        '{"total_count":2,"check_runs":[' +
        // Original attempt: ran for minutes and failed on the code.
        '{"id":111,"name":"unittest","status":"completed","conclusion":"failure","started_at":"2026-09-30T00:00:00Z","completed_at":"2026-09-30T00:03:00Z","output":{"annotations_count":0}},' +
        // Rerun: billing-blocked (never executed).
        '{"id":112,"name":"unittest","status":"completed","conclusion":"failure","started_at":null,"completed_at":"2026-09-30T00:00:04Z","output":{"annotations_count":0}}' +
        ']}',
      reviewJson: localGateReview(),
    });
    try {
      const { status, stderr, merged } = runMerge(dir, {}, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(3);
      expect(merged).toBe(false);
      expect(stderr).toMatch(/EXECUTED-RED|never merge/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes the --watch fast path through the same waiver', () => {
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: BILLING_CHECK_RUNS,
      annotationsJson: BILLING_ANNOTATIONS,
      watchExit: 1,
      reviewJson: localGateReview(),
    });
    try {
      const { status, merged } = runMerge(dir, { GH_HAS_WATCH: '1' }, ['123', '--repo', 'owner/repo']);
      expect(status).toBe(0);
      expect(merged).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still requires the exact-head independent PASS even with a never-executed waiver', () => {
    // Local gate present and the checks never executed — but no independent
    // review verdict. The review gate (which runs first) must still block.
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: BILLING_CHECK_RUNS,
      annotationsJson: BILLING_ANNOTATIONS,
      reviewJson: localGateReview(),
    });
    try {
      const { status, merged } = runMerge(dir, { KOOKR_MERGE_REQUIRE_REVIEW: '1' }, [
        '123', '--repo', 'owner/repo',
      ]);
      expect(status).toBe(4);
      expect(merged).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges the issue scenario: independent PASS + local gate + billing block, pinned to the reviewed head', () => {
    const dir = makeStubDir({
      checksResponses: [FAILED_ROLLUP],
      headSha: NE_HEAD,
      checkRunsJson: BILLING_CHECK_RUNS,
      annotationsJson: BILLING_ANNOTATIONS,
      modernGh: true,
      reviewJson: localGateReview({
        commits: [{ oid: 'older-commit' }, { oid: NE_HEAD }],
        comments: [independentPassComment(NE_HEAD), localGateComment(NE_HEAD)],
      }),
    });
    try {
      const result = runMerge(dir, { KOOKR_MERGE_REQUIRE_REVIEW: '1' }, ['123', '--repo', 'owner/repo']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.merged).toBe(true);
      // Exact-head safety preserved: the merge pins the reviewed head.
      expect(result.calls.some((c) => c.includes(`--match-head-commit ${NE_HEAD}`))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('branch option validation before any GitHub request', () => {
  it.each([
    { args: ['123', '--unknown-option'], errors: ['--unknown-option'] },
    { args: ['123', '--preserve-branch', '--delete-branch'], errors: ['--preserve-branch', '--delete-branch'] },
    { args: ['123', '--delete-branch', '--preserve-branch'], errors: ['--preserve-branch', '--delete-branch'] },
    { args: ['123', '--', '--unknown-option'], errors: ['--unknown-option'] },
    { args: ['123', '--preserve-branch', '--', '--delete-branch'], errors: ['--delete-branch'] },
    { args: ['123', '--repo', '--preserve-branch'], errors: ['--repo', '--preserve-branch'] },
    { args: ['123', '--repo='], errors: ['--repo'] },
  ])('rejects $args locally', ({ args, errors }) => {
    const dir = makeStubDir({ checksResponses: [CLEAN] });
    try {
      const result = runMerge(dir, {}, args);
      expect(result.status).toBe(2);
      for (const error of errors) expect(result.stderr).toContain(error);
      expect(result.calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI merge confirmation uses gh-supported fields (#3403)', () => {
  it('succeeds when state is MERGED even if mergedAt is null', () => {
    const dir = makeStubDir({
      checksResponses: [CLEAN],
      modernGh: true,
      verificationJson: '{"state":"MERGED","mergedAt":null}',
    });
    try {
      const result = runMerge(dir, {}, ['123']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.merged).toBe(true);
      expect(result.calls.some((call) => call.includes('--json state,mergedAt'))).toBe(true);
      expect(result.calls.some((call) => /--json merged(?:\s|$)/.test(call))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('succeeds when mergedAt is set even if state is not MERGED', () => {
    const dir = makeStubDir({
      checksResponses: [CLEAN],
      modernGh: true,
      verificationJson: '{"state":"CLOSED","mergedAt":"2026-10-01T12:00:00Z"}',
    });
    try {
      const result = runMerge(dir, {}, ['123']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.merged).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not treat a successful squash-merge as failure just because gh rejects --json merged', () => {
    // The original bug: gh pr view --json merged exits 1 with "Unknown JSON
    // field", so the wrapper printed "could not verify" after gh pr merge had
    // already succeeded. The stub still rejects --json merged like real gh.
    const dir = makeStubDir({
      checksResponses: [CLEAN],
      modernGh: true,
      verificationJson: '{"state":"MERGED","mergedAt":"2026-10-01T12:00:00Z"}',
    });
    try {
      const result = runMerge(dir, {}, ['123']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('could not verify');
      expect(result.calls.filter((call) => call.startsWith('pr merge 123'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI merge confirmation', () => {
  it('reports a failed confirmation request without retrying the merge', () => {
    const dir = makeStubDir({
      checksResponses: [CLEAN],
      reviewJson: REVIEW_VIEW,
      modernGh: true,
      verificationExit: 1,
    });
    try {
      const result = runMerge(dir, { KOOKR_MERGE_REQUIRE_REVIEW: '1' }, ['123', '--preserve-branch']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('could not verify');
      expect(result.calls.filter((call) => call.startsWith('pr merge 123'))).toHaveLength(1);
      expect(result.calls.join('\n')).not.toContain('--method DELETE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(BRANCH_MODES)('respects $name for an explicitly review-disabled manual merge', ({ args, preserve }) => {
    const dir = makeStubDir({ checksResponses: [CLEAN] });
    try {
      const result = runMerge(dir, {}, ['123', ...args]);
      expect(result.status).toBe(0);
      expect(result.calls.filter((call) => call.startsWith('pr merge 123'))).toEqual([
        'pr merge 123 --squash',
      ]);
      expect(result.calls.filter((call) => call.startsWith('api --method DELETE'))).toEqual(
        preserve ? [] : ['api --method DELETE repos/owner/repo/git/refs/heads/paired/change'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- API head-branch deletion, closing-issue report, `kookr merge` (#3641) ---

const KOOKR_BIN = join(process.cwd(), 'bin/kookr.js');

describe.each([true, false])('API head-branch deletion (#3641, modern gh: %s)', (modernGh) => {
  it('exits 0 after a merge from a linked worktree, and deletes the remote branch through the API', () => {
    // linkedWorktree: the stub fails any `gh pr merge --delete-branch` after the
    // remote merge, as gh does when the base branch is checked out in another
    // worktree. The wrapper must never pass that flag.
    const dir = makeStubDir({
      checksResponses: [CLEAN],
      reviewJson: REVIEW_VIEW,
      modernGh,
      linkedWorktree: true,
    });
    try {
      const result = runMerge(dir, { KOOKR_MERGE_REQUIRE_REVIEW: '1' }, ['123', '--repo', 'owner/repo']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.merged).toBe(true);
      expect(result.calls.join('\n')).not.toContain('--delete-branch');
      expect(result.calls.filter((call) => call.startsWith('api --method DELETE'))).toEqual([
        'api --method DELETE repos/owner/repo/git/refs/heads/paired/change',
      ]);
      expect(result.stdout).toContain('deleted head branch paired/change');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an already-deleted branch as gone and still exits 0', () => {
    const dir = makeStubDir({
      checksResponses: [CLEAN],
      reviewJson: REVIEW_VIEW,
      modernGh,
      deleteExit: 1,
      deleteStderr: 'gh: Reference does not exist (HTTP 422)',
    });
    try {
      const result = runMerge(dir, { KOOKR_MERGE_REQUIRE_REVIEW: '1' }, ['123']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('head branch paired/change was already deleted');
      expect(result.stderr).not.toContain('was not deleted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns, with the command to finish the job, when the delete fails, but keeps exit 0 for the landed merge', () => {
    const dir = makeStubDir({
      checksResponses: [CLEAN],
      reviewJson: REVIEW_VIEW,
      modernGh,
      deleteExit: 1,
      deleteStderr: 'gh: Resource not accessible by integration (HTTP 403)',
    });
    try {
      const result = runMerge(dir, { KOOKR_MERGE_REQUIRE_REVIEW: '1' }, ['123']);
      expect(result.status).toBe(0);
      expect(result.merged).toBe(true);
      expect(result.stderr).toContain('head branch paired/change was not deleted');
      expect(result.stderr).toContain('gh api --method DELETE repos/owner/repo/git/refs/heads/paired/change');
      expect(result.stderr).toContain('HTTP 403');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function closingRefs(...refs: Array<[string, string, number]>): string {
  return JSON.stringify({
    closingIssuesReferences: refs.map(([owner, name, number]) => ({
      number,
      url: `https://github.com/${owner}/${name}/issues/${number}`,
      repository: { name, owner: { login: owner } },
    })),
  });
}

describe.each([true, false])('closing-issue report after the merge (#3641, modern gh: %s)', (modernGh) => {
  function run(opts: Partial<Parameters<typeof makeStubDir>[0]>) {
    const dir = makeStubDir({ checksResponses: [CLEAN], reviewJson: REVIEW_VIEW, modernGh, ...opts });
    try {
      return runMerge(dir, { KOOKR_MERGE_REQUIRE_REVIEW: '1' }, ['123', '--repo', 'owner/repo']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reports a declared closing issue that is still open after the re-check, and keeps exit 0', () => {
    const result = run({
      closingIssuesJson: closingRefs(['owner', 'repo', 7], ['owner', 'repo', 8]),
      issueStates: { 'owner/repo#7': ['open', 'open'], 'owner/repo#8': ['closed'] },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.merged).toBe(true);
    expect(result.stderr).toContain(
      'issue owner/repo#7 is declared as closed by PR #123 but is still open — close it (gh issue close 7 --repo owner/repo)',
    );
    expect(result.stderr).not.toContain('owner/repo#8');
    // Read once, then re-checked once after the grace interval; #8 was closed
    // on the first read and is not re-read.
    const issueReads = result.calls.filter((call) => call.startsWith('api repos/owner/repo/issues/'));
    expect(issueReads).toEqual([
      'api repos/owner/repo/issues/7 --jq .state',
      'api repos/owner/repo/issues/8 --jq .state',
      'api repos/owner/repo/issues/7 --jq .state',
    ]);
  });

  it('does not report an issue GitHub closes during the grace interval', () => {
    const result = run({
      closingIssuesJson: closingRefs(['owner', 'repo', 7]),
      issueStates: { 'owner/repo#7': ['open', 'closed'] },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('still open');
    expect(result.stdout).toContain('every issue PR #123 declares as closing is closed');
  });

  it('looks a cross-repository closing issue up in its own repository', () => {
    const result = run({
      closingIssuesJson: closingRefs(['other-org', 'lib', 9]),
      issueStates: { 'other-org/lib#9': ['OPEN'] },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain('api repos/other-org/lib/issues/9 --jq .state');
    expect(result.stderr).toContain('issue other-org/lib#9 is declared as closed by PR #123 but is still open');
  });

  it('says nothing about issues when the PR declares none', () => {
    const result = run({});
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some((call) => call.includes('--json closingIssuesReferences'))).toBe(true);
    expect(result.calls.some((call) => call.includes('/issues/'))).toBe(false);
    expect(result.stdout + result.stderr).not.toMatch(/closing is closed|still open/);
  });

  it('warns but keeps exit 0 when gh cannot read the closing references', () => {
    const result = run({ closingIssuesExit: 1 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('could not read the issues PR #123 declares as closing');
  });

  it('warns about an unreadable issue instead of calling it closed', () => {
    const result = run({
      closingIssuesJson: closingRefs(['owner', 'repo', 7]),
      issueStates: { 'owner/repo#7': [] },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('could not read the state of closing issue owner/repo#7');
    expect(result.stdout).not.toContain('closing is closed');
  });

  it('skips the report when the merge did not land', () => {
    const result = run({ closingIssuesJson: closingRefs(['owner', 'repo', 7]), mergeExit: 1 });
    expect(result.status).toBe(1);
    expect(result.calls.some((call) => call.includes('closingIssuesReferences'))).toBe(false);
  });
});

describe('kookr merge dispatches the wrapper from any cwd (#3641)', () => {
  function runKookr(stubDir: string, cwd: string, args: string[]) {
    const result = spawnSync(process.execPath, [KOOKR_BIN, 'merge', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
        KOOKR_MERGE_REQUIRE_REVIEW: '1',
        KOOKR_MERGE_CHECK_INTERVAL_SECONDS: '1',
        KOOKR_MERGE_CHECK_TIMEOUT_SECONDS: '30',
      },
    });
    const callsFile = join(stubDir, 'calls.log');
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      calls: existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [],
    };
  }

  it('merges through the gated wrapper with a cwd outside the kookr repo', () => {
    const stub = makeStubDir({ checksResponses: [CLEAN], reviewJson: REVIEW_VIEW, modernGh: true });
    const elsewhere = mkdtempSync(join(tmpdir(), 'kookr-merge-elsewhere-'));
    try {
      const result = runKookr(stub, elsewhere, ['123', '--repo', 'owner/repo']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('independent-review gate: pass');
      expect(result.calls).toContain(`pr merge 123 --repo owner/repo --squash --match-head-commit ${REVIEWED_SHA}`);
      expect(result.calls).toContain('api --method DELETE repos/owner/repo/git/refs/heads/paired/change');
    } finally {
      rmSync(stub, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('passes the wrapper exit code through (review gate block -> 4)', () => {
    const stub = makeStubDir({ checksResponses: [CLEAN], reviewJson: { ...REVIEW_VIEW, comments: [] } });
    const elsewhere = mkdtempSync(join(tmpdir(), 'kookr-merge-elsewhere-'));
    try {
      const result = runKookr(stub, elsewhere, ['123', '--repo', 'owner/repo']);
      expect(result.status).toBe(4);
      expect(result.calls.some((call) => call.startsWith('pr merge 123'))).toBe(false);
    } finally {
      rmSync(stub, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('passes usage errors and --help through', () => {
    const stub = makeStubDir({ checksResponses: [CLEAN] });
    const elsewhere = mkdtempSync(join(tmpdir(), 'kookr-merge-elsewhere-'));
    try {
      expect(runKookr(stub, elsewhere, ['not-a-number']).status).toBe(2);
      const help = runKookr(stub, elsewhere, ['--help']);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('Usage: kookr-merge <pr-number>');
      expect(help.calls).toEqual([]);
    } finally {
      rmSync(stub, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
