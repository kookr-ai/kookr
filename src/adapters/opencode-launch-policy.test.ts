import { describe, expect, test } from 'vitest';
import { resolveOpenCodeLaunchMode } from './opencode-launch-policy.js';

describe('resolveOpenCodeLaunchMode', () => {
  test('defaults to tui with no persisted mode', () => {
    expect(resolveOpenCodeLaunchMode()).toEqual({ ok: true, mode: 'tui' });
    expect(resolveOpenCodeLaunchMode({})).toEqual({ ok: true, mode: 'tui' });
  });
  test('honours a persisted tui and treats unknown values as the default', () => {
    expect(resolveOpenCodeLaunchMode({ persisted: 'tui' })).toEqual({ ok: true, mode: 'tui' });
    expect(resolveOpenCodeLaunchMode({ persisted: 'bogus' })).toEqual({ ok: true, mode: 'tui' });
  });
  test('a persisted container is refused while containers are unavailable (no silent tui fallback)', () => {
    const r = resolveOpenCodeLaunchMode({ persisted: 'container' });
    expect(r).toMatchObject({ ok: false, code: 'container_unavailable' });
  });
  test('a persisted container resolves to container once available', () => {
    expect(resolveOpenCodeLaunchMode({ persisted: 'container', containersAvailable: true })).toEqual({ ok: true, mode: 'container' });
  });
  test('availability alone never promotes an unpersisted task to container', () => {
    expect(resolveOpenCodeLaunchMode({ containersAvailable: true })).toEqual({ ok: true, mode: 'tui' });
  });
});

describe('resolveOpenCodeLaunchMode: flag-requested containers (S2d)', () => {
  test('requested + available + nothing persisted => container', () => {
    expect(resolveOpenCodeLaunchMode({ containersRequested: true, containersAvailable: true })).toEqual({ ok: true, mode: 'container' });
  });
  test('requested but unavailable => tui (never a refusal for a task with no history)', () => {
    expect(resolveOpenCodeLaunchMode({ containersRequested: true })).toEqual({ ok: true, mode: 'tui' });
  });
  test('a persisted tui stays tui even when the flag is on (decided once)', () => {
    expect(resolveOpenCodeLaunchMode({ persisted: 'tui', containersRequested: true, containersAvailable: true })).toEqual({ ok: true, mode: 'tui' });
  });
});
