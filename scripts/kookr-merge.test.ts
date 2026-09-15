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
 * without skipping review, exact-head pinning, checks, or `.merged == true`.
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
  mergeExit?: number;
  verificationExit?: number;
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
  *"--json merged"*)
    [ ${opts.verificationExit ?? 0} -eq 0 ] || exit ${opts.verificationExit ?? 0}
    cat "$DIR/merge.json"; exit 0 ;;
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
    exit 0 ;;
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
    printf 'merged\\n' > "$DIR/merged.marker"; exit 0 ;;
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
          expect(mergeCalls).toEqual([
            `pr merge 123 --repo owner/repo --squash${preserve ? '' : ' --delete-branch'} --match-head-commit ${REVIEWED_SHA}`,
          ]);
          expect(putCalls).toEqual([]);
          expect(deleteCalls).toEqual([]);
          expect(result.calls.some((call) => call.includes('--json merged'))).toBe(true);
        } else {
          expect(mergeCalls).toEqual([]);
          expect(putCalls).toEqual([
            `api --method PUT repos/owner/repo/pulls/123/merge --raw-field sha=${REVIEWED_SHA} --raw-field merge_method=squash`,
          ]);
          expect(deleteCalls).toEqual(preserve ? [] : [
            `api --method DELETE repos/${headOwner}/repo/git/refs/heads/paired/change`,
          ]);
        }
        if (preserve) {
          expect(result.calls.join('\n')).not.toContain('--delete-branch');
          expect(result.stdout).toMatch(/source-branch deletion skipped/i);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each(['{"merged":false}', '{}', 'not-json'])('rejects an unconfirmed merge: %s', (mergeResponse) => {
      const dir = makeStubDir({
        checksResponses: [CLEAN],
        reviewJson: REVIEW_VIEW,
        modernGh,
        mergeResponse,
      });
      try {
        const result = runMerge(dir, { KOOKR_MERGE_REQUIRE_REVIEW: '1' }, ['123', ...args]);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/did not merge|could not verify/i);
        expect(result.calls.join('\n')).not.toContain('--method DELETE');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

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
        `pr merge 123 --squash${preserve ? '' : ' --delete-branch'}`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
