import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The hook-side classifier this module cannot import (it is an ES module under plugin/); used for a parity check only.
import { classifyShelf } from '../../plugin/hooks/lib/notebook-layers.mjs';
import {
  REVIEWER_FANOUT_LAUNCH_MARKER,
  REVIEWER_FANOUT_SCHEMA_VERSION,
  REVIEWER_NOTEBOOK_ROLE_BASE,
  deserializeReviewerFanoutWorkflow,
  isReviewerFanoutLaunch,
  reviewerNotebookLayers,
  reviewerNotebookRole,
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

  test('carries a provided notebook role, and omits the field when none is given', () => {
    const scoped = createReviewerFanoutWorkflow({
      roles: ['correctness'],
      diffScope,
      notebookRole: 'code-review@owner-repo',
    });
    expect(scoped.notebookRole).toBe('code-review@owner-repo');

    const bare = createReviewerFanoutWorkflow({ roles: ['correctness'], diffScope });
    expect('notebookRole' in bare).toBe(false);
  });
});

describe('reviewerNotebookRole', () => {
  test('scopes by slug when one is usable, else the global base', () => {
    expect(reviewerNotebookRole('kookr-ai-kookr')).toBe('code-review@kookr-ai-kookr');
    expect(reviewerNotebookRole()).toBe(REVIEWER_NOTEBOOK_ROLE_BASE);
    expect(reviewerNotebookRole('')).toBe(REVIEWER_NOTEBOOK_ROLE_BASE);
    expect(reviewerNotebookRole(null)).toBe(REVIEWER_NOTEBOOK_ROLE_BASE);
  });

  test('flattens an unsafe slug to the notebook role charset (never a traversal)', () => {
    expect(reviewerNotebookRole('Owner/Repo')).toBe('code-review@owner-repo');
    expect(reviewerNotebookRole('../evil')).toBe('code-review@evil');
    expect(reviewerNotebookRole('--x--')).toBe('code-review@x');
    // Interior `..` is collapsed to a single dot (pins the `.{2,}` step, which
    // the leading/trailing strips alone do not exercise).
    expect(reviewerNotebookRole('a..b')).toBe('code-review@a.b');
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

  test('inlines the workflow notebook role and tags the lens', () => {
    const scoped = createReviewerFanoutWorkflow({
      roles: ['correctness'],
      diffScope,
      notebookRole: 'code-review@owner-repo',
    });
    const launch = buildSpecialistLaunch(scoped, scoped.specialists[0], loader({}));
    expect(launch.prompt).toContain('Notebook shelf: code-review@owner-repo');
    expect(launch.prompt).toContain('nb show code-review@owner-repo');
    expect(launch.prompt).toContain('(correctness)'); // lens tag
    expect(launch.prompt).toContain('nb show code-review`'); // the domain layer too
  });

  test('falls back to the domain code-review shelf when the workflow has none', () => {
    const launch = buildSpecialistLaunch(wf, wf.specialists[0], loader({}));
    expect(launch.prompt).toContain(`Notebook shelf: ${REVIEWER_NOTEBOOK_ROLE_BASE}`);
    expect(launch.prompt).not.toContain('code-review@');
  });
});

describe('reviewerNotebookLayers', () => {
  test('splits a project shelf into its domain and project layers', () => {
    expect(reviewerNotebookLayers('code-review@owner-repo')).toEqual({
      domain: 'code-review',
      project: 'code-review@owner-repo',
    });
  });

  test('a bare shelf, or a name with an empty side of the @, has no project layer', () => {
    expect(reviewerNotebookLayers('code-review')).toEqual({ domain: 'code-review' });
    expect(reviewerNotebookLayers('code-review@')).toEqual({ domain: 'code-review@' });
    expect(reviewerNotebookLayers('@owner-repo')).toEqual({ domain: '@owner-repo' });
    expect(reviewerNotebookLayers('code-review@ ')).toEqual({ domain: 'code-review@ ' }); // blank slug, as in classifyShelf
  });

  test('splits on the LAST @, as the hook classifier does', () => {
    expect(reviewerNotebookLayers('a@b@slug')).toEqual({ domain: 'a@b', project: 'a@b@slug' });
  });

  test.each(['code-review', 'code-review@owner-repo', 'a@b@slug', 'x@', '@x', 'x@ ', 'plain', 'Code-Review@Kookr-AI-Kookr'])(
    'agrees with plugin/hooks/lib/notebook-layers.mjs classifyShelf on %j',
    (name) => {
      const hook = classifyShelf(name);
      const here = reviewerNotebookLayers(name);
      if (hook.layer === 'project') {
        expect(here).toEqual({ domain: hook.base, project: name });
      } else {
        // domain or malformed: this module has no project layer and keeps the whole name.
        expect(here.project).toBeUndefined();
        expect(here.domain).toBe(name);
      }
    },
  );
});

describe('specialist launch: both notebook layers', () => {
  const lineOf = (prompt: string): string => prompt.split('\n').find((l) => l.startsWith('Notebook shelf:')) ?? '';
  const launchFor = (slug?: string | null) => {
    const wf = createReviewerFanoutWorkflow({
      roles: ['correctness'],
      diffScope,
      ...(slug === undefined ? {} : { notebookRole: reviewerNotebookRole(slug) }),
    });
    return buildSpecialistLaunch(wf, wf.specialists[0], loader({ 'correctness-specialist.md': 'BODY {repoDir}' }));
  };

  test('slug set: names the project and the domain shelf, domain read first', () => {
    const line = lineOf(launchFor('owner-repo').prompt);
    expect(line).toContain('code-review@owner-repo (project layer)');
    expect(line).toContain('code-review (domain layer)');
    expect(line).toMatch(/`nb show code-review` then `nb show code-review@owner-repo`/);
    expect(line).toContain('Notebook Protocol');
    expect(line).toContain('lens (correctness)');
  });

  test('slug unset: names the domain shelf alone and never builds a name ending in @', () => {
    for (const unset of [undefined, null, '', '   ']) {
      const line = lineOf(launchFor(unset).prompt);
      expect(line).toContain('Notebook shelf: code-review (domain layer only');
      expect(line).toMatch(/`nb show code-review`/);
      expect(line).not.toContain('@');
      expect(line).not.toContain('project layer');
    }
  });

  test('the header points at the shared protocol and restates no placement, cap or eviction rule', () => {
    for (const slug of ['owner-repo', undefined]) {
      const line = lineOf(launchFor(slug).prompt);
      expect(line).not.toMatch(/\d+[\s-]*char|[\u2264<]=?\s*\d|evict|fleet-global|narrowest|unless/i);
    }
  });

  test('keeps the launch shape existing callers rely on', () => {
    const launch = launchFor('owner-repo');
    expect(Object.keys(launch).sort()).toEqual(['label', 'machineEvent', 'prompt', 'role']);
    expect(launch.role).toBe('correctness');
    expect(launch.label).toBe('review_correctness');
    expect(launch.machineEvent).toBe(true);
    expect(isReviewerFanoutLaunch(launch.prompt)).toBe(true);
    const lines = launch.prompt.split('\n');
    expect(lines[0]).toBe(`${REVIEWER_FANOUT_LAUNCH_MARKER} role=correctness workflow=reviewer-fanout:feat/x`);
    expect(lines[1]).toBe('Repo: /repo/worktree');
    expect(lines[2]).toBe('Diff scope: origin/main..feat/x (2 changed file(s))');
    expect(lines[3]).toMatch(/^Notebook shelf: /);
    // The header is still exactly four lines, then a blank line, then the body.
    expect(lines[4]).toBe('');
    expect(lines.slice(5).join('\n')).toBe('BODY /repo/worktree');
  });

  test('the workflow still serializes with a single notebookRole string (no schema change)', () => {
    const wf = createReviewerFanoutWorkflow({ roles: ['correctness'], diffScope, notebookRole: 'code-review@owner-repo' });
    expect(wf.notebookRole).toBe('code-review@owner-repo');
    expect(wf.schemaVersion).toBe(REVIEWER_FANOUT_SCHEMA_VERSION);
    expect(deserializeReviewerFanoutWorkflow(serializeReviewerFanoutWorkflow(wf))).toEqual(wf);
  });

  describe('against a real store whose project shelf does not exist yet', () => {
    test('both reads the header names succeed (exit 0), the missing one is told so, and nothing is created', () => {
      const dir = mkdtempSync(join(tmpdir(), 'fanout-nb-'));
      try {
        const env = { PATH: process.env.PATH, HOME: process.env.HOME, NB_DIR: dir, NB_GIT_AUTOCOMMIT: '0' };
        const nb = (args: string[]) =>
          spawnSync('node', [join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'nb.js'), ...args], { env, encoding: 'utf-8' });
        expect(nb(['add', 'code-review', 'throwaway domain lesson for the test']).status).toBe(0);
        const before = readdirSync(dir).sort();

        const line = lineOf(launchFor('owner-repo').prompt);
        const shelves = [...line.matchAll(/`nb show ([^`]+)`/g)].map((m) => m[1]);
        expect(shelves).toEqual(['code-review', 'code-review@owner-repo']);

        const domain = nb(['show', shelves[0]]);
        expect(domain.status).toBe(0);
        expect(domain.stdout).toContain('throwaway domain lesson');
        const project = nb(['show', shelves[1]]);
        expect(project.status).toBe(0);
        expect(project.stdout + project.stderr).toContain('no notebook for shelf "code-review@owner-repo"');
        // A read of a missing shelf must not create the file.
        expect(readdirSync(dir).sort()).toEqual(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
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
