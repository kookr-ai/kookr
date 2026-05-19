// RFC 018 §11 — relevance-gate verdict schema (vendored).
//
// This is a deliberate VENDORED COPY of the `gate_verdict` schema artifact
// from knowledge-base-mcp-server (`src/relevance-gate-schema.ts`,
// `kb.relevance-gate.v1`). RFC 018 §11: "The Kookr hook imports/copies this
// schema and validates what it receives — so a schema change is caught at
// the hook's test layer, not silently at runtime. There is deliberately no
// version token; the schema artifact plus contract tests on both sides is
// the mechanism."
//
// If the kb-mcp-server schema changes, `kb-context-injection.test.ts` will
// fail against a real `kb search` payload — that is the intended drift
// signal. Keep this file structurally identical to the upstream artifact.

import { z } from 'zod';

export const RELEVANCE_GATE_SCHEMA_VERSION = 'kb.relevance-gate.v1';

export const relevanceGateVerdictSchema = z.object({
  schema_version: z.literal(RELEVANCE_GATE_SCHEMA_VERSION),
  state: z.enum(['bypassed', 'empty-index', 'injected', 'no-relevant-context']),
  low_confidence: z.boolean(),
  input_count: z.number().int().nonnegative(),
  output_count: z.number().int().nonnegative(),
  dropped: z.array(
    z.object({
      id: z.string(),
      stage: z.string(),
      reason: z.string(),
    }),
  ),
  judge: z.object({
    status: z.enum(['not-run', 'skipped', 'succeeded', 'failed']),
    reason: z.string().optional(),
    model: z.string().nullable().optional(),
  }),
  empty_verdict_enabled: z.boolean(),
});

export type RelevanceGateVerdict = z.infer<typeof relevanceGateVerdictSchema>;

/**
 * Validate an untrusted `gate_verdict` object against the vendored schema.
 * Throws {@link RelevanceGateSchemaError} on any mismatch — the hook
 * fail-opens on the throw, so a contract break never silently injects
 * mis-shaped context.
 */
export function parseRelevanceGateVerdict(value: unknown): RelevanceGateVerdict {
  const result = relevanceGateVerdictSchema.safeParse(value);
  if (!result.success) {
    throw new RelevanceGateSchemaError(
      `gate_verdict failed ${RELEVANCE_GATE_SCHEMA_VERSION} validation: ${result.error.message}`,
    );
  }
  return result.data;
}

export class RelevanceGateSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelevanceGateSchemaError';
  }
}
