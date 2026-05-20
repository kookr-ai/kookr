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

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function mount(onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(OperationsPanel, { send: vi.fn(), onClose }));
  });
  return { el: container, onClose };
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
    if (url === '/api/anomaly-stats') {
      return Promise.resolve(jsonResponse({ checks: {}, fires: {}, falsePositives: {} }));
    }
    if (url === '/api/finding-evidence-audit') {
      return Promise.resolve(jsonResponse({ records: [], reviewCandidates: [] }));
    }
    if (url === '/api/finding-evidence-review-log?limit=5') {
      return Promise.resolve(jsonResponse({
        schemaVersion: 'finding-evidence-review-log-read.v1',
        records: [],
        diagnostics: [],
      }));
    }
    if (url === '/api/finding-evidence-review-sampler') {
      return Promise.resolve(jsonResponse({ error: 'finding-review-sampler-unavailable' }, false, 503));
    }
    if (url === '/api/finding-evidence-review-detector-proposals?minReviews=2&maxEvidence=3') {
      return Promise.resolve(jsonResponse({
        schemaVersion: 'detector-proposal-report-response.v1',
        reports: [],
        diagnostics: [],
      }));
    }
    return Promise.resolve(jsonResponse({}));
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
    expect(el.textContent).toContain('Finding Evidence');
    expect(el.textContent).toContain('No persisted finding-evidence reviews yet');
    expect(el.textContent).toContain('No detector proposal candidates yet');
    expect(el.textContent).toContain('No circuit breakers reported yet');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(title?.textContent).toBe('Diagnostics');
    expect(document.activeElement).toBe(el.querySelector('.operations-panel-close'));
  });

  test('surfaces finding evidence audit, sampler, review log, and proposal diagnostics', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/anomaly-stats') {
        return Promise.resolve(jsonResponse({ checks: {}, fires: {}, falsePositives: {} }));
      }
      if (url === '/api/finding-evidence-audit') {
        return Promise.resolve(jsonResponse({
          records: [
            {
              id: 'finding-1',
              agentId: 'agent-a',
              anomalyType: 'needs_input',
              explanation: 'waiting',
              detectedAt: '2026-05-20T06:00:00.000Z',
              updatedAt: '2026-05-20T06:01:00.000Z',
              status: 'active',
              verdict: 'pending',
              observations: [],
              notes: [],
            },
            {
              id: 'finding-2',
              agentId: 'agent-b',
              anomalyType: 'repeated_error',
              explanation: 'resolved',
              detectedAt: '2026-05-20T06:02:00.000Z',
              updatedAt: '2026-05-20T06:03:00.000Z',
              status: 'resolved',
              verdict: 'possible_false_positive',
              observations: [],
              notes: [],
            },
          ],
          reviewCandidates: [{ id: 'finding-1' }],
        }));
      }
      if (url === '/api/finding-evidence-review-log?limit=5') {
        return Promise.resolve(jsonResponse({
          schemaVersion: 'finding-evidence-review-log-read.v1',
          records: [
            {
              kind: 'valid_review',
              appendedAt: '2026-05-20T06:05:00.000Z',
              inputHash: 'a'.repeat(64),
              target: { candidateKind: 'false_positive', detectorTarget: 'needs_input' },
              review: { candidateId: 'finding-1', verdict: 'likely_false_positive', confidence: 'high' },
            },
            {
              kind: 'invalid_attempt',
              appendedAt: '2026-05-20T06:06:00.000Z',
              inputHash: 'b'.repeat(64),
              target: { candidateKind: 'false_positive', detectorTarget: 'repeated_error' },
              attempt: { candidateId: 'finding-2', failureKind: 'invalid_json' },
            },
          ],
          diagnostics: [{ lineNumber: 9, failureKind: 'malformed_json', message: 'bad json' }],
        }));
      }
      if (url === '/api/finding-evidence-review-sampler') {
        return Promise.resolve(jsonResponse({
          schemaVersion: 'finding-evidence-review-sampler-status.v1',
          enabled: true,
          running: true,
          providerAvailable: false,
          lastRun: null,
          nextRunAt: null,
          queue: {
            queued: 2,
            in_progress: 1,
            reviewed: 4,
            failed_retryable: 0,
            failed_terminal: 1,
          },
          budget: {
            dailyCostCents: 100,
            spentCostCents: 25,
            remainingCostCents: 75,
            dailyTokenBudget: 20000,
            spentTokens: 5000,
            remainingTokens: 15000,
          },
        }));
      }
      if (url === '/api/finding-evidence-review-detector-proposals?minReviews=2&maxEvidence=3') {
        return Promise.resolve(jsonResponse({
          schemaVersion: 'detector-proposal-report-response.v1',
          reports: [
            {
              detectorTarget: 'needs_input',
              candidateKind: 'false_positive',
              reviewCounts: {
                total: 3,
                falsePositive: 3,
                falseNegative: 0,
                invalid: 0,
                unclear: 0,
                supportsFinding: 0,
              },
              proposal: {
                status: 'candidate',
                summary: 'needs_input has repeated false-positive reviews',
              },
            },
          ],
          diagnostics: [],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { el } = mount();
    await flush();

    expect(el.textContent).toContain('1 active, 2 reviews, 1 proposals');
    expect(el.textContent).toContain('Review candidates');
    expect(el.textContent).toContain('possible false positive 1');
    expect(el.textContent).toContain('Sampler enabled');
    expect(el.textContent).toContain('provider unavailable');
    expect(el.textContent).toContain('2 queued, 1 running, 4 reviewed, 1 failed');
    expect(el.textContent).toContain('$0.75 budget left');
    expect(el.textContent).toContain('repeated_error');
    expect(el.textContent).toContain('invalid json');
    expect(el.textContent).toContain('needs_input has repeated false-positive reviews');
    expect(el.textContent).toContain('review log line 9: malformed_json');
    expect(el.querySelector<HTMLAnchorElement>('.finding-evidence-proposal-link')?.href)
      .toContain('/api/finding-evidence-review-detector-proposals');
    expect(el.querySelector<HTMLAnchorElement>('.finding-evidence-proposal-link')?.getAttribute('aria-label'))
      .toBe('Open detector proposal report for needs_input');
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
      '/api/finding-evidence-review-log?limit=5',
      '/api/finding-evidence-review-detector-proposals?minReviews=2&maxEvidence=3',
    ]));
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
    const findingEvidenceHeader = el.querySelector<HTMLButtonElement>('.finding-evidence-section .section-header-button');

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
