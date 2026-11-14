// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { chainBadgeLabel, chainBadgeTitle, formatRemaining, isActiveChainTip } from './ChainBadge.js';
import { parseRepeatInputs } from '../PlaybookBrowser.js';
import type { TaskChainState } from '../../../shared/contracts/playbook-chain.js';

const NOW = Date.parse('2026-11-14T20:00:00.000Z');
const base: TaskChainState = { chainId: 'c', iteration: 3, startedAt: '2026-11-14T18:00:00.000Z', unhealthyStreak: 0 };

describe('chainBadgeLabel', () => {
  it('shows position and remaining time for a running chain', () => {
    expect(chainBadgeLabel({ ...base, maxIterations: 10 }, NOW)).toBe('⛓ 3/10');
    expect(chainBadgeLabel({ ...base, deadlineAt: '2026-11-14T22:14:30.000Z' }, NOW)).toBe('⛓ #3 · 2h 14m left');
    expect(chainBadgeLabel({ ...base, maxIterations: 10, deadlineAt: '2026-11-14T20:45:00.000Z' }, NOW)).toBe('⛓ 3/10 · 45m left');
  });

  it('flags a pending stop and a passed deadline', () => {
    expect(chainBadgeLabel({ ...base, maxIterations: 10, stopRequest: { at: '', by: 'operator' } }, NOW)).toBe('⛓ 3/10 · stopping');
    expect(chainBadgeLabel({ ...base, deadlineAt: '2026-11-14T19:00:00.000Z' }, NOW)).toBe('⛓ #3 · time up, last iteration');
  });

  it('shows why an ended chain ended, and only the position on earlier iterations', () => {
    expect(chainBadgeLabel({ ...base, maxIterations: 3, ended: { at: '', reason: 'iterations_reached' } }, NOW)).toBe('⛓ 3/3 · ended: all iterations ran');
    expect(chainBadgeLabel({ ...base, maxIterations: 10, successorTaskId: 'next', deadlineAt: '2026-11-14T22:00:00.000Z' }, NOW)).toBe('⛓ 3/10');
    expect(isActiveChainTip({ ...base, successorTaskId: 'next' })).toBe(false);
  });

  it('phrases the bounds naturally for each kind of chain', () => {
    expect(chainBadgeTitle({ ...base, maxIterations: 10 })).toContain('Runs for 10 iterations.');
    expect(chainBadgeTitle({ ...base, deadlineAt: '2026-11-14T22:00:00.000Z' })).toMatch(/Runs until .+\./);
    expect(chainBadgeTitle({ ...base, deadlineAt: '2026-11-14T22:00:00.000Z' })).not.toContain('Runs for until');
    expect(chainBadgeTitle({ ...base, maxIterations: 10, deadlineAt: '2026-11-14T22:00:00.000Z' })).toMatch(/Runs for 10 iterations or until .+, whichever comes first\./);
  });

  it('explains the contract and the end detail in the tooltip', () => {
    expect(chainBadgeTitle({ ...base, maxIterations: 10 })).toContain('Kookr launches the next iteration when this task completes.');
    expect(chainBadgeTitle({ ...base, ended: { at: '', reason: 'runaway', detail: '3 unhealthy iterations in a row' } })).toContain('3 unhealthy iterations in a row');
  });
});

describe('formatRemaining', () => {
  it('rounds down to minutes', () => {
    expect(formatRemaining(30_000)).toBe('<1m');
    expect(formatRemaining(2 * 3_600_000)).toBe('2h');
    expect(formatRemaining(61 * 60_000)).toBe('1h 1m');
  });
});

describe('parseRepeatInputs', () => {
  it('treats two empty inputs as a single run', () => {
    expect(parseRepeatInputs('', ' ')).toEqual({ ok: true, value: undefined });
  });

  it('turns hours into minutes and validates both inputs', () => {
    expect(parseRepeatInputs('5', '6')).toEqual({ ok: true, value: { maxIterations: 5, durationMinutes: 360 } });
    expect(parseRepeatInputs('', '0.5')).toEqual({ ok: true, value: { durationMinutes: 30 } });
    expect(parseRepeatInputs('2.5', '')).toMatchObject({ ok: false });
    expect(parseRepeatInputs('', '200')).toMatchObject({ ok: false });
  });
});

describe('ChainStopButton', () => {
  async function render(chain: TaskChainState) {
    const React = await import('react');
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { ChainStopButton } = await import('./ChainBadge.js');
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(React.createElement(ChainStopButton, { agent: { agentId: 'a', taskId: 'tip-1', chain } as never }));
    });
    return { container, act, root };
  }

  it('posts an operator stop for the chain tip', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { container, act, root } = await render({ ...base, maxIterations: 10 });
    const button = container.querySelector('button')!;
    expect(button.textContent).toBe('Stop chain');
    await act(async () => { button.click(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/tip-1/chain/stop', expect.objectContaining({ method: 'POST', body: JSON.stringify({ by: 'operator' }) }));
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('is hidden once a stop is pending, on ended chains, and on earlier iterations', async () => {
    for (const chain of [
      { ...base, stopRequest: { at: '', by: 'operator' as const } },
      { ...base, ended: { at: '', reason: 'stopped' as const } },
      { ...base, successorTaskId: 'next' },
    ]) {
      const { container, act, root } = await render(chain);
      expect(container.querySelector('button')).toBeNull();
      act(() => root.unmount());
    }
  });
});
