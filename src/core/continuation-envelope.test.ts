import { describe, test, expect } from 'vitest';
import {
  CONTINUATION_ENVELOPE_VERSION,
  advanceEnvelope,
  continuationAttemptCap,
  areContinuationsDistinct,
  continuationCursorKey,
  parseContinuationEnvelope,
  renderContinuationPrompt,
  resolveContinuationState,
  type ContinuationEnvelope,
  type DurableStateSnapshot,
  type StateResolver,
} from './continuation-envelope.js';

function envelope(overrides: Partial<ContinuationEnvelope> = {}): ContinuationEnvelope {
  return {
    version: CONTINUATION_ENVELOPE_VERSION,
    goal: 'Implement the open issue batch one at a time',
    cursor: {
      repo: 'kookr-ai/kookr',
      selector: 'gh issue list --label batch --state open',
      nextUnit: '#109',
      remainingUnits: ['#109', '#110', '#111'],
      sourceRevision: 'sha-abc',
      attemptCap: 3,
    },
    parent: { taskId: 'task-42', prUrl: 'https://example/pr/9', issue: '#108' },
    authorization: { autoCloseOnSignal: true, deliveryAuthorized: false, mergeAfterImplementation: true },
    ...overrides,
  };
}

function resolverFor(snapshot: DurableStateSnapshot): StateResolver {
  return () => snapshot;
}

describe('resolveContinuationState — happy path', () => {
  test('works the cursor unit when it is still eligible', async () => {
    const resolved = await resolveContinuationState(
      envelope(),
      resolverFor({
        units: [
          { id: '#109', status: 'eligible' },
          { id: '#110', status: 'eligible' },
          { id: '#111', status: 'eligible' },
        ],
        parentResolved: true,
        sourceRevision: 'sha-def',
      }),
    );
    expect(resolved.selectedUnit).toBe('#109');
    expect(resolved.cursorWasStale).toBe(false);
    expect(resolved.parentMissing).toBe(false);
    expect(resolved.remainingUnits).toEqual(['#109', '#110', '#111']);
    expect(resolved.sourceRevision).toBe('sha-def');
  });

  test('selects the first eligible unit when the envelope has no pointer', async () => {
    const resolved = await resolveContinuationState(
      envelope({ cursor: { repo: 'r', selector: 's' } }),
      resolverFor({
        units: [
          { id: '#200', status: 'blocked' },
          { id: '#201', status: 'eligible' },
        ],
      }),
    );
    expect(resolved.selectedUnit).toBe('#201');
    expect(resolved.cursorWasStale).toBe(false);
  });

  test('ends the chain (null) with no pointer and nothing eligible', async () => {
    const resolved = await resolveContinuationState(
      envelope({ cursor: { repo: 'r', selector: 's' } }),
      resolverFor({ units: [] }),
    );
    expect(resolved.selectedUnit).toBeNull();
    expect(resolved.cursorWasStale).toBe(false);
    expect(resolved.remainingUnits).toEqual([]);
    expect(resolved.notes.join(' ')).toContain('chain complete');
  });

  test('awaits an async resolver', async () => {
    const asyncResolver: StateResolver = () =>
      Promise.resolve({ units: [{ id: '#109', status: 'eligible' as const }] });
    const resolved = await resolveContinuationState(envelope(), asyncResolver);
    expect(resolved.selectedUnit).toBe('#109');
  });
});

describe('resolveContinuationState — stale cursor recovery', () => {
  test('recovers to the next eligible unit when the cursor unit is already done', async () => {
    const resolved = await resolveContinuationState(
      envelope(),
      resolverFor({
        units: [
          { id: '#109', status: 'done' }, // the pointer — completed out of band
          { id: '#110', status: 'eligible' },
          { id: '#111', status: 'eligible' },
        ],
        parentResolved: true,
      }),
    );
    expect(resolved.cursorWasStale).toBe(true);
    expect(resolved.selectedUnit).toBe('#110');
    expect(resolved.remainingUnits).toEqual(['#110', '#111']);
    expect(resolved.notes.join(' ')).toContain('#109');
    expect(resolved.notes.join(' ')).toContain('done');
  });

  test('recovers when the cursor unit vanished from durable state entirely', async () => {
    const resolved = await resolveContinuationState(
      envelope(),
      resolverFor({ units: [{ id: '#110', status: 'eligible' }] }),
    );
    expect(resolved.cursorWasStale).toBe(true);
    expect(resolved.selectedUnit).toBe('#110');
    expect(resolved.notes.join(' ')).toContain('absent');
  });

  test('treats an in-flight cursor unit as stale and skips it', async () => {
    const resolved = await resolveContinuationState(
      envelope(),
      resolverFor({
        units: [
          { id: '#109', status: 'in-flight' },
          { id: '#110', status: 'eligible' },
        ],
      }),
    );
    expect(resolved.cursorWasStale).toBe(true);
    expect(resolved.selectedUnit).toBe('#110');
  });

  test('ends the chain (null) when the cursor is stale and nothing else is eligible', async () => {
    const resolved = await resolveContinuationState(
      envelope(),
      resolverFor({
        units: [
          { id: '#109', status: 'done' },
          { id: '#110', status: 'done' },
        ],
      }),
    );
    expect(resolved.cursorWasStale).toBe(true);
    expect(resolved.selectedUnit).toBeNull();
    expect(resolved.remainingUnits).toEqual([]);
    expect(resolved.notes.join(' ')).toContain('chain complete');
  });
});

describe('resolveContinuationState — missing parent state', () => {
  test('flags parentMissing when parent refs no longer resolve', async () => {
    const resolved = await resolveContinuationState(
      envelope(),
      resolverFor({
        units: [{ id: '#109', status: 'eligible' }],
        parentResolved: false,
      }),
    );
    expect(resolved.parentMissing).toBe(true);
    // The chain still proceeds — a missing parent is a trace gap, not a stop.
    expect(resolved.selectedUnit).toBe('#109');
    expect(resolved.notes.join(' ')).toContain('parent');
  });

  test('does not flag parentMissing when the envelope carries no parent refs', async () => {
    const resolved = await resolveContinuationState(
      envelope({ parent: {} }),
      resolverFor({ units: [{ id: '#109', status: 'eligible' }], parentResolved: false }),
    );
    expect(resolved.parentMissing).toBe(false);
  });

  test('does not flag parentMissing when parentResolved is omitted', async () => {
    const resolved = await resolveContinuationState(
      envelope(),
      resolverFor({ units: [{ id: '#109', status: 'eligible' }] }),
    );
    expect(resolved.parentMissing).toBe(false);
  });
});

describe('resolveContinuationState — outcome (blocked vs complete distinction)', () => {
  test('eligible: a workable unit yields outcome "eligible"', async () => {
    const resolved = await resolveContinuationState(
      envelope(),
      resolverFor({ units: [{ id: '#109', status: 'eligible' }] }),
    );
    expect(resolved.outcome).toBe('eligible');
    expect(resolved.selectedUnit).toBe('#109');
    expect(resolved.blockedUnits).toEqual([]);
  });

  test('blocked-unsatisfied: no eligible unit but a blocked one → "blocked", not "complete"', async () => {
    // The dependent-phase deadlock: the next phase is blocked on an unmerged
    // dependency. This must be reported as waiting, never as chain-complete.
    const resolved = await resolveContinuationState(
      envelope({ cursor: { repo: 'r', selector: 's' } }),
      resolverFor({ units: [{ id: '#110', status: 'blocked' }] }),
    );
    expect(resolved.outcome).toBe('blocked');
    expect(resolved.selectedUnit).toBeNull();
    expect(resolved.blockedUnits).toEqual(['#110']);
    expect(resolved.notes.join(' ')).toContain('waiting on a dependency');
    expect(resolved.notes.join(' ')).not.toContain('chain complete');
  });

  test('blocked-now-satisfied: the same unit becomes eligible once its dependency merges', async () => {
    const before = await resolveContinuationState(
      envelope({ cursor: { repo: 'r', selector: 's' } }),
      resolverFor({ units: [{ id: '#110', status: 'blocked' }] }),
    );
    expect(before.outcome).toBe('blocked');

    const after = await resolveContinuationState(
      envelope({ cursor: { repo: 'r', selector: 's' } }),
      resolverFor({ units: [{ id: '#110', status: 'eligible' }] }),
    );
    expect(after.outcome).toBe('eligible');
    expect(after.selectedUnit).toBe('#110');
  });

  test('complete: no eligible and no blocked units → "complete"', async () => {
    const resolved = await resolveContinuationState(
      envelope({ cursor: { repo: 'r', selector: 's' } }),
      resolverFor({ units: [{ id: '#109', status: 'done' }] }),
    );
    expect(resolved.outcome).toBe('complete');
    expect(resolved.selectedUnit).toBeNull();
    expect(resolved.blockedUnits).toEqual([]);
    expect(resolved.notes.join(' ')).toContain('chain complete');
  });

  test('stale cursor + only a blocked unit remains → "blocked" (not complete)', async () => {
    const resolved = await resolveContinuationState(
      envelope(), // pointer '#109'
      resolverFor({
        units: [
          { id: '#109', status: 'done' },
          { id: '#110', status: 'blocked' },
        ],
      }),
    );
    expect(resolved.cursorWasStale).toBe(true);
    expect(resolved.outcome).toBe('blocked');
    expect(resolved.blockedUnits).toEqual(['#110']);
  });
});

describe('advanceEnvelope — authorization toggles survive continuation exactly', () => {
  test('resolves the shared default and persists it across a continuation', () => {
    const current = envelope({ cursor: { repo: 'owner/repo', selector: 'open' } });
    expect(continuationAttemptCap(current)).toBe(10);
    const next = advanceEnvelope(current, {
      selectedUnit: 'next',
      outcome: 'eligible',
      blockedUnits: [],
      remainingUnits: ['next'],
      cursorWasStale: false,
      parentMissing: false,
      notes: [],
    });
    expect(next.cursor.attemptCap).toBe(10);
    expect(continuationAttemptCap(next)).toBe(10);
  });

  test('preserves an explicit lower cap across a restart-shaped parse/reload', () => {
    const current = envelope();
    current.cursor.attemptCap = 3;
    const reloaded = parseContinuationEnvelope(JSON.parse(JSON.stringify(current)));
    expect(continuationAttemptCap(reloaded)).toBe(3);
    const next = advanceEnvelope(reloaded, {
      selectedUnit: 'next',
      outcome: 'eligible',
      blockedUnits: [],
      remainingUnits: ['next'],
      cursorWasStale: false,
      parentMissing: false,
      notes: [],
    });
    expect(next.cursor.attemptCap).toBe(3);
  });

  test('copies authorization verbatim (deep equal, no re-derivation)', () => {
    const current = envelope();
    const next = advanceEnvelope(current, {
      selectedUnit: '#110',
      outcome: 'eligible',
      blockedUnits: [],
      remainingUnits: ['#110', '#111'],
      cursorWasStale: false,
      parentMissing: false,
      notes: [],
    });
    expect(next.authorization).toEqual(current.authorization);
    // Every toggle preserved bit-for-bit, including the false ones.
    expect(next.authorization.autoCloseOnSignal).toBe(true);
    expect(next.authorization.deliveryAuthorized).toBe(false);
    expect(next.authorization.mergeAfterImplementation).toBe(true);
  });

  test('preserves a bespoke toggle that has no named field', () => {
    const current = envelope({ authorization: { customDeployToggle: true } });
    const next = advanceEnvelope(current, {
      selectedUnit: '#110',
      outcome: 'eligible',
      blockedUnits: [],
      remainingUnits: ['#110'],
      cursorWasStale: false,
      parentMissing: false,
      notes: [],
    });
    expect(next.authorization).toEqual({ customDeployToggle: true });
  });

  test('mutating the successor authorization does not touch the predecessor (copied, not shared)', () => {
    const current = envelope();
    const next = advanceEnvelope(current, {
      selectedUnit: '#110',
      outcome: 'eligible',
      blockedUnits: [],
      remainingUnits: ['#110'],
      cursorWasStale: false,
      parentMissing: false,
      notes: [],
    });
    (next.authorization as Record<string, boolean>).deliveryAuthorized = true;
    expect(current.authorization.deliveryAuthorized).toBe(false);
  });

  test('advances the cursor to the next unit and carries the goal and attempt cap', () => {
    const current = envelope();
    const next = advanceEnvelope(current, {
      selectedUnit: '#110',
      outcome: 'eligible',
      blockedUnits: [],
      remainingUnits: ['#110', '#111'],
      cursorWasStale: false,
      parentMissing: false,
      sourceRevision: 'sha-new',
      notes: [],
    });
    expect(next.cursor.nextUnit).toBe('#110');
    expect(next.cursor.remainingUnits).toEqual(['#110', '#111']);
    expect(next.cursor.sourceRevision).toBe('sha-new');
    expect(next.cursor.attemptCap).toBe(3);
    expect(next.goal).toBe(current.goal);
  });

  test('accepts a parent override for the spawning task', () => {
    const next = advanceEnvelope(
      envelope(),
      { selectedUnit: '#110', outcome: 'eligible', blockedUnits: [], remainingUnits: ['#110'], cursorWasStale: false, parentMissing: false, notes: [] },
      { taskId: 'task-43', issue: '#109' },
    );
    expect(next.parent).toEqual({ taskId: 'task-43', issue: '#109' });
  });

  test('leaves nextUnit unset at the end of the chain', () => {
    const next = advanceEnvelope(envelope(), {
      selectedUnit: null,
      outcome: 'complete',
      blockedUnits: [],
      remainingUnits: [],
      cursorWasStale: false,
      parentMissing: false,
      notes: [],
    });
    expect(next.cursor.nextUnit).toBeUndefined();
    expect(next.cursor.remainingUnits).toEqual([]);
  });
});

describe('content-distinct successor spawn', () => {
  test('a real advance produces a content-distinct successor', () => {
    const current = envelope();
    const next = advanceEnvelope(current, {
      selectedUnit: '#110',
      outcome: 'eligible',
      blockedUnits: [],
      remainingUnits: ['#110', '#111'],
      cursorWasStale: false,
      sourceRevision: 'sha-def',
      parentMissing: false,
      notes: [],
    });
    expect(areContinuationsDistinct(current, next)).toBe(true);
    expect(continuationCursorKey(current)).not.toBe(continuationCursorKey(next));
  });

  test('a non-advancing re-spawn is NOT distinct (must not be launched)', () => {
    const current = envelope();
    // Same source of truth, cursor did not move.
    const stalled = advanceEnvelope(current, {
      selectedUnit: '#109',
      outcome: 'eligible',
      blockedUnits: [],
      remainingUnits: ['#109', '#110', '#111'],
      cursorWasStale: false,
      sourceRevision: 'sha-abc',
      parentMissing: false,
      notes: [],
    });
    expect(areContinuationsDistinct(current, stalled)).toBe(false);
  });

  test('the cursor key is independent of parent refs and authorization (cursor-only)', () => {
    const a = envelope();
    const b = envelope({ parent: { taskId: 'other' }, authorization: { autoCloseOnSignal: false } });
    // Same cursor → same key even though parent/auth differ.
    expect(continuationCursorKey(a)).toBe(continuationCursorKey(b));
  });

  test('rendered prompts differ across an advance (satisfies spawn dedup)', () => {
    const current = envelope();
    const next = advanceEnvelope(current, {
      selectedUnit: '#110',
      outcome: 'eligible',
      blockedUnits: [],
      remainingUnits: ['#110', '#111'],
      cursorWasStale: false,
      sourceRevision: 'sha-def',
      parentMissing: false,
      notes: [],
    });
    expect(renderContinuationPrompt(current)).not.toBe(renderContinuationPrompt(next));
  });
});

describe('renderContinuationPrompt — compact and bounded', () => {
  test('references the shared skill instead of inlining invariant rules', () => {
    const prompt = renderContinuationPrompt(envelope());
    expect(prompt).toContain('self-continuation-task skill');
    expect(prompt).toContain('#109');
    expect(prompt).toContain('autoCloseOnSignal: true');
    expect(prompt).toContain('deliveryAuthorized: false');
  });

  test('caps the remaining-units list so the prompt stays bounded', () => {
    const many = Array.from({ length: 50 }, (_, i) => `#${i + 1}`);
    const prompt = renderContinuationPrompt(
      envelope({ cursor: { repo: 'r', selector: 's', nextUnit: '#1', remainingUnits: many } }),
    );
    expect(prompt).toContain('+30 more');
    expect(prompt).not.toContain('#50');
  });

  test('renders byte-identical output (locked snapshot — additive changes must not alter the prompt)', () => {
    // The blocked-vs-complete contract change is resolver-side only; the rendered
    // continuation prompt for a normal (non-self-advancing) chain must not move.
    const prompt = renderContinuationPrompt(envelope());
    expect(prompt).toBe(
      'You are continuing a sequential Kookr task chain (continuation envelope v1).\n'
      + '\n'
      + 'Goal: Implement the open issue batch one at a time\n'
      + '\n'
      + 'Follow the self-continuation-task skill for all invariant rules\n'
      + '(fresh worktree, one unit only, durable-state selection, record-before-spawn,\n'
      + 'immediate parent close after spawn, end-of-chain sweep). Do not re-derive them here.\n'
      + '\n'
      + 'Cursor:\n'
      + '- repo: kookr-ai/kookr\n'
      + '- selector: gh issue list --label batch --state open\n'
      + '- next unit: #109\n'
      + '- remaining eligible: #109, #110, #111\n'
      + '- source revision: sha-abc\n'
      + '- attempt cap: 3\n'
      + '\n'
      + 'Parent: task task-42, PR https://example/pr/9, issue #108\n'
      + '\n'
      + 'Authorization (preserve exactly in any successor):\n'
      + '- autoCloseOnSignal: true\n'
      + '- deliveryAuthorized: false\n'
      + '- mergeAfterImplementation: true\n'
      + '\n'
      + 'Revalidate the cursor against durable state before acting; if the next unit is\n'
      + 'no longer eligible, recover the next eligible unit from the selector.\n',
    );
  });

  test('omits optional sections cleanly when absent', () => {
    const prompt = renderContinuationPrompt({
      version: CONTINUATION_ENVELOPE_VERSION,
      goal: 'g',
      cursor: { repo: 'r', selector: 's' },
      parent: {},
      authorization: {},
    });
    expect(prompt).not.toContain('Parent:');
    expect(prompt).not.toContain('Authorization');
    expect(prompt).toContain('Goal: g');
  });
});

describe('parseContinuationEnvelope', () => {
  test('round-trips a valid envelope', () => {
    const parsed = parseContinuationEnvelope(JSON.parse(JSON.stringify(envelope())));
    expect(parsed).toEqual(envelope());
  });

  test('rejects an unknown version (forward/backward incompatibility)', () => {
    expect(() => parseContinuationEnvelope({ ...envelope(), version: 999 })).toThrow(/version/);
  });

  test('rejects a missing cursor', () => {
    expect(() => parseContinuationEnvelope({ version: CONTINUATION_ENVELOPE_VERSION, goal: 'g' })).toThrow(/cursor/);
  });

  test('rejects a cursor missing selector', () => {
    expect(() =>
      parseContinuationEnvelope({ version: CONTINUATION_ENVELOPE_VERSION, goal: 'g', cursor: { repo: 'r' } }),
    ).toThrow(/selector/);
  });

  test('rejects a cursor missing repo', () => {
    expect(() =>
      parseContinuationEnvelope({ version: CONTINUATION_ENVELOPE_VERSION, goal: 'g', cursor: { selector: 's' } }),
    ).toThrow(/repo/);
  });

  test('rejects a non-object', () => {
    expect(() => parseContinuationEnvelope(null)).toThrow(/object/);
    expect(() => parseContinuationEnvelope('nope')).toThrow(/object/);
  });

  test('rejects an empty goal', () => {
    expect(() =>
      parseContinuationEnvelope({ version: CONTINUATION_ENVELOPE_VERSION, goal: '  ', cursor: { repo: 'r', selector: 's' } }),
    ).toThrow(/goal/);
  });

  test('rejects a non-finite attemptCap rather than trusting it', () => {
    expect(() => parseContinuationEnvelope({
      version: CONTINUATION_ENVELOPE_VERSION,
      goal: 'g',
      cursor: { repo: 'r', selector: 's', attemptCap: Number.POSITIVE_INFINITY },
    })).toThrow(/attemptCap/);
  });

  test('rejects an attemptCap above the shared maximum on restart', () => {
    expect(() => parseContinuationEnvelope({
      version: CONTINUATION_ENVELOPE_VERSION,
      goal: 'g',
      cursor: { repo: 'r', selector: 's', attemptCap: 21 },
    })).toThrow(/iteration cap/);
  });

  test('drops non-boolean authorization values rather than trusting them', () => {
    const parsed = parseContinuationEnvelope({
      version: CONTINUATION_ENVELOPE_VERSION,
      goal: 'g',
      cursor: { repo: 'r', selector: 's' },
      authorization: { real: true, bogus: 'yes' },
    });
    expect(parsed.authorization).toEqual({ real: true });
  });

  test('rejects non-integer processedCount and remainingBudget', () => {
    expect(() => parseContinuationEnvelope({
      version: CONTINUATION_ENVELOPE_VERSION,
      goal: 'g',
      cursor: { repo: 'r', selector: 's', processedCount: -1 },
    })).toThrow(/processedCount/);
    expect(() => parseContinuationEnvelope({
      version: CONTINUATION_ENVELOPE_VERSION,
      goal: 'g',
      cursor: { repo: 'r', selector: 's', remainingBudget: 1.5 },
    })).toThrow(/remainingBudget/);
  });
});

describe('batch progress on continuation envelopes', () => {
  test('advanceEnvelope copies progress into the successor cursor', () => {
    const current = envelope({
      cursor: {
        ...envelope().cursor,
        processedCount: 4,
        remainingBudget: 6,
      },
    });
    const next = advanceEnvelope(
      current,
      {
        selectedUnit: '#110',
        outcome: 'eligible',
        blockedUnits: [],
        remainingUnits: ['#110', '#111'],
        cursorWasStale: false,
        sourceRevision: 'sha-def',
        parentMissing: false,
        notes: [],
      },
      { taskId: 'task-43', issue: '#109' },
      { processedCount: 5, remainingBudget: 5 },
    );
    expect(next.cursor.processedCount).toBe(5);
    expect(next.cursor.remainingBudget).toBe(5);
    expect(areContinuationsDistinct(current, next)).toBe(true);
    expect(renderContinuationPrompt(next)).toContain('processed units: 5');
    expect(renderContinuationPrompt(next)).toContain('remaining budget: 5');
  });

  test('omitting progress preserves existing counters', () => {
    const current = envelope({
      cursor: {
        ...envelope().cursor,
        processedCount: 4,
        remainingBudget: 6,
      },
    });
    const next = advanceEnvelope(current, {
      selectedUnit: '#110',
      outcome: 'eligible',
      blockedUnits: [],
      remainingUnits: ['#110'],
      cursorWasStale: false,
      sourceRevision: 'sha-def',
      parentMissing: false,
      notes: [],
    });
    expect(next.cursor.processedCount).toBe(4);
    expect(next.cursor.remainingBudget).toBe(6);
  });

  test('a budget-only advance is content-distinct even with the same next unit', () => {
    const current = envelope({
      cursor: {
        ...envelope().cursor,
        processedCount: 4,
        remainingBudget: 6,
      },
    });
    const next = advanceEnvelope(
      current,
      {
        selectedUnit: '#109',
        outcome: 'eligible',
        blockedUnits: [],
        remainingUnits: ['#109', '#110', '#111'],
        cursorWasStale: false,
        sourceRevision: 'sha-abc',
        parentMissing: false,
        notes: [],
      },
      undefined,
      { processedCount: 5, remainingBudget: 5 },
    );
    expect(next.cursor.nextUnit).toBe('#109');
    expect(areContinuationsDistinct(current, next)).toBe(true);
  });
});
