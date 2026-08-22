import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SETTINGS, type KookrSettings } from '../core/settings-store.js';
import { applyKillSwitchTransition } from '../core/automation-kill-switch.js';
import {
  orchestratorShouldSpawn,
  resolveOrchestrationPausePath,
  type OrchestrationQuotaSample,
} from '../core/orchestration-pause.js';
import {
  OrchestrationPauseService,
  clearKillSwitchCreatedPauseRecord,
  readPauseRecordSync,
} from './orchestration-pause-service.js';

/**
 * A settings double that applies the same kill-switch transition the real
 * server does on every update (so `safeModeSince` bookkeeping matches prod).
 */
function makeSettings(now: () => Date) {
  let current: KookrSettings = { ...DEFAULT_SETTINGS };
  return {
    get: () => current,
    update: async (next: KookrSettings) => {
      current = applyKillSwitchTransition(current, { ...next }, now().toISOString());
      return [];
    },
    peek: () => current,
  };
}

describe('OrchestrationPauseService', () => {
  let dir: string;
  const fixedNow = new Date('2026-08-19T00:00:00.000Z');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-orch-pause-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('pause engages SAFE MODE and writes the pause record (who/why/since/source)', async () => {
    const settings = makeSettings(() => fixedNow);
    const svc = new OrchestrationPauseService({
      kookrDir: dir,
      getSettings: settings.get,
      updateSettings: settings.update,
      now: () => fixedNow,
    });

    const status = await svc.pause({ source: 'human', reason: 'quota reset window', by: 'jean' });

    // SAFE MODE engaged with a since stamp.
    expect(settings.peek().automationKillSwitch).toBe(true);
    expect(settings.peek().safeModeSince).toBe(fixedNow.toISOString());
    expect(status.paused).toBe(true);
    expect(status.safeMode.engaged).toBe(true);

    // Durable record present with the who/why/since/source fields.
    const path = resolveOrchestrationPausePath(dir);
    expect(existsSync(path)).toBe(true);
    const rec = JSON.parse(readFileSync(path, 'utf8'));
    expect(rec).toMatchObject({
      schemaVersion: 2,
      paused: true,
      source: 'human',
      reason: 'quota reset window',
      pausedBy: 'jean',
      pausedAt: fixedNow.toISOString(),
      mechanism: 'automationKillSwitch',
    });
  });

  it('resume disengages SAFE MODE and clears the record', async () => {
    const settings = makeSettings(() => fixedNow);
    const svc = new OrchestrationPauseService({
      kookrDir: dir,
      getSettings: settings.get,
      updateSettings: settings.update,
      now: () => fixedNow,
    });

    await svc.pause({ source: 'human', reason: 'r', by: 'jean' });
    const result = await svc.resume({ by: 'jean' });

    expect(result.resumed).toBe(true);
    expect(settings.peek().automationKillSwitch).toBe(false);
    expect(settings.peek().safeModeSince).toBeNull();
    expect(existsSync(resolveOrchestrationPausePath(dir))).toBe(false);
    expect(result.status.paused).toBe(false);
  });

  it('a soft-quota auto-resume does NOT lift a human pause', async () => {
    const settings = makeSettings(() => fixedNow);
    const svc = new OrchestrationPauseService({
      kookrDir: dir,
      getSettings: settings.get,
      updateSettings: settings.update,
      now: () => fixedNow,
    });

    await svc.pause({ source: 'human', reason: 'operator hold', by: 'jean' });
    const result = await svc.resume({ by: 'orchestrator', auto: true });

    expect(result.resumed).toBe(false);
    expect(result.reason).toContain('human pause is sticky');
    // Still paused.
    expect(settings.peek().automationKillSwitch).toBe(true);
    expect(existsSync(resolveOrchestrationPausePath(dir))).toBe(true);
  });

  it('a soft-quota auto-resume DOES lift a soft-quota pause', async () => {
    const settings = makeSettings(() => fixedNow);
    const svc = new OrchestrationPauseService({
      kookrDir: dir,
      getSettings: settings.get,
      updateSettings: settings.update,
      now: () => fixedNow,
    });

    await svc.pause({ source: 'soft-quota', reason: 'near quota', by: 'orchestrator' });
    const result = await svc.resume({ by: 'orchestrator', auto: true });

    expect(result.resumed).toBe(true);
    expect(settings.peek().automationKillSwitch).toBe(false);
    expect(existsSync(resolveOrchestrationPausePath(dir))).toBe(false);
  });

  it('a soft-quota pause does NOT overwrite an active human pause (stickiness at the service layer)', async () => {
    const settings = makeSettings(() => fixedNow);
    const svc = new OrchestrationPauseService({
      kookrDir: dir,
      getSettings: settings.get,
      updateSettings: settings.update,
      now: () => fixedNow,
    });

    await svc.pause({ source: 'human', reason: 'operator hold', by: 'jean' });
    await svc.pause({ source: 'soft-quota', reason: 'near quota', by: 'orchestrator' });

    // Still a human pause — not downgraded to auto-resumable soft-quota.
    const rec = readPauseRecordSync(dir);
    expect(rec!.source).toBe('human');
    expect(rec!.reason).toBe('operator hold');
    expect(settings.peek().automationKillSwitch).toBe(true);
  });

  it('an auto-resume declines a pause engaged outside the soft-quota rule (no record)', async () => {
    // SAFE MODE flipped directly (e.g. settings UI), no pause record on disk.
    let committed = { ...DEFAULT_SETTINGS, automationKillSwitch: true };
    const svc = new OrchestrationPauseService({
      kookrDir: dir,
      getSettings: () => committed,
      updateSettings: async (next) => { committed = applyKillSwitchTransition(committed, { ...next }, fixedNow.toISOString()); return []; },
      now: () => fixedNow,
    });

    const result = await svc.resume({ by: 'orchestrator', auto: true });
    expect(result.resumed).toBe(false);
    expect(result.reason).toContain('not engaged by the soft-quota rule');
    expect(committed.automationKillSwitch).toBe(true); // left engaged
  });

  it('re-pausing under the same source preserves the original pausedAt', async () => {
    let clock = new Date('2026-08-19T00:00:00.000Z');
    const settings = makeSettings(() => clock);
    const svc = new OrchestrationPauseService({
      kookrDir: dir,
      getSettings: settings.get,
      updateSettings: settings.update,
      now: () => clock,
    });

    await svc.pause({ source: 'human', reason: 'r1', by: 'jean' });
    clock = new Date('2026-08-19T06:00:00.000Z');
    await svc.pause({ source: 'human', reason: 'r2', by: 'jean' });

    const rec = readPauseRecordSync(dir);
    expect(rec!.pausedAt).toBe('2026-08-19T00:00:00.000Z'); // original, not the re-pause time
    expect(rec!.reason).toBe('r2'); // reason updated
  });

  it('status surfaces the quota sample and a soft-quota recommendation', async () => {
    const settings = makeSettings(() => fixedNow);
    const sample: OrchestrationQuotaSample = {
      agentType: 'claude-code',
      supported: true,
      utilization: 96,
      resetsAt: '2026-08-25T00:00:00.000Z',
      window: 'seven-day',
    };
    const svc = new OrchestrationPauseService({
      kookrDir: dir,
      getSettings: settings.get,
      updateSettings: settings.update,
      getQuotaSample: () => sample,
      now: () => fixedNow,
    });

    const status = svc.status();
    expect(status.quota).toEqual(sample);
    // Not paused + 96% ≥ 95% stop line ⇒ recommend pause.
    expect(status.recommendation?.action).toBe('pause');
  });

  it('clearKillSwitchCreatedPauseRecord deletes a leftover kill-switch record so spawn is allowed (issue #2743)', async () => {
    const settings = makeSettings(() => fixedNow);
    const svc = new OrchestrationPauseService({
      kookrDir: dir,
      getSettings: settings.get,
      updateSettings: settings.update,
      now: () => fixedNow,
    });

    await svc.pause({ source: 'human', reason: 'weekly quota window', by: 'jean' });
    // Split-brain leftover: kill switch already off, on-disk record still paused.
    await settings.update({ ...settings.peek(), automationKillSwitch: false });
    expect(settings.peek().automationKillSwitch).toBe(false);

    const cleared = clearKillSwitchCreatedPauseRecord(dir);
    expect(cleared).toBe(true);
    expect(existsSync(resolveOrchestrationPausePath(dir))).toBe(false);
    expect(readPauseRecordSync(dir)).toBeNull();
    expect(svc.status().paused).toBe(false);
    expect(orchestratorShouldSpawn({
      safeModeEngaged: false,
      record: readPauseRecordSync(dir),
    })).toBe(true);
  });

  it('clearKillSwitchCreatedPauseRecord leaves a non-kill-switch pause record in place (issue #2743)', async () => {
    const path = resolveOrchestrationPausePath(dir);
    mkdirSync(join(dir, 'playbook-state', 'orchestrator'), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: 2,
        paused: true,
        source: 'human',
        reason: 'external hold',
        pausedAt: fixedNow.toISOString(),
        pausedBy: 'jean',
        mechanism: 'external-hold',
      }, null, 2)}\n`,
      'utf8',
    );

    expect(clearKillSwitchCreatedPauseRecord(dir)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(readPauseRecordSync(dir)?.mechanism).toBe('external-hold');
    expect(readPauseRecordSync(dir)?.paused).toBe(true);
  });
});
