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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ checks: {}, fires: {}, falsePositives: {} }),
  } as Response)));
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
    expect(el.textContent).toContain('No circuit breakers reported yet');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(title?.textContent).toBe('Diagnostics');
    expect(document.activeElement).toBe(el.querySelector('.operations-panel-close'));
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
    const runDiagnostic = el.querySelector<HTMLButtonElement>('.diagnostic-run-btn');

    close?.focus();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(document.activeElement).toBe(runDiagnostic);

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
