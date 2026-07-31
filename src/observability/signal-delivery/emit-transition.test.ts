import { describe, expect, test } from 'vitest';
import { detectTransition } from './emit-transition.js';

describe('detectTransition — AC: deploy-lag ok→alert fires, alert→ok clears', () => {
  test('ok → alert emits an alert signal', () => {
    const { signal, nextPrev } = detectTransition({
      source: 'deploy-lag', prev: 'ok', curr: 'alert', detail: '7 commits behind',
    });
    expect(signal?.kind).toBe('alert');
    expect(signal?.key).toBe('deploy-lag:alert');
    expect(signal?.detail).toBe('7 commits behind');
    expect(nextPrev).toBe('alert');
  });

  test('alert → ok emits a clear signal', () => {
    const { signal, nextPrev } = detectTransition({ source: 'deploy-lag', prev: 'alert', curr: 'ok' });
    expect(signal?.kind).toBe('clear');
    expect(signal?.key).toBe('deploy-lag:clear');
    expect(nextPrev).toBe('ok');
  });

  test('unchanged status does not emit', () => {
    expect(detectTransition({ source: 's', prev: 'alert', curr: 'alert' }).signal).toBeNull();
    expect(detectTransition({ source: 's', prev: 'ok', curr: 'ok' }).signal).toBeNull();
  });

  test('first-ever reading (prev unknown) records without emitting', () => {
    const r = detectTransition({ source: 's', prev: 'unknown', curr: 'alert' });
    expect(r.signal).toBeNull();
    expect(r.nextPrev).toBe('alert');
  });

  test('unknown current reading never emits and preserves last known status', () => {
    const r = detectTransition({ source: 's', prev: 'alert', curr: 'unknown' });
    expect(r.signal).toBeNull();
    expect(r.nextPrev).toBe('alert'); // does not manufacture a spurious clear later
  });

  test('prod-smoke uses its own source in the key', () => {
    const { signal } = detectTransition({ source: 'prod-smoke', prev: 'ok', curr: 'alert' });
    expect(signal?.key).toBe('prod-smoke:alert');
    expect(signal?.source).toBe('prod-smoke');
  });
});
