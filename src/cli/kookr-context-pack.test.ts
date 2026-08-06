import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DEFAULT_PACK_SKILLS, runContextPackCli } from './kookr-context-pack.js';

function fakeConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    out: {
      log: (m?: unknown) => logs.push(String(m)),
      error: (m?: unknown) => errors.push(String(m)),
    },
  };
}

async function writeSkill(pluginDir: string, name: string, description: string): Promise<void> {
  const dir = join(pluginDir, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody of ${name}.\n`,
    'utf8',
  );
}

describe('runContextPackCli', () => {
  let root: string;
  let pluginDir: string;
  let cacheDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kookr-ctxpack-'));
    pluginDir = join(root, 'plugin');
    cacheDir = join(root, 'cache');
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
    await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'), '{"name":"kookr-toolkit"}', 'utf8');
    for (const name of DEFAULT_PACK_SKILLS) {
      await writeSkill(pluginDir, name, `desc for ${name}`);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeSpec(spec: Record<string, unknown>): Promise<string> {
    const path = join(root, 'spec.json');
    await writeFile(path, JSON.stringify(spec), 'utf8');
    return path;
  }

  const baseArgs = (spec: string, out: string) => [
    '--spec', spec, '--out', out, '--plugin-dir', pluginDir, '--cache-dir', cacheDir,
  ];

  it('writes a context pack with the default skill digests (incl. excerpt bodies)', async () => {
    const spec = await writeSpec({
      issueNumber: 1306,
      issueTitle: 'Context pack',
      issueBody: 'Do it.\n- [ ] Attach a pack',
      candidateFiles: ['src/core/context-pack.ts'],
      baseBranch: 'main',
      baseCommit: 'abc1234',
      repoFullName: 'kookr-ai/kookr',
    });
    const outPath = join(root, 'pack.md');
    const con = fakeConsole();

    const code = await runContextPackCli(baseArgs(spec, outPath), { out: con.out, env: {} as NodeJS.ProcessEnv });

    expect(code).toBe(0);
    const md = await readFile(outPath, 'utf8');
    expect(md).toContain('issue #1306');
    expect(md).toContain('floor, not a ceiling');
    expect(md).toContain('- [ ] Attach a pack');
    for (const name of DEFAULT_PACK_SKILLS) {
      expect(md).toContain(name);
      // Assert the digest *body* survived, not just the name in the header.
      expect(md).toContain(`Body of ${name}.`);
    }
  });

  it('reads the issue body from issueBodyFile when issueBody is absent', async () => {
    const bodyFile = join(root, 'body.md');
    await writeFile(bodyFile, 'Body from file\n- [ ] From file criterion', 'utf8');
    const spec = await writeSpec({
      issueNumber: 7,
      issueTitle: 'T',
      issueBodyFile: bodyFile,
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
    });
    const outPath = join(root, 'pack.md');
    const con = fakeConsole();

    const code = await runContextPackCli(baseArgs(spec, outPath), { out: con.out, env: {} as NodeJS.ProcessEnv });
    expect(code).toBe(0);
    const md = await readFile(outPath, 'utf8');
    expect(md).toContain('Body from file');
    expect(md).toContain('- [ ] From file criterion');
  });

  it('emits a --json envelope with counts and per-skill cache flags', async () => {
    const spec = await writeSpec({
      issueNumber: 8,
      issueTitle: 'T',
      issueBody: 'x',
      candidateFiles: ['a.ts', 'b.ts'],
      acceptanceCriteria: ['one', 'two', 'three'],
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
    });
    const con = fakeConsole();
    const code = await runContextPackCli(
      [...baseArgs(spec, join(root, 'p.md')), '--json'],
      { out: con.out, env: {} as NodeJS.ProcessEnv },
    );
    expect(code).toBe(0);
    const env = JSON.parse(con.logs[0]);
    expect(env.ok).toBe(true);
    expect(env.candidateFileCount).toBe(2);
    expect(env.acceptanceCriteriaCount).toBe(3);
    expect(env.reviewOut).toBeNull();
    expect(env.skills).toHaveLength(DEFAULT_PACK_SKILLS.length);
  });

  it('reuses skill digests from cache on a second run', async () => {
    const spec = await writeSpec({
      issueNumber: 1,
      issueTitle: 'T',
      issueBody: 'b',
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
    });
    const args = [...baseArgs(spec, join(root, 'p.md')), '--json'];

    const first = fakeConsole();
    await runContextPackCli(args, { out: first.out, env: {} as NodeJS.ProcessEnv });
    const firstEnv = JSON.parse(first.logs[0]);
    expect(firstEnv.skills.every((s: { cached: boolean }) => s.cached === false)).toBe(true);

    const second = fakeConsole();
    await runContextPackCli(args, { out: second.out, env: {} as NodeJS.ProcessEnv });
    const secondEnv = JSON.parse(second.logs[0]);
    expect(secondEnv.skills.every((s: { cached: boolean }) => s.cached === true)).toBe(true);
  });

  it('invalidates only the changed skill on a later run (real-disk cache)', async () => {
    const spec = await writeSpec({
      issueNumber: 2,
      issueTitle: 'T',
      issueBody: 'b',
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
    });
    const args = [...baseArgs(spec, join(root, 'p.md')), '--json'];

    const first = fakeConsole();
    await runContextPackCli(args, { out: first.out, env: {} as NodeJS.ProcessEnv });

    // Change exactly one skill file between runs.
    const [changed] = DEFAULT_PACK_SKILLS;
    await writeSkill(pluginDir, changed, 'a different description now');

    const second = fakeConsole();
    await runContextPackCli(args, { out: second.out, env: {} as NodeJS.ProcessEnv });
    const env = JSON.parse(second.logs[0]);
    const byName: Record<string, boolean> = Object.fromEntries(
      env.skills.map((s: { name: string; cached: boolean }) => [s.name, s.cached]),
    );
    expect(byName[changed]).toBe(false); // regenerated
    for (const name of DEFAULT_PACK_SKILLS) {
      if (name !== changed) expect(byName[name]).toBe(true); // still cached
    }
  });

  it('writes a review pack with the staged diff when requested', async () => {
    const diffPath = join(root, 'diff.txt');
    await writeFile(diffPath, 'diff --git a/x b/x\n+new line', 'utf8');
    const spec = await writeSpec({
      issueNumber: 2,
      issueTitle: 'T',
      issueBody: 'b',
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
      stagedDiffFile: diffPath,
    });
    const reviewOut = join(root, 'review.md');
    const con = fakeConsole();

    const code = await runContextPackCli(
      [...baseArgs(spec, join(root, 'p.md')), '--review-out', reviewOut],
      { out: con.out, env: {} as NodeJS.ProcessEnv },
    );

    expect(code).toBe(0);
    const md = await readFile(reviewOut, 'utf8');
    expect(md).toContain('Staged diff (subject of review)');
    expect(md).toContain('+new line');
  });

  it('errors when --review-out is set without a stagedDiffFile', async () => {
    const spec = await writeSpec({
      issueNumber: 3,
      issueTitle: 'T',
      issueBody: 'b',
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
    });
    const con = fakeConsole();
    const code = await runContextPackCli(
      [...baseArgs(spec, join(root, 'p.md')), '--review-out', join(root, 'r.md')],
      { out: con.out, env: {} as NodeJS.ProcessEnv },
    );
    expect(code).toBe(2);
    expect(con.errors.join('\n')).toContain('stagedDiffFile');
  });

  it('errors when the stagedDiffFile is unreadable', async () => {
    const spec = await writeSpec({
      issueNumber: 3,
      issueTitle: 'T',
      issueBody: 'b',
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
      stagedDiffFile: join(root, 'does-not-exist.diff'),
    });
    const con = fakeConsole();
    const code = await runContextPackCli(
      [...baseArgs(spec, join(root, 'p.md')), '--review-out', join(root, 'r.md')],
      { out: con.out, env: {} as NodeJS.ProcessEnv },
    );
    expect(code).toBe(2);
    expect(con.errors.join('\n')).toContain('stagedDiffFile');
  });

  it('skips missing and unsafe-named skills without failing', async () => {
    const spec = await writeSpec({
      issueNumber: 4,
      issueTitle: 'T',
      issueBody: 'b',
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
      skills: ['git-commit-discipline', 'does-not-exist', '../../etc/evil'],
    });
    const outPath = join(root, 'pack.md');
    const con = fakeConsole();
    const code = await runContextPackCli(baseArgs(spec, outPath), { out: con.out, env: {} as NodeJS.ProcessEnv });
    expect(code).toBe(0);
    const errs = con.errors.join('\n');
    expect(errs).toContain('does-not-exist');
    expect(errs).toContain('unsafe name');
    const md = await readFile(outPath, 'utf8');
    expect(md).toContain('git-commit-discipline');
  });

  it('rejects a spec whose array field is a bare string', async () => {
    const spec = await writeSpec({
      issueNumber: 5,
      issueTitle: 'T',
      issueBody: 'b',
      candidateFiles: 'src/a.ts',
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
    });
    const con = fakeConsole();
    const code = await runContextPackCli(baseArgs(spec, join(root, 'p.md')), { out: con.out, env: {} as NodeJS.ProcessEnv });
    expect(code).toBe(2);
    const errs = con.errors.join('\n');
    expect(errs).toContain('candidateFiles must be an array');
    // The offending value is echoed back so the author sees what they supplied.
    expect(errs).toContain(JSON.stringify('src/a.ts'));
  });

  it('rejects a malformed spec (missing baseBranch)', async () => {
    const spec = await writeSpec({ issueNumber: 6, issueTitle: 'T', issueBody: 'b', baseCommit: 'sha', repoFullName: 'o/r' });
    const con = fakeConsole();
    const code = await runContextPackCli(baseArgs(spec, join(root, 'p.md')), { out: con.out, env: {} as NodeJS.ProcessEnv });
    expect(code).toBe(2);
    const errs = con.errors.join('\n');
    expect(errs).toContain('baseBranch');
    // A missing field reports `undefined` as the received value.
    expect(errs).toContain('got undefined');
  });

  it('reports the received value for a scalar type mismatch', async () => {
    // issueNumber authored as a string is the canonical guess-and-retry case.
    const spec = await writeSpec({
      issueNumber: '779',
      issueTitle: 'T',
      issueBody: 'b',
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
    });
    const con = fakeConsole();
    const code = await runContextPackCli(baseArgs(spec, join(root, 'p.md')), { out: con.out, env: {} as NodeJS.ProcessEnv });
    expect(code).toBe(2);
    const errs = con.errors.join('\n');
    expect(errs).toContain('spec.issueNumber must be a number');
    expect(errs).toContain('got "779"');
  });

  it('prints help and returns 0 for --help', async () => {
    const con = fakeConsole();
    const code = await runContextPackCli(['--help'], { out: con.out, env: {} as NodeJS.ProcessEnv });
    expect(code).toBe(0);
    expect(con.logs.join('\n')).toContain('kookr context-pack');
  });

  it('rejects an unknown option', async () => {
    const con = fakeConsole();
    const code = await runContextPackCli(['--bogus'], { out: con.out, env: {} as NodeJS.ProcessEnv });
    expect(code).toBe(2);
    expect(con.errors.join('\n')).toContain('unknown option');
  });

  it('requires --spec and --out', async () => {
    const con = fakeConsole();
    const code = await runContextPackCli(['--out', join(root, 'p.md')], { out: con.out, env: {} as NodeJS.ProcessEnv });
    expect(code).toBe(2);
    expect(con.errors.join('\n')).toContain('--spec and --out are required');
  });
});
