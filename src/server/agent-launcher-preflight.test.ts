import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLauncherPreflight } from './agent-launcher-preflight.js';

/**
 * These spawn a real shim through `execFile('kookr', …)` with the temp dir
 * prepended to PATH — the same resolution path a spawned agent uses — so the
 * test proves the issue #786 fix end-to-end (bare-name resolution), not just
 * that a file exists.
 */
describe('runAgentLauncherPreflight', () => {
  const tempDirs: string[] = [];

  function makeBinDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-launcher-preflight-'));
    tempDirs.push(dir);
    return dir;
  }

  function cleanup(): void {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reports `ok` when a bare `kookr` resolves and exits 0', async () => {
    const dir = makeBinDir();
    const launcher = join(dir, 'kookr');
    // Minimal stand-in for the real shim: exits 0 like `kookr --help`.
    writeFileSync(launcher, '#!/bin/sh\nexit 0\n');
    chmodSync(launcher, 0o755);
    try {
      const result = await runAgentLauncherPreflight({ launcherBinDir: dir, basePath: process.env.PATH });
      expect(result).toEqual({ status: 'ok', launcherDir: dir });
    } finally {
      cleanup();
    }
  });

  it('defaults to the committed bundled launcher and reports `ok`', async () => {
    // No override: exercises the real resolveAgentLauncherBinDir() against this
    // checkout's committed bin/kookr shim — the production path.
    const result = await runAgentLauncherPreflight();
    expect(result.status).toBe('ok');
  });

  it('reports `absent` when no launcher resolves (the literal issue #786 state)', async () => {
    // `null` forces the unresolved path without spawning anything — the exact
    // state where bin/kookr is missing and agents would hit exit 127.
    const result = await runAgentLauncherPreflight({ launcherBinDir: null });
    expect(result.status).toBe('absent');
    if (result.status === 'absent') {
      expect(result.reason).toContain('127');
    }
  });

  it('reports `broken` when the launcher dir has no `kookr` on it (ENOENT branch)', async () => {
    const dir = makeBinDir(); // empty — no `kookr` inside
    try {
      const result = await runAgentLauncherPreflight({ launcherBinDir: dir, basePath: '' });
      expect(result.status).toBe('broken');
      if (result.status === 'broken') {
        expect(result.reason).toContain('did not resolve');
      }
    } finally {
      cleanup();
    }
  });

  it('reports `broken` (non-zero branch) when a resolved launcher exits non-zero', async () => {
    const dir = makeBinDir();
    const launcher = join(dir, 'kookr');
    writeFileSync(launcher, '#!/bin/sh\nexit 7\n'); // no `node` call → isolates the non-zero branch
    chmodSync(launcher, 0o755);
    try {
      const result = await runAgentLauncherPreflight({ launcherBinDir: dir, basePath: '' });
      expect(result.status).toBe('broken');
      if (result.status === 'broken') {
        // Distinguish the non-zero-exit branch from the ENOENT branch above so a
        // regression collapsing the two is caught.
        expect(result.reason).toContain('failed from');
        expect(result.reason).not.toContain('did not resolve');
      }
    } finally {
      cleanup();
    }
  });
});
