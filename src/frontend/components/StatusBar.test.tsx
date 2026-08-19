// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { QuotaDisplay } from './StatusBar.js';
import type { QuotaStatus } from '../../shared/protocol.js';

// Fixed "now" so formatResetTime is deterministic.
const NOW = new Date('2026-08-19T12:00:00.000Z').getTime();

function renderQuota(quota: QuotaStatus): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<QuotaDisplay quota={quota} />);
  });
  return { container, root };
}

describe('QuotaDisplay 7-day reset time (issue #2705)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  test('7d pill renders its reset time in the same class as the 5h pill', () => {
    const quota: QuotaStatus = {
      fiveHour: { utilization: 31, resetsAt: new Date(NOW + 2 * 60 * 60_000).toISOString() },
      sevenDay: { utilization: 62, resetsAt: new Date(NOW + 4 * 24 * 60 * 60_000).toISOString() },
      updatedAt: NOW,
    };
    const { container, root } = renderQuota(quota);

    const pills = Array.from(container.querySelectorAll<HTMLElement>('.quota-pill'));
    expect(pills).toHaveLength(2);

    const sevenDayPill = pills.find((p) => p.textContent?.includes('7d:'));
    expect(sevenDayPill).toBeDefined();
    const reset = sevenDayPill?.querySelector('.quota-reset');
    expect(reset).not.toBeNull();
    // 4 days out → "(4d)", using the same in-file formatter/class as 5h.
    expect(reset?.textContent).toBe('(4d)');

    act(() => root.unmount());
    container.remove();
  });

  test('5h pill still renders its reset time (unaffected)', () => {
    const quota: QuotaStatus = {
      fiveHour: { utilization: 31, resetsAt: new Date(NOW + (2 * 60 + 56) * 60_000).toISOString() },
      sevenDay: { utilization: 62, resetsAt: new Date(NOW + 4 * 24 * 60 * 60_000).toISOString() },
      updatedAt: NOW,
    };
    const { container, root } = renderQuota(quota);

    const fiveHourPill = Array.from(container.querySelectorAll<HTMLElement>('.quota-pill'))
      .find((p) => p.textContent?.includes('5h:'));
    expect(fiveHourPill?.querySelector('.quota-reset')?.textContent).toBe('(2h 56m)');

    act(() => root.unmount());
    container.remove();
  });

  test('7d pill reads "(now)" when its window has already reset', () => {
    const quota: QuotaStatus = {
      fiveHour: { utilization: 31, resetsAt: new Date(NOW + 60 * 60_000).toISOString() },
      // resetsAt already elapsed (stale snapshot / clock skew): diffMs <= 0.
      sevenDay: { utilization: 88, resetsAt: new Date(NOW - 1_000).toISOString() },
      updatedAt: NOW,
    };
    const { container, root } = renderQuota(quota);

    const sevenDayPill = Array.from(container.querySelectorAll<HTMLElement>('.quota-pill'))
      .find((p) => p.textContent?.includes('7d:'));
    expect(sevenDayPill?.querySelector('.quota-reset')?.textContent).toBe('(now)');

    act(() => root.unmount());
    container.remove();
  });

  test('7d pill renders on its own when the 5-hour window is null', () => {
    const quota: QuotaStatus = {
      fiveHour: null,
      sevenDay: { utilization: 62, resetsAt: new Date(NOW + 4 * 24 * 60 * 60_000).toISOString() },
      updatedAt: NOW,
    };
    const { container, root } = renderQuota(quota);

    const pills = Array.from(container.querySelectorAll<HTMLElement>('.quota-pill'));
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toContain('7d:');
    expect(pills[0].querySelector('.quota-reset')?.textContent).toBe('(4d)');
    expect(container.textContent).not.toContain('5h:');

    act(() => root.unmount());
    container.remove();
  });

  test('renders nothing for a null 7-day window and no 7d pill', () => {
    const quota: QuotaStatus = {
      fiveHour: { utilization: 31, resetsAt: new Date(NOW + 60 * 60_000).toISOString() },
      sevenDay: null,
      updatedAt: NOW,
    };
    const { container, root } = renderQuota(quota);

    const pills = Array.from(container.querySelectorAll<HTMLElement>('.quota-pill'));
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toContain('5h:');
    expect(container.textContent).not.toContain('7d:');

    act(() => root.unmount());
    container.remove();
  });
});
