import { describe, test, expect } from 'vitest';
import {
  CONTINUATION_ENVELOPE_VERSION,
  advanceEnvelope,
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

describe('advanceEnvelope — authorization toggles survive continuation exactly', () => {
  test('copies authorization verbatim (deep equal, no re-derivation)', () => {
    const current = envelope();
    const next = advanceEnvelope(current, {
      selectedUnit: '#110',
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
      { selectedUnit: '#110', remainingUnits: ['#110'], cursorWasStale: false, parentMissing: false, notes: [] },
      { taskId: 'task-43', issue: '#109' },
    );
    expect(next.parent).toEqual({ taskId: 'task-43', issue: '#109' });
  });

  test('leaves nextUnit unset at the end of the chain', () => {
    const next = advanceEnvelope(envelope(), {
      selectedUnit: null,
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

  test('drops a non-finite attemptCap rather than trusting it', () => {
    const parsed = parseContinuationEnvelope({
      version: CONTINUATION_ENVELOPE_VERSION,
      goal: 'g',
      cursor: { repo: 'r', selector: 's', attemptCap: Number.POSITIVE_INFINITY },
    });
    expect(parsed.cursor.attemptCap).toBeUndefined();
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
});
