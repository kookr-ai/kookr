import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INDEPENDENT_REVIEW_MARKER,
  REVIEW_SKIPPED_TIMEOUT_LABEL,
  REQUIRE_REVIEW_ENV,
} from './independent-review.js';

const repoRoot = join(import.meta.dirname, '..', '..');
const mergeScript = join(repoRoot, 'scripts', 'kookr-merge.sh');

/**
 * The merge wrapper embeds the review-gate literals verbatim (bash cannot import
 * the TS constants). These drift-guard assertions fail loudly if the script and
 * src/core/independent-review.ts fall out of sync — mirroring how the playbook
 * test pins KB_LESSON_SKIP_MARKER.
 */
describe('kookr-merge.sh review-gate literals stay in sync with independent-review.ts', () => {
  const script = readFileSync(mergeScript, 'utf-8');

  test('embeds the review marker, timeout label, and env toggle', () => {
    expect(script).toContain(INDEPENDENT_REVIEW_MARKER);
    expect(script).toContain(REVIEW_SKIPPED_TIMEOUT_LABEL);
    expect(script).toContain(REQUIRE_REVIEW_ENV);
    // The gate must be invoked before the actual merge command.
    const gateCallIdx = script.indexOf('if ! require_review_verdict');
    const mergeIdx = script.indexOf('gh pr merge "$PR"');
    expect(gateCallIdx).toBeGreaterThan(0);
    expect(mergeIdx).toBeGreaterThan(gateCallIdx);
  });

  test('documents exit code 4 for a review-gate block', () => {
    expect(script).toMatch(/4\s+blocked by the independent-review gate/i);
  });

  test('uses commits (not headRefOid) for head SHA — gh < ~2.14 compat (#1853)', () => {
    // headRefOid is not a valid `gh pr view --json` field on older gh; the gate
    // must not request it or every merge fails with exit 4 before reading verdicts.
    // Comments may still mention the old field name when explaining the fallback.
    expect(script).toMatch(/--json comments,labels,commits/);
    expect(script).not.toMatch(/--json[^'"\n]*headRefOid/);
    expect(script).toMatch(/\.commits/);
  });

  test('feature-probes --match-head-commit before pinning (#1853)', () => {
    expect(script).toMatch(/gh pr merge --help/);
    expect(script).toMatch(/--match-head-commit/);
    expect(script).toMatch(/lacks --match-head-commit/);
  });
});

/** Build the view JSON the gate expects: comments/labels/commits (not headRefOid). */
function gateView(opts: {
  headOid: string;
  labels?: Array<{ name: string }>;
  comments?: Array<{ body: string; createdAt?: string }>;
}): object {
  return {
    commits: [{ oid: opts.headOid }],
    labels: opts.labels ?? [],
    comments: opts.comments ?? [],
  };
}

/**
 * End-to-end gate behavior: run the real script with a stubbed `gh` so no
 * network or real PR is touched, and assert the merge is reached only when the
 * verdict/label authorize it.
 */
describe('kookr-merge.sh review gate (integration, stubbed gh)', () => {
  let binDir: string;
  let viewFile: string;
  let mergeArgsFile: string;

  // Modern-gh stub: advertises --match-head-commit and records the merge argv.
  const fakeGh = (viewJsonPath: string, mergeArgsPath: string) => `#!/usr/bin/env bash
args="$*"
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  if [[ "$args" == *"state,isDraft,reviewDecision"* ]]; then
    echo '{"state":"OPEN","isDraft":false,"reviewDecision":""}'; exit 0
  fi
  if [[ "$args" == *"comments,labels,commits"* ]]; then
    cat "${viewJsonPath}"; exit 0
  fi
  # Zero-check PR that GitHub confirms is mergeable. Since #2148 the script only
  # short-circuits a zero-check merge when mergeStateStatus=CLEAN (or mergeable
  # on old gh), so the stub must declare it or watch_checks polls to timeout.
  echo '{"statusCheckRollup":[],"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE"}'; exit 0
fi
if [[ "$1" == "pr" && "$2" == "checks" ]]; then
  if [[ "$args" == *"--help"* ]]; then echo "  --watch  Watch checks and exit"; exit 0; fi
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "merge" ]]; then
  if [[ "$args" == *"--help"* ]]; then
    echo "  --match-head-commit string   Commit SHA that the HEAD of the PR must match"; exit 0
  fi
  printf '%s\\n' "$*" > "${mergeArgsPath}"
  echo "FAKE-GH-MERGED"; exit 0
fi
echo "fake-gh: unhandled: $args" >&2; exit 99
`;

  function run(): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync('bash', [mergeScript, '123', '--repo', 'owner/repo'], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        encoding: 'utf-8',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  function setView(json: unknown): void {
    writeFileSync(viewFile, JSON.stringify(json));
  }

  const verdictBody = (verdict: string, sha: string) =>
    `${INDEPENDENT_REVIEW_MARKER}\nkookr-review-verdict: ${verdict}\nreview-head-sha: ${sha}`;

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'kookr-merge-gate-'));
    viewFile = join(binDir, 'view.json');
    mergeArgsFile = join(binDir, 'merge-args.txt');
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, fakeGh(viewFile, mergeArgsFile));
    chmodSync(ghPath, 0o755);
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  test('BLOCK verdict stops the merge with exit 4 and never merges', () => {
    setView(gateView({ headOid: 'abc123', comments: [{ body: verdictBody('block', 'abc123') }] }));
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/blocked-finding/i);
    expect(res.stdout).not.toContain('FAKE-GH-MERGED');
  });

  test('no verdict and no label stops the merge with exit 4', () => {
    setView(gateView({ headOid: 'abc123', comments: [] }));
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/no-verdict/i);
    expect(res.stdout).not.toContain('FAKE-GH-MERGED');
  });

  test('PASS verdict for the current head reaches the merge', () => {
    setView(gateView({ headOid: 'abc123', comments: [{ body: verdictBody('pass', 'abc123') }] }));
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
  });

  test('PASS merge pins --match-head-commit when gh supports it', () => {
    setView(gateView({ headOid: 'abc123', comments: [{ body: verdictBody('pass', 'abc123') }] }));
    writeFileSync(mergeArgsFile, '');
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
    const mergeArgs = readFileSync(mergeArgsFile, 'utf-8');
    expect(mergeArgs).toMatch(/--match-head-commit\s+abc123/);
  });

  test('head SHA is the last commit oid (not the first) on multi-commit PRs', () => {
    // Production uses `((.commits // []) | last | .oid)` — a single-element fixture
    // would not catch a regression that used commits[0] instead.
    setView({
      commits: [{ oid: 'first000' }, { oid: 'middle00' }, { oid: 'headsha1' }],
      labels: [],
      comments: [{ body: verdictBody('pass', 'headsha1') }],
    });
    writeFileSync(mergeArgsFile, '');
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
    const mergeArgs = readFileSync(mergeArgsFile, 'utf-8');
    expect(mergeArgs).toMatch(/--match-head-commit\s+headsha1/);
    expect(mergeArgs).not.toMatch(/first000|middle00/);
  });

  test('timeout label authorizes the merge when no verdict is present', () => {
    setView(gateView({ headOid: 'abc123', labels: [{ name: REVIEW_SKIPPED_TIMEOUT_LABEL }], comments: [] }));
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
  });

  test('a PASS bound to a stale head is refused (jq staleness guard)', () => {
    setView(gateView({ headOid: 'newsha', comments: [{ body: verdictBody('pass', 'oldsha') }] }));
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/stale-verdict/i);
    expect(res.stdout).not.toContain('FAKE-GH-MERGED');
  });

  test('a stale PASS plus the timeout label is allowed', () => {
    setView(
      gateView({
        headOid: 'newsha',
        labels: [{ name: REVIEW_SKIPPED_TIMEOUT_LABEL }],
        comments: [{ body: verdictBody('pass', 'oldsha') }],
      }),
    );
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
  });

  test('KOOKR_MERGE_REQUIRE_REVIEW=0 disables the gate', () => {
    setView(gateView({ headOid: 'abc123', comments: [] }));
    try {
      const stdout = execFileSync('bash', [mergeScript, '123', '--repo', 'owner/repo'], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, [REQUIRE_REVIEW_ENV]: '0' },
        encoding: 'utf-8',
      });
      expect(stdout).toContain('FAKE-GH-MERGED');
      expect(stdout).toMatch(/gate disabled/i);
    } catch (err) {
      throw new Error(`expected disabled gate to merge, got failure: ${(err as Error).message}`);
    }
  });
});

/**
 * Old-gh degraded path (issue #1853): stub does not advertise --match-head-commit
 * and only returns fields that exist on gh 2.4.x. A valid PASS must still merge
 * with the gate enabled, and the script must emit a degraded-mode notice rather
 * than failing the merge.
 */
describe('kookr-merge.sh review gate on older gh without --match-head-commit (#1853)', () => {
  let binDir: string;
  let viewFile: string;
  let mergeArgsFile: string;

  const fakeGhOld = (viewJsonPath: string, mergeArgsPath: string) => `#!/usr/bin/env bash
args="$*"
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  if [[ "$args" == *"state,isDraft,reviewDecision"* ]]; then
    echo '{"state":"OPEN","isDraft":false,"reviewDecision":""}'; exit 0
  fi
  # Refuse headRefOid the way real old gh does — script must not request it.
  if [[ "$args" == *"headRefOid"* ]]; then
    echo 'Unknown JSON field: "headRefOid"' >&2; exit 1
  fi
  if [[ "$args" == *"comments,labels,commits"* ]]; then
    cat "${viewJsonPath}"; exit 0
  fi
  # Old gh omits mergeStateStatus, so the script falls back to mergeable. A
  # mergeable zero-check PR must merge without polling to timeout (since #2148).
  echo '{"statusCheckRollup":[],"mergeable":"MERGEABLE"}'; exit 0
fi
if [[ "$1" == "pr" && "$2" == "checks" ]]; then
  if [[ "$args" == *"--help"* ]]; then echo "  --watch  Watch checks and exit"; exit 0; fi
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "merge" ]]; then
  # No --match-head-commit in help (old gh).
  if [[ "$args" == *"--help"* ]]; then
    echo "Usage: gh pr merge [<number> | <url> | <branch>]"; exit 0
  fi
  # Fail if the script still passed the unsupported flag.
  if [[ "$args" == *"--match-head-commit"* ]]; then
    echo "unknown flag: --match-head-commit" >&2; exit 1
  fi
  printf '%s\\n' "$*" > "${mergeArgsPath}"
  echo "FAKE-GH-MERGED"; exit 0
fi
echo "fake-gh: unhandled: $args" >&2; exit 99
`;

  const verdictBody = (verdict: string, sha: string) =>
    `${INDEPENDENT_REVIEW_MARKER}\nkookr-review-verdict: ${verdict}\nreview-head-sha: ${sha}`;

  function run(): { status: number; stdout: string; stderr: string } {
    try {
      // Capture stderr too: the degraded-mode notice is written to stderr.
      const stdout = execFileSync('bash', [mergeScript, '123', '--repo', 'owner/repo'], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        encoding: 'utf-8',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  // re-run capturing combined streams via shell redirect for notice assertion
  function runCombined(): { status: number; out: string } {
    try {
      const out = execFileSync(
        'bash',
        ['-c', `"$0" "$@" 2>&1`, mergeScript, '123', '--repo', 'owner/repo'],
        {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          encoding: 'utf-8',
        },
      );
      return { status: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'kookr-merge-oldgh-'));
    viewFile = join(binDir, 'view.json');
    mergeArgsFile = join(binDir, 'merge-args.txt');
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, fakeGhOld(viewFile, mergeArgsFile));
    chmodSync(ghPath, 0o755);
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  test('PASS verdict merges with gate enabled and no --match-head-commit', () => {
    writeFileSync(
      viewFile,
      JSON.stringify(gateView({ headOid: 'abc123', comments: [{ body: verdictBody('pass', 'abc123') }] })),
    );
    writeFileSync(mergeArgsFile, '');
    const res = runCombined();
    expect(res.status).toBe(0);
    expect(res.out).toContain('FAKE-GH-MERGED');
    expect(res.out).toMatch(/lacks --match-head-commit/i);
    const mergeArgs = readFileSync(mergeArgsFile, 'utf-8');
    expect(mergeArgs).not.toMatch(/--match-head-commit/);
  });

  test('BLOCK verdict still blocks on old gh', () => {
    writeFileSync(
      viewFile,
      JSON.stringify(gateView({ headOid: 'abc123', comments: [{ body: verdictBody('block', 'abc123') }] })),
    );
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/blocked-finding/i);
  });

  test('stale PASS still blocks on old gh', () => {
    writeFileSync(
      viewFile,
      JSON.stringify(gateView({ headOid: 'newsha', comments: [{ body: verdictBody('pass', 'oldsha') }] })),
    );
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/stale-verdict/i);
  });

  test('missing verdict still blocks on old gh', () => {
    writeFileSync(viewFile, JSON.stringify(gateView({ headOid: 'abc123', comments: [] })));
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/no-verdict/i);
  });
});

/**
 * watch_checks polling path on repos with no CI (issue #1850). The `gh pr checks
 * --watch` fast path is unavailable here, so the script polls statusCheckRollup.
 * A PR with no reported checks has a null rollup (or []); the poller must treat
 * that as "nothing to wait on" and merge, not error on null iteration or poll
 * until timeout. The stub deliberately hides `--watch` to force the poll path.
 */
describe('kookr-merge.sh watch_checks with no reported checks (integration, stubbed gh)', () => {
  let binDir: string;
  let viewFile: string;
  let rollupFile: string;

  // No `--watch` in `pr checks --help` output → the script falls to the poll path.
  const fakeGhNoWatch = (viewJsonPath: string, rollupJsonPath: string) => `#!/usr/bin/env bash
args="$*"
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  if [[ "$args" == *"state,isDraft,reviewDecision"* ]]; then
    echo '{"state":"OPEN","isDraft":false,"reviewDecision":""}'; exit 0
  fi
  if [[ "$args" == *"comments,labels,commits"* ]]; then
    cat "${viewJsonPath}"; exit 0
  fi
  if [[ "$args" == *"statusCheckRollup"* ]]; then
    cat "${rollupJsonPath}"; exit 0
  fi
  echo '{}'; exit 0
fi
if [[ "$1" == "pr" && "$2" == "checks" ]]; then
  if [[ "$args" == *"--help"* ]]; then echo "Usage: gh pr checks [<number>]"; exit 0; fi
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "merge" ]]; then
  if [[ "$args" == *"--help"* ]]; then
    echo "  --match-head-commit string   Commit SHA that the HEAD of the PR must match"; exit 0
  fi
  echo "FAKE-GH-MERGED"; exit 0
fi
echo "fake-gh: unhandled: $args" >&2; exit 99
`;

  const verdictBody = (verdict: string, sha: string) =>
    `${INDEPENDENT_REVIEW_MARKER}\nkookr-review-verdict: ${verdict}\nreview-head-sha: ${sha}`;

  function run(): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync('bash', [mergeScript, '123', '--repo', 'owner/repo'], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          // Bound the poll loop so a regression fails fast instead of hanging.
          KOOKR_MERGE_CHECK_TIMEOUT_SECONDS: '3',
          KOOKR_MERGE_CHECK_INTERVAL_SECONDS: '1',
        },
        encoding: 'utf-8',
        timeout: 30_000,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'kookr-merge-nocheck-'));
    viewFile = join(binDir, 'view.json');
    rollupFile = join(binDir, 'rollup.json');
    writeFileSync(
      viewFile,
      JSON.stringify(gateView({ headOid: 'abc123', comments: [{ body: verdictBody('pass', 'abc123') }] })),
    );
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, fakeGhNoWatch(viewFile, rollupFile));
    chmodSync(ghPath, 0o755);
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  test('a null statusCheckRollup is treated as no checks and reaches the merge', () => {
    writeFileSync(rollupFile, JSON.stringify({ statusCheckRollup: null, mergeStateStatus: 'CLEAN' }));
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
    expect(res.stdout).toMatch(/no status checks reported/i);
  });

  test('an empty statusCheckRollup reaches the merge without polling to timeout', () => {
    writeFileSync(rollupFile, JSON.stringify({ statusCheckRollup: [], mergeStateStatus: 'CLEAN' }));
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
    expect(res.stdout).toMatch(/no status checks reported/i);
  });
});

/**
 * issue #2102 — the `gh pr checks --watch` fast path exits 1 with
 * "no checks reported on the '<branch>' branch" when the base has no CI.
 * kookr-merge must short-circuit on a null/empty statusCheckRollup *before*
 * invoking --watch, otherwise a CLEAN/MERGEABLE PR still fails with exit 3.
 * The stub advertises --watch and would poison the merge if called.
 */
describe('kookr-merge.sh watch_checks skips --watch when no checks are reported (issue #2102)', () => {
  let binDir: string;
  let viewFile: string;
  let rollupFile: string;
  let checksCalledFile: string;

  const fakeGhWatchPoison = (
    viewJsonPath: string,
    rollupJsonPath: string,
    checksCalledPath: string,
  ) => `#!/usr/bin/env bash
args="$*"
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  if [[ "$args" == *"state,isDraft,reviewDecision"* ]]; then
    echo '{"state":"OPEN","isDraft":false,"reviewDecision":""}'; exit 0
  fi
  if [[ "$args" == *"comments,labels,commits"* ]]; then
    cat "${viewJsonPath}"; exit 0
  fi
  if [[ "$args" == *"statusCheckRollup"* ]]; then
    cat "${rollupJsonPath}"; exit 0
  fi
  echo '{}'; exit 0
fi
if [[ "$1" == "pr" && "$2" == "checks" ]]; then
  if [[ "$args" == *"--help"* ]]; then echo "  --watch  Watch checks and exit"; exit 0; fi
  # Real gh exits 1 with this message when the branch has no CI. If the merge
  # script still reaches this path after a null rollup, the test must fail.
  printf 'called\\n' >> "${checksCalledPath}"
  echo "no checks reported on the 'main' branch" >&2
  exit 1
fi
if [[ "$1" == "pr" && "$2" == "merge" ]]; then
  if [[ "$args" == *"--help"* ]]; then
    echo "  --match-head-commit string   Commit SHA that the HEAD of the PR must match"; exit 0
  fi
  echo "FAKE-GH-MERGED"; exit 0
fi
echo "fake-gh: unhandled: $args" >&2; exit 99
`;

  const verdictBody = (verdict: string, sha: string) =>
    `${INDEPENDENT_REVIEW_MARKER}\nkookr-review-verdict: ${verdict}\nreview-head-sha: ${sha}`;

  function run(): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync('bash', [mergeScript, '123', '--repo', 'owner/repo'], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        encoding: 'utf-8',
        timeout: 15_000,
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'kookr-merge-watch-poison-'));
    viewFile = join(binDir, 'view.json');
    rollupFile = join(binDir, 'rollup.json');
    checksCalledFile = join(binDir, 'checks-called');
    writeFileSync(
      viewFile,
      JSON.stringify(gateView({ headOid: 'abc123', comments: [{ body: verdictBody('pass', 'abc123') }] })),
    );
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, fakeGhWatchPoison(viewFile, rollupFile, checksCalledFile));
    chmodSync(ghPath, 0o755);
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  test('null rollup short-circuits before gh pr checks --watch (which would exit 1)', () => {
    writeFileSync(rollupFile, JSON.stringify({ statusCheckRollup: null, mergeStateStatus: 'CLEAN' }));
    try {
      rmSync(checksCalledFile);
    } catch {
      /* not present yet */
    }
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
    expect(res.stdout).toMatch(/no status checks reported/i);
    // --watch must not have been invoked; otherwise the poison path would have
    // written this file and returned exit 1.
    let checksCalled = false;
    try {
      checksCalled = readFileSync(checksCalledFile, 'utf-8').includes('called');
    } catch {
      checksCalled = false;
    }
    expect(checksCalled).toBe(false);
  });

  test('empty rollup also short-circuits before a failing --watch path', () => {
    writeFileSync(rollupFile, JSON.stringify({ statusCheckRollup: [], mergeStateStatus: 'CLEAN' }));
    try {
      rmSync(checksCalledFile);
    } catch {
      /* not present yet */
    }
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
    let checksCalled = false;
    try {
      checksCalled = readFileSync(checksCalledFile, 'utf-8').includes('called');
    } catch {
      checksCalled = false;
    }
    expect(checksCalled).toBe(false);
  });
});
