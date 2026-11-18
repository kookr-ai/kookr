/**
 * Cadence decay instead of a fail-closed pause (issue #4186).
 *
 * Drives a schedule through the service the way the runner does: each fire
 * happens at the time the runner would pick (`nextScheduledRunFor`, which the
 * runner's tick and catch-up both use), under a fake clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nextScheduledRunFor, ScheduleStore, type Schedule } from '../core/schedule.js';
import { ScheduleService } from './schedule-service.js';
import { ScheduleValidator } from './schedule-validator.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = '2026-11-18T08:00:00.000Z';

let dir: string;
let store: ScheduleStore;
let service: ScheduleService;
let taskSeq = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(START));
  dir = mkdtempSync(join(tmpdir(), 'schedule-backoff-test-'));
  store = new ScheduleStore(dir);
  service = new ScheduleService({ store, validator: new ScheduleValidator() });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function createSchedule(extra: Partial<Parameters<ScheduleStore['create']>[0]> = {}): Schedule {
  return store.create({
    name: 'Every thirty minutes',
    cron: '*/30 * * * *',
    playbook: { path: 'loop.md', parameters: {} },
    cwd: '/tmp',
    ...extra,
  });
}

/**
 * Fire the schedule at the next time the runner would pick, then end the run
 * `runMs` later with the given outcome. Returns the fire time.
 */
async function fireAt(
  id: string,
  outcome: 'timeout' | 'completed',
  runMs = 20 * MIN,
): Promise<Date> {
  const schedule = store.get(id)!;
  const due = nextScheduledRunFor(schedule)!;
  vi.setSystemTime(due);
  const receipt = await service.reserveExecution(schedule, 'cron', due.toISOString());
  const taskId = `task-${++taskSeq}`;
  await service.markExecutionAccepted(id, receipt.id, taskId, false);
  vi.setSystemTime(due.getTime() + runMs);
  if (outcome === 'completed') {
    await service.recordTaskTerminalOutcome(taskId, 'completed');
  } else {
    await service.recordTaskTerminalOutcome(taskId, 'cancelled', 'timeout');
  }
  return due;
}

function gaps(times: Date[]): number[] {
  return times.slice(1).map((t, i) => t.getTime() - times[i]!.getTime());
}

describe('schedule cadence decay (issue #4186)', () => {
  it('a default-policy schedule that times out 4 times in a row stays armed and doubles its gap, capped at 6 h', async () => {
    const { id } = createSchedule();
    const fires: Date[] = [];
    for (let i = 0; i < 5; i += 1) fires.push(await fireAt(id, 'timeout'));

    // First fire on the 30-min grid, then 1 h, 2 h, 4 h, and the 6 h cap
    // (8 h uncapped).
    expect(gaps(fires)).toEqual([1 * HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR]);
    const after = store.get(id)!;
    expect(after.enabled).toBe(true);
    expect(after.stopReason).toBeUndefined();
    expect(after.operatorHold).toBeUndefined();
    expect(after.consecutiveFailures).toBe(5);
    expect(after.failureBackoff?.level).toBe(5);
    // Still capped: the next fire is 6 h after the last one.
    expect(nextScheduledRunFor(after)!.getTime() - fires[4]!.getTime()).toBe(6 * HOUR);
    expect(service.getStatusSnapshot().schedulesPausedByFailure).toBeUndefined();
  });

  it('the first successful run resets the interval to the configured cadence', async () => {
    const { id } = createSchedule();
    await fireAt(id, 'timeout');
    await fireAt(id, 'timeout');
    const success = await fireAt(id, 'completed');

    const after = store.get(id)!;
    expect(after.consecutiveFailures).toBe(0);
    expect(after.failureBackoff).toBeUndefined();
    // Back on the 30-min grid, with no burst of the slots skipped while slowed.
    const next = await fireAt(id, 'completed');
    expect(next.getTime() - success.getTime()).toBe(30 * MIN);
  });

  it('does not fire the occurrences inside the backoff window, so nothing bursts once it ends', async () => {
    const { id } = createSchedule();
    const first = await fireAt(id, 'timeout');
    const slowed = store.get(id)!;
    // Wall clock is 20 min after the fire; the next cron slot (+30 min) is
    // inside the 1 h window and must not be due.
    vi.setSystemTime(first.getTime() + 45 * MIN);
    expect(nextScheduledRunFor(slowed)!.getTime()).toBe(first.getTime() + HOUR);
    expect(service.listResponse().schedules[0]!.nextRunAt).toBe(new Date(first.getTime() + HOUR).toISOString());
  });

  it('persists the backoff so it survives a restart', async () => {
    const { id } = createSchedule();
    await fireAt(id, 'timeout');
    await fireAt(id, 'timeout');
    const before = store.get(id)!.failureBackoff;
    expect(before).toEqual({ level: 2, notBefore: expect.any(String) });

    const reloaded = new ScheduleStore(dir);
    await reloaded.load();
    expect(reloaded.get(id)!.failureBackoff).toEqual(before);
    expect(nextScheduledRunFor(reloaded.get(id)!)).toEqual(nextScheduledRunFor(store.get(id)!));
  });

  it('a recovery_critical schedule keeps its configured cadence (no backoff, never paused)', async () => {
    const { id } = createSchedule({ failurePolicy: 'recovery_critical' });
    const fires: Date[] = [];
    for (let i = 0; i < 4; i += 1) fires.push(await fireAt(id, 'timeout'));
    expect(gaps(fires)).toEqual([30 * MIN, 30 * MIN, 30 * MIN]);
    const after = store.get(id)!;
    expect(after.enabled).toBe(true);
    expect(after.failureBackoff).toBeUndefined();
    expect(after.consecutiveFailures).toBe(4);
  });

  it('a human disable still holds: the slowed schedule does not fire, and re-enable restores the cadence', async () => {
    const { id } = createSchedule();
    await fireAt(id, 'timeout');
    await service.setEnabled(id, false, { operatorHold: true });
    expect(store.get(id)!.enabled).toBe(false);
    expect(service.listResponse().schedules[0]!.nextRunAt).toBeNull();

    await service.setEnabled(id, true);
    const after = store.get(id)!;
    expect(after.failureBackoff).toBeUndefined();
    expect(after.consecutiveFailures).toBe(0);
  });

  it('classifies a legacy hold whose execution reason is none by its terminal reason (timeout) and keeps it parked', async () => {
    const created = createSchedule();
    const firedAt = '2026-11-18T07:00:00.000Z';
    // A hold persisted before #4186: the run reached its task, so the
    // execution says `none` and the real cause sits on terminalReason.
    store.replace({
      ...created,
      enabled: false,
      stopReason: 'consecutive_failures',
      operatorHold: true,
      holdSource: 'daemon',
      consecutiveFailures: 3,
      latestExecution: {
        receiptId: 'r-1',
        executionToken: 't-1',
        evaluatedAt: firedAt,
        trigger: 'cron',
        outcome: 'cancelled',
        reasonCode: 'none',
        terminalReason: { reasonCode: 'timeout', source: 'watchdog', at: firedAt },
      },
    } as Schedule);

    const { rearmed } = await service.rearmTransientFailureHolds(true, START);
    expect(rearmed).toEqual([]);
    expect(store.get(created.id)!.enabled).toBe(false);
  });
});
