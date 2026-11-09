import { describe, expect, it } from 'vitest';
import {
  isOpenCodeEnabled,
  OPENCODE_PINNED_VERSION,
  pinnedOpenCodeToolPath,
  preflightOpenCode,
  resolveOpenCodeBin,
} from './opencode-preflight.js';
import type { ProbeExecRunner } from './probe-agent-binary.js';

const versionExec = (out: string): ProbeExecRunner => async (_f, args) => {
  if (args.includes('--version')) return { stdout: out, stderr: '' };
  throw new Error('no --help');
};

describe('resolveOpenCodeBin', () => {
  it('prefers KOOKR_OPENCODE_BIN', () => {
    expect(resolveOpenCodeBin({ KOOKR_OPENCODE_BIN: '/x/opencode' }, { exists: () => true })).toEqual({
      bin: '/x/opencode',
      configuredVia: 'env',
    });
  });

  it('uses the pinned tools install when it exists', () => {
    const r = resolveOpenCodeBin({}, { home: '/h', exists: (p) => p === pinnedOpenCodeToolPath('/h') });
    expect(r).toEqual({ bin: '/h/.kookr/tools/opencode-1.19.5/node_modules/.bin/opencode', configuredVia: 'default' });
  });

  it('falls back to PATH', () => {
    expect(resolveOpenCodeBin({}, { exists: () => false })).toEqual({ bin: 'opencode', configuredVia: 'default' });
  });
});

describe('preflightOpenCode', () => {
  const resolution = { bin: '/bin/opencode', configuredVia: 'env' as const };

  it('accepts the pinned version', async () => {
    const r = await preflightOpenCode({ env: {}, resolution, exec: versionExec(`${OPENCODE_PINNED_VERSION}\n`) });
    expect(r).toMatchObject({ kind: 'ok', resolvedPath: '/bin/opencode', version: '1.19.5' });
  });

  it('rejects a different version', async () => {
    const r = await preflightOpenCode({ env: {}, resolution, exec: versionExec('2.2.0\n') });
    expect(r).toMatchObject({ kind: 'absent', configuredVia: 'env', envVarName: 'KOOKR_OPENCODE_BIN' });
    expect((r as { reason: string }).reason).toContain('pinned 1.19.5');
  });

  it('accepts any version with the override', async () => {
    const r = await preflightOpenCode({
      env: { KOOKR_OPENCODE_ALLOW_ANY_VERSION: '1' },
      resolution,
      exec: versionExec('2.2.0\n'),
    });
    expect(r).toMatchObject({ kind: 'ok', version: '2.2.0' });
  });

  it('reports absent when the binary does not respond', async () => {
    const exec: ProbeExecRunner = async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    };
    const r = await preflightOpenCode({ env: {}, resolution: { bin: 'opencode', configuredVia: 'default' }, exec });
    expect(r).toMatchObject({ kind: 'absent', configuredVia: 'default' });
  });
});

describe('isOpenCodeEnabled', () => {
  it('is off unless KOOKR_OPENCODE_ENABLED is 1/true/yes', () => {
    expect(isOpenCodeEnabled({})).toBe(false);
    expect(isOpenCodeEnabled({ KOOKR_OPENCODE_ENABLED: '0' })).toBe(false);
    for (const v of ['1', 'true', 'YES']) expect(isOpenCodeEnabled({ KOOKR_OPENCODE_ENABLED: v })).toBe(true);
  });
});
