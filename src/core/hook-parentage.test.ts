import { describe, expect, it } from 'vitest';
import {
  classifyHookParentage,
  createSessionRuntimeIdentity,
  recordSessionStart,
} from './hook-parentage.js';

describe('classifyHookParentage', () => {
  const now = new Date('2026-05-13T12:00:00Z').toISOString();

  it('returns unknown when parent has not been established', () => {
    const identity = createSessionRuntimeIdentity();
    expect(classifyHookParentage('codex-abc', identity)).toBe('unknown');
  });

  it('returns unknown when raw session id is missing', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', undefined, now);
    expect(classifyHookParentage(undefined, identity)).toBe('unknown');
  });

  it('returns parent for the established parent session id', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', '/t/p', now);
    expect(classifyHookParentage('codex-parent', identity)).toBe('parent');
  });

  it('returns child for any other session id once parent is set', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', '/t/p', now);
    expect(classifyHookParentage('codex-child-1', identity)).toBe('child');
  });
});

describe('recordSessionStart', () => {
  const t0 = new Date('2026-05-13T12:00:00Z').toISOString();
  const t1 = new Date('2026-05-13T12:01:00Z').toISOString();
  const t2 = new Date('2026-05-13T12:02:00Z').toISOString();

  it('claims parent on first sighting and freezes it', () => {
    const identity = createSessionRuntimeIdentity();

    expect(recordSessionStart(identity, 'codex-parent', '/t/p', t0)).toBe('parent');
    expect(identity.parentSessionId).toBe('codex-parent');
    expect(identity.parentTranscriptPath).toBe('/t/p');
    expect(identity.parentSeenAt).toBe(t0);

    // Four child reviewer sessions arrive — must not overwrite parent.
    for (const id of ['codex-r1', 'codex-r2', 'codex-r3', 'codex-r4']) {
      expect(recordSessionStart(identity, id, `/t/${id}`, t1)).toBe('child');
    }
    expect(identity.parentSessionId).toBe('codex-parent');
    expect(identity.parentTranscriptPath).toBe('/t/p');
    expect(identity.childSessionIds.size).toBe(4);
  });

  it('idempotently records a repeat child session start', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', '/t/p', t0);

    recordSessionStart(identity, 'codex-child', '/t/c', t1);
    recordSessionStart(identity, 'codex-child', '/t/c2', t2);

    expect(identity.childSessionIds.get('codex-child')?.firstSeenAt).toBe(t1);
    expect(identity.childSessionIds.get('codex-child')?.transcriptPath).toBe('/t/c');
  });

  it('returns parent for a repeated parent SessionStart (resume case)', () => {
    const identity = createSessionRuntimeIdentity();
    recordSessionStart(identity, 'codex-parent', '/t/p', t0);
    expect(recordSessionStart(identity, 'codex-parent', '/t/p', t2)).toBe('parent');
    expect(identity.childSessionIds.size).toBe(0);
  });
});
