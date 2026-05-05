// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  terminalInstances: [] as any[],
  fitAddonInstances: [] as any[],
  webSocketInstances: [] as any[],
}));

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

class MockWebSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor(_url: string) {
    mocks.webSocketInstances.push(this);
  }
}

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    rows = 24;
    resizeHandler: ((size: { cols: unknown; rows: unknown }) => void) | null = null;
    clear = vi.fn();
    write = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn((cb) => {
      this.resizeHandler = cb;
      return { dispose: vi.fn() };
    });
    scrollLines = vi.fn();
    refresh = vi.fn();
    dispose = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    paste = vi.fn();

    constructor() {
      mocks.terminalInstances.push(this);
    }
  }

  return { Terminal: MockTerminal };
});
vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));

    constructor() {
      mocks.fitAddonInstances.push(this);
    }
  }

  return { FitAddon: MockFitAddon };
});
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class WebLinksAddon {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../terminal-send.js', () => ({ registerTerminalSend: vi.fn() }));
vi.mock('../telemetry.js', () => ({ track: vi.fn() }));

import { TerminalPanel } from './TerminalPanel.js';

describe('TerminalPanel visibility restore', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.terminalInstances.length = 0;
    mocks.fitAddonInstances.length = 0;
    mocks.webSocketInstances.length = 0;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
    }
    container?.remove();
    vi.unstubAllGlobals();
  });

  test('forces an xterm repaint when the hidden pane becomes visible again', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: null, visible: false }));
    });

    expect(mocks.terminalInstances).toHaveLength(1);
    expect(mocks.fitAddonInstances).toHaveLength(1);
    const terminal = mocks.terminalInstances[0];
    const fitAddon = mocks.fitAddonInstances[0];
    expect(terminal.loadAddon).toHaveBeenCalledWith(fitAddon);
    expect(terminal.open).toHaveBeenCalledTimes(1);

    fitAddon.fit.mockClear();
    terminal.refresh.mockClear();

    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: null, visible: true }));
    });

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  test.each([
    ['null dims', { cols: null, rows: null }],
    ['zero cols', { cols: 0, rows: 24 }],
    ['negative cols', { cols: -1, rows: 24 }],
    ['fractional cols', { cols: 1.5, rows: 24 }],
    ['string cols', { cols: '80', rows: 24 }],
    ['zero rows', { cols: 80, rows: 0 }],
  ])('does not send invalid resize frames (%s)', (_label, frame) => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onopen?.();
    });
    ws.send.mockClear();

    act(() => {
      terminal.resizeHandler?.(frame);
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  test('sends valid positive-integer resize frames', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onopen?.();
    });
    ws.send.mockClear();

    act(() => {
      terminal.resizeHandler?.({ cols: 80, rows: 24 });
    });

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  });
});
