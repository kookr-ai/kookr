// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import { shouldAutoFocusReply, anomalyTransitionKey } from './detail-panel-focus.js';

function makeDiv(className = ''): HTMLDivElement {
  const el = document.createElement('div');
  if (className) el.className = className;
  return el;
}

describe('anomalyTransitionKey', () => {
  test('returns null when no anomaly type', () => {
    expect(anomalyTransitionKey('a1', undefined)).toBe(null);
    expect(anomalyTransitionKey('a1', '')).toBe(null);
    expect(anomalyTransitionKey(undefined, undefined)).toBe(null);
  });

  test('combines agentId and anomaly type so agent-switch counts as a transition', () => {
    expect(anomalyTransitionKey('a1', 'needs_input')).toBe('a1:needs_input');
    expect(anomalyTransitionKey('a2', 'needs_input')).toBe('a2:needs_input');
  });

  test('missing agentId still yields a stable key', () => {
    expect(anomalyTransitionKey(undefined, 'needs_input')).toBe(':needs_input');
  });
});

describe('shouldAutoFocusReply — transition gate', () => {
  test('no current anomaly → do not focus', () => {
    expect(shouldAutoFocusReply({
      currentKey: null,
      prevKey: null,
      selectionLength: 0,
      activeElement: document.body,
    })).toBe(false);
  });

  test('anomaly first appears (null → type) → focus', () => {
    expect(shouldAutoFocusReply({
      currentKey: 'a1:needs_input',
      prevKey: null,
      selectionLength: 0,
      activeElement: document.body,
    })).toBe(true);
  });

  test('same (agent, anomaly type) as last tick → skip (this is the bug-fix case)', () => {
    // WebSocket re-emits the same anomaly on every update — must not re-focus.
    expect(shouldAutoFocusReply({
      currentKey: 'a1:needs_input',
      prevKey: 'a1:needs_input',
      selectionLength: 0,
      activeElement: document.body,
    })).toBe(false);
  });

  test('anomaly type changes on same agent → focus', () => {
    expect(shouldAutoFocusReply({
      currentKey: 'a1:repeated_error',
      prevKey: 'a1:needs_input',
      selectionLength: 0,
      activeElement: document.body,
    })).toBe(true);
  });

  test('agent switch while both carry the same anomaly type → focus', () => {
    // Without the agentId in the key this would be a false negative.
    expect(shouldAutoFocusReply({
      currentKey: 'a2:needs_input',
      prevKey: 'a1:needs_input',
      selectionLength: 0,
      activeElement: document.body,
    })).toBe(true);
  });
});

describe('shouldAutoFocusReply — selection gate', () => {
  test('non-empty text selection blocks focus even on a real transition', () => {
    expect(shouldAutoFocusReply({
      currentKey: 'a1:needs_input',
      prevKey: null,
      selectionLength: 42,
      activeElement: document.body,
    })).toBe(false);
  });

  test('empty selection does not block', () => {
    expect(shouldAutoFocusReply({
      currentKey: 'a1:needs_input',
      prevKey: null,
      selectionLength: 0,
      activeElement: document.body,
    })).toBe(true);
  });
});

describe('shouldAutoFocusReply — active-element gate', () => {
  test('focus already in an INPUT → do not steal', () => {
    const input = document.createElement('input');
    expect(shouldAutoFocusReply({
      currentKey: 'a1:needs_input',
      prevKey: null,
      selectionLength: 0,
      activeElement: input,
    })).toBe(false);
  });

  test('focus already in a TEXTAREA → do not steal', () => {
    const ta = document.createElement('textarea');
    expect(shouldAutoFocusReply({
      currentKey: 'a1:needs_input',
      prevKey: null,
      selectionLength: 0,
      activeElement: ta,
    })).toBe(false);
  });

  test('focus inside an .xterm subtree → do not steal', () => {
    const term = makeDiv('xterm');
    const child = document.createElement('span');
    term.appendChild(child);
    document.body.appendChild(term);
    try {
      expect(shouldAutoFocusReply({
        currentKey: 'a1:needs_input',
        prevKey: null,
        selectionLength: 0,
        activeElement: child,
      })).toBe(false);
    } finally {
      term.remove();
    }
  });

  test('focus inside a .terminal-xterm container → do not steal', () => {
    const term = makeDiv('terminal-xterm');
    const child = document.createElement('span');
    term.appendChild(child);
    document.body.appendChild(term);
    try {
      expect(shouldAutoFocusReply({
        currentKey: 'a1:needs_input',
        prevKey: null,
        selectionLength: 0,
        activeElement: child,
      })).toBe(false);
    } finally {
      term.remove();
    }
  });

  test('null activeElement still allows focus', () => {
    expect(shouldAutoFocusReply({
      currentKey: 'a1:needs_input',
      prevKey: null,
      selectionLength: 0,
      activeElement: null,
    })).toBe(true);
  });
});
