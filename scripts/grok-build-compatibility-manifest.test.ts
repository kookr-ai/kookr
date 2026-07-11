/**
 * CI schema-validation for the POC-A `grok-build-compatibility.v1` manifest
 * (issue #1339, Phase 0A). The RFC requires CI to schema-validate the manifest
 * and verify that adapter qualification derives from it rather than a duplicate
 * hard-coded allowlist. There is no adapter yet (Phase 1), so this test locks in
 * the manifest contract and the single-source qualification helper now.
 *
 * The schema + manifest live under docs/poc/ (schema-owned data path); this test
 * lives under scripts/ so Vitest's include globs discover it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  CompatibilityManifest,
  qualifyBuild,
  GATE_IDS,
} from '../docs/poc/009-grok-build-basic-supervision/grok-build-compatibility.v1.schema.js';

const POC_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../docs/poc/009-grok-build-basic-supervision',
);
const MANIFEST_PATH = resolve(POC_DIR, 'grok-build-compatibility.v1.json');

describe('grok-build-compatibility.v1 manifest', () => {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  it('conforms to the grok-build-compatibility.v1 schema', () => {
    const parsed = CompatibilityManifest.parse(raw);
    expect(parsed.schema).toBe('grok-build-compatibility.v1');
    expect(parsed.binary.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records exactly one RFC decision from the allowed set', () => {
    const m = CompatibilityManifest.parse(raw);
    expect(['proceed', 'constrained-proceed', 'evaluate-acp', 'stop']).toContain(m.decision);
  });

  it('covers every POC-A hard gate id', () => {
    const m = CompatibilityManifest.parse(raw);
    const reported = new Set(m.gates.map((g) => g.id));
    for (const gate of GATE_IDS) {
      expect(reported.has(gate)).toBe(true);
    }
  });

  it('references only fixtures that exist on disk', () => {
    const m = CompatibilityManifest.parse(raw);
    for (const gate of m.gates) {
      for (const ref of gate.fixtureRefs) {
        expect(existsSync(resolve(POC_DIR, ref)), `${gate.id} → ${ref}`).toBe(true);
      }
    }
  });

  it('qualifies the build solely from the manifest (no duplicate allowlist)', () => {
    const m = CompatibilityManifest.parse(raw);
    const q = qualifyBuild(m);
    expect(['tested', 'unknown', 'known-incompatible']).toContain(q);
    // A `tested` manifest with any hard-gate failure must not qualify as tested.
    if (m.reviewStatus === 'tested' && m.gates.some((g) => g.verdict === 'fail')) {
      expect(q).toBe('known-incompatible');
    }
  });
});
