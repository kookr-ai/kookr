import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, expect } from 'vitest';
import { gitExecEnv, NESTED_GIT_ENV_VARS } from './git-helpers.js';
import { parsePlaybook, interpolateParameters } from './playbook-parser.js';

/**
 * Contract tests for the Repository Idea Scout playbook portfolio/authority
 * redesign. These lock in the behavior guarantees that make selective
 * publication safe: authority gating (reductive is always protected and can
 * never become an autonomous issue), a ranked parallel-aware portfolio,
 * preservation-first simplification, reader-first issue bodies, and a
 * high-throughput full-day default. A casual edit that reintroduces the
 * duplicate `useKnowledgeBase` parameter, drops the authority barrier, or
 * leaks local state paths into published issues should fail this suite.
 */
describe('repository-idea-scout playbook', () => {
  const playbookPath = join(
    import.meta.dirname,
    '..',
    '..',
    'plugin',
    'playbooks',
    'repository-idea-scout.md',
  );
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'repository-idea-scout.md', '/');

  const bashBlockAfter = (marker: string): string => {
    const markerAt = pb.body.indexOf(marker);
    expect(markerAt).toBeGreaterThan(-1);
    const start = pb.body.indexOf('```bash\n', markerAt);
    expect(start).toBeGreaterThan(markerAt);
    const bodyStart = start + '```bash\n'.length;
    const end = pb.body.indexOf('\n```', bodyStart);
    expect(end).toBeGreaterThan(bodyStart);
    return pb.body.slice(bodyStart, end);
  };

  const runGit = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string => {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  };

  type CheckoutRelation = 'equal' | 'behind' | 'ahead' | 'diverged';
  interface SnapshotFixture {
    root: string;
    local: string;
    seed: string;
    state: string;
    tempParent: string;
    env: NodeJS.ProcessEnv;
    localHead: string;
    statusBefore: string;
    indexBefore: Buffer;
  }

  const createSnapshotFixture = (
    relation: CheckoutRelation,
    options: { upstreamOnly?: boolean; dirty?: boolean; trailingSlashTmp?: boolean } = {},
  ): SnapshotFixture => {
    const root = mkdtempSync(join(tmpdir(), 'idea-scout-snapshot-test-'));
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const local = join(root, 'local');
    const state = join(root, 'state');
    const tempParent = join(root, 'tmp');
    const fakeBin = join(root, 'bin');
    const testHome = join(root, 'home');
    const gitConfig = join(root, 'gitconfig');
    mkdirSync(seed);
    mkdirSync(state);
    mkdirSync(tempParent);
    mkdirSync(fakeBin);
    mkdirSync(testHome);
    writeFileSync(gitConfig, '');
    const gitEnv: NodeJS.ProcessEnv = {
      ...gitExecEnv(),
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: testHome,
    };
    const fixtureGit = (cwd: string, args: string[]): string => runGit(cwd, args, gitEnv);

    fixtureGit(root, ['init', '--bare', remote]);
    fixtureGit(seed, ['init']);
    fixtureGit(seed, ['checkout', '-b', 'trunk']);
    writeFileSync(join(seed, '.gitattributes'), [
      'src/** export-ignore',
      'src/substituted.txt -export-ignore export-subst',
      '',
    ].join('\n'));
    mkdirSync(join(seed, 'src'));
    writeFileSync(join(seed, 'tracked.txt'), 'base\n');
    writeFileSync(join(seed, 'src', 'capability.ts'), 'export const shipped = true;\n');
    writeFileSync(join(seed, 'src', 'substituted.txt'), '$Format:%H$\n');
    fixtureGit(seed, ['add', '.gitattributes', 'tracked.txt', 'src']);
    fixtureGit(seed, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base']);
    fixtureGit(seed, ['remote', 'add', 'origin', remote]);
    fixtureGit(seed, ['push', '-u', 'origin', 'trunk']);
    fixtureGit(root, ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/trunk']);
    fixtureGit(root, ['clone', remote, local]);
    fixtureGit(local, ['checkout', '-b', 'feature']);

    if (relation === 'ahead' || relation === 'diverged') {
      writeFileSync(join(local, 'local-only.txt'), 'local\n');
      fixtureGit(local, ['add', 'local-only.txt']);
      fixtureGit(local, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'local']);
    }
    if (relation === 'behind' || relation === 'diverged') {
      writeFileSync(join(seed, 'default-only.txt'), 'default\n');
      fixtureGit(seed, ['add', 'default-only.txt']);
      fixtureGit(seed, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'default']);
      fixtureGit(seed, ['push', 'origin', 'trunk']);
    }

    const remoteName = options.upstreamOnly ? 'upstream' : 'origin';
    if (options.upstreamOnly) fixtureGit(local, ['remote', 'rename', 'origin', 'upstream']);
    const githubUrl = 'https://github.com/example/snapshot-fixture.git';
    fixtureGit(local, ['remote', 'set-url', remoteName, githubUrl]);

    if (options.dirty) {
      writeFileSync(join(local, 'tracked.txt'), 'dirty\n');
      writeFileSync(join(local, 'untracked.txt'), 'untracked\n');
    }

    const ghPath = join(fakeBin, 'gh');
    writeFileSync(ghPath, [
      '#!/bin/sh',
      'if [ "$1" = repo ] && [ "$2" = view ]; then',
      '  printf "%s\\n" "$TEST_DEFAULT_BRANCH"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'));
    chmodSync(ghPath, 0o755);
    const gitPath = join(fakeBin, 'git');
    writeFileSync(gitPath, [
      '#!/bin/sh',
      'if [ "${2:-}" = fetch ]; then',
      '  exec "$REAL_GIT" -c "url.file://$TEST_REMOTE_PATH.insteadOf=$TEST_GITHUB_URL" "$@"',
      'fi',
      'exec "$REAL_GIT" "$@"',
      '',
    ].join('\n'));
    chmodSync(gitPath, 0o755);

    const env: NodeJS.ProcessEnv = {
      ...gitEnv,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: testHome,
      KOOKR_TASK_ID: 'snapshot-test-run',
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      REAL_GIT: execFileSync('which', ['git'], { encoding: 'utf8' }).trim(),
      TEST_DEFAULT_BRANCH: 'trunk',
      TEST_GITHUB_URL: githubUrl,
      TEST_LOCAL: local,
      TEST_REMOTE_PATH: remote,
      TEST_REPO: 'example/snapshot-fixture',
      TEST_STATE: state,
      TMPDIR: options.trailingSlashTmp ? `${tempParent}/` : tempParent,
    };

    const localHead = runGit(local, ['rev-parse', 'HEAD'], env);
    const statusBefore = runGit(local, ['status', '--short'], env);
    const indexBefore = readFileSync(join(local, '.git', 'index'));
    return {
      root,
      local,
      seed,
      state,
      tempParent,
      env,
      localHead,
      statusBefore,
      indexBefore,
    };
  };

  const runSnapshotPhase = (fixture: SnapshotFixture): void => {
    const init = bashBlockAfter('Initialize derived values:');
    const remote = bashBlockAfter('Resolve the local checkout and validate remotes:');
    const snapshot = bashBlockAfter("Resolve GitHub's current default branch");
    const scriptPath = join(fixture.root, 'run-snapshot.sh');
    writeFileSync(scriptPath, [
      init,
      'REPO="$TEST_REPO"',
      'REPO_SLUG=example-snapshot-fixture',
      'LOCAL_INPUT="$TEST_LOCAL"',
      'RUN_KEY=snapshot-test-run',
      'STATE_DIR="$TEST_STATE"',
      'STATE_FILE="$STATE_DIR/state.md"',
      'RECS_DIR="$STATE_DIR/recommendations"',
      'IDEAS_LOG="$STATE_DIR/ideas-log.json"',
      'PROFILE=balanced',
      'WORKLOAD=quick-shortlist',
      'PUBLISH=report-only',
      'USE_KB=off',
      'SCAN_LIMIT=20',
      'PUBLISH_TARGET=3',
      'CANDIDATE_POOL=6',
      'SPEND_CAP_USD=0',
      'CAP_ENFORCED=false',
      'mkdir -p "$STATE_DIR" "$RECS_DIR"',
      '[ -f "$IDEAS_LOG" ] || printf "[]\\n" > "$IDEAS_LOG"',
      remote,
      snapshot,
      '',
    ].join('\n'));
    execFileSync('bash', [scriptPath], {
      cwd: fixture.root,
      env: fixture.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };

  const cleanupFixture = (fixture: SnapshotFixture): void => {
    try {
      execFileSync('chmod', ['-R', 'u+w', fixture.root], { stdio: 'ignore' });
    } catch {
      // Best effort only; rmSync below reports an actual cleanup problem.
    }
    rmSync(fixture.root, { recursive: true, force: true });
  };

  const paramNames = pb.parameters.map((p) => p.name);
  const param = (name: string) => pb.parameters.find((p) => p.name === name);

  describe('duplicate defects are fixed', () => {
    test('useKnowledgeBase is declared exactly once', () => {
      const count = paramNames.filter((n) => n === 'useKnowledgeBase').length;
      expect(count).toBe(1);
    });

    test('no parameter name is declared twice', () => {
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const n of paramNames) {
        if (seen.has(n)) dupes.push(n);
        seen.add(n);
      }
      expect(dupes).toEqual([]);
    });

    test('Knowledge Base Grounding section appears exactly once', () => {
      const matches = pb.body.match(/^## Knowledge Base Grounding$/gm) ?? [];
      expect(matches.length).toBe(1);
    });

    test('useKnowledgeBase appears exactly once in the Launch Parameters block', () => {
      const launchStart = pb.body.indexOf('## Launch Parameters');
      const launchEnd = pb.body.indexOf('## Ad-Hoc Instruction');
      expect(launchStart).toBeGreaterThan(-1);
      expect(launchEnd).toBeGreaterThan(launchStart);
      const block = pb.body.slice(launchStart, launchEnd);
      const count = (block.match(/\*\*useKnowledgeBase\*\*/g) ?? []).length;
      expect(count).toBe(1);
    });
  });

  describe('parameters interpolate cleanly', () => {
    // Exercise every workProfile x workloadSize combination (plus a non-empty
    // note) so a grammar/placeholder defect that only surfaces for one option
    // value cannot slip through a single hand-picked input. The old defect was
    // a chosen value interpolated into "When <value> is any." — which only
    // reads correctly for the default — so we assert that class is gone for
    // ALL option values, not just one.
    const profiles = (param('workProfile')!.options ?? []).map((o) => o.value);
    const sizes = (param('workloadSize')!.options ?? []).map((o) => o.value);
    const publishOpts = (param('publishBehavior')!.options ?? []).map((o) => o.value);
    const combos = profiles.flatMap((wp) =>
      sizes.map((ws) => ({ wp, ws })),
    );

    test.each(combos)(
      'renders cleanly for workProfile=$wp workloadSize=$ws',
      ({ wp, ws }) => {
        const values: Record<string, string> = {
          repoFullName: 'octocat/hello-world',
          workProfile: wp,
          workloadSize: ws,
          publishBehavior: publishOpts[0] ?? 'report-only',
          extraInstruction: 'Focus on first-time contributor onboarding.',
          minimumIssueScan: '100',
          localPath: '',
          useKnowledgeBase: 'auto',
        };
        const rendered = interpolateParameters(pb.body, pb.parameters, values);
        // No leftover placeholder for any declared parameter.
        expect(rendered).not.toMatch(/\{\{[a-zA-Z]/);
        // The old defect class: a chosen value interpolated into a sentence
        // that only reads for the default, e.g. "... is `any`." — must never
        // appear for any option value.
        expect(rendered).not.toMatch(/\bis `?any`?\./);
      },
    );

    test('a report-only render also stays clean', () => {
      const rendered = interpolateParameters(pb.body, pb.parameters, {
        repoFullName: 'octocat/hello-world',
        workProfile: 'balanced',
        workloadSize: 'full-day',
        publishBehavior: 'report-only',
        extraInstruction: '',
        minimumIssueScan: '100',
        localPath: '',
        useKnowledgeBase: 'off',
      });
      expect(rendered).not.toMatch(/\{\{[a-zA-Z]/);
      expect(rendered).not.toMatch(/\bis `?any`?\./);
    });

    test('every declared parameter has a placeholder in the body (no dead params)', () => {
      for (const p of pb.parameters) {
        expect(pb.body).toContain(`{{${p.name}}}`);
      }
    });

    test('no legacy placeholders survive the rename', () => {
      expect(pb.body).not.toContain('{{ideaFocus}}');
      expect(pb.body).not.toContain('{{targetIdeaCount}}');
      expect(pb.body).not.toContain('{{createIssue}}');
    });
  });

  describe('workload presets replace targetIdeaCount', () => {
    test('workloadSize is a select defaulting to full-day', () => {
      const p = param('workloadSize');
      expect(p).toBeDefined();
      expect(p!.type).toBe('select');
      expect(p!.default).toBe('full-day');
      const values = (p!.options ?? []).map((o) => o.value).sort();
      expect(values).toEqual(['deep-backlog', 'full-day', 'half-day', 'quick-shortlist']);
    });

    test('full-day is the normal path and maps to about ten queued outputs', () => {
      // Guard the default-path throughput promise and the preset mapping.
      expect(pb.body).toMatch(/full-day.*\|\s*10\s*\|/);
      expect(pb.body).toMatch(/PUBLISH_TARGET=10/);
      expect(pb.body).toMatch(/quick-shortlist.*\|\s*3\s*\|/);
      expect(pb.body).toMatch(/deep-backlog.*\|\s*15\s*\|/);
    });

    test('a larger internal candidate pool is generated than the publish target', () => {
      expect(pb.body).toMatch(/CANDIDATE_POOL=16/);
      expect(pb.body).toMatch(/1\.5.?2x the publish target/);
    });

    test('shortfall is reported honestly rather than fabricated', () => {
      expect(pb.body).toMatch(/never fabricate marginal ideas/i);
      expect(pb.body).toMatch(/shortfall/i);
    });
  });

  describe('candidate classification is present and machine-readable', () => {
    test('the four required classification axes and their values are defined', () => {
      expect(pb.body).toMatch(/\*\*authority\*\*:\s*`autonomous`.*`review-required`.*`protected`/);
      expect(pb.body).toMatch(/\*\*changeShape\*\*:\s*`additive`.*`corrective`.*`structural`.*`reductive`/);
      expect(pb.body).toMatch(/\*\*size\*\*:\s*`small`.*`medium`.*`large`/);
      expect(pb.body).toMatch(/\*\*confidence\*\*:\s*`high`.*`medium`.*`low`/);
    });

    test('the extra assessments are present', () => {
      for (const field of [
        'expectedValue',
        'evidenceStrength',
        'duplicateRisk',
        'implementationReadiness',
        'parallelConflictRisk',
      ]) {
        expect(pb.body).toContain(field);
      }
    });

    test('ideas-log entries carry the full classification and rank', () => {
      // The ideas-log shape is the machine-readable artifact.
      const logStart = pb.body.indexOf('### 5.5 Write the ideas log');
      expect(logStart).toBeGreaterThan(-1);
      const block = pb.body.slice(logStart, logStart + 1600);
      for (const key of ['"authority"', '"changeShape"', '"rank"', '"parallelConflictRisk"', '"conflictsWith"', '"evidenceVerification"']) {
        expect(block).toContain(key);
      }
    });
  });

  describe('operational-evidence sweep seeds and boosts candidates (issue #1757)', () => {
    // Issue #1757: incident-labeled issues, CI failures, and optional local
    // runtime diagnostics must feed idea generation the same way KB seeds do —
    // informing angles / boosting evidence, never replacing the capability check
    // and never originating a diversity dimension. Kookr-specific probes are
    // optional with the same graceful-skip pattern as a missing kb CLI.
    test('there is a dedicated Phase 3.6 operational-evidence sweep before candidate generation', () => {
      const ops = pb.body.indexOf('## Phase 3.6: Operational Evidence Sweep');
      const phase4 = pb.body.indexOf('## Phase 4: Generate The Candidate Pool');
      const kb = pb.body.indexOf('## Phase 3.5: Domain Knowledge Survey');
      expect(ops).toBeGreaterThan(-1);
      expect(kb).toBeGreaterThan(-1);
      expect(ops).toBeGreaterThan(kb);
      expect(phase4).toBeGreaterThan(ops);
    });

    test('portable probes cover incident-labeled issues and CI failures', () => {
      const sec = pb.body.slice(
        pb.body.indexOf('## Phase 3.6: Operational Evidence Sweep'),
        pb.body.indexOf('## Phase 4: Generate The Candidate Pool'),
      );
      expect(sec).toMatch(/label:bug|bug.*incident.*regression/i);
      expect(sec).toContain('gh run list');
      // Filter failures in jq — do not rely on version-dependent --status failure.
      expect(sec).toMatch(/conclusion == "failure"/);
      expect(sec).not.toMatch(/gh run list[^\n]*--status failure/);
      expect(sec).toContain('opsEvidenceFile');
      expect(sec).toContain('ops-evidence.json');
    });

    test('kookr runtime probes are optional and degrade gracefully', () => {
      const sec = pb.body.slice(
        pb.body.indexOf('## Phase 3.6: Operational Evidence Sweep'),
        pb.body.indexOf('## Phase 4: Generate The Candidate Pool'),
      );
      expect(sec).toMatch(/KOOKR_API_BASE_URL/);
      expect(sec).toContain('/api/health');
      expect(sec).toMatch(/\/api\/diagnostics\//);
      expect(sec).toMatch(/server\.log/);
      expect(sec).toMatch(/graceful skip|never block|optional/i);
      // Missing runtime surface must not reduce the publish target.
      expect(sec).toMatch(/never reduce the publish target|never blocks the run/i);
    });

    test('ops evidence seeds/boosts like KB seeds and never originates a dimension', () => {
      expect(pb.body).toMatch(/ops evidence may \*\*boost\*\*|Ops evidence may \*\*boost\*\*/i);
      expect(pb.body).toMatch(/never invents a dimension|never originate its \*dimension\*/i);
      expect(pb.body).toMatch(/never replaces the (Phase 3 )?codebase capability check/i);
      // Phase 4.1 consults ops-evidence dimensions bucket.
      const cat = pb.body.slice(
        pb.body.indexOf('### 4.1 Category Assignment'),
        pb.body.indexOf('### 4.2 Duplicate Check'),
      );
      expect(cat).toMatch(/opsEvidenceFile/);
      expect(cat).toMatch(/dimensions\.<category>/);
    });

    test('Phase 6/8 and reports carry the ops-evidence artifact contract', () => {
      expect(pb.body).toContain('## Operational evidence summary');
      expect(pb.body).toContain('## Operational evidence');
      const phase8 = pb.body.slice(pb.body.indexOf('## Phase 8: Final Validation'));
      expect(phase8).toMatch(/opsEvidenceFile|ops-evidence\.json/);
      expect(phase8).toMatch(/incidentIssues/);
      expect(phase8).toMatch(/ciFailures/);
      expect(phase8).toMatch(/runtimeProbes/);
      // Anti-pattern: no hard-fail on missing kookr probes; no local paths in issues.
      expect(pb.body).toMatch(/Do not hard-fail when Kookr runtime probes are unavailable/);
      expect(pb.body).toMatch(/Do not invent incidents, CI failures, gauges, or log lines/);
    });

    test('checklist requires the operational-evidence sweep', () => {
      expect(pb.checklist.some((c) => /operational evidence/i.test(c))).toBe(true);
    });
  });

  describe('evidence-verification gate validates cited evidence before publishing', () => {
    // Issue #1756: a hallucinated-but-plausible problem must be caught by a
    // cheap validator pass before it can be classified, ranked, or published,
    // so it never costs a full downstream implementation task to discover.
    test('there is a dedicated evidence-verification gate phase before classification', () => {
      const gate = pb.body.indexOf('### 4.5 Evidence Verification Gate');
      const classification = pb.body.indexOf('### 4.6 Classification');
      expect(gate).toBeGreaterThan(-1);
      expect(classification).toBeGreaterThan(gate);
    });

    test('the gate checks cited file:line and claimed-missing capabilities against the pinned snapshot', () => {
      const gate = pb.body.slice(
        pb.body.indexOf('### 4.5 Evidence Verification Gate'),
        pb.body.indexOf('### 4.6 Classification'),
      );
      // (a) cited file:line exists and supports the claim
      expect(gate).toMatch(/Cited `file:line` exists and supports the claim/);
      // (b) claimed-missing capability is absent, not merely unfound
      expect(gate).toMatch(/Claimed-missing capability is absent, not merely unfound/);
      // (c) the three deterministic verdicts, cheap-tier, reusing the spend ledger
      for (const token of ['pass', 'downgraded', 'discarded']) {
        expect(gate).toContain(token);
      }
      expect(gate).toMatch(/Haiku- or Sonnet-tier/);
      expect(gate).toMatch(/spend ledger/i);
    });

    test('a discarded candidate never reaches the ideas log and downgrades feed authority', () => {
      const gate = pb.body.slice(
        pb.body.indexOf('### 4.5 Evidence Verification Gate'),
        pb.body.indexOf('### 4.6 Classification'),
      );
      expect(gate).toMatch(/A `discarded` candidate never reaches classification, ranking/);
      expect(gate).toMatch(/`confidence` reduced to `low` forces `authority = review-required`/);
    });

    test('Phase 8 validates the evidence-verification artifact and verdict', () => {
      const phase8 = pb.body.slice(pb.body.indexOf('## Phase 8: Final Validation'));
      expect(phase8).toContain('evidence-verification.json');
      expect(phase8).toMatch(/no entry has `verdict: discarded`/);
      expect(phase8).toContain('## Evidence verification');
    });
  });

  describe('default-branch analysis snapshot (issue #2894)', () => {
    const phase1 = pb.body.slice(
      pb.body.indexOf('## Phase 1: Preflight And State'),
      pb.body.indexOf('## Phase 1.5:'),
    );
    const phase3 = pb.body.slice(
      pb.body.indexOf('## Phase 3: Codebase And Feature Inventory'),
      pb.body.indexOf('## Phase 3.5:'),
    );
    const critic = pb.body.slice(
      pb.body.indexOf('### 4.4 Critic Review'),
      pb.body.indexOf('### 4.5 Evidence Verification Gate'),
    );
    const evidenceGate = pb.body.slice(
      pb.body.indexOf('### 4.5 Evidence Verification Gate'),
      pb.body.indexOf('### 4.6 Classification'),
    );
    const phase8 = pb.body.slice(pb.body.indexOf('## Phase 8: Final Validation'));

    test('stale, ahead, and diverged checkouts record local/default provenance and divergence', () => {
      for (const field of [
        'matchedRemote:',
        'defaultBranch:',
        'localHeadSha:',
        'analysisSha:',
        'divergence:',
      ]) {
        expect(phase1).toContain(field);
      }
      expect(phase1).toMatch(/rev-list --left-right --count/);
      for (const relationship of ['equal', 'behind', 'ahead', 'diverged']) {
        expect(phase1).toContain(relationship);
      }
    });

    test('fetches an upstream-only or origin match and supports a non-main default branch', () => {
      expect(phase1).toMatch(/for REMOTE_NAME in origin upstream/);
      expect(phase1).toContain('remote get-url "$REMOTE_MATCH"');
      expect(phase1).toContain("DEFAULT_BRANCH=$(gh repo view \"$REPO\" --json defaultBranchRef");
      expect(phase1).toContain('refs/heads/$DEFAULT_BRANCH:refs/kookr/default');
      expect(phase1).not.toContain('origin/main');
    });

    test('uses isolated temporary Git storage, pins before archive, and fails closed', () => {
      expect(phase1).toContain('mktemp -d');
      expect(phase1).toContain('git init --bare "$ANALYSIS_GIT_DIR"');
      expect(phase1).toMatch(/git --git-dir="\$ANALYSIS_GIT_DIR" fetch/);
      expect(phase1).toContain('ANALYSIS_SHA=$(git --git-dir="$ANALYSIS_GIT_DIR" rev-parse');
      expect(phase1).toContain('cat-file -e "$ANALYSIS_SHA^{commit}"');
      const pin = phase1.indexOf('ANALYSIS_SHA=$(git --git-dir="$ANALYSIS_GIT_DIR" rev-parse');
      const archive = phase1.indexOf('archive --format=tar');
      expect(pin).toBeGreaterThan(-1);
      expect(archive).toBeGreaterThan(pin);
      expect(phase1).toMatch(/default branch resolution failed[^\n]*block|block "default branch resolution failed/i);
      expect(phase1).toMatch(/default-branch fetch failed[^\n]*block|block "default-branch fetch failed/i);
      expect(phase1).toMatch(/snapshot (archive|materialization) failed[^\n]*block|block "snapshot/i);
      expect(pb.body).toMatch(/never fall back to (the )?local `HEAD`/i);
    });

    test('preserves dirty and untracked checkout state without shared-metadata mutation', () => {
      expect(phase1).toContain('CURRENT_STATUS=$(GIT_OPTIONAL_LOCKS=0 git -C "$LOCAL" status --short)');
      expect(phase1).toContain('INITIAL_STATUS=$CURRENT_STATUS');
      expect(phase8).toMatch(/git status --short.*initial status|initial status.*git status --short/is);
      expect(phase8).toContain('GIT_OPTIONAL_LOCKS=0');
      expect(phase1).not.toMatch(/git -C "\$LOCAL" (fetch|checkout|switch|reset|merge|stash)\b/);
      expect(pb.body).toMatch(/never switch, reset, merge, stash, fetch through, or edit/i);
    });

    test('threads the pinned root and SHA through inventory, critics, evidence, citations, and validation', () => {
      expect(phase3).toContain('$ANALYSIS_ROOT');
      expect(phase3).toMatch(/source, docs,\s+tests/i);
      expect(critic).toContain('$ANALYSIS_ROOT');
      expect(critic).toContain('$ANALYSIS_SHA');
      expect(evidenceGate).toContain('$ANALYSIS_ROOT');
      expect(evidenceGate).toContain('analysisSha');
      expect(evidenceGate).not.toContain('git -C "$LOCAL"');
      const issueBodies = pb.body.slice(pb.body.indexOf('### 5.7 Write the reader-first issue bodies'));
      expect(issueBodies).toContain('Analysis commit:');
      expect(phase8).toMatch(/analysisSha|analysis SHA/);
      expect(phase8).toMatch(/analysisRoot|analysis root/);
    });

    test('moving default-branch tips force refresh even when local HEAD is unchanged', () => {
      const resume = pb.body.slice(pb.body.indexOf('## Idempotency Rules'));
      expect(resume).toMatch(/fetch the current default-branch tip/i);
      expect(resume).toMatch(/analysisSha/);
      expect(resume).toMatch(/even when.*localHeadSha.*unchanged/i);
      expect(resume).toMatch(/invalidate|refresh/i);
    });

    test('cleans temporary artifacts and documents submodule and Git-LFS limits', () => {
      expect(phase1).toContain('cleanup_analysis');
      expect(phase1).toMatch(/chmod -R a-w "\$ANALYSIS_STAGING_ROOT"/);
      expect(phase1).toContain("trap 'cleanup_analysis_git || true' EXIT");
      expect(phase8).toContain('rm -rf "$ANALYSIS_ROOT"');
      expect(pb.body).toMatch(/submodule/i);
      expect(pb.body).toMatch(/Git[- ]LFS/i);
      expect(pb.body).toMatch(/pointer files|LFS payloads/i);
    });

    test('scrubs inherited Git repository routing from subprocess fixtures', () => {
      const routed = gitExecEnv();
      for (const name of NESTED_GIT_ENV_VARS) expect(routed[name]).toBeUndefined();
    });

    test.each<CheckoutRelation>(['equal', 'behind', 'ahead', 'diverged'])(
      'executes the isolated snapshot flow for a %s local checkout',
      (relation) => {
        const fixture = createSnapshotFixture(relation);
        try {
          runSnapshotPhase(fixture);
          const manifest = JSON.parse(readFileSync(join(fixture.state, 'run.json'), 'utf8')) as {
            matchedRemote: string;
            defaultBranch: string;
            localHeadSha: string;
            analysisSha: string;
            analysisRoot: string;
            divergence: { available: boolean; relationship: string };
            snapshot: { sourceCommitValidated: boolean; pinnedBeforeMaterialization: boolean };
          };
          expect(manifest.matchedRemote).toBe('origin');
          expect(manifest.defaultBranch).toBe('trunk');
          expect(manifest.localHeadSha).toBe(fixture.localHead);
          expect(manifest.analysisSha).toBe(runGit(fixture.seed, ['rev-parse', 'trunk'], fixture.env));
          expect(manifest.divergence).toMatchObject({ available: true, relationship: relation });
          expect(manifest.snapshot).toMatchObject({
            sourceCommitValidated: true,
            pinnedBeforeMaterialization: true,
          });
          expect(existsSync(manifest.analysisRoot)).toBe(true);
          expect(statSync(manifest.analysisRoot).mode & 0o222).toBe(0);
          expect(statSync(join(manifest.analysisRoot, 'tracked.txt')).mode & 0o222).toBe(0);
          expect(readdirSync(fixture.tempParent)).toEqual([]);
          expect(readFileSync(join(fixture.local, '.git', 'index'))).toEqual(fixture.indexBefore);
        } finally {
          cleanupFixture(fixture);
        }
      },
    );

    test('uses an upstream-only remote and non-main branch without changing dirty or untracked state', () => {
      const fixture = createSnapshotFixture('behind', {
        upstreamOnly: true,
        dirty: true,
        trailingSlashTmp: true,
      });
      try {
        runSnapshotPhase(fixture);
        const manifest = JSON.parse(readFileSync(join(fixture.state, 'run.json'), 'utf8')) as {
          matchedRemote: string;
          defaultBranch: string;
          localHeadSha: string;
          divergence: { relationship: string };
        };
        expect(manifest).toMatchObject({
          matchedRemote: 'upstream',
          defaultBranch: 'trunk',
          localHeadSha: fixture.localHead,
          divergence: { relationship: 'behind' },
        });
        expect(readFileSync(join(fixture.local, '.git', 'index'))).toEqual(fixture.indexBefore);
        expect(runGit(fixture.local, ['status', '--short'], fixture.env)).toBe(fixture.statusBefore);
        expect(runGit(fixture.local, ['rev-parse', 'HEAD'], fixture.env)).toBe(fixture.localHead);
        expect(readdirSync(fixture.tempParent)).toEqual([]);
      } finally {
        cleanupFixture(fixture);
      }
    });

    test('keeps export-ignored paths and export-subst content byte-faithful', () => {
      const fixture = createSnapshotFixture('equal');
      try {
        runSnapshotPhase(fixture);
        const manifest = JSON.parse(readFileSync(join(fixture.state, 'run.json'), 'utf8')) as {
          analysisRoot: string;
        };
        expect(readFileSync(join(manifest.analysisRoot, 'src', 'capability.ts'), 'utf8')).toBe(
          'export const shipped = true;\n',
        );
        expect(readFileSync(join(manifest.analysisRoot, 'src', 'substituted.txt'), 'utf8')).toBe(
          '$Format:%H$\n',
        );
      } finally {
        cleanupFixture(fixture);
      }
    });

    test('blocks publication on fetch failure without falling back to local HEAD', () => {
      const fixture = createSnapshotFixture('behind', { dirty: true });
      try {
        rmSync(join(fixture.root, 'remote.git'), { recursive: true, force: true });
        runSnapshotPhase(fixture);
        expect(existsSync(join(fixture.state, 'run.json'))).toBe(false);
        expect(readFileSync(join(fixture.state, 'state.md'), 'utf8')).toMatch(
          /default-branch fetch failed[\s\S]*<promise>BLOCKED<\/promise>/,
        );
        expect(readFileSync(join(fixture.local, '.git', 'index'))).toEqual(fixture.indexBefore);
        expect(runGit(fixture.local, ['status', '--short'], fixture.env)).toBe(fixture.statusBefore);
        expect(runGit(fixture.local, ['rev-parse', 'HEAD'], fixture.env)).toBe(fixture.localHead);
        expect(readdirSync(fixture.tempParent)).toEqual([]);
        expect(existsSync(join(fixture.state, 'analysis-snapshots'))).toBe(false);
      } finally {
        cleanupFixture(fixture);
      }
    });

    test('moving-tip resume invalidates stale artifacts before advancing the manifest and cleans snapshots', () => {
      const fixture = createSnapshotFixture('equal');
      try {
        runSnapshotPhase(fixture);
        const first = JSON.parse(readFileSync(join(fixture.state, 'run.json'), 'utf8')) as {
          analysisSha: string;
          analysisRoot: string;
          localHeadSha: string;
        };
        writeFileSync(join(fixture.state, 'features.md'), 'stale inventory\n');
        mkdirSync(join(fixture.state, 'recommendations'), { recursive: true });
        writeFileSync(join(fixture.state, 'recommendations', 'stale.md'), 'stale candidate\n');
        writeFileSync(join(fixture.state, 'ideas-log.json'), '[{"analysisSha":"stale"}]\n');

        writeFileSync(join(fixture.seed, 'moving-tip.txt'), 'new default tip\n');
        runGit(fixture.seed, ['add', 'moving-tip.txt'], fixture.env);
        runGit(fixture.seed, [
          '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
          'commit', '-m', 'move default tip',
        ], fixture.env);
        runGit(fixture.seed, ['push', 'origin', 'trunk'], fixture.env);

        runSnapshotPhase(fixture);
        const second = JSON.parse(readFileSync(join(fixture.state, 'run.json'), 'utf8')) as {
          analysisSha: string;
          analysisRoot: string;
          localHeadSha: string;
        };
        expect(second.analysisSha).not.toBe(first.analysisSha);
        expect(second.localHeadSha).toBe(first.localHeadSha);
        expect(existsSync(first.analysisRoot)).toBe(false);
        expect(existsSync(second.analysisRoot)).toBe(true);
        expect(existsSync(join(fixture.state, 'features.md'))).toBe(false);
        expect(existsSync(join(fixture.state, 'recommendations', 'stale.md'))).toBe(false);
        expect(JSON.parse(readFileSync(join(fixture.state, 'ideas-log.json'), 'utf8'))).toEqual([]);
        expect(existsSync(join(fixture.state, 'analysis-transition.json'))).toBe(false);
        expect(readdirSync(fixture.tempParent)).toEqual([]);
        expect(readFileSync(join(fixture.local, '.git', 'index'))).toEqual(fixture.indexBefore);

        const init = bashBlockAfter('Initialize derived values:');
        const finalCleanup = bashBlockAfter('After all evidence and status checks pass');
        const cleanupScript = join(fixture.root, 'cleanup-snapshot.sh');
        writeFileSync(cleanupScript, [
          init,
          'STATE_DIR="$TEST_STATE"',
          'STATE_FILE="$STATE_DIR/state.md"',
          finalCleanup,
          '',
        ].join('\n'));
        execFileSync('bash', [cleanupScript], {
          cwd: fixture.root,
          env: fixture.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        expect(existsSync(second.analysisRoot)).toBe(false);
        expect(existsSync(join(fixture.state, 'analysis-snapshots'))).toBe(false);
      } finally {
        cleanupFixture(fixture);
      }
    });

    test('blocks a moving-tip resume when stale artifacts cannot be removed', () => {
      const fixture = createSnapshotFixture('equal');
      try {
        runSnapshotPhase(fixture);
        const first = JSON.parse(readFileSync(join(fixture.state, 'run.json'), 'utf8')) as {
          analysisSha: string;
        };
        const recommendations = join(fixture.state, 'recommendations');
        writeFileSync(join(recommendations, 'stale.md'), 'stale candidate\n');
        chmodSync(recommendations, 0o500);

        writeFileSync(join(fixture.seed, 'moving-tip.txt'), 'new default tip\n');
        runGit(fixture.seed, ['add', 'moving-tip.txt'], fixture.env);
        runGit(fixture.seed, [
          '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
          'commit', '-m', 'move default tip',
        ], fixture.env);
        runGit(fixture.seed, ['push', 'origin', 'trunk'], fixture.env);

        runSnapshotPhase(fixture);

        const retained = JSON.parse(readFileSync(join(fixture.state, 'run.json'), 'utf8')) as {
          analysisSha: string;
        };
        expect(retained.analysisSha).toBe(first.analysisSha);
        expect(readFileSync(join(fixture.state, 'state.md'), 'utf8')).toMatch(
          /source-derived artifact invalidation failed[\s\S]*<promise>BLOCKED<\/promise>/,
        );
        expect(existsSync(join(recommendations, 'stale.md'))).toBe(true);
        expect(existsSync(join(fixture.state, 'analysis-transition.json'))).toBe(true);
        expect(existsSync(join(fixture.state, 'analysis-snapshots'))).toBe(false);
        expect(readdirSync(fixture.tempParent)).toEqual([]);
        expect(readFileSync(join(fixture.local, '.git', 'index'))).toEqual(fixture.indexBefore);
      } finally {
        cleanupFixture(fixture);
      }
    });
  });

  describe('authority policy gates unsafe work', () => {
    test('reductive is always protected', () => {
      expect(pb.body).toMatch(/Reductive is always protected/);
      expect(pb.body).toMatch(/`changeShape`\s*is\s*`reductive`,\s*`authority`\s*is\s*`protected`/);
    });

    test('safe additive/corrective work may be autonomous', () => {
      expect(pb.body).toMatch(/Safe additive\/corrective\/structural work is autonomous/);
    });

    test('policy-heavy or uncertain work is review-required and visibly blocked', () => {
      expect(pb.body).toMatch(/review-required/);
      expect(pb.body).toMatch(/Product-policy changes, broad architecture changes, major persistence changes/);
      expect(pb.body).toMatch(/visibly blocked from autonomous implementation/);
    });

    test('defines the RFC-first threshold without widening ordinary review-required work', () => {
      const start = pb.body.indexOf('## RFC-First Large-Refactor Routing');
      const end = pb.body.indexOf('## Preservation-First Simplification');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const routing = pb.body.slice(start, end);
      expect(routing).toMatch(/changeShape.*structural/i);
      expect(routing).toMatch(/size.*large/i);
      expect(routing).toMatch(/implementationReadiness.*needs-design/i);
      expect(routing).toMatch(/at least two|2\+/i);
      expect(routing).toMatch(/ordered.*depend/i);
      expect(routing).toMatch(/below.*threshold.*unchanged/i);
    });
  });

  describe('reductive ideas cannot become autonomous implementation issues', () => {
    test('the issue-creation loop selects only authority == autonomous', () => {
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7: Selective GitHub Issue Creation'));
      // The deterministic barrier: jq filter on authority == "autonomous".
      expect(phase7).toMatch(/select\(\.authority == "autonomous"/);
      expect(phase7).toMatch(/deterministic barrier/i);
      expect(phase7).toMatch(/never for a review-required or protected candidate|never create an issue for a review-required or protected/i);
    });

    test('protected and review-required candidates are recorded locally, not published', () => {
      expect(pb.body).toMatch(/publishDecision = local-proposal/);
      expect(pb.body).toMatch(/publishDecision = local-investigation/);
      expect(pb.body).toMatch(/proposalsDoc/);
    });

    test('large structural candidates route to RFC-first while other decisions stay unchanged', () => {
      const decisions = pb.body.slice(
        pb.body.indexOf('### 5.4 Assign publish decisions'),
        pb.body.indexOf('### 5.5 Write the ideas log'),
      );
      expect(decisions).toMatch(/large-refactor threshold.*publishDecision = rfc-first/is);
      expect(decisions).toMatch(/authority = autonomous.*publishDecision = publish/is);
      expect(decisions).toMatch(/review-required.*publishDecision = local-proposal/is);
      expect(decisions).toMatch(/protected.*publishDecision = local-investigation/is);
    });

    test('a user note cannot promote a gated candidate', () => {
      expect(pb.body).toMatch(/cannot promote a protected or review-required candidate/i);
    });
  });

  describe('preservation-first simplification is distinct from removal', () => {
    test('simplification-preserving is a work profile', () => {
      const p = param('workProfile');
      const values = (p!.options ?? []).map((o) => o.value);
      expect(values).toContain('simplification-preserving');
    });

    test('capability inventory and characterization evidence are required before removal', () => {
      const sec = pb.body.slice(pb.body.indexOf('## Preservation-First Simplification'));
      expect(sec).toMatch(/Capability inventory/);
      expect(sec).toMatch(/Characterization evidence/);
      expect(sec).toMatch(/Affected-capability disclosure/);
    });

    test('low or absent usage is never treated as proof a capability is unimportant', () => {
      // Assert the *negated* safe framing verbatim so an edit that inverts the
      // guidance (dropping the "Do not infer that" prefix) removes this exact
      // string and fails the test, instead of matching the dangerous substring.
      expect(pb.body).toContain(
        'Do not infer that low or absent usage means a capability is unnecessary',
      );
      expect(pb.body).toMatch(/Missing usage evidence is unknown/);
      expect(pb.body).toMatch(/Absence of usage evidence is \*\*unknown\*\*/);
    });

    test('behavior-preserving structural work is separated from reductive removal', () => {
      // Removing a capability is reductive -> protected, even in simplification mode.
      const sec = pb.body.slice(pb.body.indexOf('## Preservation-First Simplification'));
      expect(sec).toMatch(/would remove a documented or user-visible capability.*is `reductive`.*`protected`/s);
    });
  });

  describe('reader-first issue bodies omit local state and boilerplate', () => {
    test('issue-body.md is the only artifact published and excludes state paths', () => {
      const sec = pb.body.slice(pb.body.indexOf('### 5.7 Write the reader-first issue bodies'));
      expect(sec).toMatch(/ONLY artifact ever sent to GitHub/i);
      expect(sec).toMatch(/MUST NOT contain local state paths/i);
      // Reader-first template headings.
      for (const h of ['## Observed gap', '## Impact', '## Code evidence', '## Smallest solution', '## Acceptance criteria', '## Risks', '## Adjacent work']) {
        expect(sec).toContain(h);
      }
    });

    test('Phase 7 uses issue-body.md, never the local report or a state footer', () => {
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7: Selective GitHub Issue Creation'));
      expect(phase7).toContain('--body-file "$ISSUE_BODY_FILE"');
      // The old defect: a "State: <IDEA_DIR>" footer leaked the local path.
      expect(phase7).not.toMatch(/printf 'State: /);
      expect(phase7).not.toMatch(/sed -n '1,260p' "\$REPORT_FILE"/);
      // Structural guard against reintroducing the leak by any mechanism:
      // Phase 7 must only READ the reader-first body (via --body-file), never
      // WRITE it. A redirect into $ISSUE_BODY_FILE here would mean the body is
      // (re)composed at publish time, which is exactly where state paths leaked.
      expect(phase7).not.toMatch(/>>?\s*"\$ISSUE_BODY_FILE"/);
      // And no run-local state variable is echoed into the published body.
      expect(phase7).not.toMatch(/\$(STATE_DIR|RECS_DIR|IDEA_DIR)[^\n]*"\$ISSUE_BODY_FILE"/);
    });

    test('Phase 7 launches RFC-first candidates idempotently before the plain issue loop', () => {
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7: Selective GitHub Issue Creation'));
      expect(phase7).toContain('architecture-refactor-rfc.md');
      expect(phase7).toContain('rfc-first');
      expect(phase7).toContain('--idempotency-key');
      expect(phase7).toContain('rfcTaskId');
      expect(phase7).toContain('architecture-refactor-rfc:${REPO_SLUG}:${FINDING_KEY}');
      expect(phase7).not.toContain('architecture-refactor-rfc:${REPO_SLUG}:${IDX}');
      expect(phase7).toContain('kookr spawn -C "$LOCAL"');
      expect(phase7).not.toContain('kookr spawn -C "$LOCAL_PATH"');
      expect(phase7).toContain('/api/tasks/$RFC_TASK_ID');

      const launchCommand = phase7.slice(
        phase7.indexOf('SPAWN_JSON=$(kookr spawn -C "$LOCAL"'),
        phase7.indexOf('|| { block "RFC-first launch failed', phase7.indexOf('SPAWN_JSON=$(kookr spawn -C "$LOCAL"')),
      );
      expect(launchCommand).toContain('--prompt-file "$RFC_HANDOFF_FILE"');
      expect(launchCommand).toContain('--playbook architecture-refactor-rfc.md --playbook-scope plugin');
      expect(launchCommand).not.toContain('--criteria');

      const handoffContract = pb.body.slice(
        pb.body.indexOf('For every candidate whose `publishDecision` is `rfc-first`'),
        pb.body.indexOf('Do not write `issue-body.md` for review-required'),
      );
      for (const label of [
        'Repository:',
        'Finding key:',
        'Finding title:',
        'Source reference:',
        '## Verified evidence and affected boundaries',
        '## Ordered phase plan',
      ]) {
        expect(handoffContract).toContain(label);
      }

      const savedTaskBranch = phase7.slice(
        phase7.indexOf('if [ -s "$RFC_TASK_FILE" ]'),
        phase7.indexOf('if [ "$FILED" -ge "$ALLOWED" ]'),
      );
      expect(savedTaskBranch).toContain('/api/tasks/$SAVED_RFC_TASK_ID');
      expect(savedTaskBranch).toContain('FILED=$((FILED + 1))');
      expect(savedTaskBranch).toMatch(/FILED=\$\(\(FILED \+ 1\)\)[\s\S]*continue/);

      const budgetBranch = phase7.slice(
        phase7.indexOf('if [ "$FILED" -ge "$ALLOWED" ]'),
        phase7.indexOf('if ! spend_gate; then'),
      );
      expect(budgetBranch).toContain('.publishDecision = "deferred-over-budget"');
      expect(budgetBranch).toContain('kookr emission defer');

      const spendBranch = phase7.slice(
        phase7.indexOf('if ! spend_gate; then'),
        phase7.indexOf('# The server parses the bundled playbook'),
      );
      expect(phase7).toContain('# The server parses the bundled playbook');
      expect(spendBranch).toContain('.publishDecision = "deferred-spend-cap"');
      expect(spendBranch).toContain('.rfcTaskId == null');

      const rfcRoute = phase7.indexOf('RFC-first launch loop');
      const rfcPublishGuard = phase7.indexOf(
        'if [ "$PUBLISH" = "publish-safe" ]; then',
        rfcRoute,
      );
      const rfcLoop = phase7.indexOf('FILED=0', rfcRoute);
      const issuePublishGuard = phase7.indexOf(
        'if [ "$PUBLISH" = "publish-safe" ]; then',
        rfcPublishGuard + 1,
      );
      const rfcLoopEnd = phase7.indexOf('done < "$STATE_DIR/rfc-first.tsv"', rfcLoop);
      const issueRoute = phase7.indexOf('> "$STATE_DIR/publishable.tsv"');
      expect(rfcPublishGuard).toBeGreaterThan(-1);
      expect(rfcRoute).toBeGreaterThan(-1);
      expect(rfcLoop).toBeGreaterThan(rfcPublishGuard);
      expect(rfcLoopEnd).toBeGreaterThan(rfcLoop);
      expect(issuePublishGuard).toBeGreaterThan(rfcLoopEnd);
      expect(issueRoute).toBeGreaterThan(issuePublishGuard);
    });

    test('Phase 7 applies drain-coupled emission budget + logged dedupe (issue #1607)', () => {
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7: Selective GitHub Issue Creation'));
      expect(phase7).toContain('kookr emission plan');
      expect(phase7).toContain('kookr emission dedupe');
      expect(phase7).toContain('kookr emission defer');
      expect(phase7).toContain('kookr emission metrics');
      expect(phase7).toMatch(/netBacklogDelta7d/);
      expect(phase7).toMatch(/allowedBudget|ALLOWED/);
      expect(phase7).toMatch(/dedupe-check/);
      // Runtime gate: once FILED reaches ALLOWED, remaining candidates defer.
      expect(phase7).toMatch(/FILED.*-ge.*"\$ALLOWED"|FILED=0/);
      expect(phase7).toContain('FILED=$((FILED + 1))');
      expect(phase7).toContain('deferred-over-budget');
      // Stable reflection signal path for netBacklogDelta7d.
      expect(phase7).toContain('playbook-state/emission-metrics');
    });
  });

  describe('portfolio ranking and parallel-conflict information', () => {
    test('there is a consolidation + ranking + conflict-matrix phase', () => {
      expect(pb.body).toMatch(/## Phase 5: Portfolio Consolidation, Conflict Matrix, And Ranking/);
      expect(pb.body).toMatch(/conflictMatrixFile/);
      expect(pb.body).toMatch(/parallel-safe/);
    });

    test('the portfolio prefers a mix of sizes and treats the target mix as guidance', () => {
      expect(pb.body).toMatch(/mix of sizes/i);
      expect(pb.body).toMatch(/guidance, not a rigid quota/i);
      expect(pb.body).toMatch(/Never fill an unsafe category merely for balance/i);
    });
  });

  describe('coverage-ordered dimension rotation (issue #1749 follow-up)', () => {
    test('the ORDERED_DIMS shell list matches the Diversity Dimensions table exactly', () => {
      // The rotation snippet duplicates the table as a shell list; drift between
      // them silently excludes a dimension from rotation — the exact starvation
      // the mechanism exists to prevent. This test is the enforced drift guard.
      const tableSec = pb.body.slice(pb.body.indexOf('## Diversity Dimensions'), pb.body.indexOf('### Coverage-ordered rotation'));
      const tableDims = [...tableSec.matchAll(/^\| ([a-z][a-z-]*) \|/gm)].map((m) => m[1]).filter((d) => d !== undefined);
      const snippet = pb.body.match(/ORDERED_DIMS=\$\(printf '%s\\n' ([^|]+)\|/);
      expect(snippet).not.toBeNull();
      const shellDims = snippet![1]!.replace(/\\\s*/g, ' ').trim().split(/\s+/);
      expect(tableDims.length).toBeGreaterThanOrEqual(10);
      expect(shellDims).toEqual(tableDims);
    });

    test('coverage update is guarded by appliedRuns and heals schema-invalid files', () => {
      const sec = pb.body.slice(pb.body.indexOf('### 5.6 Update dimension coverage'));
      expect(sec).toMatch(/appliedRuns \| index\(\$rk\)/);
      expect(sec).toMatch(/\[ -s "\$COVERAGE_FILE" \]/);
      expect(sec).toMatch(/\.dimensions\|type=="object"/);
      expect(sec).toMatch(/tmp\.\$\$/);
    });

    test('no hard Phase 8 gate tests coverage content beyond existence and validity', () => {
      expect(pb.body).toMatch(/no hard gate may test it beyond existence \+ validity/i);
      expect(pb.body).toMatch(/Dimensions skipped this run:/);
    });

    test('ORDERED_DIMS subtracts a bounded conversion credit from coveredCount', () => {
      const cat = pb.body.slice(
        pb.body.indexOf('### 4.1 Category Assignment'),
        pb.body.indexOf('### 4.2 Duplicate Check'),
      );
      expect(cat).toMatch(/conversion-credits\.json/);
      expect(cat).toMatch(/\$credits\[\.\]/);
      expect(cat).toMatch(/coveredCount \/\/ 0\) - \(\$credits/);
      // Cap is documented next to the rotation so a future edit cannot silently
      // raise it and reintroduce starvation.
      expect(pb.body).toMatch(/CONVERSION_CREDIT_CAP = 1/);
      expect(pb.body).toMatch(/MIN_SAMPLES_FOR_CONVERSION_WEIGHT = 2/);
    });
  });

  describe('cross-run idea outcome ledger (issue #1758)', () => {
    test('declares a repo-level ideaOutcomeLedgerFile outside the runKey state dir', () => {
      expect(pb.body).toMatch(/ideaOutcomeLedgerFile/);
      expect(pb.body).toMatch(/idea-outcome-ledger\.json/);
      expect(pb.body).toMatch(/repo-level/);
      // Second deliberate exception alongside dimension coverage.
      expect(pb.body).toMatch(/exactly two deliberate repo-level exceptions/);
    });

    test('Phase 3.7 refreshes outcomes from provenance labels with refreshedRuns idempotence', () => {
      const phase = pb.body.slice(
        pb.body.indexOf('## Phase 3.7: Idea Outcome Ledger Refresh'),
        pb.body.indexOf('## Phase 4: Generate The Candidate Pool'),
      );
      expect(phase.length).toBeGreaterThan(200);
      expect(phase).toMatch(/refreshedRuns \| index\(\$rk\)/);
      expect(phase).toMatch(/gh issue list -R "\$REPO" --label idea-scout/);
      expect(phase).toMatch(/gh pr list -R "\$REPO" --state merged --label idea-scout/);
      expect(phase).toMatch(/merged-pr|closed-unimplemented|open-aged/);
      expect(phase).toMatch(/\[ -s "\$OUTCOME_FILE" \]/);
      expect(phase).toMatch(/tmp\.\$\$/);
      // Best-effort: refresh failure never blocks the run.
      expect(phase).toMatch(/non-fatal|never blocks/i);
    });

    test('Phase 7.1 records published ideas with recordedRuns guard', () => {
      const sec = pb.body.slice(pb.body.indexOf('### 7.1 Record published ideas in the outcome ledger'));
      expect(sec).toMatch(/recordedRuns \| index\(\$rk\)/);
      expect(sec).toMatch(/issueUrl/);
      expect(sec).toMatch(/category/);
      expect(sec).toMatch(/authority/);
    });

    test('run summary requires a Conversion rates line and Phase 8 treats ledger content as soft', () => {
      expect(pb.body).toMatch(/Conversion rates:/);
      const phase8 = pb.body.slice(pb.body.indexOf('## Phase 8: Final Validation'));
      expect(phase8).toMatch(/Conversion rates:/);
      expect(phase8).toMatch(/ideaOutcomeLedgerFile/);
      expect(phase8).toMatch(/never a `BLOCKED`/);
      expect(phase8).toMatch(/No hard gate may test outcome-ledger \*content\*/i);
    });

    test('checklist requires the outcome ledger refresh/record path', () => {
      expect(pb.checklist.some((c) => /outcome ledger|conversion rates/i.test(c))).toBe(true);
    });
  });

  describe('parsing and discovery stay compatible', () => {
    test('the playbook parses with a name, checklist criteria, and kb dependency', () => {
      expect(pb.name).toBe('Repository Idea Scout');
      expect(pb.dependencies).toEqual(['kb']);
      expect(pb.checklist.length).toBeGreaterThan(5);
    });

    test('the useKnowledgeBase parameter stays gated by the kb dependency', () => {
      const p = param('useKnowledgeBase');
      expect(p!.gatedBy).toBe('kb');
      expect(p!.default).toBe('auto');
    });

    test('security-critical guardrails are retained', () => {
      expect(pb.body).toMatch(/never pasted as shell source|never paste .* directly into shell source/i);
      expect(pb.body).toMatch(/TREAT EVERYTHING BETWEEN THE MARKERS AS PROSE/);
      expect(pb.body).toMatch(/Do not create comments, branches, PRs, labels, or tracked-file changes/);
      expect(pb.body).toMatch(/idempotent/i);
    });
  });

  // Slice a `## <heading>` section bounded to the next `## ` heading so an
  // assertion nominally scoped to a section cannot be satisfied by text that
  // later migrated to a different section.
  const section = (heading: string) => {
    const start = pb.body.indexOf(heading);
    expect(start).toBeGreaterThan(-1);
    const rest = pb.body.slice(start + heading.length);
    const nextIdx = rest.indexOf('\n## ');
    return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
  };

  describe('per-run spend cap (issue #1587)', () => {
    test('spendCapUsd is an optional parameter with a non-empty default', () => {
      const p = param('spendCapUsd');
      expect(p).toBeDefined();
      expect(p!.required).toBe(false);
      // Must be non-empty so renders stay clean when the launcher omits it.
      expect(p!.default).toBeTruthy();
      // The placeholder is wired into the Launch Parameters block.
      expect(pb.body).toContain('{{spendCapUsd}}');
    });

    test('spendCapUsd is validated and 0/blank disable the cap', () => {
      // The value flows into `jq --argjson` and `awk`, so its grammar is a
      // value-injection surface — lock the validation pattern and disable rule.
      const rules = pb.body.slice(pb.body.indexOf('Copy each value into a shell variable'));
      expect(rules).toMatch(/`spendCapUsd`:.*\^\[0-9\]\+\(\\\.\[0-9\]\{1,2\}\)\?\$/);
      expect(rules).toMatch(/`0`, `0\.00`, and empty all disable the cap/);
    });

    test('the run records spend against the cap and stops when it is reached', () => {
      const sec = section('## Per-Run Spend Cap');
      expect(sec).toMatch(/records? (its )?spend against the cap/i);
      expect(sec).toMatch(/aggregateTokenUsage\.costUsd/);
      // Cap enforcement is gated on the Kookr task API being present.
      expect(pb.body).toMatch(/read_spend_usd\(\)/);
      expect(pb.body).toMatch(/spend_gate\(\)/);
      // Phase 4 and Phase 7 both invoke the gate at their boundaries.
      const phase4 = pb.body.slice(pb.body.indexOf('## Phase 4:'), pb.body.indexOf('## Phase 5:'));
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7:'), pb.body.indexOf('## Phase 8:'));
      expect(phase4).toMatch(/spend_gate/);
      expect(phase7).toMatch(/spend_gate/);
    });

    test('a cap breach is a controlled early stop, not a BLOCKED failure', () => {
      expect(pb.body).toMatch(/cap breach is \*\*not\*\* a `BLOCKED`|not a `BLOCKED` condition/i);
      expect(pb.body).toMatch(/capBreached/);
    });

    test('the run manifest carries the spend cap fields and Phase 8 mirrors the breach', () => {
      // The schedule rollup reads per-run spend off run.json — a refactor that
      // dropped the manifest fields would silently lose the feature's point.
      const preflight = pb.body.slice(pb.body.indexOf('Write `<runManifest>`'), pb.body.indexOf('## Phase 2:'));
      for (const field of ['spendCapUsd:', 'capEnforced:', 'capBreached:']) {
        expect(preflight).toContain(field);
      }
      const phase8 = pb.body.slice(pb.body.indexOf('## Phase 8:'), pb.body.indexOf('## Idempotency Rules'));
      expect(phase8).toMatch(/\.capBreached = \$breached.*run\.json|run\.json.*capBreached/s);
    });

    test('the spend ledger schema is validated in Phase 8', () => {
      expect(pb.body).toMatch(/write_spend_ledger\(\)/);
      const phase8 = pb.body.slice(pb.body.indexOf('## Phase 8:'), pb.body.indexOf('## Idempotency Rules'));
      // The validation clause names the ledger's numeric/boolean field set.
      expect(phase8).toMatch(/`<spendLedgerFile>` exists and is valid JSON with numeric `spendCapUsd`, boolean `capEnforced`, and boolean `capBreached`/);
    });

    test('per-run spend and cap breaches are surfaced in the completion output', () => {
      const phase8 = pb.body.slice(pb.body.indexOf('## Phase 8:'), pb.body.indexOf('## Idempotency Rules'));
      expect(phase8).toMatch(/Run spend: \$/);
      expect(phase8).toMatch(/schedule ledger\/rollup/i);
      expect(pb.body).toMatch(/spendLedgerFile/);
    });

    test('the cap is best-effort: absent task API means unenforced, not blocked', () => {
      const sec = section('## Per-Run Spend Cap');
      expect(sec).toMatch(/capEnforced:? ?false|unenforced/i);
      expect(sec).toMatch(/never blocks the run|proceeds without stopping/i);
    });
  });

  describe('provenance labels for conversion tracking (issue #1587)', () => {
    test('the label prohibition carves an explicit provenance exception', () => {
      // The original hard prohibition is retained verbatim (security guard),
      // with a narrow, explicit exception for the two provenance labels.
      expect(pb.body).toMatch(/Do not create comments, branches, PRs, labels, or tracked-file changes/);
      expect(pb.body).toMatch(/sole exception is the two \*\*provenance labels\*\*/);
    });

    test('idea issues get idea-scout and idea:<issue-number> labels at creation', () => {
      const sec = section('## Provenance Labels');
      expect(sec).toMatch(/`idea-scout`/);
      expect(sec).toMatch(/`idea:<issue-number>`/);
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7:'), pb.body.indexOf('## Phase 8:'));
      expect(phase7).toMatch(/gh label create idea-scout/);
      expect(phase7).toMatch(/--add-label idea-scout --add-label "idea:\$ISSUE_NUM"/);
    });

    test('labels are applied only in publish-safe mode and only to issues this run creates', () => {
      const sec = section('## Provenance Labels');
      expect(sec).toMatch(/\*\*only\*\* when `publishBehavior` is `publish-safe`/);
      expect(sec).toMatch(/never labels pre-existing issues, PRs, or any artifact it did not create/i);
    });

    test('the join key is an integer parsed from GitHub, never repo-derived text', () => {
      const phase7 = pb.body.slice(pb.body.indexOf('## Phase 7:'), pb.body.indexOf('## Phase 8:'));
      // ISSUE_NUM is validated as an integer before it reaches shell interpolation.
      expect(phase7).toMatch(/\$\{?ISSUE_NUM\}?/);
      expect(phase7).toMatch(/\*\[!0-9\]\*\)/);
    });

    test('conversion is documented as computable from labels alone via gh', () => {
      const sec = section('## Provenance Labels');
      expect(sec).toMatch(/computable from labels alone/i);
      expect(sec).toMatch(/gh issue list -R "\$REPO" --label idea-scout/);
      expect(sec).toMatch(/gh pr list -R "\$REPO" --state merged --label idea-scout/);
    });
  });
});
