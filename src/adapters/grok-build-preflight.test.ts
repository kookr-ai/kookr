import { describe, it, expect } from 'vitest';
import {
  parseGrokVersionOutput,
  resolveHostPlatform,
  resolveGrokInstalledState,
} from './grok-build-preflight.js';
import { resolveInstalledBinaryIdentity } from './probe-agent-binary.js';
import type { CompatibilityRecord, LoadManifestResult } from './grok-build-compatibility.js';

describe('parseGrokVersionOutput', () => {
  it('parses version, buildId, and channel from the standard format', () => {
    const result = parseGrokVersionOutput('grok 0.2.93 (f00f96316d) [stable]\n');
    expect(result).toEqual({ version: '0.2.93', buildId: 'f00f96316d', channel: 'stable' });
  });

  it('parses version and buildId with no channel present', () => {
    const result = parseGrokVersionOutput('grok 0.3.0 (abcdef1234)');
    expect(result).not.toBeNull();
    expect(result?.version).toBe('0.3.0');
    expect(result?.buildId).toBe('abcdef1234');
    expect(result?.channel).toBeUndefined();
  });

  it('returns null for unrecognized output', () => {
    expect(parseGrokVersionOutput('not grok output')).toBeNull();
  });
});

describe('resolveHostPlatform', () => {
  it('maps linux/x64 to linux/x86_64', () => {
    expect(resolveHostPlatform({ platform: 'linux', arch: 'x64' })).toEqual({
      os: 'linux',
      arch: 'x86_64',
    });
  });

  it('maps darwin/arm64 to darwin/arm64', () => {
    expect(resolveHostPlatform({ platform: 'darwin', arch: 'arm64' })).toEqual({
      os: 'darwin',
      arch: 'arm64',
    });
  });
});

describe('resolveInstalledBinaryIdentity', () => {
  it('resolves canonical identity with fully injected deps', async () => {
    const sha256 = '4e07' + '0'.repeat(60);
    const result = await resolveInstalledBinaryIdentity('grok', {
      resolveExecutablePath: async () => '/x/.grok/bin/grok',
      realpath: async () => '/x/.grok/bin/grok-0.2.93',
      stat: async () => ({ size: 159465672, mode: 0o755, uid: 1000, gid: 1000 }),
      hashFile: async () => sha256,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.identity.canonicalPath).toBe('/x/.grok/bin/grok-0.2.93');
      expect(result.identity.sha256).toBe(sha256);
      expect(result.identity.sizeBytes).toBe(159465672);
    }
  });

  it('returns absent with a not-found-on-PATH reason when unresolved', async () => {
    const result = await resolveInstalledBinaryIdentity('grok', {
      resolveExecutablePath: async () => null,
    });
    expect(result.kind).toBe('absent');
    if (result.kind === 'absent') {
      expect(result.reason).toContain('not found on PATH');
    }
  });
});

describe('resolveGrokInstalledState', () => {
  const sha256 = '4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135';
  const host = { os: 'linux', arch: 'x86_64' };

  const identityFs = {
    resolveExecutablePath: async () => '/x/.grok/bin/grok',
    realpath: async () => '/x/.grok/bin/grok-0.2.93',
    stat: async () => ({ size: 159465672, mode: 0o755, uid: 1000, gid: 1000 }),
    hashFile: async () => sha256,
  };

  const testedRecord: CompatibilityRecord = {
    version: '0.2.93',
    buildId: 'f00f96316d',
    sha256,
    platform: { os: 'linux', arch: 'x86_64', libc: 'glibc 2.35' },
    reviewStatus: 'tested',
    decision: 'constrained-proceed',
    manifestQualification: 'tested',
    evidenceBuildId: '0.2.93 (f00f96316d)',
  };

  it('resolves an ok state with tested qualification', async () => {
    const result = await resolveGrokInstalledState({
      agentBin: 'grok',
      exec: async () => ({ stdout: 'grok 0.2.93 (f00f96316d) [stable]', stderr: '' }),
      identityFs,
      loadRecord: (): LoadManifestResult => ({ kind: 'ok', record: testedRecord }),
      host,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.qualification.status).toBe('tested');
    }
  });

  it('returns absent when exec throws ENOENT', async () => {
    const result = await resolveGrokInstalledState({
      agentBin: 'grok',
      exec: async () => {
        const e = new Error('nope') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
      identityFs,
      loadRecord: (): LoadManifestResult => ({ kind: 'ok', record: testedRecord }),
      host,
    });
    expect(result.kind).toBe('absent');
    if (result.kind === 'absent') {
      expect(result.reason).toContain('not found');
    }
  });

  it('returns absent with "not recognized" reason for unrecognized stdout', async () => {
    const result = await resolveGrokInstalledState({
      agentBin: 'grok',
      exec: async () => ({ stdout: 'bad', stderr: '' }),
      identityFs,
      loadRecord: (): LoadManifestResult => ({ kind: 'ok', record: testedRecord }),
      host,
    });
    expect(result.kind).toBe('absent');
    if (result.kind === 'absent') {
      expect(result.reason).toContain('not recognized');
    }
  });

  it('degrades to unknown qualification when the manifest fails to load', async () => {
    const result = await resolveGrokInstalledState({
      agentBin: 'grok',
      exec: async () => ({ stdout: 'grok 0.2.93 (f00f96316d) [stable]', stderr: '' }),
      identityFs,
      loadRecord: (): LoadManifestResult => ({ kind: 'error', reason: 'missing' }),
      host,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.qualification.status).toBe('unknown');
    }
  });
});
