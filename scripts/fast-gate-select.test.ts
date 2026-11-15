import { describe, expect, it } from 'vitest';
import { CAP_TESTS, buildTestCounter, hookTestsFor, referenceNeedles, selectFastGate } from './fast-gate-select.mjs';

const TRACKED = [
  'src/frontend/design-tokens.test.ts',
  'src/frontend/app.css',
  'scripts/validate-skills.test.ts',
  'scripts/validate-playbooks.test.ts',
  'scripts/lane-parity.test.ts',
  'plugin/skills/disk-reclaim/SKILL.md',
  'plugin/skills/disk-reclaim/scripts/disk-reclaim.test.mjs',
  'plugin/skills/token-efficiency/SKILL.md',
  'plugin/hooks/delivery-step-stop.test.mjs',
  'plugin/agents/reviewer.test.mjs',
  'plugin/playbooks/nightly.test.mjs',
  '.claude/skills/demo-skill/helper.test.mjs',
  'hooks/pr-workflow-gate.sh',
  '.hooks/pre-push',
  '.claude/hooks-tests/pr-workflow-gate.test.sh',
  '.claude/hooks-tests/pr-workflow-gate-worktree-key.test.sh',
  '.claude/hooks-tests/pre-push-fast-gate.test.sh',
  '.claude/hooks-tests/pre-push-git-env.test.sh',
  '.claude/hooks-tests/verify-script.test.sh',
  '.claude/hooks-tests/shims/gh',
];

type RunOpts = {
  gone?: string[];
  refs?: Record<string, string[]>;
  hookRefs?: Record<string, string[]>;
  tracked?: string[];
  countTests?: (files: string[]) => number;
};

function run(changed: string[], opts: RunOpts = {}) {
  const gone = new Set(opts.gone ?? []);
  const lookups: string[][] = [];
  const result = selectFastGate({
    changed,
    exists: (p: string) => !gone.has(p),
    findReferences: (needles: string[]) => {
      lookups.push(needles);
      return [...new Set(needles.flatMap((n) => opts.refs?.[n] ?? []))];
    },
    findHookTestReferences: (needles: string[]) => [...new Set(needles.flatMap((n) => opts.hookRefs?.[n] ?? []))],
    tracked: opts.tracked ?? TRACKED,
    countTests: opts.countTests,
  });
  return { result, lookups };
}

describe('selectFastGate', () => {
  it('sends existing TS/JS files to related and skips reference search for them', () => {
    const { result, lookups } = run(['src/a.ts', 'src/b.tsx', 'x/c.mts', 'x/d.mjs', 'bin/e.js', 'bin/f.cjs']);
    expect(result.related).toEqual(['bin/e.js', 'bin/f.cjs', 'src/a.ts', 'src/b.tsx', 'x/c.mts', 'x/d.mjs']);
    expect(result.tests).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it('ignores deleted TS files', () => {
    const { result } = run(['src/gone.ts', 'src/kept.ts'], { gone: ['src/gone.ts'] });
    expect(result.related).toEqual(['src/kept.ts']);
    expect(result.unmapped).toEqual([]);
  });

  it('puts a changed test file into related so it runs itself', () => {
    expect(run(['src/a.test.ts']).result.related).toEqual(['src/a.test.ts']);
  });

  it('splits reference hits into tests and related sources', () => {
    const { result } = run(['docs/guides/launch-checklist.yaml'], {
      refs: { 'docs/guides/launch-checklist.yaml': ['src/loader.ts', 'src/loader.test.ts'] },
    });
    expect(result.related).toEqual(['src/loader.ts']);
    expect(result.tests).toEqual(['src/loader.test.ts']);
    expect(result.unmapped).toEqual([]);
  });

  it('looks up a deleted non-code file by its old path', () => {
    const { result, lookups } = run(['templates/old-template.yaml'], {
      gone: ['templates/old-template.yaml'],
      refs: { 'templates/old-template.yaml': ['src/t.test.ts'] },
    });
    expect(lookups[0]).toContain('templates/old-template.yaml');
    expect(result.tests).toEqual(['src/t.test.ts']);
  });

  it('never lists the changed file as its own reference', () => {
    const { result } = run(['scripts/x.json'], { refs: { 'scripts/x.json': ['scripts/x.json'] } });
    expect(result.related).toEqual([]);
    expect(result.unmapped).toEqual(['scripts/x.json']);
  });

  it('reports an unmapped non-TS file with no rule and no hit', () => {
    expect(run(['assets/logo.svg']).result.unmapped).toEqual(['assets/logo.svg']);
  });

  it('runs a hook change\'s own suites (<name>.test.sh and <name>-*.test.sh), not the whole lane', () => {
    const { result } = run(['hooks/pr-workflow-gate.sh']);
    expect(result.hookTests).toEqual([
      '.claude/hooks-tests/pr-workflow-gate-worktree-key.test.sh',
      '.claude/hooks-tests/pr-workflow-gate.test.sh',
    ]);
    expect(result.commands).toEqual([]);
    expect(result.tests).toEqual([]);
    expect(result.unmapped).toEqual([]);
  });

  it('adds the hook suites that mention the changed file by path', () => {
    const { result } = run(['.hooks/pre-push'], {
      hookRefs: { '.hooks/pre-push': ['.claude/hooks-tests/verify-script.test.sh', 'scripts/not-a-hook-test.sh'] },
    });
    expect(result.hookTests).toEqual([
      '.claude/hooks-tests/pre-push-fast-gate.test.sh',
      '.claude/hooks-tests/pre-push-git-env.test.sh',
      '.claude/hooks-tests/verify-script.test.sh',
    ]);
    expect(result.commands).toEqual([]);
  });

  it('runs a changed hook suite itself', () => {
    const { result } = run(['.claude/hooks-tests/verify-script.test.sh']);
    expect(result.hookTests).toEqual(['.claude/hooks-tests/verify-script.test.sh']);
    expect(result.commands).toEqual([]);
  });

  it('runs the whole hook lane only when the runner or a shared helper changes', () => {
    for (const path of ['scripts/run-hook-tests.sh', 'scripts/lib/repo-slug.sh', '.claude/hooks-tests/shims/gh', '.claude/hooks-tests/fixtures/open-issue/x.json', 'plugin/hooks/lib/notebook-layers.mjs']) {
      expect(run([path]).result.commands, path).toEqual(['pnpm test:hooks']);
    }
    expect(run(['scripts/foo.sh']).result.commands).toEqual([]);
  });

  it('logs a shell file with no suite of its own and no reference as unmapped', () => {
    const { result } = run(['scripts/foo.sh']);
    expect(result.hookTests).toEqual([]);
    expect(result.unmapped).toEqual(['scripts/foo.sh']);
  });

  it('never sends a hook suite to the Vitest lists', () => {
    const { result } = run(['hooks/pr-workflow-gate.sh'], {
      refs: { 'hooks/pr-workflow-gate.sh': ['src/pr-gate.test.ts'] },
    });
    expect(result.tests).toEqual(['src/pr-gate.test.ts']);
    expect([...result.related, ...result.tests].some((f) => f.endsWith('.test.sh'))).toBe(false);
  });

  it('maps stt/** to the stt lane', () => {
    expect(run(['stt/Dockerfile']).result.commands).toEqual(['pnpm test:stt']);
  });

  it('maps CSS to the design-token tests', () => {
    const { result } = run(['src/frontend/app.css']);
    expect(result.tests).toEqual(['src/frontend/design-tokens.test.ts']);
  });

  it('maps a skill file to its own tests plus the validators', () => {
    const { result } = run(['plugin/skills/disk-reclaim/SKILL.md']);
    expect(result.tests).toEqual([
      'plugin/skills/disk-reclaim/scripts/disk-reclaim.test.mjs',
      'scripts/validate-playbooks.test.ts',
      'scripts/validate-skills.test.ts',
    ]);
  });

  it('maps a skill with no tests of its own to the validators only', () => {
    const { result } = run(['plugin/skills/token-efficiency/SKILL.md']);
    expect(result.tests).toEqual(['scripts/validate-playbooks.test.ts', 'scripts/validate-skills.test.ts']);
  });

  const VALIDATORS = ['scripts/validate-playbooks.test.ts', 'scripts/validate-skills.test.ts'];

  it('maps plugin/agents/** to its own tests plus the validators', () => {
    const { result } = run(['plugin/agents/reviewer.md']);
    expect(result.tests).toEqual(['plugin/agents/reviewer.test.mjs', ...VALIDATORS]);
    expect(result.commands).toEqual([]);
    expect(result.unmapped).toEqual([]);
  });

  it('maps plugin/hooks/** to its own tests and the validators', () => {
    const { result } = run(['plugin/hooks/delivery-step-stop.mjs']);
    expect(result.related).toEqual(['plugin/hooks/delivery-step-stop.mjs']);
    expect(result.tests).toEqual(['plugin/hooks/delivery-step-stop.test.mjs', ...VALIDATORS]);
    expect(result.commands).toEqual([]);
    expect(result.unmapped).toEqual([]);
  });

  it('maps plugin/playbooks/** to its own tests plus the validators', () => {
    const { result } = run(['plugin/playbooks/nightly.md']);
    expect(result.tests).toEqual(['plugin/playbooks/nightly.test.mjs', ...VALIDATORS]);
    expect(result.commands).toEqual([]);
  });

  it('maps .claude/skills/<name>/** to its own tests plus the validators', () => {
    const { result } = run(['.claude/skills/demo-skill/SKILL.md']);
    expect(result.tests).toEqual(['.claude/skills/demo-skill/helper.test.mjs', ...VALIDATORS]);
    expect(result.unmapped).toEqual([]);
  });

  it('maps .kookr/playbooks/** to the validators only', () => {
    const { result } = run(['.kookr/playbooks/nightly.md']);
    expect(result.tests).toEqual(VALIDATORS);
    expect(result.unmapped).toEqual([]);
  });

  it('defers build configuration and suite setup, even TypeScript ones', () => {
    const changed = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vitest.config.mts', 'vitest.fast-gate.config.mts', 'vite.config.mts', 'tsconfig.json', 'src/tsconfig.build.json', 'test/setup-env.ts', 'test/fixtures/x.json'];
    const { result } = run(changed);
    expect(result.deferred).toEqual([...changed].sort());
    expect(result.related).toEqual([]);
    expect(result.tests).toEqual([]);
    expect(result.commands).toEqual([]);
  });

  it('lets a test file under test/ run itself', () => {
    const { result } = run(['test/git-repo-guard.test.ts']);
    expect(result.related).toEqual(['test/git-repo-guard.test.ts']);
    expect(result.deferred).toEqual([]);
  });

  it('treats docs and other Markdown as mapped', () => {
    const { result } = run(['docs/reference/cli.md', 'CONTRIBUTING.md']);
    expect(result.unmapped).toEqual([]);
    expect(result.commands).toEqual([]);
  });

  it('de-duplicates and sorts every list', () => {
    const { result } = run(['scripts/lib/b.sh', 'scripts/lib/a.sh', 'scripts/lib/a.sh', 'z.ts', 'a.ts']);
    expect(result.related).toEqual(['a.ts', 'z.ts']);
    expect(result.commands).toEqual(['pnpm test:hooks']);
  });
});

describe('selectFastGate reference hits (#3816)', () => {
  it('never hands a config or suite-setup reference hit to vitest', () => {
    const { result } = run(['.hooks/pre-push'], {
      refs: { 'pre-push': ['vitest.config.mts', 'vite.config.mts', 'test/setup-env.ts', 'src/a.ts', 'src/a.test.ts'] },
    });
    expect(result.related).toEqual(['src/a.ts']);
    expect(result.tests).toEqual(['src/a.test.ts']);
    expect(result.deferred).toEqual([]);
  });

  it('does not search a base name another tracked file shares', () => {
    // The plugin.json shape: a manifest whose base name a second manifest shares.
    const tracked = [...TRACKED, 'manifests/main/registry.json', 'deploy/other/registry.json'];
    const refs = { 'registry.json': ['src/other-registry-reader.ts', 'src/other-registry-reader.test.ts'] };
    const { result, lookups } = run(['manifests/main/registry.json'], { tracked, refs });
    expect(lookups.flat()).not.toContain('registry.json');
    expect(result.related).toEqual([]);
    expect(result.tests).toEqual([]);
  });

  it('finds a reference written as a path suffix of two or more segments', () => {
    const { result } = run(['docs/reference/api.md'], { refs: { 'reference/api.md': ['src/docs/api-drift.test.ts'] } });
    expect(result.tests).toEqual(['src/docs/api-drift.test.ts']);
  });

  describe('per-file cap', () => {
    // Each hit stands for 10 downstream test files; a test hit for one.
    const countTests = (files: string[]) => files.reduce((n, f) => n + (/\.test\./.test(f) ? 1 : 10), 0);

    it(`keeps only the tests naming the full path when one file would select more than ${CAP_TESTS}`, () => {
      const broad = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
      const { result } = run(['CLAUDE.md'], {
        countTests,
        refs: { CLAUDE: [], 'CLAUDE.md': [...broad, 'src/claude-md.test.ts'] },
      });
      expect(result.related).toEqual([]);
      expect(result.tests).toEqual(['src/claude-md.test.ts']);
      expect(result.capped).toEqual([{ path: 'CLAUDE.md', estimate: 51 }]);
      expect(result.unmapped).toEqual([]);
    });

    it('drops weak (base-name-only) hits under the cap', () => {
      const { result } = run(['docs/reference/auto-close-on-signal.md'], {
        countTests,
        refs: {
          'auto-close-on-signal.md': ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
          'docs/reference/auto-close-on-signal.md': ['src/doc-link.test.ts'],
        },
      });
      expect(result.related).toEqual([]);
      expect(result.tests).toEqual(['src/doc-link.test.ts']);
      expect(result.capped.map((c) => c.path)).toEqual(['docs/reference/auto-close-on-signal.md']);
    });

    it('leaves a selection at or under the cap alone', () => {
      const { result } = run(['docs/guides/x.yaml'], { countTests, refs: { 'docs/guides/x.yaml': ['src/a.ts', 'src/b.ts'] } });
      expect(result.related).toEqual(['src/a.ts', 'src/b.ts']);
      expect(result.capped).toEqual([]);
    });

    it('never caps a changed source file: vitest related still gets it', () => {
      const { result } = run(['src/shared/contracts/messages.ts'], { countTests: () => 999 });
      expect(result.related).toEqual(['src/shared/contracts/messages.ts']);
      expect(result.capped).toEqual([]);
    });
  });

  it('reports the estimated size and the three largest contributors', () => {
    const countTests = (files: string[]) => files.reduce((n, f) => n + ({ 'src/a.ts': 30, 'src/b.ts': 20, 'src/c.ts': 10, 'src/d.ts': 5 }[f] ?? 1), 0);
    const { result } = run(['src/d.ts', 'src/c.ts', 'src/b.ts', 'src/a.ts', 'hooks/pr-workflow-gate.sh'], { countTests });
    expect(result.summary.top).toEqual([
      { path: 'src/a.ts', estimate: 30 },
      { path: 'src/b.ts', estimate: 20 },
      { path: 'src/c.ts', estimate: 10 },
    ]);
    expect(result.summary.estimate).toBe(30 + 20 + 10 + 5 + 2);
  });
});

describe('hookTestsFor', () => {
  it('matches <stem>.test.sh and <stem>-*.test.sh, nothing looser', () => {
    const tracked = ['.claude/hooks-tests/gate.test.sh', '.claude/hooks-tests/gate-extra.test.sh', '.claude/hooks-tests/gatekeeper.test.sh'];
    expect(hookTestsFor('plugin/hooks/gate.sh', tracked)).toEqual(['.claude/hooks-tests/gate.test.sh', '.claude/hooks-tests/gate-extra.test.sh']);
  });
});

describe('buildTestCounter', () => {
  it('counts the test files that reach a file through relative imports', () => {
    const files: Record<string, string> = {
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': "import { a } from './a.js';\nexport const b = a;",
      'src/b.test.ts': "import { b } from './b.js';",
      'src/a.test.ts': "import { a } from './a';",
      'src/other.test.ts': "import x from 'vitest';",
    };
    const count = buildTestCounter(Object.keys(files), (p: string) => files[p] ?? null);
    expect(count(['src/a.ts'])).toBe(2);
    expect(count(['src/b.ts'])).toBe(1);
    expect(count(['src/other.test.ts'])).toBe(1);
    expect(count([])).toBe(0);
  });
});

describe('referenceNeedles', () => {
  it('searches the repo-relative path and its suffixes of two or more segments', () => {
    expect(referenceNeedles('docs/reference/api.md')).toEqual({ strong: ['docs/reference/api.md', 'reference/api.md'], weak: [] });
  });

  it('adds a distinctive base name only when no other tracked file has it', () => {
    expect(referenceNeedles('a/b/delivery-gate.json', ['a/b/delivery-gate.json']).weak).toEqual(['delivery-gate.json']);
    expect(referenceNeedles('a/b/delivery-gate.json', ['a/b/delivery-gate.json', 'c/delivery-gate.json']).weak).toEqual([]);
    expect(referenceNeedles('a/b/delivery-gate.json').weak).toEqual([]);
  });

  it('skips generic and short base names', () => {
    const tracked = ['docs/README.md', 'x/CHANGELOG.md', 'x/index.html', 'x/a.css'];
    for (const p of tracked) expect(referenceNeedles(p, tracked).weak, p).toEqual([]);
  });

  it('searches SKILL.md by <dir>/SKILL.md and a long <dir>', () => {
    expect(referenceNeedles('plugin/skills/disk-reclaim/SKILL.md')).toEqual({
      strong: ['plugin/skills/disk-reclaim/SKILL.md', 'skills/disk-reclaim/SKILL.md', 'disk-reclaim/SKILL.md'],
      weak: ['disk-reclaim'],
    });
    expect(referenceNeedles('plugin/skills/tdd/SKILL.md').weak).toEqual([]);
  });
});
