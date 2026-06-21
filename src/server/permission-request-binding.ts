import { createHash } from 'node:crypto';

import type { AgentEvent } from '../shared/contracts/agent-events.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';
import {
  DEFAULT_PERMISSION_APPROVAL_TTL_MS,
  MAX_PERMISSION_APPROVAL_TTL_MS,
  type PermissionApprovalPayload,
  type PermissionBindingValidation,
  type PermissionRequestBinding,
} from '../shared/contracts/permission-request-binding.js';

export type {
  PermissionApprovalPayload,
  PermissionBindingValidation,
  PermissionRequestBinding,
} from '../shared/contracts/permission-request-binding.js';

// Keep this layer-local: src/remote has an equivalent helper because remote
// load-purity forbids importing server/core/shared runtime modules.
type PermissionRequestEvent = Extract<AgentEvent, { type: 'permission_request' }>;

export function latestPermissionRequestEvent(events: readonly AgentEvent[]): PermissionRequestEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'permission_request') return event;
    // Terminal/input events close the active prompt, so an older permission
    // request must not be reused for a later approval.
    if (event.type === 'tool_result' || event.type === 'input_received' || event.type === 'tool_error') break;
  }
  return null;
}

export function buildPermissionRequestBinding(input: {
  sessionId: string;
  event: PermissionRequestEvent;
  detectedAt: Date | string;
  ttlMs?: number;
}): PermissionRequestBinding {
  const toolInputHash = hashValue(input.event.toolInput);
  const detectedAt = typeof input.detectedAt === 'string'
    ? new Date(input.detectedAt).toISOString()
    : input.detectedAt.toISOString();
  const requestId = hashValue({
    schema: 'permission-request-binding.v1',
    sessionId: input.sessionId,
    eventSeq: input.event.eventSeq ?? null,
    toolName: input.event.toolName,
    toolInputHash,
    detectedAt,
  });
  return {
    requestId,
    toolName: input.event.toolName,
    toolInputHash,
    detectedAt,
    ttlMs: input.ttlMs ?? DEFAULT_PERMISSION_APPROVAL_TTL_MS,
  };
}

export function validatePermissionApprovalBinding(input: {
  sessionId: string;
  events: readonly AgentEvent[];
  anomaly: Anomaly | null | undefined;
  payload: PermissionApprovalPayload | undefined;
  now?: Date;
}): PermissionBindingValidation {
  if (input.anomaly?.type !== 'permission_blocked') {
    return { ok: false, reason: 'session has no active permission finding' };
  }
  const event = latestPermissionRequestEvent(input.events);
  if (!event) return { ok: false, reason: 'session has no active permission request' };

  const supplied = parsePermissionRequestBinding(input.payload?.permissionRequest);
  if (!supplied) return { ok: false, reason: 'missing permission request binding' };
  if (!Number.isInteger(supplied.ttlMs) || supplied.ttlMs <= 0 || supplied.ttlMs > MAX_PERMISSION_APPROVAL_TTL_MS) {
    return { ok: false, reason: 'invalid permission request ttl' };
  }

  const expected = buildPermissionRequestBinding({
    sessionId: input.sessionId,
    event,
    detectedAt: input.anomaly.detectedAt,
    ttlMs: supplied.ttlMs,
  });
  if (supplied.requestId !== expected.requestId) return { ok: false, reason: 'permission request mismatch' };
  if (supplied.toolName !== expected.toolName) return { ok: false, reason: 'permission request tool mismatch' };
  if (supplied.toolInputHash !== expected.toolInputHash) return { ok: false, reason: 'permission request input mismatch' };
  if (supplied.detectedAt !== expected.detectedAt) return { ok: false, reason: 'permission request detection mismatch' };

  const expiresAt = Date.parse(supplied.detectedAt) + supplied.ttlMs;
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'invalid permission request detectedAt' };
  if ((input.now ?? new Date()).getTime() > expiresAt) {
    return { ok: false, reason: 'stale permission request approval' };
  }

  return { ok: true, binding: supplied };
}

function parsePermissionRequestBinding(value: unknown): PermissionRequestBinding | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PermissionRequestBinding>;
  if (
    typeof candidate.requestId !== 'string'
    || typeof candidate.toolName !== 'string'
    || typeof candidate.toolInputHash !== 'string'
    || typeof candidate.detectedAt !== 'string'
    || typeof candidate.ttlMs !== 'number'
  ) {
    return null;
  }
  return {
    requestId: candidate.requestId,
    toolName: candidate.toolName,
    toolInputHash: candidate.toolInputHash,
    detectedAt: candidate.detectedAt,
    ttlMs: candidate.ttlMs,
  };
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(object[key])}`
  )).join(',')}}`;
}
