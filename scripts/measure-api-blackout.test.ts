import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts/measure-api-blackout.sh');

describe('measure-api-blackout.sh', () => {
  it('exists with shebang and executable bit', () => {
    const body = readFileSync(SCRIPT, 'utf8');
    expect(body.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(body).toContain('measure-api-blackout');
    // git tracks the mode as 100755; assert the worktree bit is still set.
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
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
    expect(out).toMatch(/default:\s*10\b|10ms/);
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

  it('rejects interval-ms 0 (no busy-poll)', () => {
    const result = spawnSync('bash', [SCRIPT, '--interval-ms', '0', '--timeout-s', '1'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toMatch(/interval-ms/);
  });
});
