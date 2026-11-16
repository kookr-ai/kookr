// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { AgentState, GitHubPRState } from '../../../shared/protocol.js';
import type { PrDeliveryState } from '../../../shared/contracts/pr-delivery.js';
import { createKookrStore, useKookrStore } from '../../store/useStore.js';
import { PrDeliveryFact } from '../DetailPanel/PrDeliveryFact.js';
import { CompletedRow } from './CompletedRow.js';
import { FindingPrChip } from './FindingPrChip.js';
import { deliverySentence, findingPrChipLabel, selectFindingPrChip } from './finding-pr-chip.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  useKookrStore.setState(Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  ));
}

function makePr(fields: Partial<GitHubPRState> = {}): GitHubPRState {
  return {
    ref: {
      type: 'pr', owner: 'kookr-ai', repo: 'kookr', number: 3920,
      url: 'https://github.com/kookr-ai/kookr/pull/3920',
      detectedAt: new Date('2026-11-16T08:00:00.000Z'), detectedFrom: 'agent', taskId: 'task-1',
    },
    title: 'Delivery state', status: 'merged', mergeable: 'UNKNOWN', author: 'dev', branch: 'b', baseBranch: 'staging',
    reviewDecision: null, reviewers: [], unresolvedThreads: [], totalComments: 0, checks: [],
    lastFetchedAt: new Date('2026-11-16T10:00:00.000Z'),
    ...fields,
  };
}

const base = { integrationBranch: 'staging', openedAt: '2026-11-16T08:30:00.000Z', mergedAt: '2026-11-16T09:00:00.000Z' };
const STATES: Record<string, { pr: Partial<GitHubPRState>; delivery: PrDeliveryState; label: string; tone: string }> = {
  open: {
    pr: { status: 'open' },
    delivery: { stage: 'pr-open', integrationBranch: 'staging', openedAt: base.openedAt },
    label: '#3920 · PR open',
    tone: 'open',
  },
  staging: {
    pr: {},
    delivery: { ...base, stage: 'in-staging' },
    label: '#3920 · in staging',
    tone: 'staging',
  },
  main: {
    pr: {},
    delivery: { ...base, stage: 'on-main', onMainAt: '2026-11-16T09:40:00.000Z' },
    label: '#3920 · on main',
    tone: 'main',
  },
  reverted: {
    pr: {},
    delivery: {
      ...base, stage: 'reverted', revertedAt: '2026-11-16T09:30:00.000Z',
      revert: { revertCommit: 'b'.repeat(40), attempt: 2, maxAttempts: 3, fixTaskKey: 'train-fix-issue-3915-2', needsHuman: false, failingTests: ['src/b.test.ts > b > breaks'] },
    },
    label: '#3920 · reverted · fix 2/3',
    tone: 'reverted',
  },
  needsHuman: {
    pr: {},
    delivery: {
      ...base, stage: 'reverted', revertedAt: '2026-11-16T09:30:00.000Z',
      revert: { revertCommit: 'b'.repeat(40), needsHuman: true, failingTests: [] },
    },
    label: '#3920 · reverted · needs you',
    tone: 'reverted',
  },
  skipped: {
    pr: { baseBranch: 'main' },
    delivery: { ...base, stage: 'on-main', onMainAt: base.mergedAt, mergedIntoMain: true, skippedTrain: true },
    label: '#3920 · on main · skipped train',
    tone: 'skipped',
  },
};

describe('delivery labels', () => {
  test('without a delivery state the chip keeps the plain PR status', () => {
    expect(findingPrChipLabel(selectFindingPrChip([makePr()])!)).toBe('#3920 · merged');
  });

  test.each(Object.entries(STATES))('%s: the chip names where the change is', (_name, s) => {
    expect(findingPrChipLabel(selectFindingPrChip([makePr({ ...s.pr, delivery: s.delivery })])!)).toBe(s.label);
  });

  test('a problem on an open PR is still listed after the delivery word', () => {
    const pr = makePr({ status: 'open', mergeable: 'CONFLICTING', delivery: STATES.open!.delivery });
    expect(findingPrChipLabel(selectFindingPrChip([pr])!)).toBe('#3920 · PR open · conflict');
  });

  test('the sentence explains each state in the operator\'s words', () => {
    expect(deliverySentence(STATES.staging!.delivery)).toMatch(/^In staging since .+, awaiting the train: main does not have it yet\.$/);
    expect(deliverySentence(STATES.main!.delivery)).toMatch(/^On main since .+: the train verified it\.$/);
    expect(deliverySentence(STATES.reverted!.delivery)).toMatch(/Fix attempt 2 of 3 is running\.$/);
    expect(deliverySentence(STATES.needsHuman!.delivery)).toMatch(/it needs a human\.$/);
    expect(deliverySentence(STATES.skipped!.delivery)).toMatch(/it skipped the train\.$/);
  });

  test('a PR merged into main before the train existed is never described as train-verified', () => {
    const preTrain: PrDeliveryState = { ...base, stage: 'on-main', mergedIntoMain: true };
    expect(findingPrChipLabel(selectFindingPrChip([makePr({ baseBranch: 'main', delivery: preTrain })])!)).toBe('#3920 · on main');
    expect(deliverySentence(preTrain)).toMatch(/merged straight into main, before the train ran\.$/);
    expect(deliverySentence(preTrain)).not.toMatch(/train verified/);
  });
});

describe('FindingPrChip delivery badge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test.each(Object.entries(STATES))('%s: tone class, glyph, stage attribute and an explaining title', (_name, s) => {
    act(() => {
      root.render(<FindingPrChip prs={[makePr({ ...s.pr, delivery: s.delivery })]} onSelect={vi.fn()} />);
    });
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="finding-pr-chip"]')!;
    expect(chip.textContent).toContain(s.label);
    expect(chip.className).toContain(`finding-pr-chip--delivery-${s.tone}`);
    expect(chip.dataset.deliveryStage).toBe(s.delivery.stage);
    expect(chip.querySelector('.finding-pr-chip-glyph')?.getAttribute('aria-hidden')).toBe('true');
    expect(chip.title).toBe(deliverySentence(s.delivery));
    expect(chip.getAttribute('aria-label')).toContain(deliverySentence(s.delivery));
  });

  test('a failed CI keeps its red attention colour over the delivery tone', () => {
    act(() => {
      root.render(<FindingPrChip
        prs={[makePr({ status: 'open', checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }], delivery: STATES.open!.delivery })]}
        onSelect={vi.fn()}
      />);
    });
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="finding-pr-chip"]')!;
    expect(chip.className).toContain('finding-pr-chip--failed');
    expect(chip.className).not.toContain('finding-pr-chip--delivery-');
  });

  test('without a delivery state there is no glyph and no title', () => {
    act(() => { root.render(<FindingPrChip prs={[makePr()]} onSelect={vi.fn()} />); });
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="finding-pr-chip"]')!;
    expect(chip.querySelector('.finding-pr-chip-glyph')).toBeNull();
    expect(chip.hasAttribute('title')).toBe(false);
    expect(chip.dataset.deliveryStage).toBeUndefined();
  });
});

describe('CompletedRow delivery badge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderRow(prs: GitHubPRState[] | undefined) {
    const agent = {
      agentId: 'agent-1', taskId: 'task-1', taskName: 'Delivered task', description: 'Done', events: [],
      taskStatus: 'completed', cwd: '/tmp/project', finishedAt: '2026-11-16T09:05:00.000Z',
    } as unknown as AgentState;
    useKookrStore.setState({
      agents: [agent],
      githubState: prs ? { 'task-1': { taskId: 'task-1', prs, issues: [], changes: [] } } : {},
    });
    act(() => {
      root.render(<CompletedRow agent={agent} selected={false} send={vi.fn()} pendingDeletion={false} />);
    });
  }

  test('a delivered task in the completed list shows where its change is', () => {
    renderRow([makePr({ delivery: STATES.staging!.delivery })]);
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="finding-pr-chip"]');
    expect(chip?.textContent).toContain('#3920 · in staging');
  });

  test('a task without a PR shows no chip', () => {
    renderRow(undefined);
    expect(container.querySelector('[data-testid="finding-pr-chip"]')).toBeNull();
  });
});

describe('PrDeliveryFact (detail pane)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(name: keyof typeof STATES) {
    const s = STATES[name]!;
    act(() => { root.render(<dl><PrDeliveryFact prs={[makePr({ ...s.pr, delivery: s.delivery })]} /></dl>); });
    const steps = [...container.querySelectorAll('.detail-delivery-step')].map((li) => ({
      text: li.querySelector('span:nth-child(2)')?.textContent,
      state: [...li.classList].find((c) => c.startsWith('detail-delivery-step--'))?.replace('detail-delivery-step--', ''),
      hasTime: li.querySelector('time') !== null,
    }));
    return { fact: container.querySelector('[data-testid="detail-fact-delivery"]'), steps };
  }

  test('nothing when the PR has no delivery state', () => {
    act(() => { root.render(<dl><PrDeliveryFact prs={[makePr()]} /></dl>); });
    expect(container.querySelector('[data-testid="detail-fact-delivery"]')).toBeNull();
  });

  test('PR open: opened, then two pending steps', () => {
    const { fact, steps } = render('open');
    expect(fact?.textContent).toContain('PR open');
    expect(steps.map((s) => [s.text, s.state, s.hasTime])).toEqual([
      ['PR opened', 'done', true],
      ['Merged into staging', 'pending', false],
      ['On main', 'pending', false],
    ]);
  });

  test('in staging: merged with its time, main still awaiting the train', () => {
    const { steps } = render('staging');
    expect(steps.map((s) => [s.text, s.state, s.hasTime])).toEqual([
      ['PR opened', 'done', true],
      ['Merged into staging', 'done', true],
      ['On main: awaiting the train', 'pending', false],
    ]);
  });

  test('on main: every step reached, each with its time', () => {
    const { steps } = render('main');
    expect(steps.map((s) => [s.text, s.state, s.hasTime])).toEqual([
      ['PR opened', 'done', true],
      ['Merged into staging', 'done', true],
      ['On main', 'done', true],
    ]);
  });

  test('reverted: the revert step, the failing tests and the fix task with its attempt', () => {
    const { fact, steps } = render('reverted');
    expect(steps.at(-1)).toEqual({ text: 'Reverted by the train', state: 'bad', hasTime: true });
    const box = fact?.querySelector('[data-testid="detail-delivery-revert"]');
    expect(box?.textContent).toContain('src/b.test.ts > b > breaks');
    expect(box?.textContent).toContain('Fix task train-fix-issue-3915-2 (attempt 2 of 3).');
    expect(box?.textContent).toContain('bbbbbbbbbb');
  });

  test('reverted with no fix left: says it needs a human', () => {
    const { fact } = render('needsHuman');
    expect(fact?.querySelector('[data-testid="detail-delivery-revert"]')?.textContent).toContain('No automatic fix left: needs a human.');
  });

  test('merged into main before the train: one plain step, no staging step', () => {
    act(() => {
      root.render(<dl><PrDeliveryFact prs={[makePr({ baseBranch: 'main', delivery: { ...base, stage: 'on-main', mergedIntoMain: true } })]} /></dl>);
    });
    const labels = [...container.querySelectorAll('.detail-delivery-step span:nth-child(2)')].map((el) => el.textContent);
    expect(labels).toEqual(['PR opened', 'Merged into main']);
  });

  test('skipped the train: one warning step instead of the staging step', () => {
    const { steps } = render('skipped');
    expect(steps.map((s) => [s.text, s.state])).toEqual([
      ['PR opened', 'done'],
      ['Merged straight into main (skipped the train)', 'warn'],
    ]);
  });
});
