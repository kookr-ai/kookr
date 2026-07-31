/**
 * Property-based invariants for AttentionQueue (issue #1767).
 *
 * Follows the repo's PBT style (seeded LCG, fixed seed ranges, no fast-check):
 * see anomaly-detector.property.test.ts and schedule-rollup.test.ts.
 *
 * Invariants:
 *   I1  Severity-first ordering holds under arbitrary enqueue/skip/snooze sequences
 *   I2  A snoozed finding never surfaces before its expiry
 *   I3  Skip moves an item to the back without dropping it
 *   I4  No finding starves indefinitely within a bounded op stream
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Anomaly, AnomalySeverity, AnomalyType } from './types.js';
import { AttentionQueue } from './attention-queue.js';
import { anomalyFingerprint } from './anomaly-fingerprint.js';

const SEVERITY_ORDER: Record<AnomalySeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const SEVERITIES: readonly AnomalySeverity[] = ['critical', 'warning', 'info'];
const TYPES: readonly AnomalyType[] = [
  'needs_input',
  'permission_blocked',
  'repeated_error',
  'api_error',
  'stale_agent',
];

const AGENT_POOL = ['a0', 'a1', 'a2', 'a3', 'a4'] as const;
const SEED_COUNT = 40;
const OPS_PER_SEED = 60;
const FIXED_TIME = new Date('2026-01-01T00:00:00.000Z');

function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG — same generator as anomaly-detector.property.test.ts
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

function makeAnomaly(
  agentId: string,
  severity: AnomalySeverity,
  type: AnomalyType = 'needs_input',
): Anomaly {
  return {
    agentId,
    type,
    severity,
    explanation: `${type} for ${agentId} (${severity})`,
    detectedAt: FIXED_TIME,
  };
}

/** Shadow entry mirroring AttentionQueue active-map semantics. */
interface ShadowEntry {
  agentId: string;
  anomaly: Anomaly;
  skipped: boolean;
  /** Monotonic rank assigned on first insert; Map preserves this order. */
  insertRank: number;
}

function sortShadow(entries: Iterable<ShadowEntry>): ShadowEntry[] {
  return [...entries].sort((a, b) => {
    if (a.skipped !== b.skipped) return a.skipped ? 1 : -1;
    const bySev = SEVERITY_ORDER[a.anomaly.severity] - SEVERITY_ORDER[b.anomaly.severity];
    if (bySev !== 0) return bySev;
    return a.insertRank - b.insertRank;
  });
}

function assertMatchesShadow(
  queue: AttentionQueue,
  shadow: Map<string, ShadowEntry>,
  label: string,
): void {
  const expected = sortShadow(shadow.values()).map((e) => e.agentId);
  const actual = queue.inspectActive().map((e) => e.agentId);
  expect(actual, `${label} active order`).toEqual(expected);

  const next = queue.next();
  if (expected.length === 0) {
    expect(next, `${label} next empty`).toBeNull();
  } else {
    expect(next?.agentId, `${label} next head`).toBe(expected[0]);
    expect(next?.anomaly.severity, `${label} next severity`).toBe(
      sortShadow(shadow.values())[0]!.anomaly.severity,
    );
  }
}

/**
 * Apply one op to both the real queue and the shadow model.
 * Snooze is modelled as "leave active map"; cancel re-admits at a fresh rank.
 */
function applyOp(
  queue: AttentionQueue,
  shadow: Map<string, ShadowEntry>,
  snoozed: Map<string, Anomaly>,
  nextRank: { value: number },
  op: 'enqueue' | 'skip' | 'snooze' | 'remove' | 'cancel',
  agentId: string,
  random: () => number,
): void {
  switch (op) {
    case 'enqueue': {
      const severity = pick(SEVERITIES, random);
      const type = pick(TYPES, random);
      const anomaly = makeAnomaly(agentId, severity, type);

      if (snoozed.has(agentId)) {
        // Only re-enqueue the same finding while snoozed so we never trip wake-on-escalation.
        const hidden = snoozed.get(agentId)!;
        const same = makeAnomaly(agentId, hidden.severity, hidden.type);
        queue.enqueue(agentId, same);
        // Still snoozed for non-escalating same-or-lower severity same-ish fingerprints.
        // Wake paths: severity escalate, or critical+different fp. Our same() avoids both.
        if (queue.getSnoozedUntil(agentId) !== null) {
          snoozed.set(agentId, queue.getAnomaly(agentId) ?? same);
          return;
        }
        // Woke unexpectedly — treat as active.
        snoozed.delete(agentId);
      } else {
        queue.enqueue(agentId, anomaly);
      }

      if (queue.getSnoozedUntil(agentId) !== null) {
        // enqueue was swallowed by an existing snooze
        const a = queue.getAnomaly(agentId);
        if (a) snoozed.set(agentId, a);
        shadow.delete(agentId);
        return;
      }

      const admitted = queue.peek(agentId);
      if (!admitted) {
        shadow.delete(agentId);
        return;
      }

      const existing = shadow.get(agentId);
      if (existing) {
        const sameFp = anomalyFingerprint(existing.anomaly) === anomalyFingerprint(admitted);
        shadow.set(agentId, {
          agentId,
          anomaly: admitted,
          skipped: sameFp ? existing.skipped : false,
          insertRank: existing.insertRank,
        });
      } else {
        shadow.set(agentId, {
          agentId,
          anomaly: admitted,
          skipped: false,
          insertRank: nextRank.value++,
        });
      }
      return;
    }
    case 'skip': {
      if (!shadow.has(agentId)) return;
      queue.skip(agentId);
      const entry = shadow.get(agentId)!;
      shadow.set(agentId, { ...entry, skipped: true });
      return;
    }
    case 'snooze': {
      if (!shadow.has(agentId)) return;
      const entry = shadow.get(agentId)!;
      queue.snooze(agentId, 60_000);
      snoozed.set(agentId, entry.anomaly);
      shadow.delete(agentId);
      return;
    }
    case 'remove': {
      if (!shadow.has(agentId)) return;
      queue.remove(agentId);
      shadow.delete(agentId);
      return;
    }
    case 'cancel': {
      if (!snoozed.has(agentId)) return;
      const ok = queue.cancelSnooze(agentId);
      if (!ok) return;
      snoozed.delete(agentId);
      const anomaly = queue.peek(agentId);
      if (anomaly) {
        shadow.set(agentId, {
          agentId,
          anomaly,
          skipped: false,
          insertRank: nextRank.value++,
        });
      }
      return;
    }
  }
}

describe('AttentionQueue property invariants', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('I1: severity-first ordering holds under arbitrary enqueue/skip/snooze sequences', () => {
    const ops = ['enqueue', 'skip', 'snooze', 'remove', 'cancel'] as const;

    for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
      const random = makeSeededRandom(seed);
      const queue = new AttentionQueue();
      const shadow = new Map<string, ShadowEntry>();
      const snoozed = new Map<string, Anomaly>();
      const nextRank = { value: 0 };

      for (let step = 0; step < OPS_PER_SEED; step += 1) {
        const op = pick(ops, random);
        const agentId = pick(AGENT_POOL, random);
        applyOp(queue, shadow, snoozed, nextRank, op, agentId, random);
        assertMatchesShadow(queue, shadow, `seed=${seed} step=${step} op=${op} agent=${agentId}`);
      }
    }
  });

  test('I1b: pure enqueue sequences keep non-decreasing severity order', () => {
    for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
      const random = makeSeededRandom(seed + 10_000);
      const queue = new AttentionQueue();

      for (let step = 0; step < OPS_PER_SEED; step += 1) {
        const agentId = pick(AGENT_POOL, random);
        queue.enqueue(agentId, makeAnomaly(agentId, pick(SEVERITIES, random), pick(TYPES, random)));

        const all = queue.inspectActive();
        for (let i = 1; i < all.length; i += 1) {
          const prev = SEVERITY_ORDER[all[i - 1]!.anomaly.severity];
          const cur = SEVERITY_ORDER[all[i]!.anomaly.severity];
          expect(prev, `seed=${seed} step=${step} idx=${i}`).toBeLessThanOrEqual(cur);
        }
      }
    }
  });

  test('I2: a snoozed finding never surfaces before its expiry', () => {
    for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
      const random = makeSeededRandom(seed + 20_000);
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_TIME);

      const queue = new AttentionQueue();
      const durationMs = 5_000 + Math.floor(random() * 20) * 1_000; // 5–24s
      const agentCount = 2 + Math.floor(random() * 3);
      const agents = AGENT_POOL.slice(0, agentCount);

      for (const agentId of agents) {
        queue.enqueue(agentId, makeAnomaly(agentId, pick(SEVERITIES, random), pick(TYPES, random)));
      }

      const snoozedId = pick(agents, random);
      const beforeSnooze = queue.peek(snoozedId)!;
      queue.snooze(snoozedId, durationMs);

      const preSteps = 1 + Math.floor(random() * 5);
      for (let i = 0; i < preSteps; i += 1) {
        vi.advanceTimersByTime(Math.floor(durationMs / (preSteps + 1)));
        if (Date.now() >= FIXED_TIME.getTime() + durationMs) break;

        expect(
          queue.inspectActive().some((e) => e.agentId === snoozedId),
          `seed=${seed} pre-expiry step=${i}: must stay hidden`,
        ).toBe(false);
        expect(queue.getSnoozedUntil(snoozedId), `seed=${seed} still snoozed`).not.toBeNull();
        expect(queue.next()?.agentId === snoozedId, `seed=${seed} next must not be snoozed`).toBe(false);

        // Non-waking re-enqueue of the same finding
        queue.enqueue(
          snoozedId,
          makeAnomaly(snoozedId, beforeSnooze.severity, beforeSnooze.type),
        );
        expect(
          queue.inspectActive().some((e) => e.agentId === snoozedId),
          `seed=${seed} same-fp re-enqueue must not wake`,
        ).toBe(false);
      }

      vi.setSystemTime(new Date(FIXED_TIME.getTime() + durationMs + 1));
      // getAll/next restore agent-keyed expired snoozes; inspectActive does not.
      const afterExpiry = queue.getAll();
      expect(
        afterExpiry.some((e) => e.agentId === snoozedId),
        `seed=${seed} snooze must restore after expiry`,
      ).toBe(true);
      expect(queue.getSnoozedUntil(snoozedId)).toBeNull();

      vi.useRealTimers();
    }
  });

  test('I3: skip moves an item to the back without dropping it', () => {
    for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
      const random = makeSeededRandom(seed + 30_000);
      const queue = new AttentionQueue();

      const count = 2 + Math.floor(random() * (AGENT_POOL.length - 1));
      const agents = AGENT_POOL.slice(0, count);
      for (const agentId of agents) {
        queue.enqueue(agentId, makeAnomaly(agentId, pick(SEVERITIES, random), pick(TYPES, random)));
      }

      const before = queue.inspectActive();
      expect(before).toHaveLength(count);
      const beforeIds = new Set(before.map((e) => e.agentId));

      const head = queue.next();
      expect(head).not.toBeNull();
      const skippedId = head!.agentId;
      queue.skip(skippedId);

      const after = queue.inspectActive();
      expect(after, `seed=${seed} length preserved`).toHaveLength(count);
      expect(new Set(after.map((e) => e.agentId)), `seed=${seed} no drop`).toEqual(beforeIds);
      expect(
        after.some((e) => e.agentId === skippedId),
        `seed=${seed} skipped still present`,
      ).toBe(true);

      if (count > 1) {
        const newHead = queue.next();
        expect(newHead).not.toBeNull();
        expect(newHead!.agentId, `seed=${seed} skip moves off head`).not.toBe(skippedId);

        // With a single skip and all peers still non-skipped, the skipped agent
        // occupies the sole slot in the skipped partition → last position.
        const idx = after.findIndex((e) => e.agentId === skippedId);
        expect(idx, `seed=${seed} skipped is last`).toBe(count - 1);
      }
    }
  });

  test('I4: no finding starves indefinitely under bounded skip/remove streams', () => {
    for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
      const random = makeSeededRandom(seed + 40_000);

      // --- Skip rotation on equal-severity fresh queue: each surfaces within |N| ---
      {
        const queue = new AttentionQueue();
        const count = 2 + Math.floor(random() * 3);
        const agents = AGENT_POOL.slice(0, count);
        for (const agentId of agents) {
          queue.enqueue(agentId, makeAnomaly(agentId, 'warning', 'needs_input'));
        }

        const seen = new Set<string>();
        for (let i = 0; i < count; i += 1) {
          const head = queue.next();
          expect(head, `seed=${seed} skip-rot step ${i}`).not.toBeNull();
          seen.add(head!.agentId);
          queue.skip(head!.agentId);
        }
        expect(seen.size, `seed=${seed} every agent surfaces under skip rotation`).toBe(count);
      }

      // --- Remove drain of a closed set: every finding consumed exactly once ---
      {
        const queue = new AttentionQueue();
        const count = 2 + Math.floor(random() * 3);
        const agents = AGENT_POOL.slice(0, count);
        for (const agentId of agents) {
          queue.enqueue(agentId, makeAnomaly(agentId, pick(SEVERITIES, random), pick(TYPES, random)));
        }

        const drained: string[] = [];
        const bound = count; // must finish in exactly |agents| removes
        for (let i = 0; i < bound; i += 1) {
          const head = queue.next();
          expect(head, `seed=${seed} drain step ${i}`).not.toBeNull();
          drained.push(head!.agentId);
          queue.remove(head!.agentId);
        }
        expect(queue.isAllClear(), `seed=${seed} queue drains fully`).toBe(true);
        expect(new Set(drained).size, `seed=${seed} each finding drained once`).toBe(count);
      }

      // --- Mixed skip/remove: remaining agents are never dropped; remove drain finishes ---
      {
        const queue = new AttentionQueue();
        const agents = [...AGENT_POOL.slice(0, 4)];
        const enqueued = new Set(agents);
        for (const agentId of agents) {
          queue.enqueue(agentId, makeAnomaly(agentId, pick(SEVERITIES, random), pick(TYPES, random)));
        }

        for (let step = 0; step < 12; step += 1) {
          const head = queue.next();
          if (!head) break;
          if (random() < 0.5) {
            queue.skip(head.agentId);
          } else {
            queue.remove(head.agentId);
            enqueued.delete(head.agentId);
          }
          // No silent drops: every still-tracked agent is still active
          const activeIds = new Set(queue.inspectActive().map((e) => e.agentId));
          expect(activeIds, `seed=${seed} mixed step=${step} no drop`).toEqual(enqueued);
        }

        // Finish by remove-draining whatever remains — bound = remaining size
        const remaining = queue.inspectActive().map((e) => e.agentId);
        for (let i = 0; i < remaining.length + 1; i += 1) {
          const head = queue.next();
          if (!head) break;
          queue.remove(head.agentId);
          enqueued.delete(head.agentId);
        }
        expect(queue.isAllClear(), `seed=${seed} mixed residual drains`).toBe(true);
        expect(enqueued.size, `seed=${seed} shadow matches empty queue`).toBe(0);
      }

      // --- Re-enqueue with a new fingerprint un-skips: finding cannot stay buried ---
      {
        const queue = new AttentionQueue();
        queue.enqueue('a0', makeAnomaly('a0', 'info', 'needs_input'));
        queue.enqueue('a1', makeAnomaly('a1', 'info', 'needs_input'));
        queue.skip('a0');
        expect(queue.next()!.agentId).toBe('a1');

        // New fingerprint (different type) resets skipped → a0 can surface again
        queue.enqueue('a0', makeAnomaly('a0', 'critical', 'repeated_error'));
        expect(queue.next()!.agentId, `seed=${seed} re-enqueue un-skips`).toBe('a0');
      }
    }
  });

  test('I4b: severity order during pure remove drain is non-decreasing rank', () => {
    for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
      const random = makeSeededRandom(seed + 50_000);
      const queue = new AttentionQueue();
      const count = 3 + Math.floor(random() * 2);
      const agents = AGENT_POOL.slice(0, count);

      for (const agentId of agents) {
        queue.enqueue(agentId, makeAnomaly(agentId, pick(SEVERITIES, random), pick(TYPES, random)));
      }

      let lastRank = -1;
      while (!queue.isAllClear()) {
        const head = queue.next();
        expect(head).not.toBeNull();
        const rank = SEVERITY_ORDER[head!.anomaly.severity];
        expect(rank, `seed=${seed} drain severity order`).toBeGreaterThanOrEqual(lastRank);
        lastRank = rank;
        queue.remove(head!.agentId);
      }
    }
  });
});
