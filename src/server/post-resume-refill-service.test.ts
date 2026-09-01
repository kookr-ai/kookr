import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CapacityLedger } from '../core/capacity-ledger.js';
import type { LaunchOpts, LaunchResult } from './launch-service.js';
import {
  PostResumeRefillService,
  type EligibleLeaf,
  type PostResumeRefillServiceDeps,
} from './post-resume-refill-service.js';

function ledger(overrides: Partial<CapacityLedger> = {}): CapacityLedger {
  // Only freeForGeneralSources / free / pendingQueueDepth are read by the service.
  return {
    freeForGeneralSources: 5,
    free: 5,
    pendingQueueDepth: 0,
    ...overrides,
  } as unknown as CapacityLedger;
}

function leaf(n: number): EligibleLeaf {
  const url = `https://github.com/kookr-ai/kookr/issues/${n}`;
  return {
    key: `kookr-ai/kookr#${n}`,
    url,
    toLaunchOpts: (idempotencyKey): LaunchOpts => ({
      prompt: `implement #${n}`,
      cwd: '/repo',
      idempotencyKey,
      launchSource: 'api',
      name: `refill #${n}`,
    } as LaunchOpts),
  };
}

describe('PostResumeRefillService', () => {
  let dir: string;
  let launched: LaunchOpts[];
  let launcher: (opts: LaunchOpts) => Promise<LaunchResult>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'post-resume-refill-'));
    launched = [];
    launcher = vi.fn(async (opts: LaunchOpts) => {
      launched.push(opts);
      return { task: { id: `task-${launched.length}` } } as unknown as LaunchResult;
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function make(overrides: Partial<PostResumeRefillServiceDeps> = {}): PostResumeRefillService {
    return new PostResumeRefillService({
      getCapacityLedger: () => ledger(),
      enumerateEligibleLeaves: () => [leaf(101), leaf(102)],
      launcher,
      isEnabled: () => true,
      getSpawnBudget: () => 5,
      stateDir: dir,
      now: () => 1_000,
      ...overrides,
    });
  }

  it('refills eligible leaves and records their issue URLs (bounded by budget)', async () => {
    const svc = make({
      enumerateEligibleLeaves: () => [leaf(1), leaf(2), leaf(3), leaf(4)],
      getSpawnBudget: () => 2, // budget binds below leaf count and free slots
    });
    const result = await svc.onResumeTransition('T-1');
    expect(result.outcome).toBe('refilled');
    expect(result.wouldLaunchCount).toBe(2);
    expect(result.launched.map((l) => l.url)).toEqual([
      'https://github.com/kookr-ai/kookr/issues/1',
      'https://github.com/kookr-ai/kookr/issues/2',
    ]);
    expect(launched).toHaveLength(2);
    // Idempotency key is stable per transition+leaf.
    expect(launched[0].idempotencyKey).toBe('post-resume-refill:t-1:kookr-ai-kookr-1');

    const snap = svc.getRefillHealthSnapshot();
    expect(snap.schemaVersion).toBe('post-resume-refill.v1');
    expect(snap.outcome).toBe('refilled');
    expect(snap.launched).toHaveLength(2);
    expect(snap.transitionId).toBe('T-1');
  });

  it('is idempotent across repeated resume ticks for the same transition (no duplicate spawn)', async () => {
    const svc = make();
    const first = await svc.onResumeTransition('T-2');
    expect(first.outcome).toBe('refilled');
    expect(launched).toHaveLength(2);

    // A replayed resume tick for the SAME transition launches nothing.
    const second = await svc.onResumeTransition('T-2');
    expect(second.outcome).toBe('skipped');
    expect(second.reason).toBe('already_refilled_transition');
    expect(launched).toHaveLength(2); // unchanged
  });

  it('a fresh transition refills again after a prior one latched', async () => {
    const svc = make();
    await svc.onResumeTransition('T-a');
    expect(launched).toHaveLength(2);
    const next = await svc.onResumeTransition('T-b');
    expect(next.outcome).toBe('refilled');
    expect(launched).toHaveLength(4);
  });

  it('records intentional_idle when no eligible leaves exist', async () => {
    const svc = make({ enumerateEligibleLeaves: () => [] });
    const result = await svc.onResumeTransition('T-idle');
    expect(result.outcome).toBe('intentional_idle');
    expect(launched).toHaveLength(0);
    expect(svc.getRefillHealthSnapshot().outcome).toBe('intentional_idle');
  });

  it('records refill_blocked with the substrate reason when leaves are blocked by disk', async () => {
    const svc = make({ checkSubstrate: () => 'disk_floor' });
    const result = await svc.onResumeTransition('T-disk');
    expect(result.outcome).toBe('refill_blocked');
    expect(result.reason).toBe('disk_floor');
    expect(launched).toHaveLength(0);
  });

  it('records refill_blocked / claim_contended when a leaf launch is refused (duplicate claim 409)', async () => {
    const contended = vi.fn(async () => {
      throw Object.assign(new Error('issue already claimed'), { status: 409 });
    });
    const svc = make({ launcher: contended });
    const result = await svc.onResumeTransition('T-409');
    expect(result.outcome).toBe('refill_blocked');
    expect(result.reason).toBe('claim_contended');
    expect(result.launched).toHaveLength(0);

    // The loop breaks on the first refusal, so only one launch was attempted.
    expect(contended).toHaveBeenCalledTimes(1);

    // The pass latched, so a replayed tick does not retry the contended claim.
    const replay = await svc.onResumeTransition('T-409');
    expect(replay.reason).toBe('already_refilled_transition');
    expect(contended).toHaveBeenCalledTimes(1); // unchanged — no retry
  });

  it('maps ANY launcher throw (not only a 409) to refill_blocked / claim_contended', async () => {
    // The classification is deliberately throw-generic: a disk/admission/network
    // error from the launcher is a substrate contention just like a claim 409.
    const boom = vi.fn(async () => {
      throw new Error('disk admission rejected');
    });
    const svc = make({ launcher: boom });
    const result = await svc.onResumeTransition('T-throw');
    expect(result.outcome).toBe('refill_blocked');
    expect(result.reason).toBe('claim_contended');
    expect(result.launched).toHaveLength(0);
  });

  it('bounds the launch by free general slots when free is the binding constraint', async () => {
    // free (3) is above the floor but below both leaf count (5) and budget (9),
    // so it is the binding term in min(leaves, budget, free).
    const svc = make({
      getCapacityLedger: () => ledger({ freeForGeneralSources: 3, free: 3 }),
      enumerateEligibleLeaves: () => [leaf(21), leaf(22), leaf(23), leaf(24), leaf(25)],
      getSpawnBudget: () => 9,
    });
    const result = await svc.onResumeTransition('T-freebind');
    expect(result.outcome).toBe('refilled');
    expect(result.launched).toHaveLength(3); // min(5 leaves, 9 budget, 3 free) = 3
    expect(launched).toHaveLength(3);
  });

  it('keeps successfully-launched leaves when a later leaf launch is refused', async () => {
    let calls = 0;
    const flaky = vi.fn(async (opts: LaunchOpts) => {
      calls += 1;
      if (calls === 2) throw new Error('claim contended on second leaf');
      return { task: { id: `t-${calls}` } } as unknown as LaunchResult;
    });
    const svc = make({
      enumerateEligibleLeaves: () => [leaf(11), leaf(12), leaf(13)],
      launcher: flaky,
    });
    const result = await svc.onResumeTransition('T-partial');
    expect(result.outcome).toBe('refilled');
    expect(result.launched.map((l) => l.url)).toEqual([
      'https://github.com/kookr-ai/kookr/issues/11',
    ]);
  });

  describe('never launches while a gate forbids it', () => {
    it('SAFE MODE engaged → skipped safe_mode', async () => {
      const svc = make({ isAutomationEnabled: () => false });
      const result = await svc.onResumeTransition('T-safe');
      expect(result.outcome).toBe('skipped');
      expect(result.reason).toBe('safe_mode');
      expect(launched).toHaveLength(0);
    });

    it('still paused → skipped still_paused', async () => {
      const svc = make({ isPaused: () => true });
      const result = await svc.onResumeTransition('T-paused');
      expect(result.reason).toBe('still_paused');
      expect(launched).toHaveLength(0);
    });

    it('operator drain → skipped operator_drain', async () => {
      const svc = make({ isAccepting: () => false });
      const result = await svc.onResumeTransition('T-drain');
      expect(result.reason).toBe('operator_drain');
      expect(launched).toHaveLength(0);
    });

    it('queue already has work → skipped queue_not_empty', async () => {
      const svc = make({ getCapacityLedger: () => ledger({ pendingQueueDepth: 3 }) });
      const result = await svc.onResumeTransition('T-queue');
      expect(result.reason).toBe('queue_not_empty');
      expect(launched).toHaveLength(0);
    });
  });

  it('classifies but does not launch when actuation is disabled (off by default)', async () => {
    const svc = make({ isEnabled: () => false });
    const result = await svc.onResumeTransition('T-off');
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('disabled');
    expect(result.wouldLaunchCount).toBe(2); // visibility: it *would* have launched 2
    expect(launched).toHaveLength(0);

    // Not latched: enabling later still lets the SAME transition refill.
    const enabled = make({ stateDir: dir });
    const after = await enabled.onResumeTransition('T-off');
    expect(after.outcome).toBe('refilled');
  });

  it('defaults actuation off when isEnabled is not provided', async () => {
    const svc = new PostResumeRefillService({
      getCapacityLedger: () => ledger(),
      enumerateEligibleLeaves: () => [leaf(1)],
      launcher,
      getSpawnBudget: () => 5,
      stateDir: dir,
    });
    const result = await svc.onResumeTransition('T-default');
    expect(result.reason).toBe('disabled');
    expect(launched).toHaveLength(0);
  });
});
