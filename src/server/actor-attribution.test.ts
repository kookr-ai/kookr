import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import {
  ACTOR_HEADER,
  UNATTRIBUTED_ACTOR_ID,
  resetActorAttributionWarningsForTests,
  resolveLifecycleActor,
} from './actor-attribution.js';

describe('resolveLifecycleActor', () => {
  beforeEach(() => {
    resetActorAttributionWarningsForTests();
  });

  test('carries the caller-supplied id through unchanged', () => {
    expect(resolveLifecycleActor('api', 'lucy-supervisor')).toEqual({
      source: 'api',
      actorId: 'lucy-supervisor',
    });
  });

  test('trims surrounding whitespace', () => {
    expect(resolveLifecycleActor('api', '  dashboard  ')).toEqual({
      source: 'api',
      actorId: 'dashboard',
    });
  });

  test('falls back to unattributed for a missing header value', () => {
    expect(resolveLifecycleActor('api', undefined)).toEqual({
      source: 'api',
      actorId: UNATTRIBUTED_ACTOR_ID,
    });
  });

  test('falls back to unattributed for a blank header value', () => {
    expect(resolveLifecycleActor('websocket', '   ')).toEqual({
      source: 'websocket',
      actorId: UNATTRIBUTED_ACTOR_ID,
    });
  });

  test('truncates an oversized actor id rather than storing it unbounded', () => {
    const huge = 'x'.repeat(500);
    const resolved = resolveLifecycleActor('api', huge);
    expect(resolved.actorId.length).toBe(128);
  });

  test('exports the header name used by callers', () => {
    expect(ACTOR_HEADER).toBe('x-kookr-actor');
  });

  describe('warn-once-per-boot behavior', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    test('warns exactly once for repeated unattributed calls on the same source', () => {
      resolveLifecycleActor('api', undefined);
      resolveLifecycleActor('api', undefined);
      resolveLifecycleActor('api', '');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    test('warns again for a different source', () => {
      resolveLifecycleActor('api', undefined);
      resolveLifecycleActor('websocket', undefined);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    test('never warns when a caller id is supplied', () => {
      resolveLifecycleActor('api', 'lucy-supervisor');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
