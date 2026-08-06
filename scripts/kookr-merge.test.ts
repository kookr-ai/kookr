/**
 * Focused coverage for scripts/kookr-merge.sh zero-check merge eligibility (#2148).
 *
 * Background: on repos with no configured status checks (every PR targeting
 * `main` here), the poll fallback used to spin until KOOKR_MERGE_CHECK_TIMEOUT
 * and exit 3. The fix returns success immediately for a zero-check PR — but
 * ONLY once GitHub confirms mergeStateStatus=CLEAN (or mergeable=MERGEABLE on a
 * gh old enough to omit mergeStateStatus), so a branch-protected repo whose
 * required checks have not yet registered is not merged prematurely.
 *
 * Acceptance:
 * - zero checks + CLEAN         → merges immediately, exit 0, no hang
 * - zero checks + BLOCKED→CLEAN → polls, then merges once state settles
 * - zero checks stays BLOCKED   → times out exit 3, never merges
 * - no mergeStateStatus field   → falls back to mergeable (MERGEABLE merges,
 *                                  CONFLICTING keeps waiting)
 * - real checks all green       → merges (existing behavior preserved)
 * - real check failed           → exit 3, never merges (existing behavior)
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

  const gh = join(dir, 'gh');
  // The stub is intentionally POSIX-plain so it runs under /usr/bin/env bash.
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -eu
DIR=${JSON.stringify(dir)}
args="$*"
case "$args" in
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
    echo "  --squash  Squash and merge"; exit 0 ;;
  *"pr merge"*)
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
): {
  status: number | null;
  stdout: string;
  stderr: string;
  merged: boolean;
  pollCount: number;
} {
  const result = spawnSync('bash', [SCRIPT, '123'], {
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

  it('refuses to fast-path a zero-check PR when mergeStateStatus is unavailable, even if mergeable=MERGEABLE', () => {
    // Regression guard for the review finding: `mergeable` is only a Git-level
    // conflict signal and flips to MERGEABLE within seconds regardless of check
    // registration, so it must NOT authorize a zero-check merge. On a gh too
    // old to report mergeStateStatus we keep waiting rather than merge on an
    // unverifiable signal — strictly safer than re-opening the pre-registration
    // premature-merge window (#2148).
    const dir = makeStubDir({
      checksResponses: ['{"statusCheckRollup":null,"mergeable":"MERGEABLE"}'],
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
