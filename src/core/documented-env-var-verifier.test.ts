import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  computeEnvVarDrift,
  extractDocumentedEnvVars,
  extractEnvExampleVars,
  extractEnvVarsFromSource,
  verifyDocumentedEnvVars,
} from './documented-env-var-verifier.js';

describe('extractEnvVarsFromSource', () => {
  it('matches process.env and aliased env reads, dot and bracket, ignoring non-env identifiers', () => {
    const content = [
      "const port = process.env.KOOKR_PORT;",
      "const env = process.env;",
      "const token = env.KOOKR_TELEGRAM_BOT_TOKEN;",
      "const url = env?.KOOKR_API_BASE_URL;",
      "const bracket = process.env['KOOKR_HOST'];",
      "const alsoBracket = env[\"KOOKR_DEBUG\"];",
      // Not an env read: a JS identifier that merely looks like a var name.
      "const KOOKR_SPAWN_TASK_ID_RE = /task_id/;",
      // Not an env read: a child-process injection (object literal key).
      "const child = { ...process.env, KOOKR_PROD_DIR: prodDir };",
    ].join('\n');

    expect(extractEnvVarsFromSource(content)).toEqual([
      'KOOKR_API_BASE_URL',
      'KOOKR_DEBUG',
      'KOOKR_HOST',
      'KOOKR_PORT',
      'KOOKR_TELEGRAM_BOT_TOKEN',
    ]);
  });

  it('matches helper-indirection reads that pass the name as a string literal', () => {
    const content = [
      "profiles: envFlag(env, 'KOOKR_COLLABORATION_PROFILES'),",
      'timeout: readInt(env, "KOOKR_LLM_TIMEOUT_MS"),',
    ].join('\n');

    expect(extractEnvVarsFromSource(content)).toEqual([
      'KOOKR_COLLABORATION_PROFILES',
      'KOOKR_LLM_TIMEOUT_MS',
    ]);
  });

  it('does not match destructuring or concatenated/template names (documented blind spots)', () => {
    expect(extractEnvVarsFromSource('const { KOOKR_PORT } = process.env;')).toEqual([]);
    expect(extractEnvVarsFromSource("const name = 'KOOKR_RELAY_' + suffix;")).toEqual(['KOOKR_RELAY']);
    expect(extractEnvVarsFromSource('const name = `KOOKR_RELAY_${suffix}`;')).toEqual([]);
  });

  it('drops trailing-underscore prefix fragments from computed names', () => {
    expect(extractEnvVarsFromSource('env.KOOKR_RELAY_')).toEqual(['KOOKR_RELAY']);
  });
});

describe('extractDocumentedEnvVars', () => {
  it('collects backtick-prefixed KOOKR vars from tables and prose, including =value forms', () => {
    const markdown = [
      '| `KOOKR_PORT` | `4800` | port | HTTP port |',
      'Set `KOOKR_BYPASS_ALL_PERMISSIONS=true` to disable prompts.',
      'The `KOOKR_HOSTED_RELAY_MODE` / `KOOKR_RELAY_MODE` knob controls availability.',
      'Vendor keys like `GROQ_API_KEY` are not KOOKR-prefixed.',
    ].join('\n');

    expect(extractDocumentedEnvVars(markdown)).toEqual([
      'KOOKR_BYPASS_ALL_PERMISSIONS',
      'KOOKR_HOSTED_RELAY_MODE',
      'KOOKR_PORT',
      'KOOKR_RELAY_MODE',
    ]);
  });
});

describe('extractEnvExampleVars', () => {
  it('reads assignments whether commented or active, ignoring prose mentions', () => {
    const content = [
      '# KOOKR_PORT=4800',
      'KOOKR_HOST=127.0.0.1',
      '# See KOOKR_DEBUG in the reference (prose mention, not an assignment).',
      '#KOOKR_STT=true',
    ].join('\n');

    expect(extractEnvExampleVars(content)).toEqual(['KOOKR_HOST', 'KOOKR_PORT', 'KOOKR_STT']);
  });
});

describe('computeEnvVarDrift', () => {
  const base = {
    codeReferenced: ['KOOKR_PORT'],
    documented: ['KOOKR_PORT'],
    envExample: ['KOOKR_PORT'],
    internalAllowlist: [],
    documentedOnly: [],
  };

  it('passes cleanly when code, docs, and .env.example agree', () => {
    expect(computeEnvVarDrift(base).issues).toEqual([]);
  });

  it('flags an undocumented var read in source', () => {
    const result = computeEnvVarDrift({ ...base, codeReferenced: ['KOOKR_PORT', 'KOOKR_NEW_FLAG'] });
    expect(result.issues).toEqual([
      expect.objectContaining({
        name: 'KOOKR_NEW_FLAG',
        message: expect.stringContaining('not documented'),
      }),
    ]);
  });

  it('flags a stale documented var that no source reads', () => {
    const result = computeEnvVarDrift({ ...base, documented: ['KOOKR_PORT', 'KOOKR_GONE'] });
    expect(result.issues).toEqual([
      expect.objectContaining({
        name: 'KOOKR_GONE',
        message: expect.stringContaining('documented but not read in source'),
      }),
    ]);
  });

  it('flags a .env.example var missing from the canonical reference', () => {
    const result = computeEnvVarDrift({ ...base, envExample: ['KOOKR_PORT', 'KOOKR_ORPHAN'] });
    expect(result.issues).toEqual([
      expect.objectContaining({
        name: 'KOOKR_ORPHAN',
        message: expect.stringContaining('.env.example'),
      }),
    ]);
  });

  it('avoids false positives for allowlisted internal and documented-only vars', () => {
    const result = computeEnvVarDrift({
      codeReferenced: ['KOOKR_PORT', 'KOOKR_DEBUG'],
      documented: ['KOOKR_PORT', 'KOOKR_HEALTH_URL'],
      envExample: ['KOOKR_PORT'],
      internalAllowlist: ['KOOKR_DEBUG'],
      documentedOnly: ['KOOKR_HEALTH_URL'],
    });
    expect(result.issues).toEqual([]);
    expect(result.checked).toBe(2);
  });

  it('flags a redundant internal allowlist entry that is now documented', () => {
    const result = computeEnvVarDrift({
      codeReferenced: ['KOOKR_PORT'],
      documented: ['KOOKR_PORT'],
      envExample: [],
      internalAllowlist: ['KOOKR_PORT'],
      documentedOnly: [],
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        name: 'KOOKR_PORT',
        message: expect.stringContaining('INTERNAL_ENV_VARS'),
      }),
    ]);
  });

  it('flags a stale documented-only exemption that is no longer documented', () => {
    const result = computeEnvVarDrift({
      codeReferenced: ['KOOKR_PORT'],
      documented: ['KOOKR_PORT'],
      envExample: [],
      internalAllowlist: [],
      documentedOnly: ['KOOKR_VANISHED'],
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        name: 'KOOKR_VANISHED',
        message: expect.stringContaining('DOCUMENTED_ONLY_ENV_VARS'),
      }),
    ]);
  });
});

describe('verifyDocumentedEnvVars', () => {
  it('reports undocumented and stale vars against a temp repo using the built-in allowlists', () => {
    const repoRoot = createRepo({
      source: "export const port = process.env.KOOKR_PORT;\nexport const x = process.env.KOOKR_UNDOCUMENTED;\n",
      docs: '| `KOOKR_PORT` | `4800` |\n| `KOOKR_STALE` | unset |\n',
      envExample: '# KOOKR_PORT=4800\n',
    });

    const result = verifyDocumentedEnvVars(repoRoot, {
      sourceRoots: ['src'],
      internalAllowlist: [],
      documentedOnly: [],
    });

    expect(result.issues).toHaveLength(2);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'KOOKR_UNDOCUMENTED' }),
        expect.objectContaining({ name: 'KOOKR_STALE' }),
      ]),
    );
  });

  it('passes for a clean temp repo and actually scans the source file', () => {
    const repoRoot = createRepo({
      source: "export const port = process.env.KOOKR_PORT;\n",
      docs: '| `KOOKR_PORT` | `4800` |\n',
      envExample: '# KOOKR_PORT=4800\n',
    });

    const result = verifyDocumentedEnvVars(repoRoot, {
      sourceRoots: ['src'],
      internalAllowlist: [],
      documentedOnly: [],
    });
    expect(result.issues).toEqual([]);
    // Guards against a silent false-green where the scanner finds nothing.
    expect(result.checked).toBe(1);
    expect(result.codeReferenced).toEqual(['KOOKR_PORT']);
  });

  it('passes against the real repository (baseline guard)', () => {
    const result = verifyDocumentedEnvVars(process.cwd());
    expect(result.issues).toEqual([]);
  });
});

describe('verify-documented-env-vars CLI', () => {
  it('exits 0 and prints a pass message for the real repository', () => {
    const result = runCli(process.cwd());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Documented environment-variable verification passed.');
    // Don't assert stderr === '' — the tsx loader may emit unrelated warnings;
    // assert only that no verifier failure was reported.
    expect(result.stderr).not.toContain('verification failed');
  });

  it('exits 1 and prints issues when documented env vars drift', () => {
    const repoRoot = createRepo({
      source: "export const x = process.env.KOOKR_UNDOCUMENTED;\n",
      docs: '# none\n',
      envExample: '',
    });

    const result = runCli(repoRoot);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Documented environment-variable verification failed:');
    expect(result.stderr).toContain('KOOKR_UNDOCUMENTED');
  });
});

function createRepo(input: { source: string; docs: string; envExample: string }): string {
  const repoRoot = join(tmpdir(), `kookr-doc-env-test-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(repoRoot, 'docs', 'reference'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'config.ts'), input.source);
  writeFileSync(join(repoRoot, 'docs', 'reference', 'environment-variables.md'), input.docs);
  writeFileSync(join(repoRoot, '.env.example'), input.envExample);
  return repoRoot;
}

function runCli(repoRoot: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(process.cwd(), 'scripts', 'verify-documented-env-vars.ts'), repoRoot],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
