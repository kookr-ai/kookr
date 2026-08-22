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
 * Durable pause record, persisted at
 * `~/.kookr/playbook-state/orchestrator/quota-pause.json`. Schema v2 adds the
 * explicit `source` field over the operator's hand-written v1 file; v1 records
 * (no `source`) are read as a human pause.
 */
export interface OrchestrationPauseRecord {
  schemaVersion: 2;
  /** True while orchestration is paused. */
  paused: boolean;
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
   * A human turning that switch off clears only records created by it (#2743).
   */
  mechanism: string;
  /** Soft-quota context captured when the orchestrator auto-paused. */
  quota?: OrchestrationQuotaSample;
  /** Free-form operator notes (preserved across reads). */
  notes?: string[];
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
 * Tolerantly parse a raw pause record (from JSON on disk). Returns null only
 * when the value is not an object. Accepts the operator's v1 file (no
 * `source`) as a human pause. A record with `paused: false` is returned intact
 * (callers read `.paused`); absence of the file is represented by the reader
 * returning null, not this function.
 */
export function parsePauseRecord(raw: unknown): OrchestrationPauseRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const source: OrchestrationPauseSource =
    r.source === 'soft-quota' ? 'soft-quota' : 'human';
  const quota =
    r.quota && typeof r.quota === 'object'
      ? (r.quota as OrchestrationQuotaSample)
      : undefined;
  const notes = Array.isArray(r.notes)
    ? r.notes.filter((n): n is string => typeof n === 'string')
    : undefined;
  return {
    schemaVersion: 2,
    paused: r.paused === true,
    source,
    reason: typeof r.reason === 'string' ? r.reason : '',
    pausedAt: typeof r.pausedAt === 'string' ? r.pausedAt : '',
    pausedBy: typeof r.pausedBy === 'string' ? r.pausedBy : 'unknown',
    mechanism:
      typeof r.mechanism === 'string' && r.mechanism.trim().length > 0
        ? r.mechanism.trim()
        : 'automationKillSwitch',
    ...(quota ? { quota } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** Build a fresh v2 pause record. */
export function buildPauseRecord(input: {
  source: OrchestrationPauseSource;
  reason: string;
  by: string;
  atIso: string;
  quota?: OrchestrationQuotaSample;
  notes?: string[];
}): OrchestrationPauseRecord {
  return {
    schemaVersion: 2,
    paused: true,
    source: input.source,
    reason: input.reason,
    pausedAt: input.atIso,
    pausedBy: input.by,
    mechanism: 'automationKillSwitch',
    ...(input.quota ? { quota: input.quota } : {}),
    ...(input.notes && input.notes.length > 0 ? { notes: input.notes } : {}),
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
  if (record?.paused !== true) return false;
  // v1 files used "automationKillSwitch / SAFE MODE"; v2 uses the literal.
  return record.mechanism.startsWith('automationKillSwitch');
}

/**
 * Is orchestration paused? Either live SAFE MODE or a still-paused on-disk
 * record counts — the record is a real spawn gate, not a mere annotation.
 * Turning the kill switch off must therefore *clear* a kill-switch-created
 * record (issue #2743); an uncleared leftover file still reads as paused.
 */
export function isOrchestrationPaused(input: {
  safeModeEngaged: boolean;
  record: OrchestrationPauseRecord | null;
}): boolean {
  return input.safeModeEngaged || input.record?.paused === true;
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
