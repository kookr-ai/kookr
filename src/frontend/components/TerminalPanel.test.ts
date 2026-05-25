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
    dataHandler: ((data: string) => void) | null = null;
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    clear = vi.fn();
    write = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn();
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      this.keyHandler = handler;
    });
    onData = vi.fn((cb) => {
      this.dataHandler = cb;
      return { dispose: vi.fn() };
    });
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
import { buildPasteFrame } from '../terminal-paste.js';
import { registerTerminalSend } from '../terminal-send.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function changeInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Dispatch a browser `paste` on `target`. jsdom does not implement
 * `ClipboardEvent`, so we fire a plain `Event` and attach a minimal
 * `clipboardData` shape — exactly what `handlePasteCapture` reads.
 */
function dispatchPaste(target: Element, text: string): Event {
  const evt = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text' || type === 'text/plain' ? text : '') },
  });
  target.dispatchEvent(evt);
  return evt;
}

function arrayBufferFrom(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
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
    vi.clearAllMocks();
    syncGlobalStore();
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

  test('does not register global terminal send while hidden', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: false }));
    });

    const ws = mocks.webSocketInstances[0];
    const registerMock = vi.mocked(registerTerminalSend);
    ws.send.mockClear();
    act(() => {
      ws.onopen?.();
    });

    expect(registerMock).toHaveBeenLastCalledWith(null);
    expect(ws.send).not.toHaveBeenCalled();
    const sender = registerMock.mock.calls.find(([candidate]) => typeof candidate === 'function')?.[0];
    expect(sender).toBeUndefined();

    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const visibleSender = [...registerMock.mock.calls].reverse().find(([candidate]) => typeof candidate === 'function')?.[0];
    expect(typeof visibleSender).toBe('function');
    (visibleSender as (data: string) => void)('1');
    expect(ws.send).toHaveBeenCalledWith('1');
  });

  test('hidden terminals do not forward input or resize frames', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: false }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onopen?.();
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('hello');
      terminal.resizeHandler?.({ cols: 80, rows: 24 });
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  test('hiding a terminal clears interactive state and blocks search shortcuts', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const searchAddon = mocks.searchAddonInstances[0];
    const xtermContainer = container.querySelector('.terminal-xterm');
    expect(xtermContainer).not.toBeNull();

    act(() => {
      xtermContainer!.dispatchEvent(new Event('focusin', { bubbles: true }));
    });
    expect(useKookrStore.getState().focusZone).toBe('terminal');

    act(() => {
      openSearchViaShortcut(terminal);
    });
    expect(container.querySelector('input[aria-label="Search terminal scrollback"]')).not.toBeNull();

    act(() => {
      xtermContainer!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 16,
      }));
    });
    expect(container.querySelector('.terminal-context-menu')).not.toBeNull();

    searchAddon.clearDecorations.mockClear();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: false }));
    });

    expect(container.querySelector('input[aria-label="Search terminal scrollback"]')).toBeNull();
    expect(container.querySelector('.terminal-context-menu')).toBeNull();
    expect(searchAddon.clearDecorations).toHaveBeenCalled();
    expect(useKookrStore.getState().focusZone).toBe('none');

    act(() => {
      openSearchViaShortcut(terminal);
    });
    expect(container.querySelector('input[aria-label="Search terminal scrollback"]')).toBeNull();
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

  test('captures empty terminal Enter and advances without sending a newline', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\n╭────────────────╮\r\n❯ \r\n' });
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('captures empty terminal Enter after binary terminal output', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      const encoded = new TextEncoder().encode('\r\n❯ \r\n');
      ws.onmessage?.({ data: arrayBufferFrom(encoded) });
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('captures empty terminal Enter when binary prompt glyph is split across frames', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    const encoded = new TextEncoder().encode('\r\n❯ \r\n');
    act(() => {
      ws.onmessage?.({ data: arrayBufferFrom(encoded.slice(0, 4)) });
      ws.onmessage?.({ data: arrayBufferFrom(encoded.slice(4)) });
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('forwards bare Enter when no empty agent prompt is visible', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith('\r');
  });

  test('forwards Enter after terminal input has content', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\n❯ \r\n' });
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('hello');
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenNthCalledWith(1, 'hello');
    expect(ws.send).toHaveBeenNthCalledWith(2, '\r');
  });

  test('captures Enter after terminal input is erased back to empty', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\n› \r\n  gpt-5.3-codex high 75% left\r\n' });
    });

    act(() => {
      terminal.dataHandler?.('x');
      terminal.dataHandler?.('\u007f');
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('forwards Enter when Codex composer shows visible draft text after replay', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\n› run tests\r\n  gpt-5.3-codex high 75% left\r\n' });
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith('\r');
  });

  test('forwards Enter after terminal control input such as history navigation', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\n❯ \r\n' });
    });
    ws.send.mockClear();
    act(() => {
      terminal.dataHandler?.('\x1b[A');
    });

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenNthCalledWith(1, '\x1b[A');
    expect(ws.send).toHaveBeenNthCalledWith(2, '\r');
  });

  test('does not treat permission prompts as empty terminal submits', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\nAllow this command? Allow  Deny\r\n❯ \r\n' });
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith('\r');
  });

  // kookr #356 — a multiline paste must be intercepted before xterm streams
  // it to the PTY, where every newline would otherwise submit a prompt.
  test('routes a multiline paste through one structured paste frame', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const ws = mocks.webSocketInstances[0];
    ws.send.mockClear();
    const xtermContainer = container.querySelector('.terminal-xterm');
    expect(xtermContainer).not.toBeNull();

    let evt: Event;
    act(() => {
      evt = dispatchPaste(xtermContainer!, 'line1\nline2\nline3');
    });

    // The default raw paste is cancelled so xterm never sees the newlines.
    expect(evt!.defaultPrevented).toBe(true);
    // Exactly one frame — not one per line.
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(buildPasteFrame('line1\nline2\nline3'));
  });

  test('leaves a single-line paste on xterm\'s raw byte-transparent path', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const ws = mocks.webSocketInstances[0];
    ws.send.mockClear();
    const xtermContainer = container.querySelector('.terminal-xterm');

    let evt: Event;
    act(() => {
      evt = dispatchPaste(xtermContainer!, 'echo hello');
    });

    // Not intercepted — xterm handles it, no structured frame is sent.
    expect(evt!.defaultPrevented).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
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
