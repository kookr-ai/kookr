import { describe, it, expect } from 'vitest';
import {
  loadCompatibilityRecord,
  qualifyInstalledBuild,
  resolveCompatibilityManifestPath,
  GROK_COMPAT_MANIFEST_ENV,
} from './grok-build-compatibility.js';
import {
  CompatibilityManifest,
  qualifyBuild,
} from '../../docs/poc/009-grok-build-basic-supervision/grok-build-compatibility.v1.schema.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MANIFEST_PATH = resolve(
  __dirname,
  '../../docs/poc/009-grok-build-basic-supervision/grok-build-compatibility.v1.json',
);

describe('loadCompatibilityRecord (real reviewed manifest)', () => {
  it('loads the in-repo reviewed manifest by default', () => {
    const result = loadCompatibilityRecord();
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.record.reviewStatus).toBe('tested');
    expect(result.record.decision).toBe('constrained-proceed');
    expect(result.record.manifestQualification).toBe('tested');
    expect(result.record.version).toBe('0.2.101');
    expect(result.record.buildId).toBe('5bc4b5dfad');
    expect(result.record.evidenceBuildId).toBe('0.2.101 (5bc4b5dfad)');
  });
});

describe('qualifyInstalledBuild', () => {
  const loaded = loadCompatibilityRecord();
  if (loaded.kind !== 'ok') throw new Error('reviewed manifest failed to load for test setup');
  const record = loaded.record;

  it('is tested when identity and host exactly match the manifest record', () => {
    const result = qualifyInstalledBuild(
      {
        sha256: '2556299cded37f81e54c02420cfa7f1a2df9feab72a445869a0f5596e143b333',
        version: '0.2.101',
        buildId: '5bc4b5dfad',
      },
      { os: 'linux', arch: 'x86_64' },
      record,
    );
    expect(result.status).toBe('tested');
  });

  it('is unknown on a version mismatch, with the mismatch named in the reason', () => {
    const result = qualifyInstalledBuild(
      {
        sha256: '2556299cded37f81e54c02420cfa7f1a2df9feab72a445869a0f5596e143b333',
        version: '0.3.0',
        buildId: '5bc4b5dfad',
      },
      { os: 'linux', arch: 'x86_64' },
      record,
    );
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('version 0.3.0');
  });

  it('is unknown on a sha256 mismatch', () => {
    const result = qualifyInstalledBuild(
      {
        sha256: 'deadbeef00000000000000000000000000000000000000000000000000000000',
        version: '0.2.101',
        buildId: '5bc4b5dfad',
      },
      { os: 'linux', arch: 'x86_64' },
      record,
    );
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('sha256 digest');
  });

  it('is unknown on an arch mismatch', () => {
    const result = qualifyInstalledBuild(
      {
        sha256: '2556299cded37f81e54c02420cfa7f1a2df9feab72a445869a0f5596e143b333',
        version: '0.2.101',
        buildId: '5bc4b5dfad',
      },
      { os: 'linux', arch: 'arm64' },
      record,
    );
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('arch arm64');
  });
});

describe('single-source qualification agreement (RFC "no duplicate allowlist")', () => {
  it('src-derived manifestQualification agrees with the schema-canonical qualifyBuild', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const parsed = CompatibilityManifest.parse(raw);
    const canonical = qualifyBuild(parsed);

    const loaded = loadCompatibilityRecord();
    expect(loaded.kind).toBe('ok');
    if (loaded.kind !== 'ok') return;
    expect(loaded.record.manifestQualification).toBe(canonical);
    expect(canonical).toBe('tested');
  });
});

describe('loadCompatibilityRecord error paths', () => {
  it('returns an error when the manifest file does not exist', () => {
    const result = loadCompatibilityRecord(
      {},
      () => '',
      () => false,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toContain('not found');
    }
  });

  it('returns an error when the manifest is not valid JSON', () => {
    const result = loadCompatibilityRecord(
      {},
      () => '{bad json',
      () => true,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toContain('not valid JSON');
    }
  });

  it('returns an error when the manifest is missing the grok-build-compatibility.v1 schema tag', () => {
    const result = loadCompatibilityRecord(
      {},
      () => JSON.stringify({ binary: {}, platform: {}, gates: [] }),
      () => true,
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toContain('grok-build-compatibility.v1');
    }
  });

  it('derives known-incompatible when reviewStatus is tested but a gate verdict fails', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    raw.gates[0].verdict = 'fail';
    const modified = JSON.stringify(raw);

    const result = loadCompatibilityRecord(
      {},
      () => modified,
      () => true,
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.record.reviewStatus).toBe('tested');
      expect(result.record.manifestQualification).toBe('known-incompatible');
    }
  });
});

describe('resolveCompatibilityManifestPath', () => {
  it('honors the env override', () => {
    const path = resolveCompatibilityManifestPath({ [GROK_COMPAT_MANIFEST_ENV]: '/custom/path.json' });
    expect(path).toBe('/custom/path.json');
  });

  it('falls back to the in-repo reviewed manifest path', () => {
    const path = resolveCompatibilityManifestPath({});
    expect(path).toBe(MANIFEST_PATH);
  });
});
