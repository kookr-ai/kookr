/**
 * Server-side orchestration pause/resume (issue #2672).
 *
 * A thin wrapper over SAFE MODE (`automationKillSwitch`): engaging a pause
 * writes the whole settings document through the existing update path (which
 * owns the `safeModeSince` bookkeeping) and drops a durable pause record under
 * `~/.kookr/playbook-state/orchestrator/quota-pause.json`. Resuming disengages
 * SAFE MODE and clears the record.
 *
 * A human pause is sticky against auto-resume; a soft-quota pause auto-resumes.
 * The distinction is enforced here: `resume({ auto: true })` refuses to lift a
 * human pause. A human turning the automation kill switch off still clears a
 * kill-switch-created record (issue #2743) via
 * {@link clearKillSwitchCreatedPauseRecord}.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { KookrSettings } from '../core/settings-store.js';
import { resolveSafeModeStatus, type SafeModeStatus } from '../core/automation-kill-switch.js';
import {
  buildPauseRecord,
  parsePauseRecord,
  pauseRecordCreatedByKillSwitch,
  resolveOrchestrationPausePath,
  type OrchestrationPauseRecord,
  type OrchestrationPauseSource,
  type OrchestrationQuotaSample,
  type SoftQuotaAction,
  evaluateSoftQuotaPause,
} from '../core/orchestration-pause.js';

/** Read the pause record from disk, tolerating absence / corruption. */
export function readPauseRecordSync(kookrDir: string): OrchestrationPauseRecord | null {
  const path = resolveOrchestrationPausePath(kookrDir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null; // absent → not paused
  }
  try {
    return parsePauseRecord(JSON.parse(raw));
  } catch {
    return null; // corrupt → treat as no pause record (SAFE MODE is still the live gate)
  }
}

/**
 * Delete the on-disk pause record when it was created by the automation kill
 * switch. A human turning that switch off is a resume of that record
 * (issue #2743). Leaves a pause whose mechanism is not the kill switch in
 * place. Returns whether a file was removed.
 */
export function clearKillSwitchCreatedPauseRecord(kookrDir: string): boolean {
  const record = readPauseRecordSync(kookrDir);
  if (!pauseRecordCreatedByKillSwitch(record)) return false;
  const path = resolveOrchestrationPausePath(kookrDir);
  try {
    rmSync(path, { force: true });
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

  private writeRecord(record: OrchestrationPauseRecord): void {
    const path = resolveOrchestrationPausePath(this.deps.kookrDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  private clearRecord(): void {
    const path = resolveOrchestrationPausePath(this.deps.kookrDir);
    try {
      rmSync(path, { force: true });
    } catch {
      // Best-effort: SAFE MODE is already off; a lingering record still reads
      // `paused` until removed, so surface nothing but do not fail the resume.
    }
  }

  /** Current pause status, including the Phase B quota sample + recommendation. */
  status(): OrchestrationStatus {
    const safeMode = this.safeModeStatus();
    const record = readPauseRecordSync(this.deps.kookrDir);
    const paused = safeMode.engaged || record?.paused === true;
    const quota = this.deps.getQuotaSample?.() ?? undefined;
    const recommendation = quota
      ? evaluateSoftQuotaPause({
          utilization: quota.utilization ?? null,
          resetsAt: quota.resetsAt ?? null,
          nowMs: (this.deps.now?.() ?? new Date()).getTime(),
          record,
          safeModeEngaged: safeMode.engaged,
        })
      : undefined;
    return {
      safeMode,
      paused,
      pause: record,
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
    const existing = readPauseRecordSync(this.deps.kookrDir);
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
    this.writeRecord(
      buildPauseRecord({
        source: input.source,
        reason: input.reason,
        by: input.by,
        atIso,
        ...(input.quota ? { quota: input.quota } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      }),
    );
    return this.status();
  }

  /**
   * Disengage SAFE MODE + clear the record. `auto` (the orchestrator's
   * soft-quota auto-resume) refuses to lift a human pause — that stays until an
   * explicit human resume. Returns whether it actually resumed.
   */
  async resume(input: {
    by: string;
    auto?: boolean;
  }): Promise<{ status: OrchestrationStatus; resumed: boolean; reason?: string }> {
    const record = readPauseRecordSync(this.deps.kookrDir);
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
    this.clearRecord();
    // Report the actually-observed final state, not an assumption: if the
    // record clear failed (EACCES/EPERM — not swallowed ENOENT), `status()`
    // still reads `paused`, so `resumed` reflects reality rather than intent.
    const status = this.status();
    return { status, resumed: !status.paused };
  }
}
