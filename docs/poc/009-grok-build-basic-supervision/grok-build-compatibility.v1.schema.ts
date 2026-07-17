/**
 * Schema for the Grok-specific `grok-build-compatibility.v1` manifest (issue #1339,
 * RFC "Binary identity, readiness, and compatibility" §3).
 *
 * This manifest is the SOLE reviewed source of truth for whether an exact Grok
 * Build build/platform/plugin/probe revision is `tested`, `unknown`, or
 * `known-incompatible`. It is intentionally local, repo-reviewed, and
 * Grok-specific — NOT a signed registry or provider-neutral conformance format.
 *
 * POC-A deliverable: the schema + one reviewed instance. Phase 1's adapter
 * qualification must derive from this manifest rather than a duplicate
 * hard-coded allowlist (verified by scripts/grok-build-compatibility-manifest.test.ts).
 *
 * Kept under docs/poc/ (schema-owned data path) per the RFC; not production code.
 */
import { z } from 'zod';

export const GATE_IDS = [
  'additive_hook_injection',
  'minimum_supervision',
  'permission_visibility',
  'toolkit_discovery',
  'toolkit_invocation',
  'instruction_discovery',
  'instruction_following',
  'interactive_dtach',
  'stable_outcome',
  'child_control',
  'process_ownership',
] as const;

export const GateVerdict = z.enum(['pass', 'fail', 'blocked', 'warn']);

export const GateResult = z.object({
  id: z.enum(GATE_IDS),
  verdict: GateVerdict,
  /** Human-readable one-line justification tied to captured evidence. */
  evidence: z.string().min(1),
  /** Relative paths (from this manifest) to redacted fixtures backing the verdict. */
  fixtureRefs: z.array(z.string()).default([]),
});

export const PlatformTuple = z.object({
  os: z.string().min(1),        // e.g. "linux"
  arch: z.string().min(1),      // e.g. "x86_64"
  libc: z.string().min(1),      // e.g. "glibc 2.35"
  kernel: z.string().min(1),    // e.g. "6.6.87.2-microsoft-standard-WSL2"
  distro: z.string().optional(),
});

export const BinaryIdentity = z.object({
  packageName: z.string().min(1),     // "@xai-official/grok"
  version: z.string().min(1),         // "0.2.93"
  buildId: z.string().min(1),         // advertised build id, e.g. "f00f96316d"
  canonicalPath: z.string().min(1),   // resolved realpath actually executed
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive(),
  npmIntegrity: z.string().optional(),
  ownership: z.string().optional(),   // e.g. "jean:jean 755"
});

/**
 * An additional qualified build the operator runs beside the primary reviewed
 * build — e.g. a locally-built, Kookr-adapted Grok fork. Self-describing so its
 * qualification derives from ITS OWN reviewStatus + gates, never inherited from
 * the primary entry. The qualifier matches an installed identity against the
 * primary AND every `compatibleBuilds` entry; a match on any `tested` entry
 * qualifies the running binary.
 */
export const CompatibleBuild = z.object({
  binary: BinaryIdentity,
  platform: PlatformTuple,
  reviewStatus: z.enum(['tested', 'unknown', 'known-incompatible']),
  /** This build's own gate verdicts — NOT copied from the primary entry. */
  gates: z.array(GateResult).min(1),
  decision: z.enum(['proceed', 'constrained-proceed', 'evaluate-acp', 'stop']),
  /** Where the evidence came from (a run-poc.sh re-run, or observed runtime capture). */
  probeRevision: z.string().min(1),
  capturedAt: z.string().min(1),
  reviewedBy: z.string().optional(),
  pluginRevision: z.string().optional(),
  selectedModel: z.string().optional(),
  authCategory: z.enum(['oauth', 'api-key', 'device-code', 'none']).optional(),
  constraints: z.array(z.string()).default([]),
});

export type CompatibleBuild = z.infer<typeof CompatibleBuild>;

export const CompatibilityManifest = z.object({
  schema: z.literal('grok-build-compatibility.v1'),
  binary: BinaryIdentity,
  platform: PlatformTuple,
  /** SHA/label of the probe runner (run-poc.sh) that produced the evidence. */
  probeRevision: z.string().min(1),
  /** Revision/version of the injected Kookr plugin fixture used. */
  pluginRevision: z.string().min(1),
  authCategory: z.enum(['oauth', 'api-key', 'device-code', 'none']),
  selectedModel: z.string().min(1),
  capturedAt: z.string().min(1),
  reviewStatus: z.enum(['tested', 'unknown', 'known-incompatible']),
  reviewedBy: z.string().optional(),
  gates: z.array(GateResult).min(1),
  /** Exactly one of the four RFC decision outcomes. */
  decision: z.enum(['proceed', 'constrained-proceed', 'evaluate-acp', 'stop']),
  /** Free-form constraints/notes that Phase 1 must honor. */
  constraints: z.array(z.string()).default([]),
  /**
   * Additional qualified builds beyond the primary reviewed `binary` (e.g. an
   * operator's Kookr-adapted Grok fork). Each carries its own identity, gates,
   * and review status. Optional and defaults to empty, so pre-existing
   * single-build manifests remain valid unchanged.
   */
  compatibleBuilds: z.array(CompatibleBuild).default([]),
});

export type CompatibilityManifest = z.infer<typeof CompatibilityManifest>;

/**
 * The shared qualification rule, applied identically to the primary build and
 * to every {@link CompatibleBuild}: a build is only `tested` when it was
 * reviewed AND every hard gate passes (`warn` tolerated). A non-`tested`
 * review status passes through verbatim.
 */
export function qualifyReviewedGates(
  reviewStatus: 'tested' | 'unknown' | 'known-incompatible',
  gates: ReadonlyArray<{ verdict: z.infer<typeof GateVerdict> }>,
): 'tested' | 'unknown' | 'known-incompatible' {
  if (reviewStatus !== 'tested') return reviewStatus;
  const hardGatesOk = gates.every((g) => g.verdict === 'pass' || g.verdict === 'warn');
  return hardGatesOk ? 'tested' : 'known-incompatible';
}

/** Runtime qualification of the PRIMARY build, derived SOLELY from the manifest. */
export function qualifyBuild(
  m: CompatibilityManifest,
): 'tested' | 'unknown' | 'known-incompatible' {
  return qualifyReviewedGates(m.reviewStatus, m.gates);
}
