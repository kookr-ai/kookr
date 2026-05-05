// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  terminalInstances: [] as any[],
  fitAddonInstances: [] as any[],
  searchAddonInstances: [] as any[],
  webSocketInstances: [] as any[],
  searchFound: true,
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
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    clear = vi.fn();
    write = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      this.keyHandler = handler;
    });
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
    focus = vi.fn();

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
vi.mock('@xterm/addon-search', () => {
  class MockSearchAddon {
    resultHandler: ((event: { resultIndex: number; resultCount: number }) => void) | null = null;
    findNext = vi.fn((_term: string) => {
      this.resultHandler?.({
        resultIndex: mocks.searchFound ? 0 : -1,
        resultCount: mocks.searchFound ? 1 : 0,
      });
      return mocks.searchFound;
    });
    findPrevious = vi.fn((_term: string) => {
      this.resultHandler?.({
        resultIndex: mocks.searchFound ? 0 : -1,
        resultCount: mocks.searchFound ? 1 : 0,
      });
      return mocks.searchFound;
    });
    clearDecorations = vi.fn();
    onDidChangeResults = vi.fn((handler: (event: { resultIndex: number; resultCount: number }) => void) => {
      this.resultHandler = handler;
      return { dispose: vi.fn() };
    });

    constructor() {
      mocks.searchAddonInstances.push(this);
    }
  }

  return { SearchAddon: MockSearchAddon };
});
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class WebLinksAddon {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../terminal-send.js', () => ({ registerTerminalSend: vi.fn() }));
vi.mock('../telemetry.js', () => ({ track: vi.fn() }));

import { TerminalPanel } from './TerminalPanel.js';

function changeInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function openSearchViaShortcut(terminal: { keyHandler: ((event: KeyboardEvent) => boolean) | null }) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const handled = terminal.keyHandler?.({
    type: 'keydown',
    key: 'f',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault,
    stopPropagation,
  } as KeyboardEvent);
  return { handled, preventDefault, stopPropagation };
}

describe('TerminalPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.terminalInstances.length = 0;
    mocks.fitAddonInstances.length = 0;
    mocks.searchAddonInstances.length = 0;
    mocks.webSocketInstances.length = 0;
    mocks.searchFound = true;
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
    expect(mocks.searchAddonInstances).toHaveLength(1);
    const terminal = mocks.terminalInstances[0];
    const fitAddon = mocks.fitAddonInstances[0];
    const searchAddon = mocks.searchAddonInstances[0];
    expect(terminal.loadAddon).toHaveBeenCalledWith(fitAddon);
    expect(terminal.loadAddon).toHaveBeenCalledWith(searchAddon);
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

  test('opens terminal search with Ctrl+F and searches as the query changes', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const searchAddon = mocks.searchAddonInstances[0];
    let shortcut: ReturnType<typeof openSearchViaShortcut> | null = null;

    act(() => {
      shortcut = openSearchViaShortcut(terminal);
    });

    expect(shortcut?.handled).toBe(false);
    expect(shortcut?.preventDefault).toHaveBeenCalledOnce();
    expect(shortcut?.stopPropagation).toHaveBeenCalledOnce();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search terminal scrollback"]');
    expect(input).not.toBeNull();

    act(() => {
      changeInputValue(input!, 'permission denied');
    });

    expect(searchAddon.findNext).toHaveBeenCalledWith(
      'permission denied',
      expect.objectContaining({ incremental: true }),
    );
    expect(container.textContent).toContain('1/1');
  });

  test('search controls navigate previous and next matches', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const searchAddon = mocks.searchAddonInstances[0];

    act(() => {
      openSearchViaShortcut(terminal);
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search terminal scrollback"]');
    act(() => {
      changeInputValue(input!, 'stack trace');
    });
    searchAddon.findNext.mockClear();

    const previous = container.querySelector<HTMLButtonElement>('button[aria-label="Previous match"]');
    const next = container.querySelector<HTMLButtonElement>('button[aria-label="Next match"]');
    act(() => {
      previous!.click();
      next!.click();
    });

    expect(searchAddon.findPrevious).toHaveBeenCalledWith('stack trace', expect.anything());
    expect(searchAddon.findNext).toHaveBeenLastCalledWith('stack trace', expect.anything());
  });

  test('shows no-match feedback when terminal search finds no result', () => {
    mocks.searchFound = false;
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    act(() => {
      openSearchViaShortcut(terminal);
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search terminal scrollback"]');
    act(() => {
      changeInputValue(input!, 'not-here');
    });

    expect(container.textContent).toContain('No matches');
  });

  test('Escape closes search before reaching the terminal session', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const searchAddon = mocks.searchAddonInstances[0];
    act(() => {
      openSearchViaShortcut(terminal);
    });
    expect(container.querySelector('input[aria-label="Search terminal scrollback"]')).not.toBeNull();

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    act(() => {
      const handled = terminal.keyHandler?.({
        type: 'keydown',
        key: 'Escape',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        preventDefault,
        stopPropagation,
      } as KeyboardEvent);
      expect(handled).toBe(false);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(searchAddon.clearDecorations).toHaveBeenCalled();
    expect(terminal.focus).toHaveBeenCalled();
    expect(container.querySelector('input[aria-label="Search terminal scrollback"]')).toBeNull();
  });

  test('Escape in the focused search input closes search first', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const searchAddon = mocks.searchAddonInstances[0];
    act(() => {
      openSearchViaShortcut(terminal);
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search terminal scrollback"]');
    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input!.dispatchEvent(escapeEvent);
    });

    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(searchAddon.clearDecorations).toHaveBeenCalled();
    expect(terminal.focus).toHaveBeenCalled();
    expect(container.querySelector('input[aria-label="Search terminal scrollback"]')).toBeNull();
  });

  test('switching sessions clears the scoped terminal search', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test-a', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const searchAddon = mocks.searchAddonInstances[0];
    act(() => {
      openSearchViaShortcut(terminal);
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search terminal scrollback"]');
    act(() => {
      changeInputValue(input!, 'old session');
    });

    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test-b', visible: true }));
    });

    expect(searchAddon.clearDecorations).toHaveBeenCalled();
    expect(container.querySelector('input[aria-label="Search terminal scrollback"]')).toBeNull();
  });
});
