/**
 * Grok Build compatibility gate (issue #1343, RFC "Binary identity, readiness,
 * and compatibility" §2 + §3).
 *
 * Adapter build-qualification derives SOLELY from the reviewed
 * `grok-build-compatibility.v1` manifest — there is NO duplicate hard-coded
 * allowlist in the adapter. The manifest DATA (which exact build/platform is
 * `tested`, and its gate verdicts) lives in
 * `docs/poc/009-grok-build-basic-supervision/grok-build-compatibility.v1.json`;
 * its authoritative zod schema and the canonical `qualifyBuild` live beside it
 * under `docs/poc/` and are schema-validated in CI by
 * `scripts/grok-build-compatibility-manifest.test.ts`.
 *
 * This module cannot import that schema at build time (it sits outside the
 * server tsconfig `rootDir: src`), so it reads the JSON at runtime and applies
 * qualification logic byte-identical to the schema's `qualifyBuild`. A unit
 * test pins the two in agreement. Only fields the adapter consumes are
 * validated here; the full-schema validation remains the CI test's job.
 *
 * An installed binary is `tested` only when (a) the manifest itself qualifies
 * as `tested` (reviewed AND every hard gate pass/warn) AND (b) the running
 * binary's exact identity (version + build id + sha256) and platform match the
 * manifest. Any mismatch — a newer build, a different arch, a tampered digest —
 * is `unknown`, and unknown builds may run ONLY inside the POC runner, never as
 * a managed Kookr task.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InstalledBinaryIdentity } from './probe-agent-binary.js';

const moduleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

/** Env override for the manifest location; else the in-repo reviewed path. */
export const GROK_COMPAT_MANIFEST_ENV = 'KOOKR_GROK_COMPAT_MANIFEST';

const DEFAULT_MANIFEST_REL =
  'docs/poc/009-grok-build-basic-supervision/grok-build-compatibility.v1.json';

export type BuildReviewStatus = 'tested' | 'unknown' | 'known-incompatible';

/** The subset of the reviewed manifest the adapter consumes. */
export interface CompatibilityRecord {
  version: string;
  buildId: string;
  sha256: string;
  platform: { os: string; arch: string; libc: string };
  reviewStatus: BuildReviewStatus;
  decision: 'proceed' | 'constrained-proceed' | 'evaluate-acp' | 'stop';
  /** Manifest-level qualification (reviewed AND all hard gates pass/warn). */
  manifestQualification: BuildReviewStatus;
  /** The exact build string for diagnostics/evidence, e.g. "0.2.93 (f00f96316d)". */
  evidenceBuildId: string;
}

export interface LoadManifestOk {
  kind: 'ok';
  record: CompatibilityRecord;
}
export interface LoadManifestError {
  kind: 'error';
  reason: string;
}
export type LoadManifestResult = LoadManifestOk | LoadManifestError;

/** Resolve the manifest path: env override → in-repo reviewed manifest. */
export function resolveCompatibilityManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[GROK_COMPAT_MANIFEST_ENV];
  if (override && override.trim()) return override.trim();
  return resolve(moduleDir, '..', '..', DEFAULT_MANIFEST_REL);
}

/**
 * Load + minimally validate the reviewed compatibility manifest. Returns a
 * structured error (never throws) when the manifest is missing or malformed, so
 * the adapter degrades to `unknown` with an actionable reason rather than
 * crashing startup.
 */
export function loadCompatibilityRecord(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
  exists: (p: string) => boolean = existsSync,
): LoadManifestResult {
  const path = resolveCompatibilityManifestPath(env);
  if (!exists(path)) {
    return { kind: 'error', reason: `compatibility manifest not found at ${path}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(path));
  } catch (err) {
    return { kind: 'error', reason: `compatibility manifest is not valid JSON: ${describe(err)}` };
  }
  return interpretManifest(raw, path);
}

function interpretManifest(raw: unknown, path: string): LoadManifestResult {
  if (!isObject(raw) || raw.schema !== 'grok-build-compatibility.v1') {
    return { kind: 'error', reason: `manifest at ${path} is not a grok-build-compatibility.v1 document` };
  }
  const binary = raw.binary;
  const platform = raw.platform;
  const gates = raw.gates;
  if (!isObject(binary) || !isObject(platform) || !Array.isArray(gates)) {
    return { kind: 'error', reason: `manifest at ${path} is missing binary/platform/gates` };
  }
  const version = asString(binary.version);
  const buildId = asString(binary.buildId);
  const sha256 = asString(binary.sha256);
  const reviewStatus = asReviewStatus(raw.reviewStatus);
  const decision = asDecision(raw.decision);
  if (!version || !buildId || !sha256 || !reviewStatus || !decision) {
    return { kind: 'error', reason: `manifest at ${path} has malformed binary/reviewStatus/decision fields` };
  }

  // Mirror docs/poc/…schema.ts `qualifyBuild`: a `tested` review qualifies only
  // when every hard gate passes (warn tolerated); otherwise it is
  // known-incompatible. A non-`tested` review status passes through verbatim.
  const hardGatesOk = gates.every((g) => {
    const verdict = isObject(g) ? g.verdict : undefined;
    return verdict === 'pass' || verdict === 'warn';
  });
  const manifestQualification: BuildReviewStatus =
    reviewStatus !== 'tested' ? reviewStatus : hardGatesOk ? 'tested' : 'known-incompatible';

  return {
    kind: 'ok',
    record: {
      version,
      buildId,
      sha256,
      platform: {
        os: asString(platform.os) ?? '',
        arch: asString(platform.arch) ?? '',
        libc: asString(platform.libc) ?? '',
      },
      reviewStatus,
      decision,
      manifestQualification,
      evidenceBuildId: `${version} (${buildId})`,
    },
  };
}

export interface QualificationResult {
  status: BuildReviewStatus;
  reason: string;
  /** The manifest's evidence build id, for the supervision-status surface. */
  evidenceBuildId?: string;
}

/**
 * Qualify a resolved installed identity against the reviewed manifest record.
 * `tested` requires an exact identity match (version + build id + sha256) on the
 * manifest's platform tuple; anything else is `unknown` (POC-runner-only).
 * `platform` describes the host so an arch/libc mismatch is reported precisely.
 */
export function qualifyInstalledBuild(
  identity: Pick<InstalledBinaryIdentity, 'sha256'> & { version: string; buildId: string },
  host: { os: string; arch: string; libc?: string },
  record: CompatibilityRecord,
): QualificationResult {
  const evidenceBuildId = record.evidenceBuildId;
  if (record.manifestQualification !== 'tested') {
    return {
      status: record.manifestQualification,
      reason:
        record.manifestQualification === 'known-incompatible'
          ? `reviewed build ${evidenceBuildId} is known-incompatible (a hard gate did not pass)`
          : `no tested build is recorded in the compatibility manifest`,
      evidenceBuildId,
    };
  }

  const mismatches: string[] = [];
  if (identity.version !== record.version) mismatches.push(`version ${identity.version}≠${record.version}`);
  if (identity.buildId !== record.buildId) mismatches.push(`buildId ${identity.buildId}≠${record.buildId}`);
  if (identity.sha256 !== record.sha256) mismatches.push('sha256 digest');
  if (host.os !== record.platform.os) mismatches.push(`os ${host.os}≠${record.platform.os}`);
  if (host.arch !== record.platform.arch) mismatches.push(`arch ${host.arch}≠${record.platform.arch}`);

  if (mismatches.length > 0) {
    return {
      status: 'unknown',
      reason: `installed binary does not match the tested build (${mismatches.join(', ')}); unknown builds run only in the POC runner`,
      evidenceBuildId,
    };
  }
  return {
    status: 'tested',
    reason: `matches reviewed tested build ${evidenceBuildId} on ${record.platform.os}/${record.platform.arch}`,
    evidenceBuildId,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function asReviewStatus(v: unknown): BuildReviewStatus | undefined {
  return v === 'tested' || v === 'unknown' || v === 'known-incompatible' ? v : undefined;
}
function asDecision(v: unknown): CompatibilityRecord['decision'] | undefined {
  return v === 'proceed' || v === 'constrained-proceed' || v === 'evaluate-acp' || v === 'stop'
    ? v
    : undefined;
}
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
