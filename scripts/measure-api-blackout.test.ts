import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts/measure-api-blackout.sh');

describe('measure-api-blackout.sh', () => {
  it('exists and is executable-bit friendly (shebang + bash)', () => {
    const body = readFileSync(SCRIPT, 'utf8');
    expect(body.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(body).toContain('measure-api-blackout');
    // Ensure the file is mode-executable in the tree (git tracks the bit).
    chmodSync(SCRIPT, 0o755);
  });

  it('--help explains usage and documents the 10ms recipe', () => {
    const result = spawnSync('bash', [SCRIPT, '--help'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toMatch(/Usage: scripts\/measure-api-blackout\.sh/);
    expect(out).toMatch(/--interval-ms/);
    expect(out).toMatch(/--once/);
    expect(out).toMatch(/pnpm prod:restart/);
    expect(out).toMatch(/10ms|interval/i);
    expect(out).toMatch(/blackout_ms/);
    expect(out).toMatch(/do not fail CI|not CI gates|Measurement-only/i);
  });

  it('rejects unknown flags without hanging', () => {
    const result = spawnSync('bash', [SCRIPT, '--not-a-real-flag'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/unknown argument/);
  });
});
