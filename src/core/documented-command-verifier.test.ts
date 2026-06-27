import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { extractDocumentedCommands, verifyDocumentedCommands } from './documented-command-verifier.js';

describe('extractDocumentedCommands', () => {
  it('extracts shell fenced commands and inline commands', () => {
    const commands = extractDocumentedCommands(
      'docs/example.md',
      [
        'Run `pnpm test` before pushing.',
        '',
        '```bash',
        '# install first',
        'pnpm install',
        'pnpm build && pnpm start # then open the dashboard',
        '```',
        '',
        '```text',
        'pnpm not-a-command-from-output',
        '```',
      ].join('\n'),
    );

    expect(commands).toEqual([
      { file: 'docs/example.md', line: 1, text: 'pnpm test', source: 'inline' },
      { file: 'docs/example.md', line: 5, text: 'pnpm install', source: 'fenced' },
      { file: 'docs/example.md', line: 6, text: 'pnpm build && pnpm start', source: 'fenced' },
    ]);
  });
});

describe('verifyDocumentedCommands', () => {
  it('reports documented pnpm scripts that package.json does not provide', () => {
    const repoRoot = createRepo({
      scripts: { test: 'vitest run' },
      docs: [
        '# Development',
        '',
        '```bash',
        'pnpm test',
        'pnpm test:e2e',
        '```',
      ].join('\n'),
    });

    const result = verifyDocumentedCommands(repoRoot);

    expect(result.issues).toEqual([
      expect.objectContaining({
        file: 'docs/development.md',
        line: 5,
        text: 'pnpm test:e2e',
        message: 'package.json has no script named "test:e2e"',
      }),
    ]);
    expect(result.checked.map((command) => command.normalized)).toContain('package script test');
  });

  it('validates package bins, pnpm exec binaries, and repo-local script paths', () => {
    const repoRoot = createRepo({
      scripts: { 'relay:status': 'node --import tsx scripts/relay-lifecycle.ts status' },
      bins: { 'kookr-spawn': './bin/kookr-spawn.js' },
      devDependencies: { tsx: '^4.0.0' },
      docs: [
        '# Commands',
        '',
        '- `kookr-spawn "review the diff"`',
        '- `pnpm exec playwright test`',
        '- `node --import tsx scripts/relay-lifecycle.ts status`',
        '- `bash scripts/onboarding-smoke-test.sh`',
        '- `pnpm relay:status`',
      ].join('\n'),
      files: [
        'bin/kookr-spawn.js',
        'node_modules/.bin/playwright',
        'scripts/relay-lifecycle.ts',
        'scripts/onboarding-smoke-test.sh',
      ],
    });

    const result = verifyDocumentedCommands(repoRoot);

    expect(result.issues).toEqual([]);
    expect(result.checked.map((command) => command.normalized)).toEqual([
      'package bin kookr-spawn',
      'node_modules/.bin/playwright',
      'node entrypoint scripts/relay-lifecycle.ts',
      'shell script scripts/onboarding-smoke-test.sh',
      'package script relay:status',
    ]);
  });

  it('accepts documented built node entrypoints when the source exists', () => {
    const repoRoot = createRepo({
      scripts: {},
      docs: '`node dist/server/start.js`',
      files: ['src/server/start.ts'],
    });

    const result = verifyDocumentedCommands(repoRoot);

    expect(result.issues).toEqual([]);
    expect(result.checked.map((command) => command.normalized)).toEqual([
      'node entrypoint dist/server/start.js (built from src/server/start.ts)',
    ]);
  });

  it('does not apply the built-entrypoint fallback to shell scripts', () => {
    const repoRoot = createRepo({
      scripts: {},
      docs: '`bash dist/server/start.js`',
      files: ['src/server/start.ts'],
    });

    const result = verifyDocumentedCommands(repoRoot);

    expect(result.issues).toEqual([
      expect.objectContaining({
        text: 'bash dist/server/start.js',
        message: 'shell script does not exist: dist/server/start.js',
      }),
    ]);
  });

  it('skips manual, placeholder, and compound shell commands instead of failing them', () => {
    const repoRoot = createRepo({
      scripts: {},
      docs: [
        '# Manual Commands',
        '',
        '```bash',
        'sudo systemctl restart kookr-relay',
        'ANTHROPIC_API_KEY=sk-ant-... bash scripts/onboarding-smoke-test.sh',
        'pnpm coverage:summary >> "$GITHUB_STEP_SUMMARY"',
        '```',
      ].join('\n'),
    });

    const result = verifyDocumentedCommands(repoRoot);

    expect(result.issues).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ text: 'sudo systemctl restart kookr-relay' }),
      expect.objectContaining({ text: 'ANTHROPIC_API_KEY=sk-ant-... bash scripts/onboarding-smoke-test.sh' }),
      expect.objectContaining({ text: 'pnpm coverage:summary >> "$GITHUB_STEP_SUMMARY"' }),
    ]);
  });

  it('exits successfully from the CLI when documented commands are valid', () => {
    const repoRoot = createRepo({
      scripts: { test: 'vitest run' },
      docs: '`pnpm test`',
    });

    const result = runCli(repoRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Documented command verification passed.');
    expect(result.stderr).toBe('');
  });

  it('exits non-zero from the CLI and prints issues when documented commands are invalid', () => {
    const repoRoot = createRepo({
      scripts: { test: 'vitest run' },
      docs: '`pnpm test:e2e`',
    });

    const result = runCli(repoRoot);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Documented command verification failed:');
    expect(result.stderr).toContain('docs/development.md:1 `pnpm test:e2e`');
    expect(result.stderr).toContain('package.json has no script named "test:e2e"');
  });

  it('keeps data-directory reference commands and snapshot tokens checkable', () => {
    const file = 'docs/reference/data-directory.md';
    const content = readFileSync(join(process.cwd(), file), 'utf8');

    expect(content).toContain('tasks.json.daily.YYYYMMDD');
    expect(content).toContain('tasks.json.predelete.YYYYMMDDTHHMMSS');
    expect(content).toContain('KOOKR_DATA_DIR');

    const commands = extractDocumentedCommands(file, content);
    expect(commands.map((command) => command.text)).toEqual(expect.arrayContaining([
      'kookr maintenance prune --dry-run --dir "$KOOKR_DATA_DIR"',
      'kookr maintenance prune --max-age-days 30 --dir "$KOOKR_DATA_DIR"',
      'pnpm prod:restart',
    ]));

    const result = verifyDocumentedCommands(process.cwd());
    expect(result.issues.filter((issue) => issue.file === file)).toEqual([]);
  });
});

function createRepo(input: {
  scripts: Record<string, string>;
  bins?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  docs: string;
  files?: string[];
}): string {
  const repoRoot = join(tmpdir(), `kookr-doc-command-test-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(repoRoot, 'docs'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'package.json'),
    JSON.stringify({
      name: 'kookr',
      scripts: input.scripts,
      bin: input.bins,
      dependencies: input.dependencies,
      devDependencies: input.devDependencies,
    }),
  );
  writeFileSync(join(repoRoot, 'README.md'), '# Test repo\n');
  writeFileSync(join(repoRoot, 'docs', 'development.md'), input.docs);

  for (const file of input.files ?? []) {
    mkdirSync(join(repoRoot, file, '..'), { recursive: true });
    writeFileSync(join(repoRoot, file), '');
  }

  return repoRoot;
}

function runCli(repoRoot: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [
    '--import',
    'tsx',
    join(process.cwd(), 'scripts', 'verify-documented-commands.ts'),
    repoRoot,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
