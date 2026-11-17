import { describe, expect, test, vi } from 'vitest';
import { OPERATOR_AWAY_MS, watchOperatorReturn, type PresenceSources } from './operator-presence.js';

const MIN = 60_000;

/** A page whose clock, visibility and input the test drives. */
function fakePage() {
  let now = 1_000_000;
  let hidden = false;
  const visibility = new Set<() => void>();
  const activity = new Set<() => void>();
  const sources: PresenceSources = {
    now: () => now,
    isHidden: () => hidden,
    onVisibilityChange: (listener) => { visibility.add(listener); return () => visibility.delete(listener); },
    onActivity: (listener) => { activity.add(listener); return () => activity.delete(listener); },
  };
  return {
    sources,
    pass: (ms: number) => { now += ms; },
    act: () => { for (const listener of activity) listener(); },
    hide: () => { hidden = true; for (const listener of visibility) listener(); },
    show: () => { hidden = false; for (const listener of visibility) listener(); },
    listeners: () => visibility.size + activity.size,
  };
}

describe('watchOperatorReturn', () => {
  test('ten minutes is the default', () => {
    expect(OPERATOR_AWAY_MS).toBe(10 * MIN);
  });

  test('activity after ten minutes without any is a return, reported once with how long it was', () => {
    const page = fakePage();
    const onReturn = vi.fn();
    watchOperatorReturn(onReturn, { sources: page.sources });
    page.pass(10 * MIN);
    page.act();
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onReturn).toHaveBeenCalledWith(10 * MIN);
    // The pointer keeps moving: still the same return.
    page.pass(50);
    page.act();
    page.act();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  test('steady work is never a return, however long it lasts', () => {
    const page = fakePage();
    const onReturn = vi.fn();
    watchOperatorReturn(onReturn, { sources: page.sources });
    for (let i = 0; i < 30; i += 1) {
      page.pass(9 * MIN + 59_000);
      page.act();
    }
    expect(onReturn).not.toHaveBeenCalled();
  });

  test('a tab shown again after ten minutes is a return, and the pointer that follows does not report it twice', () => {
    const page = fakePage();
    const onReturn = vi.fn();
    watchOperatorReturn(onReturn, { sources: page.sources });
    page.pass(MIN);
    page.act();
    page.hide();
    page.pass(12 * MIN);
    page.show();
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onReturn).toHaveBeenCalledWith(12 * MIN);
    page.pass(200);
    page.act();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  test('a short look at another tab is not a return', () => {
    const page = fakePage();
    const onReturn = vi.fn();
    watchOperatorReturn(onReturn, { sources: page.sources });
    page.act();
    page.hide();
    page.pass(9 * MIN);
    page.show();
    expect(onReturn).not.toHaveBeenCalled();
  });

  test('hiding the tab is not a sign of presence: a screen that locks by itself does not restart the clock', () => {
    const page = fakePage();
    const onReturn = vi.fn();
    watchOperatorReturn(onReturn, { sources: page.sources });
    page.act();
    page.pass(8 * MIN);
    page.hide(); // the screen locks, the operator left eight minutes ago
    page.pass(3 * MIN);
    page.show();
    expect(onReturn).toHaveBeenCalledWith(11 * MIN);
  });

  test('input that reaches a hidden page is ignored', () => {
    const page = fakePage();
    const onReturn = vi.fn();
    watchOperatorReturn(onReturn, { sources: page.sources });
    page.hide();
    page.pass(20 * MIN);
    page.act();
    expect(onReturn).not.toHaveBeenCalled();
    page.show();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  test('a second absence is a second return', () => {
    const page = fakePage();
    const onReturn = vi.fn();
    watchOperatorReturn(onReturn, { sources: page.sources });
    page.pass(15 * MIN);
    page.act();
    page.pass(25 * MIN);
    page.act();
    expect(onReturn.mock.calls.map((call) => call[0])).toEqual([15 * MIN, 25 * MIN]);
  });

  test('the away time can be set, and stopping removes every listener', () => {
    const page = fakePage();
    const onReturn = vi.fn();
    const stop = watchOperatorReturn(onReturn, { sources: page.sources, awayMs: MIN });
    expect(page.listeners()).toBe(2);
    page.pass(MIN);
    page.act();
    expect(onReturn).toHaveBeenCalledTimes(1);
    stop();
    expect(page.listeners()).toBe(0);
    page.pass(5 * MIN);
    page.act();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});
