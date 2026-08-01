/**
 * Durable settings-mutation audit trail (issue #1710 / #1699 WS0.4).
 *
 * Every successful settings write records who changed what so capacity-
 * changing knobs (`maxActiveTasks`, kill-switch, etc.) leave a forensic trail.
 * Reuses the shared `audit.jsonl` append path.
 */

import { appendAuditRow } from './audit-log.js';

export const SETTINGS_MUTATION_AUDIT_TYPE = 'settings.mutation' as const;

export interface SettingsMutationAuditActor {
  source: 'api' | 'websocket' | 'system' | 'unknown';
  actorId: string;
}

export interface SettingsMutationAuditRow {
  type: typeof SETTINGS_MUTATION_AUDIT_TYPE;
  timestamp: string;
  actor: SettingsMutationAuditActor;
  /** Field names whose values changed (stable, sorted). */
  changedKeys: string[];
  /** Previous values for changed keys only. */
  previous: Record<string, unknown>;
  /** New values for changed keys only. */
  next: Record<string, unknown>;
}

/**
 * Diff two plain settings objects. Only top-level keys that are present on
 * either side and whose JSON-serialized values differ are reported — nested
 * objects (shortcut bindings, agent effort) are compared as a whole.
 */
export function diffSettingsValues(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): { changedKeys: string[]; previous: Record<string, unknown>; next: Record<string, unknown> } {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changedKeys: string[] = [];
  const prevOut: Record<string, unknown> = {};
  const nextOut: Record<string, unknown> = {};

  for (const key of [...keys].sort()) {
    const a = previous[key];
    const b = next[key];
    if (stableStringify(a) === stableStringify(b)) continue;
    changedKeys.push(key);
    prevOut[key] = a === undefined ? null : a;
    nextOut[key] = b === undefined ? null : b;
  }

  return { changedKeys, previous: prevOut, next: nextOut };
}

export function buildSettingsMutationAuditRow(input: {
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
  actor: SettingsMutationAuditActor;
  timestamp?: string;
}): SettingsMutationAuditRow | null {
  const diff = diffSettingsValues(input.previous, input.next);
  if (diff.changedKeys.length === 0) return null;
  return {
    type: SETTINGS_MUTATION_AUDIT_TYPE,
    timestamp: input.timestamp ?? new Date().toISOString(),
    actor: input.actor,
    changedKeys: diff.changedKeys,
    previous: diff.previous,
    next: diff.next,
  };
}

/** Best-effort append; never throws into the settings write path. */
export async function appendSettingsMutationAudit(
  auditLogPath: string | undefined,
  row: SettingsMutationAuditRow | null,
): Promise<void> {
  if (!row) return;
  await appendAuditRow(auditLogPath, row as unknown as Record<string, unknown>);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '__undefined__';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
