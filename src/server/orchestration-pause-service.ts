/**
 * Server-side orchestration pause/resume (issue #2672).
 *
 * A thin wrapper over SAFE MODE (`automationKillSwitch`): engaging a pause
 * writes the whole settings document through the existing update path (which
 * owns the `safeModeSince` bookkeeping) and drops a durable pause record under
 * `~/.kookr/playbook-state/orchestrator/quota-pause.json`. Resuming disengages
 * SAFE MODE and closes the current record while retaining its history.
 *
 * A human pause is sticky against auto-resume; a soft-quota pause auto-resumes.
 * The distinction is enforced here: `resume({ auto: true })` refuses to lift a
 * human pause. A human turning the automation kill switch off still clears a
 * kill-switch-created record (issue #2743) via
 * {@link clearKillSwitchCreatedPauseRecord}.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { KookrSettings } from '../core/settings-store.js';
import { resolveSafeModeStatus, type SafeModeStatus } from '../core/automation-kill-switch.js';
import {
  buildPauseRecord,
  buildPauseProvenance,
  closePauseRecord,
  getCurrentPauseRecord,
  isActivePauseRecord,
  parsePauseState,
  pauseRecordCreatedByKillSwitch,
  resolveOrchestrationPausePath,
  type OrchestrationPauseRecord,
  type OrchestrationPauseState,
  type OrchestrationPauseSource,
  type OrchestrationQuotaSample,
  type SoftQuotaAction,
  evaluateSoftQuotaPause,
} from '../core/orchestration-pause.js';

/** Read the v3 pause ledger, migrating a legacy single record in memory. */
export function readPauseStateSync(kookrDir: string): OrchestrationPauseState {
  const path = resolveOrchestrationPausePath(kookrDir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { schemaVersion: 3, records: [] };
  }
  try {
    return parsePauseState(JSON.parse(raw));
  } catch {
    return { schemaVersion: 3, records: [] };
  }
}

/** Read the active or unresolved open record for compatibility with callers. */
export function readPauseRecordSync(kookrDir: string): OrchestrationPauseRecord | null {
  const records = readPauseStateSync(kookrDir).records;
  return getCurrentPauseRecord(records)
    ?? records.filter((record) => record.lifecycle === 'unresolved').at(-1)
    ?? null;
}

function writePauseStateSync(kookrDir: string, state: OrchestrationPauseState): void {
  const path = resolveOrchestrationPausePath(kookrDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  let renamed = false;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try { unlinkSync(temporaryPath); } catch { /* best-effort temp cleanup */ }
    }
  }
}

/**
 * Close an open pause record when the automation kill switch is turned off.
 * Terminal history remains available for audit and velocity accounting.
 */
export function clearKillSwitchCreatedPauseRecord(kookrDir: string): boolean {
  const state = readPauseStateSync(kookrDir);
  const record = getCurrentPauseRecord(state.records)
    ?? state.records.filter((candidate) => candidate.lifecycle === 'unresolved').at(-1)
    ?? null;
  if (!record || !pauseRecordCreatedByKillSwitch(record)) return false;
  try {
    const closed = record.lifecycle === 'active'
      ? closePauseRecord(record, {
          lifecycle: 'cancelled',
          atIso: new Date().toISOString(),
          by: 'operator',
          source: 'kill-switch-off',
        })
      : {
          ...record,
          lifecycle: 'cancelled' as const,
          paused: false,
          endedAt: new Date().toISOString(),
          endedBy: 'operator',
          endSource: 'kill-switch-off',
        };
    writePauseStateSync(kookrDir, {
      schemaVersion: 3,
      records: state.records.map((candidate) => candidate.id === record.id ? closed : candidate),
    });
    return true;
  } catch {
    return false;
  }
}

/** Live orchestration status returned to the CLI, route, and health surface. */
export interface OrchestrationStatus {
  /** SAFE MODE engaged/since — the underlying pause lever. */
  safeMode: SafeModeStatus;
  /** True while orchestration is paused (SAFE MODE engaged or record paused). */
  paused: boolean;
  /** The durable pause annotation, if any. */
  pause: OrchestrationPauseRecord | null;
  /** Current state is intentionally separate from historical overlap. */
  currentPause: {
    active: boolean;
    record: OrchestrationPauseRecord | null;
  };
  /** Retained lifecycle records and the bounded velocity-facing summary. */
  pauseProvenance: ReturnType<typeof buildPauseProvenance>;
  /** Default-agent quota sample (Phase B), if a signal is wired. */
  quota?: OrchestrationQuotaSample;
  /** Soft-quota recommendation for the orchestrator, when a sample exists. */
  recommendation?: SoftQuotaAction;
}

export interface OrchestrationPauseServiceDeps {
  /** Resolved kookr home dir (where the pause record lives). */
  kookrDir: string;
  /** Live settings snapshot getter. */
  getSettings: () => KookrSettings;
  /** Whole-document settings update (owns the `safeModeSince` transition). */
  updateSettings: (settings: KookrSettings) => Promise<string[]>;
  /** Settings load failure that forced fail-closed SAFE MODE, if any. */
  getSettingsLoadError?: () => string | undefined;
  /** Default-agent quota sample (Phase B). Absent ⇒ no quota block. */
  getQuotaSample?: () => OrchestrationQuotaSample | null;
  /** Clock injection point (defaults to `Date`). */
  now?: () => Date;
}

export class OrchestrationPauseService {
  constructor(private readonly deps: OrchestrationPauseServiceDeps) {}

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private safeModeStatus(): SafeModeStatus {
    const settings = this.deps.getSettings();
    return resolveSafeModeStatus({
      automationKillSwitch: settings.automationKillSwitch,
      safeModeSince: settings.safeModeSince,
      loadError: this.deps.getSettingsLoadError?.(),
    });
  }

  /** Current pause status, including the Phase B quota sample + recommendation. */
  status(): OrchestrationStatus {
    const safeMode = this.safeModeStatus();
    const state = readPauseStateSync(this.deps.kookrDir);
    const currentPause = getCurrentPauseRecord(state.records);
    const decisionRecord = currentPause
      ?? state.records.filter((record) => record.lifecycle === 'unresolved').at(-1)
      ?? null;
    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    const pauseProvenance = buildPauseProvenance(state.records, {
      windowStartMs: nowMs - 24 * 60 * 60 * 1000,
      windowEndMs: nowMs,
    });
    const paused = safeMode.engaged || isActivePauseRecord(currentPause);
    const quota = this.deps.getQuotaSample?.() ?? undefined;
    const recommendation = quota
      ? evaluateSoftQuotaPause({
          utilization: quota.utilization ?? null,
          resetsAt: quota.resetsAt ?? null,
          nowMs,
          record: decisionRecord,
          safeModeEngaged: safeMode.engaged,
        })
      : undefined;
    return {
      safeMode,
      paused,
      pause: currentPause,
      currentPause: { active: currentPause !== null, record: currentPause },
      pauseProvenance,
      ...(quota ? { quota } : {}),
      ...(recommendation ? { recommendation } : {}),
    };
  }

  /**
   * Engage SAFE MODE + write the pause record. Idempotent: re-pausing preserves
   * the original `pausedAt` unless the source changes. Engages SAFE MODE first
   * (the actual pause), then annotates — so a record-write fault never leaves
   * the fleet unpaused.
   */
  async pause(input: {
    source: OrchestrationPauseSource;
    reason: string;
    by: string;
    quota?: OrchestrationQuotaSample;
    notes?: string[];
  }): Promise<OrchestrationStatus> {
    const state = readPauseStateSync(this.deps.kookrDir);
    const existing = getCurrentPauseRecord(state.records)
      ?? state.records.filter((record) => record.lifecycle === 'unresolved').at(-1)
      ?? null;
    // A human pause is sticky: a soft-quota pause must never overwrite it
    // (that would silently make an operator hold auto-resumable, defeating the
    // module's headline guarantee). Leave the human record and SAFE MODE as-is.
    if (input.source === 'soft-quota' && existing?.paused && existing.source === 'human') {
      return this.status();
    }
    const settings = this.deps.getSettings();
    if (!settings.automationKillSwitch) {
      await this.deps.updateSettings({ ...settings, automationKillSwitch: true });
    }
    // Preserve the original pause instant when re-pausing under the same source.
    const atIso =
      existing?.paused && existing.source === input.source && existing.pausedAt
        ? existing.pausedAt
        : this.nowIso();
    const next = buildPauseRecord({
      ...(existing?.lifecycle === 'active' && existing.source === input.source
        ? { id: existing.id }
        : {}),
      source: input.source,
      reason: input.reason,
      by: input.by,
      atIso,
      ...(input.quota ? { quota: input.quota } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    });
    const records = existing?.lifecycle === 'active'
      ? state.records.map((record) => record.id === existing.id ? next : record)
      : [...state.records, next];
    writePauseStateSync(this.deps.kookrDir, { schemaVersion: 3, records });
    return this.status();
  }

  /**
   * Disengage SAFE MODE + close the current record. `auto` (the orchestrator's
   * soft-quota auto-resume) refuses to lift a human pause — that stays until an
   * explicit human resume. Returns whether it actually resumed.
   */
  async resume(input: {
    by: string;
    auto?: boolean;
  }): Promise<{ status: OrchestrationStatus; resumed: boolean; reason?: string }> {
    const state = readPauseStateSync(this.deps.kookrDir);
    const record = getCurrentPauseRecord(state.records);
    // Auto-resume (the orchestrator's soft-quota path) only ever lifts a
    // soft-quota pause. It declines a human pause AND a pause engaged outside
    // this wrapper (SAFE MODE flipped directly, no record) — mirroring the pure
    // `evaluateSoftQuotaPause` guard so the service does not lift something the
    // soft-quota rule never engaged. A human `resume` (auto=false) lifts anything.
    if (input.auto && record?.source !== 'soft-quota') {
      const reason = record?.paused && record.source === 'human'
        ? 'human pause is sticky; auto-resume declined'
        : 'pause was not engaged by the soft-quota rule; auto-resume declined';
      return { status: this.status(), resumed: false, reason };
    }
    const settings = this.deps.getSettings();
    if (settings.automationKillSwitch) {
      await this.deps.updateSettings({ ...settings, automationKillSwitch: false });
    }
    const closedAt = this.nowIso();
    const closedId = record?.id;
    // Turning SAFE MODE off invokes the settings side effect, which closes an
    // active kill-switch record. Refine that transition to the operation that
    // actually requested it after the settings write completes.
    const afterSettings = readPauseStateSync(this.deps.kookrDir);
    const records = afterSettings.records.map((candidate) => {
      if (!closedId || candidate.id !== closedId) return candidate;
      if (candidate.lifecycle === 'active') {
        return closePauseRecord(candidate, {
          lifecycle: 'ended',
          atIso: closedAt,
          by: input.by,
          source: input.auto ? 'auto-resume' : 'explicit-resume',
        });
      }
      if (candidate.lifecycle === 'cancelled') {
        return {
          ...candidate,
          lifecycle: 'ended' as const,
          endedAt: closedAt,
          endedBy: input.by,
          endSource: input.auto ? 'auto-resume' : 'explicit-resume',
        };
      }
      return candidate;
    });
    writePauseStateSync(this.deps.kookrDir, { schemaVersion: 3, records });
    // Report the actually-observed final state, not an assumption: if the
    // record clear failed (EACCES/EPERM — not swallowed ENOENT), `status()`
    // still reads `paused`, so `resumed` reflects reality rather than intent.
    const status = this.status();
    return { status, resumed: !status.paused };
  }
}
