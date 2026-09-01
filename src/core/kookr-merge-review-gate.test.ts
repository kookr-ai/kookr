import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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
  });

  test('falls back to the REST sha pin when the flag is unavailable', () => {
    // Cheap smoke test only — the wire call itself is asserted by executing the
    // script against a stubbed gh below, which does not break on a reworded line.
    expect(script).toMatch(/merge_pinned_via_api/);
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

  test('timeout label blocks the merge when no verdict is present', () => {
    setView(gateView({ headOid: 'abc123', labels: [{ name: REVIEW_SKIPPED_TIMEOUT_LABEL }], comments: [] }));
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/timeout-label|no-verdict/i);
    expect(res.stdout).not.toContain('FAKE-GH-MERGED');
  });

  test('a PASS bound to a stale head is refused (jq staleness guard)', () => {
    setView(gateView({ headOid: 'newsha', comments: [{ body: verdictBody('pass', 'oldsha') }] }));
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/stale-verdict/i);
    expect(res.stdout).not.toContain('FAKE-GH-MERGED');
  });

  test('a stale PASS plus the timeout label is still refused', () => {
    setView(
      gateView({
        headOid: 'newsha',
        labels: [{ name: REVIEW_SKIPPED_TIMEOUT_LABEL }],
        comments: [{ body: verdictBody('pass', 'oldsha') }],
      }),
    );
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/stale-verdict/i);
    expect(res.stdout).not.toContain('FAKE-GH-MERGED');
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
 * Old-gh path (issue #1853): the stub does not advertise --match-head-commit and
 * only returns fields that exist on gh 2.4.x. A valid PASS must still merge with
 * the gate enabled, taking the REST `sha` pin instead of the flag — the head is
 * still pinned server-side, so no unreviewed commit can slip through.
 */
describe('kookr-merge.sh review gate on older gh without --match-head-commit (#1853)', () => {
  let binDir: string;
  let viewFile: string;
  let mergeArgsFile: string;
  let apiArgsFile: string;
  let apiMergeStatusFile: string;
  let apiMergeBodyFile: string;
  let apiDeleteStatusFile: string;
  let headViewStatusFile: string;

  // The stub's head repo is a FORK (`forker/repo`) while the PR lives in
  // `owner/repo`. That asymmetry is deliberate: it is the only way an assertion
  // can tell the merge slug apart from the head-branch slug, so swapping one for
  // the other in the script fails the test instead of passing silently.
  const fakeGhOld = (paths: {
    view: string;
    mergeArgs: string;
    apiArgs: string;
    apiMergeStatus: string;
    apiMergeBody: string;
    apiDeleteStatus: string;
    headViewStatus: string;
  }) => `#!/usr/bin/env bash
args="$*"
if [[ "$1" == "repo" && "$2" == "view" ]]; then
  # Real gh applies -q to the JSON; the script relies on that to get a bare slug.
  if [[ "$args" == *"-q .nameWithOwner"* ]]; then echo 'owner/repo'; else echo '{"nameWithOwner":"owner/repo"}'; fi
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  if [[ "$args" == *"state,isDraft,reviewDecision"* ]]; then
    echo '{"state":"OPEN","isDraft":false,"reviewDecision":""}'; exit 0
  fi
  # Refuse headRefOid the way real old gh does — script must not request it.
  if [[ "$args" == *"headRefOid"* ]]; then
    echo 'Unknown JSON field: "headRefOid"' >&2; exit 1
  fi
  if [[ "$args" == *"comments,labels,commits"* ]]; then
    cat "${paths.view}"; exit 0
  fi
  if [[ "$args" == *"headRefName"* ]]; then
    if [[ "$(cat "${paths.headViewStatus}" 2>/dev/null || echo 0)" != "0" ]]; then
      echo 'Unknown JSON field: "headRepositoryOwner"' >&2; exit 1
    fi
    echo '{"headRefName":"feature-branch","headRepository":{"name":"repo"},"headRepositoryOwner":{"login":"forker"}}'
    exit 0
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
  printf '%s\\n' "$*" > "${paths.mergeArgs}"
  echo "FAKE-GH-MERGED"; exit 0
fi
if [[ "$1" == "api" ]]; then
  printf '%s\\n' "$*" >> "${paths.apiArgs}"
  if [[ "$args" == *"/merge"* ]]; then
    status="$(cat "${paths.apiMergeStatus}" 2>/dev/null || echo 0)"
    if [[ "$status" != "0" ]]; then
      echo "gh: Head branch was modified. Review and try the merge again. (HTTP 409)" >&2
      exit 1
    fi
    cat "${paths.apiMergeBody}"; exit 0
  fi
  if [[ "$args" == *"--method DELETE"* ]]; then
    status="$(cat "${paths.apiDeleteStatus}" 2>/dev/null || echo 0)"
    if [[ "$status" != "0" ]]; then
      echo "gh: Reference does not exist (HTTP 422)" >&2
      exit 1
    fi
  fi
  exit 0
fi
echo "fake-gh: unhandled: $args" >&2; exit 99
`;

  const verdictBody = (verdict: string, sha: string) =>
    `${INDEPENDENT_REVIEW_MARKER}\nkookr-review-verdict: ${verdict}\nreview-head-sha: ${sha}`;

  const MERGED_OK_BODY = '{"merged":true,"message":"Pull Request successfully merged"}';

  /** Run the script with combined streams; omit `--repo` to exercise slug discovery. */
  function runCombined(opts: { withRepoFlag?: boolean; repo?: string } = {}): {
    status: number;
    out: string;
  } {
    const args =
      opts.withRepoFlag === false ? ['123'] : ['123', '--repo', opts.repo ?? 'owner/repo'];
    try {
      const out = execFileSync('bash', ['-c', `"$0" "$@" 2>&1`, mergeScript, ...args], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        encoding: 'utf-8',
      });
      return { status: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  const passView = () =>
    JSON.stringify(
      gateView({ headOid: 'abc123', comments: [{ body: verdictBody('pass', 'abc123') }] }),
    );

  const apiCalls = () => readFileSync(apiArgsFile, 'utf-8');

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'kookr-merge-oldgh-'));
    viewFile = join(binDir, 'view.json');
    mergeArgsFile = join(binDir, 'merge-args.txt');
    apiArgsFile = join(binDir, 'api-args.txt');
    apiMergeStatusFile = join(binDir, 'api-merge-status.txt');
    apiMergeBodyFile = join(binDir, 'api-merge-body.json');
    apiDeleteStatusFile = join(binDir, 'api-delete-status.txt');
    headViewStatusFile = join(binDir, 'head-view-status.txt');
    const ghPath = join(binDir, 'gh');
    writeFileSync(
      ghPath,
      fakeGhOld({
        view: viewFile,
        mergeArgs: mergeArgsFile,
        apiArgs: apiArgsFile,
        apiMergeStatus: apiMergeStatusFile,
        apiMergeBody: apiMergeBodyFile,
        apiDeleteStatus: apiDeleteStatusFile,
        headViewStatus: headViewStatusFile,
      }),
    );
    chmodSync(ghPath, 0o755);
  });

  // Reset every piece of stub state between tests. The api log is appended to,
  // and a test that throws mid-body must not leak a failure toggle into the next.
  beforeEach(() => {
    writeFileSync(mergeArgsFile, '');
    writeFileSync(apiArgsFile, '');
    writeFileSync(apiMergeStatusFile, '0');
    writeFileSync(apiMergeBodyFile, MERGED_OK_BODY);
    writeFileSync(apiDeleteStatusFile, '0');
    writeFileSync(headViewStatusFile, '0');
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  test('PASS merges through the REST sha pin when the flag is unavailable', () => {
    writeFileSync(viewFile, passView());
    const res = runCombined();
    expect(res.status).toBe(0);
    // `gh pr merge` is never reached — the REST endpoint carries the pin.
    expect(readFileSync(mergeArgsFile, 'utf-8')).toBe('');
    expect(apiCalls()).toMatch(/--method PUT repos\/owner\/repo\/pulls\/123\/merge/);
    expect(apiCalls()).toMatch(/sha=abc123/);
    expect(apiCalls()).toMatch(/merge_method=squash/);
    // --delete-branch has no REST equivalent, so the head ref is deleted
    // directly — on the HEAD repo, which is the fork, not the PR's base repo.
    // Reaching the delete at all is also how the stub proves the merge succeeded:
    // the script only gets here after the PUT returns non-error.
    expect(apiCalls()).toMatch(/--method DELETE repos\/forker\/repo\/git\/refs\/heads\/feature-branch/);
  });

  test('resolves the merge slug from gh when --repo is omitted', () => {
    writeFileSync(viewFile, passView());
    const res = runCombined({ withRepoFlag: false });
    expect(res.status).toBe(0);
    // The base repo comes from `gh repo view`, never from the head (fork) repo.
    expect(apiCalls()).toMatch(/--method PUT repos\/owner\/repo\/pulls\/123\/merge/);
    expect(apiCalls()).not.toMatch(/--method PUT repos\/forker\//);
  });

  test('a failed head-branch delete does not fail an already-merged PR', () => {
    // The merge is the atomic part; the branch cleanup is not. Reporting failure
    // here would tell the caller a merged PR did not merge.
    writeFileSync(viewFile, passView());
    writeFileSync(apiDeleteStatusFile, '422');
    const res = runCombined();
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/merged PR #123/);
    expect(res.out).toMatch(/was not deleted/i);
  });

  test('a 200 that reports merged:false is not treated as a merge', () => {
    // The endpoint can answer 200 with merged:false. Trusting the exit status
    // alone would close out a still-open PR as landed.
    writeFileSync(viewFile, passView());
    writeFileSync(apiMergeBodyFile, '{"merged":false,"message":"Base branch was modified"}');
    const res = runCombined();
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/did not merge/i);
    expect(res.out).toMatch(/Base branch was modified/);
    expect(res.out).not.toMatch(/merged PR #123 \(squash\)/);
    expect(apiCalls()).not.toMatch(/--method DELETE/);
  });

  test('an unreadable head branch is reported, not silently skipped', () => {
    // Old gh is exactly where a --json field can go missing (#1853). The merge
    // still stands; the operator just has to be told the branch is still there.
    writeFileSync(viewFile, passView());
    writeFileSync(headViewStatusFile, '1');
    const res = runCombined();
    expect(res.status).toBe(0);
    expect(res.out).toMatch(/merged PR #123/);
    expect(res.out).toMatch(/could not resolve the head branch/i);
    expect(apiCalls()).not.toMatch(/--method DELETE/);
  });

  test('a HOST/OWNER/REPO --repo value is reduced to an API path', () => {
    // gh accepts the long form; an API path does not. Splicing it in unchanged
    // 404s and surfaces as a phantom head race.
    writeFileSync(viewFile, passView());
    const res = runCombined({ repo: 'ghe.example.com/owner/repo' });
    expect(res.status).toBe(0);
    expect(apiCalls()).toMatch(/--method PUT repos\/owner\/repo\/pulls\/123\/merge/);
    expect(apiCalls()).not.toMatch(/ghe\.example\.com/);
  });

  test('a head that moved during the wait fails the merge instead of merging', () => {
    // GitHub answers 409 when the PR head no longer equals `sha` — the same
    // protection --match-head-commit provides, so the script must not report success.
    writeFileSync(viewFile, passView());
    writeFileSync(apiMergeStatusFile, '409');
    const res = runCombined();
    expect(res.status).toBe(1);
    expect(res.out).not.toContain('FAKE-GH-MERGED');
    expect(res.out).toMatch(/REST merge refused/i);
    // A refused merge must not delete the head branch.
    expect(apiCalls()).not.toMatch(/--method DELETE/);
  });

  test('BLOCK verdict still blocks on old gh', () => {
    writeFileSync(
      viewFile,
      JSON.stringify(gateView({ headOid: 'abc123', comments: [{ body: verdictBody('block', 'abc123') }] })),
    );
    const res = runCombined();
    expect(res.status).toBe(4);
    expect(res.out).toMatch(/blocked-finding/i);
    expect(apiCalls()).not.toMatch(/--method PUT/);
  });

  test('stale PASS still blocks on old gh', () => {
    writeFileSync(
      viewFile,
      JSON.stringify(gateView({ headOid: 'newsha', comments: [{ body: verdictBody('pass', 'oldsha') }] })),
    );
    const res = runCombined();
    expect(res.status).toBe(4);
    expect(res.out).toMatch(/stale-verdict/i);
    expect(apiCalls()).not.toMatch(/--method PUT/);
  });

  test('missing verdict still blocks on old gh', () => {
    writeFileSync(viewFile, JSON.stringify(gateView({ headOid: 'abc123', comments: [] })));
    const res = runCombined();
    expect(res.status).toBe(4);
    expect(res.out).toMatch(/no-verdict/i);
    expect(apiCalls()).not.toMatch(/--method PUT/);
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
