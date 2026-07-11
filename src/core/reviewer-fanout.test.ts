import { describe, expect, test } from 'vitest';
import {
  REVIEWER_FANOUT_LAUNCH_MARKER,
  REVIEWER_FANOUT_SCHEMA_VERSION,
  deserializeReviewerFanoutWorkflow,
  isReviewerFanoutLaunch,
  serializeReviewerFanoutWorkflow,
  type ReviewerDiffScope,
  type ReviewerFanoutWorkflow,
} from '../shared/contracts/reviewer-fanout.js';
import {
  aggregateReviewerRuns,
  buildSpecialistLaunch,
  buildSpecialistLaunches,
  createReviewerFanoutWorkflow,
  deriveWorkflowStatus,
  instructionSources,
  parseSpecialistSelection,
} from './reviewer-fanout.js';

const diffScope: ReviewerDiffScope = {
  repoDir: '/repo/worktree',
  baseRef: 'origin/main',
  headRef: 'feat/x',
  changedFiles: ['src/a.ts', 'src/b.ts'],
};

function loader(bodies: Record<string, string>): (file: string) => string {
  return (file) => bodies[file] ?? `BODY(${file}) reviewing {repoDir}`;
}

describe('createReviewerFanoutWorkflow', () => {
  test('builds a pending workflow with pending specialists and derived id', () => {
    const wf = createReviewerFanoutWorkflow({
      roles: ['correctness', 'lint-like', 'test'],
      diffScope,
      pr: { branch: 'feat/x' },
      docsDrift: 'inactive',
    });

    expect(wf.schemaVersion).toBe(REVIEWER_FANOUT_SCHEMA_VERSION);
    expect(wf.id).toBe('reviewer-fanout:feat/x');
    expect(wf.status).toBe('pending');
    expect(wf.specialists.map((s) => s.role)).toEqual(['correctness', 'lint-like', 'test']);
    expect(wf.specialists.every((s) => s.status === 'pending')).toBe(true);
  });

  test('drops duplicate roles so the panel is a set', () => {
    const wf = createReviewerFanoutWorkflow({
      roles: ['correctness', 'correctness', 'test'],
      diffScope,
    });
    expect(wf.specialists.map((s) => s.role)).toEqual(['correctness', 'test']);
  });

  test('lint-like includes docs-drift sources only when docs-drift is active', () => {
    expect(instructionSources('lint-like', false)).toEqual([
      'conventions-specialist.md',
      'deadcode-specialist.md',
    ]);
    expect(instructionSources('lint-like', true)).toEqual([
      'conventions-specialist.md',
      'deadcode-specialist.md',
      'docs-drift-specialist.md',
    ]);
  });
});

describe('workflow serialization', () => {
  test('round-trips through serialize/deserialize', () => {
    const wf = createReviewerFanoutWorkflow({
      roles: ['correctness', 'test'],
      diffScope,
      pr: { number: 42, branch: 'feat/x' },
      force: true,
      docsDrift: 'active',
    });
    const restored = deserializeReviewerFanoutWorkflow(serializeReviewerFanoutWorkflow(wf));
    expect(restored).toEqual(wf);
  });

  test('always stamps the current schema version', () => {
    const wf = createReviewerFanoutWorkflow({ roles: ['correctness'], diffScope });
    const tampered = { ...wf, schemaVersion: 999 };
    const json = serializeReviewerFanoutWorkflow(tampered as ReviewerFanoutWorkflow);
    expect(JSON.parse(json).schemaVersion).toBe(REVIEWER_FANOUT_SCHEMA_VERSION);
  });

  test('rejects malformed JSON', () => {
    expect(() => deserializeReviewerFanoutWorkflow('{not json')).toThrow(/not valid JSON/);
  });

  test('rejects non-object payloads', () => {
    expect(() => deserializeReviewerFanoutWorkflow('[1,2,3]')).toThrow(/expected a JSON object/);
  });

  test('rejects an unsupported schema version', () => {
    const bad = JSON.stringify({ schemaVersion: 2, specialists: [] });
    expect(() => deserializeReviewerFanoutWorkflow(bad)).toThrow(/unsupported schemaVersion 2/);
  });

  test('rejects a missing specialists array', () => {
    const bad = JSON.stringify({ schemaVersion: REVIEWER_FANOUT_SCHEMA_VERSION });
    expect(() => deserializeReviewerFanoutWorkflow(bad)).toThrow(/"specialists" must be an array/);
  });

  test('rejects a half-built object missing diffScope', () => {
    const bad = JSON.stringify({ schemaVersion: REVIEWER_FANOUT_SCHEMA_VERSION, specialists: [], id: 'x' });
    expect(() => deserializeReviewerFanoutWorkflow(bad)).toThrow(/"diffScope" is required/);
  });

  test('rejects a half-built object missing id', () => {
    const bad = JSON.stringify({
      schemaVersion: REVIEWER_FANOUT_SCHEMA_VERSION,
      specialists: [],
      diffScope,
    });
    expect(() => deserializeReviewerFanoutWorkflow(bad)).toThrow(/"id" is required/);
  });
});

describe('buildSpecialistLaunch', () => {
  const wf = createReviewerFanoutWorkflow({
    roles: ['correctness', 'lint-like'],
    diffScope,
    docsDrift: 'active',
  });

  test('prefixes the machine-event marker and inlines repo/diff scope', () => {
    const load = loader({ 'correctness-specialist.md': 'Find bugs in {repoDir}.' });
    const launch = buildSpecialistLaunch(wf, wf.specialists[0], load);

    expect(launch.machineEvent).toBe(true);
    expect(launch.label).toBe('review_correctness');
    expect(isReviewerFanoutLaunch(launch.prompt)).toBe(true);
    expect(launch.prompt.split('\n', 1)[0]).toContain(REVIEWER_FANOUT_LAUNCH_MARKER);
    expect(launch.prompt).toContain('role=correctness');
    expect(launch.prompt).toContain('origin/main..feat/x (2 changed file(s))');
    // {repoDir} is substituted, specialist body preserved verbatim otherwise.
    expect(launch.prompt).toContain('Find bugs in /repo/worktree.');
    expect(launch.prompt).not.toContain('{repoDir}');
  });

  test('composes multiple instruction sources for the consolidated reviewer', () => {
    const load = loader({
      'conventions-specialist.md': 'CONVENTIONS body',
      'deadcode-specialist.md': 'DEADCODE body',
      'docs-drift-specialist.md': 'DOCS body',
    });
    const lintLike = wf.specialists.find((s) => s.role === 'lint-like')!;
    const launch = buildSpecialistLaunch(wf, lintLike, load);
    expect(launch.prompt).toContain('CONVENTIONS body');
    expect(launch.prompt).toContain('DEADCODE body');
    expect(launch.prompt).toContain('DOCS body');
    expect(launch.label).toBe('review_lint_like');
  });

  test('buildSpecialistLaunches covers every specialist', () => {
    const launches = buildSpecialistLaunches(wf, loader({}));
    expect(launches.map((l) => l.role)).toEqual(['correctness', 'lint-like']);
    expect(launches.every((l) => isReviewerFanoutLaunch(l.prompt))).toBe(true);
  });
});

describe('aggregateReviewerRuns', () => {
  test('rolls per-specialist runs into one parent-visible result', () => {
    const wf = createReviewerFanoutWorkflow({
      roles: ['correctness', 'lint-like', 'test', 'a11y'],
      diffScope,
    });
    wf.specialists[0] = {
      ...wf.specialists[0],
      status: 'completed',
      findings: [
        { severity: 'blocking', comment: 'null deref', file: 'src/a.ts' },
        { severity: 'suggestion', comment: 'simplify' },
      ],
    };
    wf.specialists[1] = { ...wf.specialists[1], status: 'completed', findings: [] };
    wf.specialists[2] = {
      ...wf.specialists[2],
      status: 'completed',
      findings: [{ severity: 'info', comment: 'note' }],
    };
    wf.specialists[3] = { ...wf.specialists[3], status: 'failed', error: 'agent crashed' };

    const agg = aggregateReviewerRuns(wf);
    expect(agg.workflowId).toBe(wf.id);
    expect(agg.status).toBe('failed');
    expect(agg.rolesRun).toEqual(['correctness', 'lint-like', 'test', 'a11y']);
    expect(agg.blockerCount).toBe(1);
    expect(agg.suggestionCount).toBe(1);
    expect(agg.infoCount).toBe(1);
    expect(agg.noFindingRoles).toEqual(['lint-like']);
    expect(agg.failedRoles).toEqual([{ role: 'a11y', error: 'agent crashed' }]);
    expect(agg.findings).toContainEqual({
      severity: 'blocking',
      comment: 'null deref',
      file: 'src/a.ts',
      role: 'correctness',
    });
    expect(agg.summary).toContain('1 blocker(s)');
  });

  test('ignores still-pending and skipped runs', () => {
    const wf = createReviewerFanoutWorkflow({ roles: ['correctness', 'test'], diffScope });
    wf.specialists[0] = { ...wf.specialists[0], status: 'completed', findings: [] };
    wf.specialists[1] = { ...wf.specialists[1], status: 'skipped' };
    const agg = aggregateReviewerRuns(wf);
    expect(agg.rolesRun).toEqual(['correctness']);
    expect(agg.status).toBe('completed');
  });
});

describe('deriveWorkflowStatus', () => {
  test('failed dominates', () => {
    expect(
      deriveWorkflowStatus([
        { role: 'correctness', instructionSources: [], status: 'completed', findings: [] },
        { role: 'test', instructionSources: [], status: 'failed', findings: [] },
      ]),
    ).toBe('failed');
  });

  test('running while any is unfinished', () => {
    expect(
      deriveWorkflowStatus([
        { role: 'correctness', instructionSources: [], status: 'completed', findings: [] },
        { role: 'test', instructionSources: [], status: 'pending', findings: [] },
      ]),
    ).toBe('running');
  });

  test('empty panel is pending', () => {
    expect(deriveWorkflowStatus([])).toBe('pending');
  });
});

describe('parseSpecialistSelection', () => {
  test('parses the select-specialists.sh machine-readable block', () => {
    const out = [
      'SPECIALISTS=correctness,lint-like,test',
      'DOCS_DRIFT=active',
      'FORCE=no',
      'COUNT=3',
      'rationale:',
      '  correctness: always',
    ].join('\n');
    expect(parseSpecialistSelection(out)).toEqual({
      roles: ['correctness', 'lint-like', 'test'],
      force: false,
      docsDrift: 'active',
    });
  });

  test('honors the force escape hatch and drops unknown roles', () => {
    const out = 'SPECIALISTS=correctness,bogus,test\nFORCE=yes\nDOCS_DRIFT=inactive\n';
    expect(parseSpecialistSelection(out)).toEqual({
      roles: ['correctness', 'test'],
      force: true,
      docsDrift: 'inactive',
    });
  });
});

describe('isReviewerFanoutLaunch', () => {
  test('true only when the marker leads the first line', () => {
    expect(isReviewerFanoutLaunch(`${REVIEWER_FANOUT_LAUNCH_MARKER} role=test\nbody`)).toBe(true);
    expect(isReviewerFanoutLaunch('You are the test-specialist reviewer')).toBe(false);
    // A marker buried mid-body (e.g. quoted by a human) is not a launch.
    expect(isReviewerFanoutLaunch(`please look at\n${REVIEWER_FANOUT_LAUNCH_MARKER}`)).toBe(false);
  });
});
