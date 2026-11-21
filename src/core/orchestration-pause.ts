/**
 * Orchestration pause/resume — a first-class, thin wrapper over SAFE MODE
 * (issue #2672).
 *
 * The problem: when a coding-agent provider's weekly quota is about to run out,
 * the operator wants to *let in-flight work finish* and *stop the orchestrator
 * from starting more* until the window resets. Kookr already has the right
 * lever for that — SAFE MODE, the `automationKillSwitch` setting, which halts
 * autonomous schedule fires while leaving manual/child launches accepted. What
 * it lacked was a named "pause orchestration" surface a human (or the
 * orchestrator itself) can flip without hand-editing the whole settings
 * document, plus a durable record of who paused, why, and since when.
 *
 * This module is the pure core of that surface: the on-disk pause-record shape,
 * tolerant parsing (it must read the operator's hand-written v1 file), the
 * "is orchestration paused / should the orchestrator spawn" predicate, and the
 * soft-quota auto-pause/auto-resume decision with hysteresis. It touches no
 * filesystem, settings store, or clock — the server service
 * (`orchestration-pause-service.ts`) supplies those.
 *
 * Two pause kinds are deliberately distinct:
 *   - a **human pause** (`source: 'human'`) is sticky against auto-resume —
 *     `kookr orchestration resume --auto` will not lift it. An explicit
 *     `kookr orchestration resume` clears it, and so does a human turning the
 *     automation kill switch off when this record was created by that switch
 *     (issue #2743);
 *   - a **soft-quota pause** (`source: 'soft-quota'`) is the orchestrator's own
 *     standing-order response to near-exhausted quota — it auto-resumes once
 *     utilization falls back under the resume line or the window resets.
 */

import { join } from 'node:path';

import type { QuotaStatus, QuotaWindow } from './quota-types.js';

/** Who/what engaged an orchestration pause. Governs auto-resume eligibility. */
export type OrchestrationPauseSource = 'human' | 'soft-quota';

/**
 * The default agent's quota-utilization sample, as far as Kookr can observe it.
 * Only the Anthropic OAuth usage endpoint is wired (via `QuotaAdapter`), so a
 * sample exists only when the default agent is `claude-code`. For `grok-build`
 * (today's server default) no supported non-key signal exists — `supported` is
 * false with an explanatory `reason` (Phase B follow-up).
 */
export interface OrchestrationQuotaSample {
  /** The configured default agent this sample describes. */
  agentType: string;
  /** True when a quota-utilization signal exists for this agent. */
  supported: boolean;
  /** Utilization (0–100) of the more-constrained window; absent when unsampled. */
  utilization?: number;
  /** ISO 8601 reset time of the more-constrained window; absent when unsampled. */
  resetsAt?: string;
  /** Which window is currently limiting (the higher-utilization one). */
  window?: 'five-hour' | 'seven-day';
  /** Why no utilization is present (unsupported agent, or no live sample yet). */
  reason?: string;
}

/**
 * Durable pause records, persisted at
 * `~/.kookr/playbook-state/orchestrator/quota-pause.json`. Schema v3 adds
 * explicit lifecycle fields over the operator's hand-written v1/v2 file;
 * legacy records without an end are retained as unresolved history.
 */
export type PauseLifecycle = 'active' | 'ended' | 'cancelled' | 'unresolved';

export interface OrchestrationPauseRecord {
  schemaVersion: 3;
  /** Stable identifier used to correlate lifecycle updates and warnings. */
  id: string;
  /** Kept for compatibility; only `lifecycle: 'active'` is current. */
  paused: boolean;
  /** Explicit lifecycle. Legacy records without this field become unresolved. */
  lifecycle: PauseLifecycle;
  /** Human vs soft-quota — governs auto-resume eligibility. */
  source: OrchestrationPauseSource;
  /** Why the pause was engaged (the "why"). */
  reason: string;
  /** ISO 8601 timestamp the pause began (the "since"). */
  pausedAt: string;
  /** Who engaged it (the "who") — an operator name or `orchestrator`. */
  pausedBy: string;
  /**
   * The lever this pause rides on (the "what"). Kill-switch / SAFE MODE pauses
   * use `automationKillSwitch` (v1 files used `automationKillSwitch / SAFE MODE`).
   * A human turning that switch off closes only records created by it (#2743).
   */
  mechanism: string;
  /** ISO 8601 timestamp at which the pause was explicitly closed. */
  endedAt?: string;
  /** Who or what closed the pause. */
  endedBy?: string;
  /** Provenance for the close operation. */
  endSource?: string;
  /** Timestamp at which the system classified an incomplete record as unknown. */
  unresolvedAt?: string;
  /** Why the record was classified as unresolved. */
  unresolvedSource?: string;
  /** Soft-quota context captured when the orchestrator auto-paused. */
  quota?: OrchestrationQuotaSample;
  /** Free-form operator notes (preserved across reads). */
  notes?: string[];
}

export interface OrchestrationPauseState {
  schemaVersion: 3;
  records: OrchestrationPauseRecord[];
}

export interface PauseProvenance {
  /** The one explicitly active record, if any. */
  currentPause: OrchestrationPauseRecord | null;
  /** All retained records, including terminal and unresolved records. */
  history: OrchestrationPauseRecord[];
  /** Known overlap in the requested window; unresolved spans are excluded. */
  historicalOverlap: {
    windowStart: string;
    windowEnd: string;
    overlapMs: number;
    overlapFraction: number;
    completeRecordCount: number;
    incompleteRecordCount: number;
  };
  /** Records whose duration cannot be known from persisted evidence. */
  incompleteRecords: Array<{
    id: string;
    source: OrchestrationPauseSource;
    pausedAt: string;
    reason: string;
  }>;
}

/** Repo-relative-to-`~/.kookr` path of the pause record. */
export const ORCHESTRATION_PAUSE_REL_PATH = join(
  'playbook-state',
  'orchestrator',
  'quota-pause.json',
);

/** Absolute path of the pause record under a resolved kookr home dir. */
export function resolveOrchestrationPausePath(kookrDir: string): string {
  return join(kookrDir, ORCHESTRATION_PAUSE_REL_PATH);
}

/**
 * Utilization at/above which the orchestrator engages a soft-quota pause. The
 * window is *nearly* exhausted (not 100%): stop filling the fleet while
 * in-flight work drains the last of the quota.
 */
export const SOFT_QUOTA_PAUSE_AT = 95;
/**
 * Utilization at/below which a soft-quota pause auto-resumes. Kept well under
 * {@link SOFT_QUOTA_PAUSE_AT} so the pause cannot flap on and off (hysteresis).
 */
export const SOFT_QUOTA_RESUME_AT = 80;

/**
 * Tolerantly parse a raw pause record (from JSON on disk). Legacy v1/v2
 * records have no trustworthy terminal lifecycle and are therefore retained as
 * `unresolved`; they must not be mistaken for a currently active pause.
 */
export function parsePauseRecord(raw: unknown): OrchestrationPauseRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const source: OrchestrationPauseSource =
    r.source === 'soft-quota' ? 'soft-quota' : 'human';
  const paused = r.paused === true;
  const endedAt = typeof r.endedAt === 'string' && r.endedAt ? r.endedAt : undefined;
  const rawLifecycle = r.lifecycle;
  const lifecycle: PauseLifecycle =
    rawLifecycle === 'active' || rawLifecycle === 'ended' || rawLifecycle === 'cancelled'
      ? rawLifecycle
      : paused && !endedAt
        ? 'unresolved'
        : endedAt
          ? 'ended'
          : 'unresolved';
  const quota =
    r.quota && typeof r.quota === 'object'
      ? (r.quota as OrchestrationQuotaSample)
      : undefined;
  const notes = Array.isArray(r.notes)
    ? r.notes.filter((n): n is string => typeof n === 'string')
    : undefined;
  return {
    schemaVersion: 3,
    id:
      typeof r.id === 'string' && r.id.trim()
        ? r.id.trim()
        : `pause-${typeof r.pausedAt === 'string' ? r.pausedAt : 'unknown'}`,
    paused,
    lifecycle,
    source,
    reason: typeof r.reason === 'string' ? r.reason : '',
    pausedAt: typeof r.pausedAt === 'string' ? r.pausedAt : '',
    pausedBy: typeof r.pausedBy === 'string' ? r.pausedBy : 'unknown',
    mechanism:
      typeof r.mechanism === 'string' && r.mechanism.trim().length > 0
        ? r.mechanism.trim()
        : 'automationKillSwitch',
    ...(endedAt ? { endedAt } : {}),
    ...(typeof r.endedBy === 'string' && r.endedBy ? { endedBy: r.endedBy } : {}),
    ...(typeof r.endSource === 'string' && r.endSource ? { endSource: r.endSource } : {}),
    ...(typeof r.unresolvedAt === 'string' && r.unresolvedAt
      ? { unresolvedAt: r.unresolvedAt }
      : {}),
    ...(typeof r.unresolvedSource === 'string' && r.unresolvedSource
      ? { unresolvedSource: r.unresolvedSource }
      : {}),
    ...(quota ? { quota } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** Parse the current v3 ledger, or migrate a legacy single-record file. */
export function parsePauseState(raw: unknown): OrchestrationPauseState {
  if (raw && typeof raw === 'object') {
    const value = raw as Record<string, unknown>;
    if (Array.isArray(value.records)) {
      return {
        schemaVersion: 3,
        records: value.records
          .map((record) => parsePauseRecord(record))
          .filter((record): record is OrchestrationPauseRecord => record !== null),
      };
    }
  }
  const legacy = parsePauseRecord(raw);
  return { schemaVersion: 3, records: legacy ? [legacy] : [] };
}

/** Build a fresh active v3 pause record. */
export function buildPauseRecord(input: {
  source: OrchestrationPauseSource;
  reason: string;
  by: string;
  atIso: string;
  id?: string;
  quota?: OrchestrationQuotaSample;
  notes?: string[];
}): OrchestrationPauseRecord {
  return {
    schemaVersion: 3,
    id: input.id ?? `pause-${input.atIso}`,
    paused: true,
    lifecycle: 'active',
    source: input.source,
    reason: input.reason,
    pausedAt: input.atIso,
    pausedBy: input.by,
    mechanism: 'automationKillSwitch',
    ...(input.quota ? { quota: input.quota } : {}),
    ...(input.notes && input.notes.length > 0 ? { notes: input.notes } : {}),
  };
}

/** Close an active pause while retaining its original start provenance. */
export function closePauseRecord(
  record: OrchestrationPauseRecord,
  input: {
    lifecycle: 'ended' | 'cancelled';
    atIso: string;
    by: string;
    source: string;
  },
): OrchestrationPauseRecord {
  return {
    ...record,
    paused: false,
    lifecycle: input.lifecycle,
    endedAt: input.atIso,
    endedBy: input.by,
    endSource: input.source,
  };
}

/** Return true only for a lifecycle record that is explicitly active. */
export function isActivePauseRecord(record: OrchestrationPauseRecord | null): boolean {
  return record?.lifecycle === 'active';
}

/** Pick the newest explicit active record from a retained ledger. */
export function getCurrentPauseRecord(
  records: OrchestrationPauseRecord[],
): OrchestrationPauseRecord | null {
  return records
    .filter((record) => isActivePauseRecord(record))
    .sort((left, right) => Date.parse(right.pausedAt) - Date.parse(left.pausedAt))[0] ?? null;
}

/**
 * Build the audit payload consumed by status/health and future velocity probes.
 * Explicitly active records are measured through the window end; unresolved
 * records are never guessed into the known overlap and are surfaced as a
 * warning instead.
 */
export function buildPauseProvenance(
  records: OrchestrationPauseRecord[],
  input: { windowStartMs: number; windowEndMs: number },
): PauseProvenance {
  const windowStartMs = Math.min(input.windowStartMs, input.windowEndMs);
  const windowEndMs = Math.max(input.windowStartMs, input.windowEndMs);
  const incompleteRecords: PauseProvenance['incompleteRecords'] = [];
  const intervals: Array<[number, number]> = [];
  let completeRecordCount = 0;

  for (const record of records) {
    const startMs = Date.parse(record.pausedAt);
    const endMs = record.lifecycle === 'active'
      ? windowEndMs
      : record.endedAt ? Date.parse(record.endedAt) : Number.NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      incompleteRecords.push({
        id: record.id,
        source: record.source,
        pausedAt: record.pausedAt,
        reason: record.unresolvedSource ?? 'missing pause end timestamp',
      });
      continue;
    }
    const clippedStart = Math.max(startMs, windowStartMs);
    const clippedEnd = Math.min(endMs, windowEndMs);
    if (clippedEnd > clippedStart) intervals.push([clippedStart, clippedEnd]);
    completeRecordCount += 1;
  }

  intervals.sort(([left], [right]) => left - right);
  let overlapMs = 0;
  let mergedEndMs = Number.NEGATIVE_INFINITY;
  for (const [startMs, endMs] of intervals) {
    if (startMs > mergedEndMs) {
      overlapMs += endMs - startMs;
      mergedEndMs = endMs;
    } else if (endMs > mergedEndMs) {
      overlapMs += endMs - mergedEndMs;
      mergedEndMs = endMs;
    }
  }

  const windowMs = Math.max(1, windowEndMs - windowStartMs);
  return {
    currentPause: getCurrentPauseRecord(records),
    history: records,
    historicalOverlap: {
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
      overlapMs,
      overlapFraction: overlapMs / windowMs,
      completeRecordCount,
      incompleteRecordCount: incompleteRecords.length,
    },
    incompleteRecords,
  };
}

/**
 * True when this pause record was created by the automation kill switch
 * (SAFE MODE). A human turning that switch off is a resume of this record
 * (issue #2743). v1 files used `automationKillSwitch / SAFE MODE`.
 */
export function pauseRecordCreatedByKillSwitch(
  record: OrchestrationPauseRecord | null,
): boolean {
  if (
    !record
    || record.paused !== true
    || (record.lifecycle !== 'active' && record.lifecycle !== 'unresolved')
  ) return false;
  // v1 files used "automationKillSwitch / SAFE MODE"; v2 uses the literal.
  return record.mechanism.startsWith('automationKillSwitch');
}

/**
 * Is orchestration paused? Live SAFE MODE or an explicitly active on-disk
 * record counts. An unresolved legacy record is audit evidence only; treating
 * it as current would silently turn an unknown historical span into a gate.
 */
export function isOrchestrationPaused(input: {
  safeModeEngaged: boolean;
  record: OrchestrationPauseRecord | null;
}): boolean {
  return input.safeModeEngaged || isActivePauseRecord(input.record);
}

/**
 * Whether the orchestrator may spawn this run. The playbook consults this
 * (via `kookr orchestration status`) and spawns nothing while paused — the
 * code-level SAFE MODE gate stops *schedule* fires, but the orchestrator's own
 * children arrive over the API path, so honoring the pause is the playbook's
 * job. This predicate is that contract.
 */
export function orchestratorShouldSpawn(input: {
  safeModeEngaged: boolean;
  record: OrchestrationPauseRecord | null;
}): boolean {
  return !isOrchestrationPaused(input);
}

/**
 * Resolve the default agent's quota sample from the Anthropic `QuotaStatus`
 * snapshot. Only `claude-code` has a wired signal; anything else is reported
 * unsupported with a reason. When claude-code has a snapshot, the
 * more-constrained (higher-utilization) of the 5-hour / 7-day windows is the
 * limiting one — that is the utilization the soft-quota rule keys on.
 */
export function resolveDefaultAgentQuotaSample(
  agentType: string,
  quota: QuotaStatus | null,
): OrchestrationQuotaSample {
  if (agentType !== 'claude-code') {
    const reason =
      agentType === 'grok-build'
        ? 'no supported non-key Grok weekly-quota signal (session/OIDC only; XAI_API_KEY is disallowed) — Phase B follow-up, issue #2672'
        : `no quota-utilization adapter for agent "${agentType}"`;
    return { agentType, supported: false, reason };
  }
  if (!quota) {
    return { agentType, supported: true, reason: 'no live Anthropic quota sample yet' };
  }
  const candidates: Array<{ label: 'five-hour' | 'seven-day'; window: QuotaWindow | null }> = [
    { label: 'five-hour', window: quota.fiveHour },
    { label: 'seven-day', window: quota.sevenDay },
  ];
  let limiting: { label: 'five-hour' | 'seven-day'; window: QuotaWindow } | null = null;
  for (const { label, window } of candidates) {
    if (!window) continue;
    if (!limiting || window.utilization > limiting.window.utilization) {
      limiting = { label, window };
    }
  }
  if (!limiting) {
    return { agentType, supported: true, reason: 'no live Anthropic quota sample yet' };
  }
  return {
    agentType,
    supported: true,
    utilization: limiting.window.utilization,
    resetsAt: limiting.window.resetsAt,
    window: limiting.label,
  };
}

/** The action the soft-quota rule recommends this orchestrator run. */
export type SoftQuotaAction =
  | { action: 'pause'; reason: string }
  | { action: 'resume'; reason: string }
  | { action: 'none'; reason: string };

/**
 * The soft-quota auto-pause / auto-resume decision, with hysteresis (issue
 * #2672 Phase B). Pure: the caller supplies the utilization sample, current
 * time, and current pause state.
 *
 * Rules:
 *   - A **human pause** is sticky against auto-resume — never auto-resumed,
 *     never soft-repaused. An explicit human resume still lifts it.
 *   - With **no sample** (utilization null — e.g. the default agent is Grok,
 *     which has no supported non-key signal), no decision is possible.
 *   - While **soft-paused**, resume when utilization ≤ {@link SOFT_QUOTA_RESUME_AT}
 *     OR the window's reset time has passed.
 *   - While **not paused**, pause when utilization ≥ {@link SOFT_QUOTA_PAUSE_AT}.
 *   - Paused with no known-soft record (e.g. an external SAFE-MODE flip): leave
 *     it — do not auto-resume something the rule did not engage.
 */
export function evaluateSoftQuotaPause(input: {
  utilization: number | null;
  resetsAt: string | null;
  nowMs: number;
  record: OrchestrationPauseRecord | null;
  safeModeEngaged: boolean;
}): SoftQuotaAction {
  const { utilization, resetsAt, nowMs, record, safeModeEngaged } = input;
  const paused = isOrchestrationPaused({ safeModeEngaged, record });

  if (record?.lifecycle === 'unresolved') {
    return {
      action: 'none',
      reason: 'pause provenance is unresolved; do not infer a second quota pause',
    };
  }

  if (paused && record?.source === 'human') {
    return {
      action: 'none',
      reason: 'human pause is sticky; auto-resume will not lift it (explicit human resume or kill-switch-off will)',
    };
  }

  if (utilization === null) {
    return { action: 'none', reason: 'no default-agent quota sample available' };
  }

  if (paused) {
    if (record?.source !== 'soft-quota') {
      return {
        action: 'none',
        reason: 'paused outside the soft-quota rule; not auto-resuming',
      };
    }
    if (utilization <= SOFT_QUOTA_RESUME_AT) {
      return {
        action: 'resume',
        reason: `utilization ${utilization}% at/below ${SOFT_QUOTA_RESUME_AT}% resume line`,
      };
    }
    if (resetsAt !== null && Number.isFinite(Date.parse(resetsAt)) && Date.parse(resetsAt) <= nowMs) {
      return { action: 'resume', reason: `quota window reset (${resetsAt}) has passed` };
    }
    return {
      action: 'none',
      reason: `utilization ${utilization}% still above ${SOFT_QUOTA_RESUME_AT}% resume line (hysteresis hold)`,
    };
  }

  if (utilization >= SOFT_QUOTA_PAUSE_AT) {
    return {
      action: 'pause',
      reason: `utilization ${utilization}% at/above ${SOFT_QUOTA_PAUSE_AT}% stop line`,
    };
  }
  return {
    action: 'none',
    reason: `utilization ${utilization}% below ${SOFT_QUOTA_PAUSE_AT}% stop line`,
  };
}
