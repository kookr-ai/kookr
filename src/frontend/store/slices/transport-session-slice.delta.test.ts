/**
 * Model-based invariants for the client snapshot+delta reconciler (issue #3067).
 *
 * `handleDelta` (transport-session-slice.ts) folds a wire `delta` into the live
 * agent list and carries two load-bearing invariants that no other test guards:
 *
 *   1. It preserves the prior *relative order* of surviving rows and appends
 *      brand-new upserts at the end.
 *   2. It keys every row by the composite `` `${agentId}:${taskId ?? ''}` `` so
 *      one agent running two parallel tasks is two independent rows — removing
 *      or renaming one must never touch the sibling.
 *
 * The one existing `handleDelta` assertion (useStore.test.ts) does
 * `agents.map(a => a.agentId).sort()`, which sorts away the very ordering the
 * reducer preserves and uses a single `agentId` per row, so composite-key
 * isolation is never exercised. A regression that scrambled survivor order or
 * keyed by `agentId` alone would ship green today.
 *
 * Style: hand-rolled model-based, matching the repo's PBT convention (seeded
 * LCG, fixed seed ranges, no fast-check) — see
 * core/attention-queue.property.test.ts and core/anomaly-detector.property.test.ts.
 * The oracle is a plain reference reducer built on a `Map` keyed by
 * `agentId:taskId`: `Map` insertion order keeps an updated key in place and
 * appends a new key at the end, which is exactly the reducer's contract.
 *
 * Scope: this suite targets the reducer's ordering + composite-key invariants,
 * so every row carries an empty event window (`events: []`). That keeps the
 * oracle exact — `mergeActivityAgent` reduces to `{ ...incoming, events: [] }`
 * for empty windows — but it deliberately does NOT exercise the event-window
 * merge/dedup path in `activity-history.ts`; that reconciliation is out of
 * scope here and would be separate coverage.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createKookrStore } from '../useStore.js';
import type { AgentState } from '../../../shared/protocol.js';

/** A wire delta as accepted by `handleDelta` (agents-only slice). */
interface AgentsDelta {
  agents: { upserts: AgentState[]; removed: string[] };
}

const key = (a: Pick<AgentState, 'agentId' | 'taskId'>): string => `${a.agentId}:${a.taskId ?? ''}`;

/** A minimal agent row; `taskName` is the mutable marker used to detect drift. */
function row(agentId: string, taskId: string | undefined, taskName: string): AgentState {
  return { agentId, taskId, events: [], anomaly: null, taskName };
}

/**
 * Reference reducer: the model the production reducer must match. A `Map` keyed
 * by `agentId:taskId` — deletions drop keys, upserts replace an existing key in
 * place (position preserved) or append a new key at the end.
 */
function referenceReduce(prev: AgentState[], delta: AgentsDelta): AgentState[] {
  const map = new Map<string, AgentState>();
  for (const a of prev) map.set(key(a), a);
  for (const k of delta.agents.removed) map.delete(k);
  for (const up of delta.agents.upserts) {
    // Mirror mergeActivityAgent for empty event windows: upsert value wins.
    map.set(key(up), { ...up, events: [] });
  }
  return [...map.values()];
}

/** Ordered composite-key projection — the ordering the reducer must preserve. */
const keysOf = (agents: AgentState[]): string[] => agents.map(key);

describe('handleDelta reconciler invariants (#3067)', () => {
  let store: ReturnType<typeof createKookrStore>;

  beforeEach(() => {
    const localStore = new Map<string, string>();
    // handleSnapshot's selection-restore path touches localStorage. Match the
    // sibling suite (useStore.test.ts) and stub via vi so vitest restores it.
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => localStore.get(k) ?? null,
      setItem: (k: string, v: string) => localStore.set(k, v),
      removeItem: (k: string) => localStore.delete(k),
      clear: () => localStore.clear(),
    });
    store = createKookrStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('explicit fixtures', () => {
    test('preserves survivor order and appends brand-new upserts at the end', () => {
      store.getState().handleSnapshot([
        row('a1', 't1', 'v0'),
        row('a2', 't2', 'v0'),
        row('a3', 't3', 'v0'),
      ]);

      store.getState().handleDelta({
        agents: {
          upserts: [
            // Re-upsert of a middle survivor must NOT move it to the end.
            row('a2', 't2', 'v1'),
            // Brand-new rows append in upsert order after all survivors.
            row('a4', 't4', 'v0'),
            row('a5', 't5', 'v0'),
          ],
          removed: [],
        },
      });

      expect(keysOf(store.getState().agents)).toEqual([
        'a1:t1',
        'a2:t2',
        'a3:t3',
        'a4:t4',
        'a5:t5',
      ]);
      // Upsert wins for the touched survivor; others untouched.
      expect(store.getState().agents.find((a) => key(a) === 'a2:t2')?.taskName).toBe('v1');
      expect(store.getState().agents.find((a) => key(a) === 'a1:t1')?.taskName).toBe('v0');
    });

    test('composite-key isolation: one agent, two parallel tasks', () => {
      store.getState().handleSnapshot([
        row('agent-1', 't1', 'keep'),
        row('agent-1', 't2', 'drop'),
      ]);
      expect(store.getState().agents).toHaveLength(2);

      // Remove exactly one sibling by its composite key.
      store.getState().handleDelta({
        agents: { upserts: [], removed: ['agent-1:t2'] },
      });

      const agents = store.getState().agents;
      expect(keysOf(agents)).toEqual(['agent-1:t1']);
      // The surviving sibling is byte-for-byte unchanged — a key-by-agentId
      // regression would have evicted it alongside its sibling.
      expect(agents[0]).toEqual(row('agent-1', 't1', 'keep'));
    });

    test('rename targets only the addressed parallel-task row', () => {
      store.getState().handleSnapshot([
        row('agent-1', 't1', 'name-1'),
        row('agent-1', 't2', 'name-2'),
      ]);

      store.getState().handleDelta({
        agents: { upserts: [row('agent-1', 't2', 'renamed-2')], removed: [] },
      });

      const agents = store.getState().agents;
      expect(agents.find((a) => key(a) === 'agent-1:t1')?.taskName).toBe('name-1');
      expect(agents.find((a) => key(a) === 'agent-1:t2')?.taskName).toBe('renamed-2');
    });

    test('remove-then-reupsert in one delta: upsert wins, appended, no duplicate key', () => {
      store.getState().handleSnapshot([
        row('a1', 't1', 'v0'),
        row('a2', 't2', 'v0'),
      ]);

      // Same key both removed and upserted in the same delta.
      store.getState().handleDelta({
        agents: {
          upserts: [row('a1', 't1', 'reupserted')],
          removed: ['a1:t1'],
        },
      });

      const agents = store.getState().agents;
      const keys = keysOf(agents);
      // Upsert wins over the removal, and the row lands at the end (treated new).
      expect(keys).toEqual(['a2:t2', 'a1:t1']);
      expect(agents.find((a) => key(a) === 'a1:t1')?.taskName).toBe('reupserted');
      // No duplicate keys.
      expect(new Set(keys).size).toBe(keys.length);
    });

    test('two upserts with the same composite key in one delta: last value wins, one row', () => {
      // The server coalesces per key, but guard the reducer's within-delta
      // behavior anyway: later upsert wins the value, and the row keeps the
      // first occurrence's (here, appended) position without duplicating.
      store.getState().handleSnapshot([row('a1', 't1', 'v0')]);

      store.getState().handleDelta({
        agents: {
          upserts: [row('a2', 't2', 'first'), row('a2', 't2', 'second')],
          removed: [],
        },
      });

      const agents = store.getState().agents;
      expect(keysOf(agents)).toEqual(['a1:t1', 'a2:t2']);
      expect(agents.find((a) => key(a) === 'a2:t2')?.taskName).toBe('second');
    });

    test('output key-set equals (prev − removed) ∪ upserts', () => {
      store.getState().handleSnapshot([
        row('a1', 't1', 'v0'),
        row('a2', 't2', 'v0'),
        row('a3', 't3', 'v0'),
      ]);

      store.getState().handleDelta({
        agents: {
          upserts: [row('a2', 't2', 'v1'), row('a9', 't9', 'v0')],
          removed: ['a1:t1'],
        },
      });

      const got = new Set(keysOf(store.getState().agents));
      const expected = new Set(['a2:t2', 'a3:t3', 'a9:t9']); // (prev − a1:t1) ∪ upserts
      expect(got).toEqual(expected);
    });
  });

  describe('selection reconciliation on removal', () => {
    test('removing the selected row via delta nulls the selection', () => {
      store.getState().handleSnapshot([
        row('a1', 't1', 'v0'),
        row('a2', 't2', 'v0'),
      ]);
      store.getState().selectAgent('a1', 't1');
      expect(store.getState().selectedAgentId).toBe('a1');

      store.getState().handleDelta({
        agents: { upserts: [], removed: ['a1:t1'] },
      });

      // Server evicted the selected row: selection is nulled (not left dangling).
      expect(store.getState().selectedAgentId).toBeNull();
      expect(store.getState().selectedTaskId).toBeNull();
    });

    test('removing the sibling row leaves an unrelated selection intact', () => {
      store.getState().handleSnapshot([
        row('a1', 't1', 'v0'),
        row('a1', 't2', 'v0'),
      ]);
      store.getState().selectAgent('a1', 't1');

      store.getState().handleDelta({
        agents: { upserts: [], removed: ['a1:t2'] },
      });

      // Composite-key isolation extends to selection: the sibling's removal
      // must not disturb the still-present selected row.
      expect(store.getState().selectedAgentId).toBe('a1');
      expect(store.getState().selectedTaskId).toBe('t1');
    });
  });

  describe('model-based: store output matches the reference reducer', () => {
    const AGENT_POOL = ['a0', 'a1', 'a2'] as const;
    const TASK_POOL = ['t0', 't1', 't2'] as const;
    const SEED_COUNT = 50;
    const DELTAS_PER_SEED = 40;

    function makeSeededRandom(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        // Numerical Recipes LCG — same generator as the core PBT suites.
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
      };
    }

    const pick = <T>(items: readonly T[], random: () => number): T =>
      items[Math.floor(random() * items.length)]!;

    /** Every composite key expressible from the pools. */
    const ALL_KEYS: string[] = AGENT_POOL.flatMap((a) => TASK_POOL.map((t) => `${a}:${t}`));

    /** Build a random delta against the current model key-set. */
    function randomDelta(present: string[], random: () => number, version: number): AgentsDelta {
      const removed: string[] = [];
      for (const k of present) {
        if (random() < 0.3) removed.push(k);
      }
      const upserts: AgentState[] = [];
      const upsertKeys = new Set<string>();
      const upsertCount = Math.floor(random() * 4); // 0..3
      for (let i = 0; i < upsertCount; i++) {
        const k = pick(ALL_KEYS, random);
        if (upsertKeys.has(k)) continue; // one coalesced value per key, as the server sends
        upsertKeys.add(k);
        const [agentId, taskId] = k.split(':') as [string, string];
        upserts.push(row(agentId, taskId, `v${version}-${i}`));
      }
      return { agents: { upserts, removed } };
    }

    for (let seed = 1; seed <= SEED_COUNT; seed++) {
      test(`seed ${seed}: order, values and key-set track the Map oracle`, () => {
        const random = makeSeededRandom(seed);

        // Random initial snapshot (distinct keys, in a random order).
        const initialKeys = ALL_KEYS.filter(() => random() < 0.5);
        const snapshot = initialKeys.map((k, i) => {
          const [agentId, taskId] = k.split(':') as [string, string];
          return row(agentId, taskId, `s${i}`);
        });
        store.getState().handleSnapshot(snapshot);
        let model: AgentState[] = snapshot.map((a) => ({ ...a }));

        for (let step = 0; step < DELTAS_PER_SEED; step++) {
          const delta = randomDelta(keysOf(model), random, step);
          store.getState().handleDelta(delta);
          model = referenceReduce(model, delta);

          const got = store.getState().agents;

          // Ordered composite keys match the oracle exactly (order + membership).
          expect(keysOf(got)).toEqual(keysOf(model));
          // No duplicate keys ever.
          expect(new Set(keysOf(got)).size).toBe(got.length);
          // Per-key value (the upsert-wins marker) matches the oracle.
          const gotMarkers = got.map((a) => `${key(a)}=${a.taskName}`);
          const modelMarkers = model.map((a) => `${key(a)}=${a.taskName}`);
          expect(gotMarkers).toEqual(modelMarkers);
        }
      });
    }
  });
});
