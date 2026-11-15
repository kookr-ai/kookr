import { describe, expect, it } from 'vitest';
import { referenceNeedles, selectFastGate } from './fast-gate-select.mjs';

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
];

function run(changed: string[], opts: { gone?: string[]; refs?: Record<string, string[]> } = {}) {
  const gone = new Set(opts.gone ?? []);
  const lookups: string[][] = [];
  const result = selectFastGate({
    changed,
    exists: (p: string) => !gone.has(p),
    findReferences: (needles: string[]) => {
      lookups.push(needles);
      return [...new Set(needles.flatMap((n) => opts.refs?.[n] ?? []))];
    },
    tracked: TRACKED,
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
      refs: { 'old-template.yaml': ['src/t.test.ts'] },
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

  it('maps hook and shell tooling to the hook-test lane', () => {
    const { result } = run(['.hooks/pre-push', 'scripts/foo.sh', '.claude/hooks-tests/a.test.sh']);
    expect(result.commands).toEqual(['pnpm test:hooks']);
    expect(result.unmapped).toEqual([]);
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

  it('maps plugin/hooks/** to its own tests, the validators and the hook-test lane', () => {
    const { result } = run(['plugin/hooks/delivery-step-stop.mjs']);
    expect(result.related).toEqual(['plugin/hooks/delivery-step-stop.mjs']);
    expect(result.tests).toEqual(['plugin/hooks/delivery-step-stop.test.mjs', ...VALIDATORS]);
    expect(result.commands).toEqual(['pnpm test:hooks']);
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
    const changed = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vitest.config.mts', 'vitest.fast-gate.config.mts', 'tsconfig.json', 'src/tsconfig.build.json', 'test/setup-env.ts', 'test/fixtures/x.json'];
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
    const { result } = run(['scripts/b.sh', 'scripts/a.sh', 'scripts/a.sh', 'z.ts', 'a.ts']);
    expect(result.related).toEqual(['a.ts', 'z.ts']);
    expect(result.commands).toEqual(['pnpm test:hooks']);
  });
});

describe('referenceNeedles', () => {
  it('always includes the repo-relative path', () => {
    expect(referenceNeedles('a/b/c.yaml')).toEqual(['a/b/c.yaml']);
  });

  it('adds a distinctive basename (8+ chars)', () => {
    expect(referenceNeedles('a/b/delivery-gate.json')).toEqual(['a/b/delivery-gate.json', 'delivery-gate.json']);
  });

  it('skips generic and short basenames', () => {
    expect(referenceNeedles('docs/README.md')).toEqual(['docs/README.md']);
    expect(referenceNeedles('x/CHANGELOG.md')).toEqual(['x/CHANGELOG.md']);
    expect(referenceNeedles('x/index.html')).toEqual(['x/index.html']);
    expect(referenceNeedles('x/a.css')).toEqual(['x/a.css']);
  });

  it('searches SKILL.md by <dir>/SKILL.md and a long <dir>', () => {
    expect(referenceNeedles('plugin/skills/disk-reclaim/SKILL.md')).toEqual([
      'plugin/skills/disk-reclaim/SKILL.md',
      'disk-reclaim/SKILL.md',
      'disk-reclaim',
    ]);
    expect(referenceNeedles('plugin/skills/tdd/SKILL.md')).toEqual(['plugin/skills/tdd/SKILL.md', 'tdd/SKILL.md']);
  });
});
