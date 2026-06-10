// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ActivityPanel } from './ActivityPanel.js';

describe('ActivityPanel delivery source labels', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  test('renders GitHub watcher deliveries with non-human attribution', () => {
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(ActivityPanel, {
        events: [],
        userInputDeliveries: [{
          deliveryId: 'd1',
          sessionId: 's1',
          deliverySeq: 1,
          source: 'github_watcher',
          text: 'Kookr GitHub watcher: PR #1 was merged.',
          status: 'queued',
          createdAt: '2026-06-10T10:00:00.000Z',
          updatedAt: '2026-06-10T10:00:00.000Z',
        }],
      }));
    });

    expect(container.querySelector('.act-msg-label')?.textContent).toBe('Kookr watcher');
  });
});
