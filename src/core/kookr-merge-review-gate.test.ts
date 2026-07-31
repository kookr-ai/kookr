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
});

/**
 * End-to-end gate behavior: run the real script with a stubbed `gh` so no
 * network or real PR is touched, and assert the merge is reached only when the
 * verdict/label authorize it.
 */
describe('kookr-merge.sh review gate (integration, stubbed gh)', () => {
  let binDir: string;
  let viewFile: string;

  const fakeGh = (viewJsonPath: string) => `#!/usr/bin/env bash
args="$*"
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  if [[ "$args" == *"state,isDraft,reviewDecision"* ]]; then
    echo '{"state":"OPEN","isDraft":false,"reviewDecision":""}'; exit 0
  fi
  if [[ "$args" == *"comments,labels,headRefOid"* ]]; then
    cat "${viewJsonPath}"; exit 0
  fi
  echo '{"statusCheckRollup":[]}'; exit 0
fi
if [[ "$1" == "pr" && "$2" == "checks" ]]; then
  if [[ "$args" == *"--help"* ]]; then echo "  --watch  Watch checks and exit"; exit 0; fi
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "merge" ]]; then echo "FAKE-GH-MERGED"; exit 0; fi
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
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, fakeGh(viewFile));
    chmodSync(ghPath, 0o755);
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  test('BLOCK verdict stops the merge with exit 4 and never merges', () => {
    setView({ headRefOid: 'abc123', labels: [], comments: [{ body: verdictBody('block', 'abc123') }] });
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/blocked-finding/i);
    expect(res.stdout).not.toContain('FAKE-GH-MERGED');
  });

  test('no verdict and no label stops the merge with exit 4', () => {
    setView({ headRefOid: 'abc123', labels: [], comments: [] });
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/no-verdict/i);
    expect(res.stdout).not.toContain('FAKE-GH-MERGED');
  });

  test('PASS verdict for the current head reaches the merge', () => {
    setView({ headRefOid: 'abc123', labels: [], comments: [{ body: verdictBody('pass', 'abc123') }] });
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
  });

  test('timeout label authorizes the merge when no verdict is present', () => {
    setView({ headRefOid: 'abc123', labels: [{ name: REVIEW_SKIPPED_TIMEOUT_LABEL }], comments: [] });
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
  });

  test('a PASS bound to a stale head is refused (jq staleness guard)', () => {
    setView({ headRefOid: 'newsha', labels: [], comments: [{ body: verdictBody('pass', 'oldsha') }] });
    const res = run();
    expect(res.status).toBe(4);
    expect(res.stdout + res.stderr).toMatch(/stale-verdict/i);
    expect(res.stdout).not.toContain('FAKE-GH-MERGED');
  });

  test('a stale PASS plus the timeout label is allowed', () => {
    setView({
      headRefOid: 'newsha',
      labels: [{ name: REVIEW_SKIPPED_TIMEOUT_LABEL }],
      comments: [{ body: verdictBody('pass', 'oldsha') }],
    });
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('FAKE-GH-MERGED');
  });

  test('KOOKR_MERGE_REQUIRE_REVIEW=0 disables the gate', () => {
    setView({ headRefOid: 'abc123', labels: [], comments: [] });
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
