import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPENCODE_PINNED_VERSION } from './opencode-preflight.js';

/**
 * Static supply-chain and entrypoint contract of deploy/opencode-worker (RFC opencode worker containers, S1).
 * The live behaviour (healthcheck, child-death exits, hook self-test) is checked by the operator-run
 * deploy/opencode-worker/test-container.sh; this test only pins the properties that must not drift silently.
 */
const DIR = join(__dirname, '..', '..', 'deploy', 'opencode-worker');
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8');

describe('opencode-worker image contract', () => {
  it('pins every base image by digest (the toolchain layer takes the worker as an ARG)', () => {
    const refs = [...read('Dockerfile').matchAll(/^(?:ARG \w+=|FROM )(\S+?:\S+)/gm)].map((m) => m[1]).filter((r) => !r.startsWith('${'));
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const r of refs) expect(r).toMatch(/@sha256:[0-9a-f]{64}$/);
    const tc = read('toolchains/kookr.Dockerfile');
    expect(tc).toMatch(/NODE_IMAGE=\S+@sha256:[0-9a-f]{64}/);
  });

  it('installs python deps only with hashes and node deps from a lockfile with integrity', () => {
    expect(read('Dockerfile')).toContain('--require-hashes');
    const req = read('requirements.txt');
    expect(req).toMatch(/^opencode-a2a==\d+\.\d+\.\d+/m);
    const pkgs = req.split(/\n(?=\S)/).filter((b) => /^[A-Za-z0-9_.-]+==/.test(b));
    expect(pkgs.length).toBeGreaterThan(10);
    for (const b of pkgs) expect(b).toContain('--hash=sha256:');
    expect(read('Dockerfile')).toContain('npm ci');
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string; integrity?: string }> };
    expect(lock.packages['node_modules/opencode-ai']?.version).toBe(OPENCODE_PINNED_VERSION);
    for (const [name, p] of Object.entries(lock.packages)) if (name) expect(p.integrity, name).toMatch(/^sha512-/);
  });

  it('runs non-root with a healthcheck and no secret baked in', () => {
    const d = read('Dockerfile');
    expect(d).toMatch(/^USER 1000:1000$/m);
    expect(d).toContain('HEALTHCHECK');
    expect(d).not.toMatch(/ENV\s+\w*(PASSWORD|TOKEN|KEY|SECRET)\w*=/i);
    expect(d).not.toMatch(/ARG\s+\w*(PASSWORD|TOKEN|KEY|SECRET)/i);
  });

  it('entrypoint reads secrets from files, never requires them in env, and has distinct exit codes', () => {
    const e = read('entrypoint.sh');
    expect(e.startsWith('#!/bin/bash')).toBe(true);
    expect(e).toContain('/run/secrets');
    expect(e).not.toMatch(/:\?required/);
    for (const code of [10, 11, 12, 13, 14]) expect(e).toMatch(new RegExp(`exit ${code}|code=${code}`));
    expect(e).toContain('wait -n "$OC" "$A2A"');
    expect(e).toContain('--max-time 2');
  });

  it('ships the operator-run live test and build script', () => {
    for (const f of ['test-container.sh', 'build.sh', 'toolchains/kookr.Dockerfile']) expect(existsSync(join(DIR, f)), f).toBe(true);
  });
});
