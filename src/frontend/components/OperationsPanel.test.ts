// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OperationsPanel } from './OperationsPanel.js';
import { __resetAudioAlertLogForTests, getAudioAlertSnapshot } from '../audio/audio-alert-log.js';
import { __resetSoundPreferenceForTests } from '../audio/sound.js';
import { __resetDndForTests, disableDnd } from '../hooks/useDnd.js';

let root: Root | null;
let container: HTMLDivElement;

function mount(onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(OperationsPanel, { send: vi.fn(), onClose }));
  });
  return { el: container, onClose };
}

function fetchResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function findingEvidenceOperationsDiagnostics(overrides: Record<string, unknown> = {}) {
  return {
    audit: {
      recordsCount: 0,
      reviewCandidatesCount: 0,
    },
    reviewLog: {
      recordsCount: 0,
      validReviews: 0,
      invalidAttempts: 0,
      diagnosticsCount: 0,
      verdictCounts: {},
    },
    sampler: {
      status: 'available',
      value: {
        enabled: false,
        running: false,
        providerAvailable: false,
        lastRun: null,
        nextRunAt: null,
        queue: {},
        budget: {
          dailyCostCents: 0,
          spentCostCents: 0,
          remainingCostCents: 0,
          dailyTokenBudget: 20_000,
          spentTokens: 0,
          remainingTokens: 20_000,
        },
      },
    },
    proposals: {
      reports: [],
      diagnosticsCount: 0,
    },
    ...overrides,
  };
}

function liveFrictionCalibration(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'live-friction-calibration.v1',
    mode: 'diagnostics_only',
    generatedAt: '2026-05-21T12:00:00.000Z',
    routingMutationAllowed: false,
    interactionCount: 0,
    activeFindingCount: 0,
    signalCount: 0,
    signals: [],
    recommendations: [],
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/anomaly-stats')) {
      return Promise.resolve(fetchResponse({ checks: {}, fires: {}, falsePositives: {} }));
    }
    if (url.startsWith('/api/live-friction-calibration')) {
      return Promise.resolve(fetchResponse(liveFrictionCalibration()));
    }
    if (url.startsWith('/api/finding-evidence-operations-diagnostics')) {
      return Promise.resolve(fetchResponse(findingEvidenceOperationsDiagnostics()));
    }
    return Promise.resolve(fetchResponse({}, false, 404));
  }));
  vi.stubGlobal('AudioContext', undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  __resetAudioAlertLogForTests();
  __resetSoundPreferenceForTests();
  __resetDndForTests();
  disableDnd();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  __resetAudioAlertLogForTests();
  __resetSoundPreferenceForTests();
  __resetDndForTests();
  vi.restoreAllMocks();
});

describe('OperationsPanel', () => {
  test('renders diagnostics and circuit breaker empty states in the utility surface', async () => {
    const { el } = mount();
    await flush();
    const dialog = el.querySelector<HTMLElement>('.operations-panel');
    const title = el.querySelector<HTMLElement>('#operations-panel-title');

    expect(el.textContent).toContain('Diagnostics');
    expect(el.textContent).toContain('Audio Alerts');
    expect(el.textContent).toContain('No audio alert decisions recorded yet');
    expect(el.textContent).toContain('No detection checks recorded yet');
    expect(el.textContent).toContain('Friction Calibration');
    expect(el.textContent).toContain('Finding Evidence');
    expect(el.textContent).toContain('Sampler disabled');
    expect(el.textContent).toContain('Review candidates');
    expect(el.textContent).toContain('No circuit breakers reported yet');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(title?.textContent).toBe('Diagnostics');
    expect(document.activeElement).toBe(el.querySelector('.operations-panel-close'));
  });

  test('renders finding evidence diagnostics from the operations diagnostics route', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/anomaly-stats')) {
        return Promise.resolve(fetchResponse({ checks: {}, fires: {}, falsePositives: {} }));
      }
      if (url.startsWith('/api/live-friction-calibration')) {
        return Promise.resolve(fetchResponse(liveFrictionCalibration({
          interactionCount: 6,
          activeFindingCount: 1,
          signalCount: 2,
          signals: [{
            kind: 'skipped_finding',
            target: 'needs_input',
            count: 2,
            agentCount: 2,
            evidence: [],
          }],
          recommendations: [{
            id: 'down-weight:needs_input',
            target: 'needs_input',
            direction: 'down_weight_candidate',
            reason: 'needs_input is being skipped frequently in this session.',
            evidence: [],
            affectedActiveAgentIds: ['agent-3'],
            wouldMutateQueue: false,
          }],
        })));
      }
      if (url.startsWith('/api/finding-evidence-operations-diagnostics')) {
        return Promise.resolve(fetchResponse(findingEvidenceOperationsDiagnostics({
          audit: {
            recordsCount: 1,
            reviewCandidatesCount: 1,
          },
          reviewLog: {
            recordsCount: 2,
            validReviews: 1,
            invalidAttempts: 1,
            diagnosticsCount: 1,
            verdictCounts: { likely_false_positive: 1 },
          },
          sampler: {
            status: 'available',
            value: {
              enabled: true,
              running: true,
              providerAvailable: true,
              lastRun: {
                finishedAt: '2026-05-20T06:02:00.000Z',
                sampled: 4,
                enqueued: 1,
                reviewed: 1,
                modelCallsFailed: 0,
                invalidOutputs: 0,
                skipped: {},
              },
              nextRunAt: '2026-05-20T06:17:00.000Z',
              queue: { queued: 2, reviewed: 3 },
              budget: {
                dailyCostCents: 100,
                spentCostCents: 25,
                remainingCostCents: 75,
                dailyTokenBudget: 20_000,
                spentTokens: 500,
                remainingTokens: 19_500,
              },
            },
          },
          proposals: {
            reports: [{
              detectorTarget: 'needs_input',
              candidateKind: 'false_positive',
              reviewCounts: { total: 2, falsePositive: 2, falseNegative: 0, invalid: 0, unclear: 0, supportsFinding: 0 },
              proposal: { status: 'candidate', summary: 'needs_input has 2 false-positive reviews' },
            }],
            diagnosticsCount: 0,
          },
        })));
      }
      return Promise.resolve(fetchResponse({}, false, 404));
    });

    const { el } = mount();
    await flush();

    expect(el.textContent).toContain('1 candidates, 2 reviews');
    expect(el.textContent).toContain('Sampler running');
    expect(el.textContent).toContain('Reviewer model ready');
    expect(el.textContent).toContain('Review attention');
    expect(el.textContent).toContain('Audit records');
    expect(el.textContent).toContain('Persisted reviews');
    expect(el.textContent).toContain('Proposal reports');
    expect(el.textContent).toContain('valid 1');
    expect(el.textContent).toContain('invalid 1');
    expect(el.textContent).toContain('diagnostics 1');
    expect(el.textContent).toContain('Likely false positive 1');
    expect(el.textContent).toContain('Needs Input');
    expect(el.textContent).toContain('Candidate');

    const calibrationHeader = Array.from(el.querySelectorAll('button')).find((button) => (
      button.textContent?.includes('Friction Calibration')
    ));
    await act(async () => {
      calibrationHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(el.textContent).toContain('Diagnostics only');
    expect(el.textContent).toContain('Does not reorder findings');
    expect(el.textContent).toContain('Down-weight candidate');
  });

  test('renders signal-only live friction calibration diagnostics', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/anomaly-stats')) {
        return Promise.resolve(fetchResponse({ checks: {}, fires: {}, falsePositives: {} }));
      }
      if (url.startsWith('/api/live-friction-calibration')) {
        return Promise.resolve(fetchResponse(liveFrictionCalibration({
          interactionCount: 4,
          activeFindingCount: 2,
          signalCount: 2,
          signals: [{
            kind: 'skipped_finding',
            target: 'needs_input',
            count: 2,
            agentCount: 2,
            evidence: [],
          }],
          recommendations: [],
        })));
      }
      if (url.startsWith('/api/finding-evidence-operations-diagnostics')) {
        return Promise.resolve(fetchResponse(findingEvidenceOperationsDiagnostics()));
      }
      return Promise.resolve(fetchResponse({}, false, 404));
    });

    const { el } = mount();
    await flush();

    expect(el.textContent).toContain('2 signals');
    const calibrationHeader = Array.from(el.querySelectorAll('button')).find((button) => (
      button.textContent?.includes('Friction Calibration')
    ));
    await act(async () => {
      calibrationHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(el.textContent).toContain('Needs Input');
    expect(el.textContent).toContain('Skipped finding');
    expect(el.textContent).toContain('2 signals across 2 agents');
  });

  test('renders live friction calibration fetch errors inside the diagnostics panel', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/anomaly-stats')) {
        return Promise.resolve(fetchResponse({ checks: {}, fires: {}, falsePositives: {} }));
      }
      if (url.startsWith('/api/live-friction-calibration')) {
        return Promise.resolve(fetchResponse({}, false, 500));
      }
      if (url.startsWith('/api/finding-evidence-operations-diagnostics')) {
        return Promise.resolve(fetchResponse(findingEvidenceOperationsDiagnostics()));
      }
      return Promise.resolve(fetchResponse({}, false, 404));
    });

    const { el } = mount();
    await flush();

    const calibrationHeader = Array.from(el.querySelectorAll('button')).find((button) => (
      button.textContent?.includes('Friction Calibration')
    ));
    await act(async () => {
      calibrationHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(el.textContent).toContain('Live friction calibration returned HTTP 500');
  });

  test('keeps finding evidence diagnostics visible when sampler status is unavailable', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/anomaly-stats')) {
        return Promise.resolve(fetchResponse({ checks: {}, fires: {}, falsePositives: {} }));
      }
      if (url.startsWith('/api/live-friction-calibration')) {
        return Promise.resolve(fetchResponse(liveFrictionCalibration()));
      }
      if (url.startsWith('/api/finding-evidence-operations-diagnostics')) {
        return Promise.resolve(fetchResponse(findingEvidenceOperationsDiagnostics({
          audit: {
            recordsCount: 1,
            reviewCandidatesCount: 1,
          },
          reviewLog: {
            recordsCount: 0,
            validReviews: 0,
            invalidAttempts: 0,
            diagnosticsCount: 1,
            verdictCounts: {},
          },
          sampler: {
            status: 'unavailable',
            error: 'finding-review-sampler-unavailable',
          },
        })));
      }
      return Promise.resolve(fetchResponse({}, false, 404));
    });

    const { el } = mount();
    await flush();

    expect(el.textContent).toContain('1 candidates, 0 reviews');
    expect(el.textContent).toContain('Sampler unavailable');
    expect(el.textContent).toContain('Audit records');
    expect(el.textContent).toContain('diagnostics 1');
    expect(el.textContent).toContain('Review attention');
  });

  test('test alert policy action records a local decision', async () => {
    const { el } = mount();
    await flush();

    const testButton = Array.from(el.querySelectorAll('button')).find((button) => button.textContent === 'Test');
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(getAudioAlertSnapshot().lastDecision).toMatchObject({
      source: 'manual_test',
      reason: 'AudioContext unavailable',
      outcome: 'audio_context_unavailable',
    });
    expect(el.textContent).toContain('No AudioContext 1');
  });

  test('close button calls onClose', async () => {
    const { el, onClose } = mount();
    await flush();

    const close = el.querySelector<HTMLButtonElement>('.operations-panel-close');
    expect(close).toBeTruthy();
    act(() => close?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('overlay click closes but dialog body click does not', async () => {
    const { el, onClose } = mount();
    await flush();

    const dialog = el.querySelector<HTMLElement>('.operations-panel');
    act(() => dialog?.click());
    expect(onClose).not.toHaveBeenCalled();

    const overlay = el.querySelector<HTMLElement>('.dialog-overlay');
    act(() => overlay?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('Escape closes the diagnostics dialog', async () => {
    const { onClose } = mount();
    await flush();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('keeps tab focus inside the diagnostics dialog', async () => {
    const { el } = mount();
    await flush();

    const close = el.querySelector<HTMLButtonElement>('.operations-panel-close');
    const findingEvidenceHeader = el.querySelector<HTMLButtonElement>('.finding-evidence-header');

    close?.focus();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(document.activeElement).toBe(findingEvidenceHeader);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(document.activeElement).toBe(close);
  });

  test('restores focus to the opener when unmounted', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    document.body.appendChild(opener);
    opener.focus();

    const { el } = mount();
    await flush();
    expect(document.activeElement).toBe(el.querySelector('.operations-panel-close'));

    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
