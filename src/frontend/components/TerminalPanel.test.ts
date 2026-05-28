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
    buffer = {
      active: {
        length: 0,
        getLine: vi.fn(() => undefined),
      },
    };

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

function setTerminalBufferLines(terminal: {
  buffer: { active: { length: number; getLine: ReturnType<typeof vi.fn> } };
}, lines: string[]) {
  terminal.buffer.active.length = lines.length;
  terminal.buffer.active.getLine.mockImplementation((index: number) => {
    const text = lines[index];
    return text === undefined ? undefined : { translateToString: vi.fn(() => text) };
  });
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

  test('captures real keyboard Enter on an empty terminal prompt before xterm forwards it', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\n╭────────────────╮\r\n❯ \r\n' });
    });
    ws.send.mockClear();
    const xtermContainer = container.querySelector('.terminal-xterm');
    expect(xtermContainer).not.toBeNull();

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      xtermContainer!.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('captures real keyboard Enter from the visible xterm buffer when raw output is stale', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: 'Working (3s • esc to interrupt)' });
    });
    setTerminalBufferLines(terminal, ['older output', '❯']);
    ws.send.mockClear();
    const xtermContainer = container.querySelector('.terminal-xterm');
    expect(xtermContainer).not.toBeNull();

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      xtermContainer!.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
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

  test('captures empty terminal Enter when the prompt is redrawn over a status line', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: 'Working (3s • esc to interrupt)\r❯ \r\n' });
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('captures bare Enter with an empty terminal draft even before output arrives', () => {
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

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
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

  test('does not navigate when the visible buffer shows a Claude selection menu', () => {
    // Purely additive menu backstop: every non-menu case behaves exactly as the
    // draft-only path. When the rendered composer shows a marked numbered row +
    // an "Enter to select" footer, Enter must confirm the choice, not navigate.
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    setTerminalBufferLines(terminal, [
      'Choose the text style that looks best with your terminal',
      ' 1. Auto (match terminal)',
      '❯ 2. Dark mode ✔',
      ' 3. Light mode',
      'Enter to select · Esc to cancel',
    ]);
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith('\r');
  });

  test('real keyboard Enter on a Codex selection menu is forwarded, not navigated', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    setTerminalBufferLines(terminal, [
      'Do you trust the contents of this directory?',
      '› 1. Yes, continue',
      '  2. No, quit',
      'Press enter to continue',
    ]);
    const xtermContainer = container.querySelector('.terminal-xterm');
    expect(xtermContainer).not.toBeNull();

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => {
      xtermContainer!.dispatchEvent(event);
    });

    // Not intercepted as navigation — xterm forwards it to the agent.
    expect(event.defaultPrevented).toBe(false);
    expect(onEmptySubmit).not.toHaveBeenCalled();
  });

  test('navigates normally when the buffer is a plain idle prompt (menu check is a no-op)', () => {
    // Regression guard: the menu backstop must NOT fire on the ordinary idle
    // composer, so empty Enter still advances exactly as before.
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    setTerminalBufferLines(terminal, [
      '────────────────────────',
      '❯ Try "write a test for <filepath>"',
      '────────────────────────',
      '⏵⏵ accept edits on (shift+tab to cycle) · ← for agents',
    ]);
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('menu veto fires on the selection-row signal alone (no footer present)', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    setTerminalBufferLines(terminal, [
      ' 1. Auto (match terminal)',
      '❯ 2. Dark mode',
      ' 3. Light mode',
    ]);
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith('\r');
  });

  test('menu veto fires on the footer signal alone (no marked row present)', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    setTerminalBufferLines(terminal, [
      'Pick a base branch',
      'main',
      'develop',
      'Press enter to continue',
    ]);
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith('\r');
  });

  test('a markdown blockquote in agent output is NOT treated as a menu (ASCII > excluded)', () => {
    // The selection-marker class deliberately excludes ASCII ">" so a quoted
    // numbered line in agent prose does not suppress navigation.
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    setTerminalBufferLines(terminal, [
      'Here is the plan:',
      '> 1. First do the thing',
      '> 2. Then the other thing',
      '❯ ',
    ]);
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
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

  test('captures Enter when replayed Codex output looks like a draft but the local draft is empty', () => {
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

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('captures Enter when replayed Claude output looks like a draft but the local draft is empty', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\n❯ run tests\r\n' });
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('captures Enter when Claude empty prompt is followed by a decorative separator', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\n────────────────────────\r\n❯ ────────────────────────\r\n  esc to interrupt · ctrl+t to hide tasks\r\n' });
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('captures empty terminal Enter while the agent is streaming', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\n• Working (7m 32s • esc to interrupt)\r\n' });
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('captures real keyboard empty Enter while the agent is streaming', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\n• Working (7m 32s • esc to interrupt)\r\n' });
    });
    ws.send.mockClear();
    const xtermContainer = container.querySelector('.terminal-xterm');
    expect(xtermContainer).not.toBeNull();

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      xtermContainer!.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
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

  // Claude Code enables focus tracking (DECSET 1004), so xterm forwards `ESC [ I`
  // through onData on focus. Without filtering, that 3-byte sequence inflated the
  // local draft and the user had to press Enter twice — first to clear the bogus
  // bytes, then to actually navigate. Codex didn't reproduce because its TUI
  // doesn't enable focus tracking. Regression coverage for #642 follow-up.
  test('focus tracking sequences do not inflate the local input draft', () => {
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
      terminal.dataHandler?.('\x1b[I');
    });

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    // The focus byte is still forwarded to the PTY so the agent knows about
    // focus, but `\r` must not reach it — empty-Enter is navigation, not submit.
    expect(ws.send).not.toHaveBeenCalledWith('\r');
  });

  test('blur tracking sequence is also filtered out of the input draft', () => {
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
      terminal.dataHandler?.('\x1b[I');
      terminal.dataHandler?.('\x1b[O');
      terminal.dataHandler?.('\x1b[I');
    });

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalledWith('\r');
  });

  // Real Claude / Codex sessions emit `\x1b[c` (Primary Device Attributes
  // query) at session start; xterm responds with `\x1b[?1;2c` on the same
  // onData channel as user keystrokes. Without filtering, that response lives
  // in the local draft forever and empty-Enter never advances on any session
  // that has been open long enough to receive a DA query. Regression coverage
  // for the bug surfaced in #642/#643 follow-up.
  test('DA1 reply (\\x1b[?1;2c) does not inflate the local input draft', () => {
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
      terminal.dataHandler?.('\x1b[?1;2c');
      terminal.dataHandler?.('\x1b[I');
    });

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalledWith('\r');
  });

  // DA2 reply (`\x1b[>0;276;0c`) and Cursor Position Report (`\x1b[24;1R`)
  // share the same shape problem as DA1: xterm-generated bytes flowing through
  // onData with no user keystroke behind them.
  test('DA2 reply and cursor position report do not inflate the input draft', () => {
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
      terminal.dataHandler?.('\x1b[>0;276;0c');
      terminal.dataHandler?.('\x1b[24;1R');
      terminal.dataHandler?.('\x1b[0n');
    });

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalledWith('\r');
  });

  // Negative control: the focus-tracking filter must be narrow enough that real
  // typed text following a focus event still defeats the empty-Enter shortcut.
  // Without this, someone broadening the filter to strip all CSI sequences
  // would silently regress empty-Enter detection during typing.
  test('focus event followed by typed text leaves Enter as a normal submit', () => {
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
      terminal.dataHandler?.('\x1b[I');
      terminal.dataHandler?.('a');
    });

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith('a');
    expect(ws.send).toHaveBeenCalledWith('\r');
  });

  test('captures empty terminal Enter without inspecting permission-looking output', () => {
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

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('captures empty terminal Enter without inspecting shell-looking output', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onmessage?.({ data: '\r\nuser@host:~/repo$ \r\n' });
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
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

  test('routes Ctrl+V multiline clipboard text through one structured paste frame', async () => {
    const readText = vi.fn().mockResolvedValue('line1\nline2\nline3');
    vi.stubGlobal('navigator', { clipboard: { readText } });
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const ws = mocks.webSocketInstances[0];
    ws.send.mockClear();
    const xtermContainer = container.querySelector('.terminal-xterm');
    expect(xtermContainer).not.toBeNull();

    const event = new KeyboardEvent('keydown', {
      key: 'v',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      xtermContainer!.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(event.defaultPrevented).toBe(false);
    expect(readText).toHaveBeenCalledOnce();
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(buildPasteFrame('line1\nline2\nline3'));
  });

  test('forwards Enter after a multiline safe paste marks the local draft non-empty', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    const xtermContainer = container.querySelector('.terminal-xterm');
    expect(xtermContainer).not.toBeNull();

    act(() => {
      dispatchPaste(xtermContainer!, 'line1\nline2');
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith('\r');
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

  test('empty-Enter fires on each new task that lands at an empty agent prompt', () => {
    // The user-reported regression case: after one empty-Enter dispatch the
    // parent navigates to the next agent, tmuxName changes, and the next Enter
    // on the new task's empty prompt must ALSO fire. The component re-runs the
    // [tmuxName] effect, disposes the previous onData listener, opens a fresh
    // WS, and re-attaches a new handler — all three steps are exercised here.
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-task-A', visible: true, onEmptySubmit }));
    });
    const terminal = mocks.terminalInstances[0];

    function streamAndPressEnter() {
      const ws = mocks.webSocketInstances[mocks.webSocketInstances.length - 1];
      act(() => { ws.onmessage?.({ data: '\r\n╭────────╮\r\n❯ \r\n' }); });
      ws.send.mockClear();
      act(() => { terminal.dataHandler?.('\r'); });
      return ws;
    }

    // Task A: empty Claude prompt → empty-Enter fires.
    let ws = streamAndPressEnter();
    expect(onEmptySubmit).toHaveBeenCalledTimes(1);
    expect(ws.send).not.toHaveBeenCalled();

    // Capture the first onData's disposable BEFORE the tmuxName transition so
    // we can assert the cleanup runs. Without this, the mock's overwrite-style
    // `dataHandler` field would silently pass even if the disposal regressed.
    const firstOnDataResult = terminal.onData.mock.results[0].value;
    expect(firstOnDataResult.dispose).not.toHaveBeenCalled();

    // Parent navigates to task B (tmuxName change).
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-task-B', visible: true, onEmptySubmit }));
    });
    expect(firstOnDataResult.dispose).toHaveBeenCalledOnce();
    // Same Terminal instance (no-deps mount effect ran once), new WebSocket.
    expect(mocks.terminalInstances).toHaveLength(1);
    expect(mocks.webSocketInstances.length).toBeGreaterThanOrEqual(2);

    // Task B: empty Claude prompt → empty-Enter fires again.
    ws = streamAndPressEnter();
    expect(onEmptySubmit).toHaveBeenCalledTimes(2);
    expect(ws.send).not.toHaveBeenCalled();

    // Task C: Codex empty prompt + composer footer → still fires.
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-task-C', visible: true, onEmptySubmit }));
    });
    const wsC = mocks.webSocketInstances[mocks.webSocketInstances.length - 1];
    act(() => { wsC.onmessage?.({ data: '\r\n› \r\n  gpt-5.5 high · ~/git/kookr\r\n' }); });
    wsC.send.mockClear();
    act(() => { terminal.dataHandler?.('\r'); });
    expect(onEmptySubmit).toHaveBeenCalledTimes(3);
    expect(wsC.send).not.toHaveBeenCalled();
  });

  test('captures empty Enter even before the new session has streamed any output', () => {
    // The reliability bug: after navigation advances to a new task, the next
    // Enter may arrive before the terminal buffer repaints. With no local draft
    // present, it must still be task navigation rather than a raw newline.
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-task-A',
        visible: true,
        onEmptySubmit,
      }));
    });
    const terminal = mocks.terminalInstances[0];
    // Note: no ws.onmessage call — the new task hasn't streamed initial pane
    // content yet. Buffer scan alone would return false.
    const ws = mocks.webSocketInstances[0];
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('captures real keyboard empty Enter without buffer confirmation', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-task-A',
        visible: true,
        onEmptySubmit,
      }));
    });
    const ws = mocks.webSocketInstances[0];
    ws.send.mockClear();
    const xtermContainer = container.querySelector('.terminal-xterm');

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      xtermContainer!.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('forwards Enter when the user has typed a draft', () => {
    // If the user typed something at the prompt, Enter must submit that text,
    // not advance to another task.
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-task-A',
        visible: true,
        onEmptySubmit,
      }));
    });
    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];

    act(() => {
      terminal.dataHandler?.('h');
      terminal.dataHandler?.('i');
    });
    ws.send.mockClear();
    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith('\r');
  });

  test('empty Enter survives the tmuxName transition before the new session streams', () => {
    // The end-to-end reliability scenario the bug actually describes:
    // Task A → empty Enter advances → task B is now selected → the next
    // empty Enter must ALSO advance, even though B's WS hasn't sent any
    // pane content yet and the local buffer is empty after `terminal.clear()`.
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-task-A',
        visible: true,
        onEmptySubmit,
      }));
    });
    const terminal = mocks.terminalInstances[0];
    const wsA = mocks.webSocketInstances[0];
    act(() => { wsA.onmessage?.({ data: '\r\n❯ \r\n' }); });
    wsA.send.mockClear();

    // First Enter at A's idle prompt fires empty-Enter.
    act(() => { terminal.dataHandler?.('\r'); });
    expect(onEmptySubmit).toHaveBeenCalledTimes(1);
    expect(wsA.send).not.toHaveBeenCalled();

    // Parent navigates to task B. B's WS is reopened but no pane content has
    // streamed yet — the local buffer is effectively empty after
    // `terminal.clear()`.
    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-task-B',
        visible: true,
        onEmptySubmit,
      }));
    });
    const wsB = mocks.webSocketInstances[mocks.webSocketInstances.length - 1];
    expect(wsB).not.toBe(wsA);
    wsB.send.mockClear();

    act(() => { terminal.dataHandler?.('\r'); });
    expect(onEmptySubmit).toHaveBeenCalledTimes(2);
    expect(wsB.send).not.toHaveBeenCalled();
  });

  test('empty terminal Enter remains navigation across same-session rerenders', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-task-X',
        visible: true,
        onEmptySubmit,
      }));
    });
    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    ws.send.mockClear();

    act(() => { terminal.dataHandler?.('\r'); });
    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
    onEmptySubmit.mockClear();
    ws.send.mockClear();

    // Same session rerender.
    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-task-X',
        visible: true,
        onEmptySubmit,
      }));
    });
    act(() => { terminal.dataHandler?.('\r'); });
    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('empty terminal Enter stays routed through navigation after rerender', () => {
    // Empty terminal Enter is a navigation shortcut. The draft, permission, and
    // shell guards still decide when Enter should reach the PTY.
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-task-Y',
        visible: true,
        onEmptySubmit,
      }));
    });
    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    ws.send.mockClear();

    act(() => { terminal.dataHandler?.('\r'); });
    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
    onEmptySubmit.mockClear();
    ws.send.mockClear();

    // Same session rerender after activity changes elsewhere in the parent.
    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-task-Y',
        visible: true,
        onEmptySubmit,
      }));
    });
    act(() => { terminal.dataHandler?.('\r'); });
    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('empty-Enter fires repeatedly within the same task as the user mashes Enter', () => {
    // Scenario: same task, the user presses Enter several times before the
    // parent has finished navigating. Each press must hit onEmptySubmit, not
    // just the first one.
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-task-X', visible: true, onEmptySubmit }));
    });
    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => { ws.onmessage?.({ data: '\r\n❯ \r\n' }); });

    for (let i = 1; i <= 5; i++) {
      ws.send.mockClear();
      act(() => { terminal.dataHandler?.('\r'); });
      expect(onEmptySubmit).toHaveBeenCalledTimes(i);
      expect(ws.send).not.toHaveBeenCalled();
    }
  });
});
