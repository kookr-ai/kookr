import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../shared/contracts/agent-events.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';
import {
  DEFAULT_PERMISSION_APPROVAL_TTL_MS,
  MAX_PERMISSION_APPROVAL_TTL_MS,
} from '../shared/contracts/permission-request-binding.js';

import {
  buildPermissionRequestBinding,
  latestPermissionRequestEvent,
  validatePermissionApprovalBinding,
} from './permission-request-binding.js';

const SESSION_ID = 'session-1';
const DETECTED_AT = new Date('2026-05-15T19:00:00.000Z');
const NOW_WITHIN_TTL = new Date('2026-05-15T19:01:00.000Z');

type PermissionRequestEvent = Extract<AgentEvent, { type: 'permission_request' }>;

const permissionEvent: PermissionRequestEvent = {
  type: 'permission_request',
  sessionId: SESSION_ID,
  toolName: 'Bash',
  toolInput: { command: 'git push origin feature' },
  eventSeq: 7,
};

function permissionBlockedAnomaly(): Anomaly {
  return {
    agentId: SESSION_ID,
    type: 'permission_blocked',
    severity: 'warning',
    explanation: 'permission',
    detectedAt: DETECTED_AT,
  };
}

function validSuppliedBinding(overrides: Partial<Record<string, unknown>> = {}) {
  const base = buildPermissionRequestBinding({
    sessionId: SESSION_ID,
    event: permissionEvent,
    detectedAt: DETECTED_AT,
  });
  return { ...base, ...overrides };
}

function validate(options: {
  anomaly?: Anomaly | null;
  events?: readonly AgentEvent[];
  permissionRequest?: unknown;
  now?: Date;
}) {
  return validatePermissionApprovalBinding({
    sessionId: SESSION_ID,
    events: options.events ?? [permissionEvent],
    anomaly: 'anomaly' in options ? options.anomaly : permissionBlockedAnomaly(),
    payload: { permissionRequest: options.permissionRequest },
    now: options.now ?? NOW_WITHIN_TTL,
  });
}

describe('latestPermissionRequestEvent', () => {
  it('returns null for no events', () => {
    expect(latestPermissionRequestEvent([])).toBeNull();
  });

  it('returns the most recent permission_request event', () => {
    const older: PermissionRequestEvent = { ...permissionEvent, toolName: 'Read', eventSeq: 3 };
    const newer: PermissionRequestEvent = { ...permissionEvent, eventSeq: 9 };
    expect(latestPermissionRequestEvent([older, newer])).toBe(newer);
  });

  it.each([
    ['tool_result', { type: 'tool_result', sessionId: SESSION_ID, toolName: 'Bash' }],
    ['input_received', { type: 'input_received', sessionId: SESSION_ID }],
    ['tool_error', { type: 'tool_error', sessionId: SESSION_ID, toolName: 'Bash', error: 'boom', isInterrupt: false }],
  ] as const)('returns null when a %s event closed the prompt after the request', (_label, closingEvent) => {
    const events: AgentEvent[] = [permissionEvent, closingEvent as AgentEvent];
    expect(latestPermissionRequestEvent(events)).toBeNull();
  });

  it('stops the backward scan at the first closing event, ignoring older requests', () => {
    const events: AgentEvent[] = [
      permissionEvent,
      { type: 'tool_result', sessionId: SESSION_ID, toolName: 'Bash' },
    ];
    // The closing event precedes no later request, so nothing is reusable.
    expect(latestPermissionRequestEvent(events)).toBeNull();
  });

  it('finds a request that follows a closing event for an earlier prompt', () => {
    const laterRequest: PermissionRequestEvent = { ...permissionEvent, eventSeq: 11 };
    const events: AgentEvent[] = [
      permissionEvent,
      { type: 'tool_result', sessionId: SESSION_ID, toolName: 'Bash' },
      laterRequest,
    ];
    expect(latestPermissionRequestEvent(events)).toBe(laterRequest);
  });
});

describe('buildPermissionRequestBinding', () => {
  it('produces an identical binding for a Date and its ISO-string equivalent', () => {
    const fromDate = buildPermissionRequestBinding({
      sessionId: SESSION_ID,
      event: permissionEvent,
      detectedAt: DETECTED_AT,
    });
    const fromIso = buildPermissionRequestBinding({
      sessionId: SESSION_ID,
      event: permissionEvent,
      detectedAt: DETECTED_AT.toISOString(),
    });
    expect(fromIso).toEqual(fromDate);
    expect(fromIso.detectedAt).toBe(DETECTED_AT.toISOString());
  });

  it('defaults ttlMs to DEFAULT_PERMISSION_APPROVAL_TTL_MS', () => {
    const binding = buildPermissionRequestBinding({
      sessionId: SESSION_ID,
      event: permissionEvent,
      detectedAt: DETECTED_AT,
    });
    expect(binding.ttlMs).toBe(DEFAULT_PERMISSION_APPROVAL_TTL_MS);
  });

  it('honors an explicit ttlMs without affecting the requestId', () => {
    const withDefault = buildPermissionRequestBinding({
      sessionId: SESSION_ID,
      event: permissionEvent,
      detectedAt: DETECTED_AT,
    });
    const withCustom = buildPermissionRequestBinding({
      sessionId: SESSION_ID,
      event: permissionEvent,
      detectedAt: DETECTED_AT,
      ttlMs: 60_000,
    });
    expect(withCustom.ttlMs).toBe(60_000);
    // ttlMs is not part of the request identity.
    expect(withCustom.requestId).toBe(withDefault.requestId);
  });

  it('hashes toolInput independent of key order', () => {
    const reordered: PermissionRequestEvent = {
      ...permissionEvent,
      toolInput: { b: 2, a: 1, nested: { y: 2, x: 1 } },
    };
    const original: PermissionRequestEvent = {
      ...permissionEvent,
      toolInput: { a: 1, b: 2, nested: { x: 1, y: 2 } },
    };
    const hashA = buildPermissionRequestBinding({ sessionId: SESSION_ID, event: reordered, detectedAt: DETECTED_AT }).toolInputHash;
    const hashB = buildPermissionRequestBinding({ sessionId: SESSION_ID, event: original, detectedAt: DETECTED_AT }).toolInputHash;
    expect(hashA).toBe(hashB);
  });

  it('produces different hashes for different toolInput values', () => {
    const other: PermissionRequestEvent = { ...permissionEvent, toolInput: { command: 'rm -rf /' } };
    const hashA = buildPermissionRequestBinding({ sessionId: SESSION_ID, event: permissionEvent, detectedAt: DETECTED_AT }).toolInputHash;
    const hashB = buildPermissionRequestBinding({ sessionId: SESSION_ID, event: other, detectedAt: DETECTED_AT }).toolInputHash;
    expect(hashA).not.toBe(hashB);
  });
});

describe('validatePermissionApprovalBinding', () => {
  it('accepts a well-formed, fresh binding', () => {
    const supplied = validSuppliedBinding();
    const result = validate({ permissionRequest: supplied });
    expect(result).toEqual({ ok: true, binding: supplied });
  });

  it('rejects when the session has no active permission_blocked finding', () => {
    expect(validate({ anomaly: null, permissionRequest: validSuppliedBinding() })).toEqual({
      ok: false,
      reason: 'session has no active permission finding',
    });
  });

  it('rejects when the active finding is a different anomaly type', () => {
    const otherAnomaly: Anomaly = { ...permissionBlockedAnomaly(), type: 'needs_input' };
    expect(validate({ anomaly: otherAnomaly, permissionRequest: validSuppliedBinding() })).toEqual({
      ok: false,
      reason: 'session has no active permission finding',
    });
  });

  it('rejects when there is no active permission request event', () => {
    expect(validate({ events: [], permissionRequest: validSuppliedBinding() })).toEqual({
      ok: false,
      reason: 'session has no active permission request',
    });
  });

  it('rejects when the request event was closed by a terminal event', () => {
    const events: AgentEvent[] = [
      permissionEvent,
      { type: 'input_received', sessionId: SESSION_ID },
    ];
    expect(validate({ events, permissionRequest: validSuppliedBinding() })).toEqual({
      ok: false,
      reason: 'session has no active permission request',
    });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a non-object', 'not-an-object'],
    ['an object missing required fields', { requestId: 'x' }],
    ['an object with a non-string field', { ...validSuppliedBinding(), toolName: 42 }],
    ['an object with a non-number ttlMs', { ...validSuppliedBinding(), ttlMs: '5' }],
  ])('rejects a binding that is %s', (_label, permissionRequest) => {
    expect(validate({ permissionRequest })).toEqual({
      ok: false,
      reason: 'missing permission request binding',
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 1.5],
    ['above the max', MAX_PERMISSION_APPROVAL_TTL_MS + 1],
  ])('rejects a ttlMs that is %s', (_label, ttlMs) => {
    expect(validate({ permissionRequest: validSuppliedBinding({ ttlMs }) })).toEqual({
      ok: false,
      reason: 'invalid permission request ttl',
    });
  });

  it('accepts a ttlMs exactly at the maximum', () => {
    const supplied = validSuppliedBinding({ ttlMs: MAX_PERMISSION_APPROVAL_TTL_MS });
    // detectedAt + MAX_TTL, so keep `now` at detection time to stay fresh.
    const result = validate({ permissionRequest: supplied, now: DETECTED_AT });
    expect(result).toEqual({ ok: true, binding: supplied });
  });

  it('rejects a tampered requestId', () => {
    expect(validate({ permissionRequest: validSuppliedBinding({ requestId: 'tampered' }) })).toEqual({
      ok: false,
      reason: 'permission request mismatch',
    });
  });

  it('rejects a tampered toolName while the requestId still matches', () => {
    // Fields are checked independently; a mismatched toolName must be caught even
    // if the (client-supplied) requestId is left at its expected value.
    expect(validate({ permissionRequest: validSuppliedBinding({ toolName: 'Write' }) })).toEqual({
      ok: false,
      reason: 'permission request tool mismatch',
    });
  });

  it('rejects a tampered toolInputHash while the requestId still matches', () => {
    expect(validate({ permissionRequest: validSuppliedBinding({ toolInputHash: 'deadbeef' }) })).toEqual({
      ok: false,
      reason: 'permission request input mismatch',
    });
  });

  it('rejects a tampered detectedAt while the requestId still matches', () => {
    const supplied = validSuppliedBinding({ detectedAt: '2020-01-01T00:00:00.000Z' });
    expect(validate({ permissionRequest: supplied })).toEqual({
      ok: false,
      reason: 'permission request detection mismatch',
    });
  });

  it('rejects an approval that is past its freshness window', () => {
    const supplied = validSuppliedBinding({ ttlMs: 60_000 });
    // detectedAt 19:00 + 60s = 19:01:00; one ms later is stale.
    const now = new Date('2026-05-15T19:01:00.001Z');
    expect(validate({ permissionRequest: supplied, now })).toEqual({
      ok: false,
      reason: 'stale permission request approval',
    });
  });

  it('accepts an approval exactly at the freshness boundary', () => {
    const supplied = validSuppliedBinding({ ttlMs: 60_000 });
    const now = new Date('2026-05-15T19:01:00.000Z');
    expect(validate({ permissionRequest: supplied, now })).toEqual({ ok: true, binding: supplied });
  });
});

describe('validatePermissionApprovalBinding — defense-in-depth guard', () => {
  // The `invalid permission request detectedAt` branch (non-finite expiresAt) is
  // unreachable through the public API: to reach it, the supplied `detectedAt`
  // must equal the expected one (else the detection-mismatch guard fires first),
  // and the expected value is always `anomaly.detectedAt.toISOString()` — a
  // parseable ISO string. This test pins that invariant so a future refactor that
  // weakens the earlier guards surfaces the now-reachable branch.
  it('always rejects a mismatched detectedAt before reaching the parse guard', () => {
    const supplied = validSuppliedBinding({ detectedAt: 'not-a-date' });
    const result = validate({ permissionRequest: supplied });
    expect(result).toEqual({ ok: false, reason: 'permission request detection mismatch' });
  });
});
