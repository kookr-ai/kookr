import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Guard for issue #1369: the CI `test` job and the local `pnpm verify` lane
// list drifted (four lanes were in CI but neither in verify.sh nor pre-push),
// so `pnpm verify` green stopped implying CI green. This test fails the next
// time a `pnpm <script>` lane is added to one of the two without the other.
//
// It compares the SET of package.json script lanes each side runs, modulo an
// explicit allowlist. The allowlist is intentionally tiny; its literal
// contents are pinned in a test below, so smuggling a genuinely-drifted lane
// into it to hide the drift shows up as a reviewable diff in this file.

const repoRoot = process.cwd();
const ciYml = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const verifySh = readFileSync(join(repoRoot, 'scripts/verify.sh'), 'utf8');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const scriptKeys = new Set(Object.keys(pkg.scripts));

// Lanes CI runs that have no local `pnpm verify` equivalent — coverage
// reporting only makes sense in CI, which uploads the artifact.
const CI_ONLY = new Set(['coverage:summary']);
// Lanes verify runs that CI covers by a different invocation: CI runs the
// vitest suite via `pnpm exec vitest run --coverage` (to also collect
// coverage), and the STT sidecar suite is a separate npm project not wired
// into the root CI `test` job.
const LOCAL_ONLY = new Set(['test', 'test:stt']);

// Strip comments so a `pnpm <script>` mentioned in prose (both ci.yml and
// verify.sh reference other lanes in explanatory comments) is not mistaken for
// an actual invocation. Removes a `#` at line start or preceded by whitespace
// through end of line — the shape every comment in these two files takes.
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
}

// Extract every `pnpm <script>` invocation whose <script> is a real
// package.json script key. `pnpm exec ...`, `pnpm install ...`, and bare
// `pnpm run doctor` (doctor is a key, but scoped away below) are handled by
// the key filter + job scoping, so only genuine lanes survive.
function pnpmScriptLanes(text: string): Set<string> {
  const lanes = new Set<string>();
  const re = /pnpm\s+(?:run\s+)?([a-z][a-z0-9:._-]*)/g;
  let m: RegExpExecArray | null;
  const stripped = stripComments(text);
  while ((m = re.exec(stripped)) !== null) {
    const tok = m[1];
    if (scriptKeys.has(tok)) lanes.add(tok);
  }
  return lanes;
}

// Slice out a single top-level job block (2-space indented `<name>:`) from the
// workflow, so lanes in the `build`/`macos` jobs don't pollute the comparison.
function extractJob(yaml: string, jobName: string): string {
  const lines = yaml.split('\n');
  const startRe = new RegExp(`^ {2}${jobName}:\\s*$`);
  const jobHeaderRe = /^ {2}[A-Za-z0-9_-]+:\s*$/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (startRe.test(lines[i])) start = i;
      continue;
    }
    if (i > start && jobHeaderRe.test(lines[i])) {
      return lines.slice(start, i).join('\n');
    }
  }
  if (start === -1) throw new Error(`job "${jobName}" not found in ci.yml`);
  return lines.slice(start).join('\n');
}

function sorted(set: Set<string>): string[] {
  return [...set].sort();
}

function requiredLanes(ci: string, verify: string): { ciLanes: string[]; verifyLanes: string[] } {
  const ciTestJob = extractJob(ci, 'test');
  const ciLanes = [...pnpmScriptLanes(ciTestJob)].filter((l) => !CI_ONLY.has(l));
  const verifyLanes = [...pnpmScriptLanes(verify)].filter((l) => !LOCAL_ONLY.has(l));
  return { ciLanes: ciLanes.sort(), verifyLanes: verifyLanes.sort() };
}

describe('CI ↔ verify.sh lane parity (#1369)', () => {
  it('runs the identical set of pnpm lanes (modulo the explicit allowlist)', () => {
    const { ciLanes, verifyLanes } = requiredLanes(ciYml, verifySh);
    expect(verifyLanes).toEqual(ciLanes);
  });

  it('keeps the allowlist honest — pinned contents, every entry still exists where claimed', () => {
    // Pin the literal allowlist. Growing it to hide a genuinely-drifted lane
    // is only possible by editing this assertion — a visible, reviewable diff.
    expect([...CI_ONLY].sort()).toEqual(['coverage:summary']);
    expect([...LOCAL_ONLY].sort()).toEqual(['test', 'test:stt']);

    const ciTestJob = extractJob(ciYml, 'test');
    const ciLanes = pnpmScriptLanes(ciTestJob);
    const verifyLanes = pnpmScriptLanes(verifySh);
    // A CI-only entry that no longer appears in CI is dead allowlist masking.
    for (const lane of CI_ONLY) expect(ciLanes, `CI_ONLY lane ${lane} missing from CI`).toContain(lane);
    // A local-only entry that no longer appears locally is dead allowlist masking.
    for (const lane of LOCAL_ONLY)
      expect(verifyLanes, `LOCAL_ONLY lane ${lane} missing from verify.sh`).toContain(lane);
    // The `test` lane is only legitimately local-only because CI runs the
    // vitest suite another way — assert CI still actually invokes it (match the
    // real `run:` line, not a bare substring that a comment could satisfy).
    expect(ciTestJob).toMatch(/run:\s*pnpm exec vitest run/);
  });

  it('detects drift: a lane dropped from verify.sh fails parity (mutation)', () => {
    const drifted = verifySh.replace(/^.*pnpm validate:playbooks.*$/m, '# lane removed by mutation test');
    expect(drifted, 'mutation should have removed the validate:playbooks lane').not.toEqual(verifySh);
    const { ciLanes, verifyLanes } = requiredLanes(ciYml, drifted);
    expect(verifyLanes).not.toEqual(ciLanes);
    expect(verifyLanes).not.toContain('validate:playbooks');
    expect(ciLanes).toContain('validate:playbooks');
  });
});
