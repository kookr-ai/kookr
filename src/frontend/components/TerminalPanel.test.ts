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
  fitProposeDimensions: (): { cols: number; rows: number } | null => ({ cols: 80, rows: 24 }),
}));

class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

class MockWebSocket {
  static OPEN = 1;
  protocol = 'kookr-terminal.v2';
  negotiated = false;
  seeded = false;
  sourcePosition = 0;
  get generation() { return `g-${mocks.webSocketInstances.indexOf(this)}`; }
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

  constructor(readonly url: string, readonly protocols?: string | string[]) {
    mocks.webSocketInstances.push(this);
  }
}

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    resizeHandler: ((size: { cols: unknown; rows: unknown }) => void) | null = null;
    dataHandler: ((data: string) => void) | null = null;
    scrollHandler: (() => void) | null = null;
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    clear = vi.fn();
    reset = vi.fn();
    write = vi.fn((_data: string | Uint8Array, callback?: () => void) => callback?.());
    modes = { synchronizedOutputMode: false };
    textarea = document.createElement('textarea');
    open = vi.fn((container: HTMLElement) => container.appendChild(this.textarea));
    loadAddon = vi.fn();
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
    registerMarker = vi.fn(() => undefined);
    getSelectionPosition = vi.fn(() => undefined);
    clearSelection = vi.fn();
    onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
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
    onScroll = vi.fn((cb) => {
      this.scrollHandler = cb;
      return { dispose: vi.fn() };
    });
    scrollLines = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols; this.rows = rows;
      this.resizeHandler?.({ cols, rows });
    });
    scrollToBottom = vi.fn();
    refresh = vi.fn();
    dispose = vi.fn(() => this.textarea.remove());
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    paste = vi.fn();
    focus = vi.fn(() => this.textarea.focus());
    buffer = {
      active: {
        baseY: 0,
        viewportY: 0,
        length: 0,
        getLine: vi.fn(() => undefined),
      },
    };

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      mocks.terminalInstances.push(this);
    }
  }

  return { Terminal: MockTerminal };
});
vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => mocks.fitProposeDimensions());

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
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class WebglAddon {
    onContextLoss = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../terminal-send.js', () => ({ registerTerminalSend: vi.fn() }));
vi.mock('../telemetry.js', () => ({ track: vi.fn() }));
vi.mock('../terminal-writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal-writer.js')>();
  return { ...actual, createTerminalWriter: (options: Parameters<typeof actual.createTerminalWriter>[0]) =>
    actual.createTerminalWriter({ ...options, scheduler: actual.createTerminalWriteScheduler((task) => task()) }) };
});

import { ABSOLUTE_TUI_COLS } from '../../shared/absolute-tui-geometry.js';
import { TerminalPanel } from './TerminalPanel.js';
import { registerTerminalSend } from '../terminal-send.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STORAGE_KEY,
} from '../hooks/usePersistedTerminalFontSize.js';

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

function terminalFrame(ws: MockWebSocket, payload: Record<string, unknown>): string {
  return JSON.stringify({ type: payload.type, generation: ws.generation, ...payload });
}

function negotiateTerminal(ws: MockWebSocket) {
  if (ws.negotiated) return;
  ws.negotiated = true;
  ws.onmessage?.({ data: terminalFrame(ws, { type: 'hello', version: 2, creditBytes: 131072, frameBytes: 8192 }) });
}

/** Business/UI tests use valid wire fixtures; protocol rejection has its own tests. */
function emitTerminalData(ws: MockWebSocket, data: string | ArrayBuffer) {
  negotiateTerminal(ws);
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const initial = !ws.seeded;
  const attach = ws.send.mock.calls.map(([frame]) => JSON.parse(String(frame))).find((frame) => frame.type === 'attach');
  const source = { epoch: ws.url, geometryRevision: 1, cols: attach?.cols ?? 80, rows: attach?.rows ?? 24 };
  if (initial) {
    ws.sourcePosition = attach?.cursor?.position ?? 0;
    ws.onmessage?.({ data: terminalFrame(ws, { type: 'seed-begin', transaction: 't', mode: attach?.cursor ? 'resume' : 'replace' }) });
  }
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    const chunk = bytes.subarray(offset, offset + 8192);
    if (!initial) ws.onmessage?.({ data: terminalFrame(ws, { type: 'source', ...source, start: ws.sourcePosition, end: ws.sourcePosition + chunk.length }) });
    ws.sourcePosition += chunk.length;
    ws.onmessage?.({ data: arrayBufferFrom(chunk) });
  }
  if (initial) {
    ws.seeded = true;
    ws.onmessage?.({ data: terminalFrame(ws, { type: 'seed-end', transaction: 't',
      cursor: { ...source, position: ws.sourcePosition }, approximate: false, historyAvailable: false }) });
  }
}

/** Dispatch a drag event carrying `files`; jsdom has no DragEvent/DataTransfer, so fake the shape the handlers read. */
function dispatchFileDrag(
  target: Element,
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  files: File[],
  dragTypes: string[] = ['Files'],
): Event {
  const evt = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'dataTransfer', { value: { types: dragTypes, files, dropEffect: 'none' } });
  target.dispatchEvent(evt);
  return evt;
}

/** Dispatch a `paste` whose clipboard holds files (and optionally text). */
function dispatchFilePaste(target: Element, files: File[], text = ''): Event {
  const evt = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'clipboardData', {
    value: { files, getData: (type: string) => (type === 'text' || type === 'text/plain' ? text : '') },
  });
  target.dispatchEvent(evt);
  return evt;
}

const PNG_FILE = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });
const savedImageResponse = (path: string) => new Response(
  JSON.stringify({ path, mime: 'image/png', size: 4 }),
  { status: 201, headers: { 'content-type': 'application/json' } },
);

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

function dispatchTerminalShortcut(
  terminal: { keyHandler: ((event: KeyboardEvent) => boolean) | null },
  key: string,
  overrides: Partial<KeyboardEvent> = {},
) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const handled = terminal.keyHandler?.({
    type: 'keydown',
    key,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault,
    stopPropagation,
    ...overrides,
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

function setTerminalScroll(terminal: {
  rows: number;
  scrollHandler: (() => void) | null;
  buffer: { active: { baseY: number; viewportY: number; length: number } };
}, scroll: { viewportY: number; baseY?: number; length?: number; rows?: number }) {
  terminal.rows = scroll.rows ?? 24;
  terminal.buffer.active.baseY = scroll.baseY ?? 0;
  terminal.buffer.active.viewportY = scroll.viewportY;
  terminal.buffer.active.length = scroll.length ?? 100;
  terminal.scrollHandler?.();
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
    mocks.fitProposeDimensions = () => ({ cols: 80, rows: 24 });
    localStorage.clear();
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('an incompatible attach offers a new view instead of trapping on reload', () => {
    act(() => root.render(React.createElement(TerminalPanel, {
      tmuxName: 'kookr-grok', visible: true, agentType: 'grok-build',
    })));
    const ws = mocks.webSocketInstances[0];
    act(() => { ws.onopen?.(); ws.onclose?.({ code: 4409 }); });
    expect(container.textContent).toContain('The terminal view lost sync. Start a new view — reloading the page usually will not help.');
    expect(container.textContent).toContain('Start a new view');
    expect(container.textContent).not.toContain('Reload Kookr');
    expect(container.textContent).not.toContain('Terminal protocol changed. Reload Kookr.');
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Start a new view');
    expect(retry).toBeTruthy();
    act(() => retry!.click());
    expect(mocks.webSocketInstances.length).toBeGreaterThan(1);
  });

  test('pins Grok attach geometry to 200 cols even when xterm is still 80', () => {
    mocks.fitProposeDimensions = () => null;
    act(() => root.render(React.createElement(TerminalPanel, {
      tmuxName: 'kookr-grok', visible: true, agentType: 'grok-build',
    })));
    const terminal = mocks.terminalInstances[0];
    expect(terminal.cols).toBe(ABSOLUTE_TUI_COLS);
    const ws = mocks.webSocketInstances[0];
    act(() => { ws.onopen?.(); negotiateTerminal(ws); });
    const attach = ws.send.mock.calls.map(([frame]) => JSON.parse(String(frame))).find((frame) => frame.type === 'attach');
    expect(attach).toMatchObject({ cols: ABSOLUTE_TUI_COLS, rows: 24, acceptGap: true });
  });

  test('non-Grok attaches keep the fitted column count', () => {
    mocks.fitProposeDimensions = () => null;
    act(() => root.render(React.createElement(TerminalPanel, {
      tmuxName: 'kookr-claude', visible: true, agentType: 'claude-code',
    })));
    const ws = mocks.webSocketInstances[0];
    act(() => { ws.onopen?.(); negotiateTerminal(ws); });
    const attach = ws.send.mock.calls.map(([frame]) => JSON.parse(String(frame))).find((frame) => frame.type === 'attach');
    expect(attach).toMatchObject({ cols: 80, rows: 24 });
  });

  test('memoized terminal skips parent metadata rerenders but accepts a changed session', async () => {
    const fontHook = await import('../hooks/usePersistedTerminalFontSize.js');
    const renderProbe = vi.spyOn(fontHook, 'usePersistedTerminalFontSize');
    function Parent({ title, session }: { title: string; session: string }) {
      return React.createElement('div', { title }, React.createElement(TerminalPanel, { tmuxName: session, visible: true }));
    }
    try {
      await act(async () => root.render(React.createElement(Parent, { title: 'before', session: 'same' })));
      const renders = renderProbe.mock.calls.length;
      expect(renders).toBeGreaterThan(0);
      await act(async () => root.render(React.createElement(Parent, { title: 'after', session: 'same' })));
      expect(renderProbe).toHaveBeenCalledTimes(renders);
      await act(async () => root.render(React.createElement(Parent, { title: 'after', session: 'changed' })));
      expect(renderProbe.mock.calls.length).toBeGreaterThan(renders);
    } finally { renderProbe.mockRestore(); }
  });

  test.each(['terminal', 'search', 'other'] as const)('preserves %s focus when a stalled parser is replaced', (focusOwner) => {
    vi.useFakeTimers();
    act(() => root.render(React.createElement(TerminalPanel, { tmuxName: 'stalled', visible: true })));
    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    terminal.write.mockImplementation(() => {});
    const other = document.createElement('button');
    container.appendChild(other);
    act(() => {
      if (focusOwner === 'terminal') terminal.textarea.focus();
      else if (focusOwner === 'search') openSearchViaShortcut(terminal);
      else other.focus();
    });
    if (focusOwner === 'search') act(() => container.querySelector<HTMLInputElement>('.terminal-search input')!.focus());
    const previousFocus = document.activeElement;
    act(() => { ws.onopen?.(); emitTerminalData(ws, 'waiting for parser'); });
    act(() => vi.advanceTimersByTime(2100));
    expect(mocks.terminalInstances).toHaveLength(2);
    expect(terminal.textarea.isConnected).toBe(false);
    const replacement = mocks.terminalInstances[1];
    expect(document.activeElement).toBe(focusOwner === 'terminal' ? replacement.textarea : previousFocus);
  });

  test('keeps interrupted input visible until dismissed and returns recovery focus to the terminal', () => {
    act(() => root.render(React.createElement(TerminalPanel, { tmuxName: 'input-warning', visible: true })));
    const ws = mocks.webSocketInstances[0];
    const terminal = mocks.terminalInstances[0];
    act(() => { ws.onopen?.(); emitTerminalData(ws, 'ready'); terminal.dataHandler?.('hello\r'); });
    act(() => ws.onclose?.({ code: 4408 }));
    expect(container.textContent).toContain('Input delivery is uncertain');
    const reconnect = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reconnect terminal')!;
    terminal.focus.mockClear();
    act(() => reconnect.click());
    expect(terminal.focus).toHaveBeenCalled();
    expect(container.textContent).toContain('Input delivery is uncertain');
    const dismiss = container.querySelector<HTMLButtonElement>('[aria-label="Dismiss input delivery warning"]')!;
    act(() => dismiss.click());
    expect(container.textContent).not.toContain('Input delivery is uncertain');
  });

  test.each(['visibility', 'session'] as const)('retains unresolved input across %s changes without warning another session', (change) => {
    const render = (tmuxName: string, visible = true) => act(() => root.render(React.createElement(TerminalPanel, { tmuxName, visible })));
    render('input-warning');
    const ws = mocks.webSocketInstances[0];
    const terminal = mocks.terminalInstances[0];
    act(() => { ws.onopen?.(); emitTerminalData(ws, 'ready'); terminal.dataHandler?.('hello\r'); });
    act(() => ws.onclose?.({ code: 4408 }));
    expect(container.textContent).toContain('Input delivery is uncertain');
    if (change === 'visibility') render('input-warning', false);
    else {
      render('other-session');
      expect(container.textContent).not.toContain('Input delivery is uncertain');
    }
    render('input-warning');
    expect(container.textContent).toContain('Input delivery is uncertain');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss input delivery warning"]')!.click());
    render('other-session');
    render('input-warning');
    expect(container.textContent).not.toContain('Input delivery is uncertain');
  });

  test('FR-TERM-003: negotiates v2 and never enables typing from a partial seed', () => {
    act(() => root.render(React.createElement(TerminalPanel, { tmuxName: 'seed-gate', visible: true })));
    const ws = mocks.webSocketInstances[0];
    expect(ws.protocols).toBe('kookr-terminal.v2');
    const terminal = mocks.terminalInstances[0];
    const callbacks: Array<() => void> = [];
    terminal.write.mockImplementation((_bytes: unknown, callback?: () => void) => { if (callback) callbacks.push(callback); });
    act(() => {
      ws.onopen?.();
      ws.onmessage?.({ data: JSON.stringify({ type: 'hello', version: 2, generation: 'g', creditBytes: 131072, frameBytes: 8192 }) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'seed-begin', generation: 'g', transaction: 't', mode: 'replace' }) });
      ws.onmessage?.({ data: arrayBufferFrom(new TextEncoder().encode('first')) });
      ws.onmessage?.({ data: arrayBufferFrom(new TextEncoder().encode('last')) });
      ws.onmessage?.({ data: JSON.stringify({ type: 'seed-end', generation: 'g', transaction: 't', cursor: null, approximate: false, historyAvailable: false }) });
    });
    act(() => callbacks.shift()?.());
    expect(container.querySelector('[data-testid="terminal-attach-pending"]')).not.toBeNull();
    act(() => callbacks.shift()?.());
    expect(container.querySelector('[data-testid="terminal-attach-pending"]')).toBeNull();
  });

  test('FR-TERM-001: accumulates captured trackpad events once per frame without sending agent input', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.set(++frameId, cb);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    act(() => root.render(React.createElement(TerminalPanel, { tmuxName: 'wheel-test', visible: true })));
    act(() => {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach((cb) => cb(0));
    });
    const terminal = mocks.terminalInstances[0];
    setTerminalScroll(terminal, { viewportY: 50, baseY: 100, length: 124 });
    const terminalContainer = container.querySelector('.terminal-xterm');
    expect(terminalContainer).not.toBeNull();
    const ws = mocks.webSocketInstances[0];
    ws.send.mockClear();
    for (let i = 0; i < 8; i++) {
      const event = new WheelEvent('wheel', { deltaY: 5, deltaMode: 0, bubbles: true, cancelable: true });
      act(() => terminalContainer!.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(terminal.scrollLines).not.toHaveBeenCalled();
    act(() => {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach((cb) => cb(16));
    });
    expect(terminal.scrollLines).toHaveBeenCalledExactlyOnceWith(1);
    expect(ws.send).not.toHaveBeenCalled();
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

    fitAddon.proposeDimensions.mockClear();
    terminal.refresh.mockClear();

    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: null, visible: true }));
    });

    expect(fitAddon.proposeDimensions).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  test('does not open terminal websocket while hidden, then subscribes when visible', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: false }));
    });

    const registerMock = vi.mocked(registerTerminalSend);
    expect(mocks.webSocketInstances).toHaveLength(0);
    expect(registerMock).toHaveBeenLastCalledWith(null);

    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });
    expect(mocks.webSocketInstances).toHaveLength(1);
    // R3: pending chrome while attach in flight (before first PTY paint).
    expect(container.querySelector('[data-testid="terminal-attach-pending"]')).not.toBeNull();

    const ws = mocks.webSocketInstances[0];
    ws.send.mockClear();
    act(() => {
      ws.onopen?.();
    });

    // Send remains gated until first paint — WS open alone is not enough (R3).
    const senderBeforePaint = [...registerMock.mock.calls].reverse().find(([candidate]) => typeof candidate === 'function')?.[0];
    expect(senderBeforePaint).toBeUndefined();
    expect(container.querySelector('[data-testid="terminal-attach-pending"]')).not.toBeNull();

    act(() => {
      emitTerminalData(ws, 'seed-bytes');
    });
    expect(container.querySelector('[data-testid="terminal-attach-pending"]')).toBeNull();

    const visibleSender = [...registerMock.mock.calls].reverse().find(([candidate]) => typeof candidate === 'function')?.[0];
    expect(typeof visibleSender).toBe('function');
    (visibleSender as (data: string) => void)('1');
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '1' }));
  });

  test('blocks terminal keystrokes until first paint of the new session', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-a', visible: true }));
    });
    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onopen?.();
    });
    ws.send.mockClear();

    // Keystrokes during pending attach must not reach the socket (wrong-agent mitigation).
    act(() => {
      terminal.dataHandler?.('x');
    });
    expect(ws.send).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="terminal-attach-pending"]')).not.toBeNull();

    act(() => {
      emitTerminalData(ws, arrayBufferFrom(new TextEncoder().encode('frame')));
    });
    expect(container.querySelector('[data-testid="terminal-attach-pending"]')).toBeNull();

    act(() => {
      terminal.dataHandler?.('y');
    });
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: 'y' }));
  });

  test('FR-TERM-002: includes versioned attach join keys after attach_timing', async () => {
    const { track } = await import('../telemetry.js');
    const trackMock = vi.mocked(track);
    vi.useFakeTimers();

    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-join',
        visible: true,
        agentType: 'claude-code',
      }));
    });
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onopen?.();
      negotiateTerminal(ws);
    });

    const resizeCall = ws.send.mock.calls.find(
      (call) => typeof call[0] === 'string' && String(call[0]).includes('"attach"'),
    );
    expect(resizeCall).toBeDefined();
    const resizePayload = JSON.parse(String(resizeCall![0]));
    expect(typeof resizePayload.attachId).toBe('string');
    expect(resizePayload.attachId.length).toBeGreaterThan(0);

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: 'attach_timing',
          generation: ws.generation,
          protocolVersion: 2,
          historyAvailable: false,
          attachSeed: 'full',
          attachId: resizePayload.attachId,
          strategy: 'full-ring',
          seedCacheHit: false,
          recoveryUsed: false,
          totalMs: 12.5,
          resizeWaitMs: 1,
          captureMs: 2,
          reconstructMs: 0,
          replayBytes: 10,
          earlySeedBytes: 0,
        }),
      });
      emitTerminalData(ws, 'hello');
    });

    // Telemetry may flush on attach_timing-after-paint or the 80ms fallback.
    act(() => {
      vi.advanceTimersByTime(80);
    });

    const latency = trackMock.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((e) => e.type === 'terminal_switch_latency');
    expect(latency).toMatchObject({
      type: 'terminal_switch_latency',
      measurementVersion: 2,
      attachId: resizePayload.attachId,
      warmLabel: 'cold',
      clientWarm: false,
      serverStrategy: 'full-ring',
      seedCacheHit: false,
      recoveryUsed: false,
      agentType: 'claude-code',
    });
    expect(typeof latency?.selectionToFirstParseMs).toBe('number');
    expect(typeof latency?.selectionToRenderOpportunityMs).toBe('number');
    expect(latency).not.toHaveProperty('selectionToFirstPaintMs');
  });

  test('FR-TERM-002: does not mistake a queued xterm write for completed parsing', async () => {
    const { track } = await import('../telemetry.js');
    vi.useFakeTimers();
    act(() => root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-slow-parse', visible: true })));
    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    let parsed: (() => void) | undefined;
    terminal.write.mockImplementation((_data: unknown, callback?: () => void) => { parsed = callback; });
    act(() => {
      ws.onopen?.();
      emitTerminalData(ws, 'hello');
      vi.advanceTimersByTime(100);
    });
    expect(container.querySelector('[data-testid="terminal-attach-pending"]')).not.toBeNull();
    expect(vi.mocked(track).mock.calls.some(([event]) => event.type === 'terminal_switch_latency')).toBe(false);
    act(() => { parsed?.(); vi.advanceTimersByTime(80); });
    expect(container.querySelector('[data-testid="terminal-attach-pending"]')).toBeNull();
    expect(vi.mocked(track).mock.calls.some(([event]) => event.measurementVersion === 2)).toBe(true);
  });

  test('FR-TERM-002: stale parse callbacks cannot unlock a newly selected session', () => {
    act(() => root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-old', visible: true })));
    const terminal = mocks.terminalInstances[0];
    const oldSocket = mocks.webSocketInstances[0];
    let oldParsed: (() => void) | undefined;
    terminal.write.mockImplementation((_data: unknown, callback?: () => void) => { oldParsed = callback; });
    act(() => { oldSocket.onopen?.(); emitTerminalData(oldSocket, 'old'); });
    act(() => root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-new', visible: true })));
    const newSocket = mocks.webSocketInstances[1];
    act(() => { newSocket.onopen?.(); oldParsed?.(); terminal.dataHandler?.('x'); });
    expect(newSocket.send).not.toHaveBeenCalledWith(terminalFrame(newSocket, { type: 'input', text: 'x' }));
    expect(container.querySelector('[data-testid="terminal-attach-pending"]')).not.toBeNull();
  });

  test('shows counted jump-to-latest pill for new output while scrolled up', () => {
    vi.useFakeTimers();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      setTerminalScroll(terminal, { baseY: 76, viewportY: 40, length: 100, rows: 24 });
      emitTerminalData(ws, 'one\r\ntwo\r\nthree\r\n');
    });

    expect(container.querySelector('button[aria-label="3 new lines, jump to latest"]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(80);
    });

    expect(container.querySelector('button[aria-label="3 new lines, jump to latest"]')).not.toBeNull();
  });

  test('counts binary terminal frames in the jump-to-latest pill', () => {
    vi.useFakeTimers();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    const encoded = new TextEncoder().encode('one\r\ntwo\r\n');
    act(() => {
      setTerminalScroll(terminal, { baseY: 76, viewportY: 40, length: 100, rows: 24 });
      emitTerminalData(ws, arrayBufferFrom(encoded));
      vi.advanceTimersByTime(80);
    });

    expect(container.querySelector('button[aria-label="2 new lines, jump to latest"]')).not.toBeNull();
  });

  test('jump-to-latest pill scrolls to bottom and hides', () => {
    vi.useFakeTimers();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      setTerminalScroll(terminal, { baseY: 76, viewportY: 40, length: 100, rows: 24 });
      emitTerminalData(ws, 'new line\r\n');
      vi.advanceTimersByTime(80);
    });

    const button = container.querySelector('button[aria-label="1 new line, jump to latest"]') as HTMLButtonElement | null;
    expect(button).not.toBeNull();

    act(() => {
      button!.click();
    });

    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
    expect(terminal.focus).toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="1 new line, jump to latest"]')).toBeNull();
  });

  test('writing while already at the bottom shows no jump-to-latest pill', () => {
    vi.useFakeTimers();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      setTerminalScroll(terminal, { baseY: 76, viewportY: 76, length: 100, rows: 24 });
      emitTerminalData(ws, 'new line\r\n');
      vi.advanceTimersByTime(120);
    });

    expect(container.querySelector('button[aria-label$="jump to latest"]')).toBeNull();
  });

  test('hidden terminals do not forward input or resize frames', () => {
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
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: false }));
    });
    expect(ws.close).toHaveBeenCalled();

    act(() => {
      terminal.dataHandler?.('hello');
      terminal.resizeHandler?.({ cols: 80, rows: 24 });
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  test('preserves draft tracking while hidden so Enter still submits typed input', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-test',
        visible: true,
        onEmptySubmit,
      }));
    });

    const terminal = mocks.terminalInstances[0];
    const firstWs = mocks.webSocketInstances[0];
    act(() => {
      firstWs.onopen?.();
      // Attach must paint before keystrokes reach the PTY (R3 send gate).
      emitTerminalData(firstWs, 'seed');
      terminal.dataHandler?.('hello');
    });

    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-test',
        visible: false,
        onEmptySubmit,
      }));
    });
    expect(firstWs.close).toHaveBeenCalled();

    act(() => {
      root.render(React.createElement(TerminalPanel, {
        tmuxName: 'kookr-test',
        visible: true,
        onEmptySubmit,
      }));
    });
    const secondWs = mocks.webSocketInstances[1];
    act(() => {
      secondWs.onopen?.();
      emitTerminalData(secondWs, 'seed');
    });
    secondWs.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(secondWs.send).toHaveBeenCalledWith(terminalFrame(secondWs, { type: 'input', text: '\r' }));
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
      emitTerminalData(ws, 'seed');
    });
    ws.send.mockClear();

    act(() => {
      terminal.resizeHandler?.(frame);
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  test('sends valid positive-integer resize frames', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
      });

      const terminal = mocks.terminalInstances[0];
      const ws = mocks.webSocketInstances[0];
      act(() => {
        ws.onopen?.();
        emitTerminalData(ws, 'seed');
      });
      ws.send.mockClear();

      act(() => {
        terminal.resizeHandler?.({ cols: 80, rows: 24 });
      });
      // A valid xterm resize is sent immediately; layout requests are already
      // frame-coalesced, and the server owns the remaining PTY resize debounce.
      expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'resize', cols: 80, rows: 24 }));
    } finally {
      vi.useRealTimers();
    }
  });

  test('captures empty terminal Enter and advances without sending a newline', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      emitTerminalData(ws, '\r\n╭────────────────╮\r\n❯ \r\n');
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
      emitTerminalData(ws, '\r\n╭────────────────╮\r\n❯ \r\n');
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
      emitTerminalData(ws, 'Working (3s • esc to interrupt)');
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
      emitTerminalData(ws, arrayBufferFrom(encoded));
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
      emitTerminalData(ws, arrayBufferFrom(encoded.slice(0, 4)));
      emitTerminalData(ws, arrayBufferFrom(encoded.slice(4)));
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
      emitTerminalData(ws, 'Working (3s • esc to interrupt)\r❯ \r\n');
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
      emitTerminalData(ws, '\r\n❯ \r\n');
    });
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('hello');
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenNthCalledWith(1, terminalFrame(ws, { type: 'input', text: 'hello' }));
    expect(ws.send).toHaveBeenNthCalledWith(2, terminalFrame(ws, { type: 'input', text: '\r' }));
  });

  test('forwards Enter when the visible composer has an adapter-injected draft', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      emitTerminalData(ws, 'seed');
    });
    setTerminalBufferLines(terminal, [
      'IGNORED_EARLY_ENTER:browser-pre-fix-reply',
      '❯ browser-pre-fix-reply',
    ]);
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
  });

  test('navigates when a historical composer draft is followed by the current empty prompt', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    setTerminalBufferLines(terminal, [
      '❯ old submitted prompt',
      'Working complete',
      '❯ ',
    ]);
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
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
    act(() => {
      emitTerminalData(ws, 'seed');
    });
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
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
  });

  test('does not navigate when a question menu is followed by blank screen rows', () => {
    // A real xterm buffer always holds a full screen. Until the session's output
    // fills it, the rows below the agent's menu are blank, so the menu is not at
    // the end of the buffer. Rows are from Claude Code v2.1.321 in a 50-row pane.
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      emitTerminalData(ws, 'seed');
    });
    terminal.rows = 50;
    setTerminalBufferLines(terminal, [
      '❯ Which color should the button be?',
      '─'.repeat(80),
      ' ☐ Color',
      '',
      'Which color do you prefer?',
      '',
      '❯ 1. Red (warm)',
      '     A warm, energetic color.',
      '  2. Green (calm)',
      '     A calm, natural color.',
      '  3. Type something.',
      '─'.repeat(80),
      '  4. Chat about this',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
      ...Array.from({ length: 35 }, () => ''),
    ]);
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
  });

  test('navigates when the only menu sits in scrollback above an idle live screen', () => {
    // The live screen (the last `terminal.rows` buffer rows) holds a short idle
    // composer; an old, already-dismissed menu sits just above it in scrollback.
    // That menu must not be read as current — Enter still advances. The buffer
    // is longer than the screen on purpose: a regression that feeds the buffer
    // length as the screen height (disabling the scrollback clamp) fails here.
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      emitTerminalData(ws, 'seed');
    });
    terminal.rows = 24;
    setTerminalBufferLines(terminal, [
      // scrollback (6 rows): the menu the operator already answered
      'Which color do you prefer?',
      '❯ 1. Red (warm)',
      '  2. Green (calm)',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
      '',
      // live screen (24 rows): idle composer, then blank bottom
      '─'.repeat(80),
      '❯ ',
      '─'.repeat(80),
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
      ...Array.from({ length: 20 }, () => ''),
    ]);
    ws.send.mockClear();

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
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
    act(() => {
      emitTerminalData(ws, 'seed');
    });
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
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
  });

  test('menu veto fires on the footer signal alone (no marked row present)', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      emitTerminalData(ws, 'seed');
    });
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
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
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
      emitTerminalData(ws, '\r\n› \r\n  gpt-5.3-codex high 75% left\r\n');
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
      emitTerminalData(ws, '\r\n› run tests\r\n  gpt-5.3-codex high 75% left\r\n');
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
      emitTerminalData(ws, '\r\n❯ run tests\r\n');
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
      emitTerminalData(ws, '\r\n────────────────────────\r\n❯ ────────────────────────\r\n  esc to interrupt · ctrl+t to hide tasks\r\n');
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
      emitTerminalData(ws, '\r\n• Working (7m 32s • esc to interrupt)\r\n');
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
      emitTerminalData(ws, '\r\n• Working (7m 32s • esc to interrupt)\r\n');
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
      emitTerminalData(ws, '\r\n❯ \r\n');
    });
    ws.send.mockClear();
    act(() => {
      terminal.dataHandler?.('\x1b[A');
    });

    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenNthCalledWith(1, terminalFrame(ws, { type: 'input', text: '\x1b[A' }));
    expect(ws.send).toHaveBeenNthCalledWith(2, terminalFrame(ws, { type: 'input', text: '\r' }));
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
      emitTerminalData(ws, '\r\n❯ \r\n');
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
    expect(ws.send).not.toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
  });

  test('blur tracking sequence is also filtered out of the input draft', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      emitTerminalData(ws, '\r\n❯ \r\n');
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
    expect(ws.send).not.toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
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
      emitTerminalData(ws, '\r\n❯ \r\n');
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
    expect(ws.send).not.toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
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
      emitTerminalData(ws, '\r\n❯ \r\n');
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
    expect(ws.send).not.toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
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
      emitTerminalData(ws, '\r\n❯ \r\n');
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
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: 'a' }));
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
  });

  test('captures empty terminal Enter without inspecting permission-looking output', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      emitTerminalData(ws, '\r\nAllow this command? Allow  Deny\r\n❯ \r\n');
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
      emitTerminalData(ws, '\r\nuser@host:~/repo$ \r\n');
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
    act(() => emitTerminalData(ws, 'seed'));
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
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'paste', text: 'line1\nline2\nline3' }));
  });

  test('routes Ctrl+V multiline clipboard text through one structured paste frame', async () => {
    const readText = vi.fn().mockResolvedValue('line1\nline2\nline3');
    vi.stubGlobal('navigator', { clipboard: { readText } });
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const ws = mocks.webSocketInstances[0];
    act(() => emitTerminalData(ws, 'seed'));
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
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'paste', text: 'line1\nline2\nline3' }));
  });

  test('discards a clipboard result after switching to another ready agent', async () => {
    let resolveClipboard!: (text: string) => void;
    const readText = vi.fn(() => new Promise<string>((resolve) => { resolveClipboard = resolve; }));
    vi.stubGlobal('navigator', { clipboard: { readText } });
    act(() => root.render(React.createElement(TerminalPanel, { tmuxName: 'old', visible: true })));
    const old = mocks.webSocketInstances[0];
    act(() => emitTerminalData(old, 'seed'));
    await act(async () => {
      container.querySelector('.terminal-xterm')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'v', ctrlKey: true, bubbles: true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(readText).toHaveBeenCalledOnce();
    act(() => root.render(React.createElement(TerminalPanel, { tmuxName: 'new', visible: true })));
    const next = mocks.webSocketInstances[1];
    act(() => emitTerminalData(next, 'seed'));
    next.send.mockClear(); old.send.mockClear();
    await act(async () => resolveClipboard('private\ntext'));
    expect(next.send).not.toHaveBeenCalled();
    expect(old.send).not.toHaveBeenCalled();
  });

  test('forwards Enter after a multiline safe paste marks the local draft non-empty', () => {
    const onEmptySubmit = vi.fn();
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true, onEmptySubmit }));
    });

    const terminal = mocks.terminalInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      emitTerminalData(ws, 'seed');
    });
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
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
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

  describe('image drag & drop and paste', () => {
    const IMG_PATH = '/srv/kookr/terminal-images/kookr-image-20260101-000000-abcd1234.png';

    function mountReady(tmuxName = 'kookr-test') {
      act(() => {
        root.render(React.createElement(TerminalPanel, { tmuxName, visible: true }));
      });
      const ws = mocks.webSocketInstances.at(-1)!;
      act(() => emitTerminalData(ws, 'seed'));
      ws.send.mockClear();
      return { ws, xterm: container.querySelector('.terminal-xterm')! };
    }
    const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const sentTypes = (ws: MockWebSocket) => ws.send.mock.calls.map(([frame]) => JSON.parse(String(frame)).type);

    test('uploads a dropped image and pastes its host path (never Enter) into the agent', async () => {
      const fetchMock = vi.fn().mockResolvedValue(savedImageResponse(IMG_PATH));
      vi.stubGlobal('fetch', fetchMock);
      const { ws, xterm } = mountReady();

      let drop: Event;
      act(() => { drop = dispatchFileDrag(xterm, 'drop', [PNG_FILE()]); });
      await flush();

      // Cancelled, so Chrome does not navigate the dashboard tab to the file.
      expect(drop!.defaultPrevented).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/terminal-images');
      expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'image/png' } });
      // The raw File is the body (not JSON/base64/multipart).
      expect(init.body).toBeInstanceOf(File);
      // One structured paste frame: the path plus a trailing space; no input / Enter frame.
      expect(sentTypes(ws)).toEqual(['paste']);
      expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'paste', text: `${IMG_PATH} ` }));
    });

    // One paste frame PER image: Codex CLI leaves two paths in a single paste as plain text.
    test('pastes several dropped images as one paste frame each, in drop order', async () => {
      let n = 0;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => savedImageResponse(`/img/${++n}.png`)));
      const { ws, xterm } = mountReady();

      act(() => { dispatchFileDrag(xterm, 'drop', [PNG_FILE(), PNG_FILE()]); });
      await flush();

      expect(ws.send.mock.calls.map(([frame]) => frame)).toEqual([
        terminalFrame(ws, { type: 'paste', text: '/img/1.png ' }),
        terminalFrame(ws, { type: 'paste', text: '/img/2.png ' }),
      ]);
    });

    test('claims file drags (overlay + cancelled dragover) but leaves dragged text alone', () => {
      vi.stubGlobal('fetch', vi.fn());
      const { xterm } = mountReady();

      let textDrag: Event;
      act(() => { textDrag = dispatchFileDrag(xterm, 'dragover', [], ['text/plain']); });
      expect(textDrag!.defaultPrevented).toBe(false);
      expect(container.querySelector('[data-testid="terminal-drop-overlay"]')).toBeNull();

      let fileDrag: Event;
      act(() => { fileDrag = dispatchFileDrag(xterm, 'dragover', [PNG_FILE()]); });
      expect(fileDrag!.defaultPrevented).toBe(true);
      expect(container.querySelector('[data-testid="terminal-drop-overlay"]')).not.toBeNull();

      act(() => { dispatchFileDrag(xterm, 'dragleave', []); });
      expect(container.querySelector('[data-testid="terminal-drop-overlay"]')).toBeNull();
    });

    test('does not upload or paste a dropped non-image, but still cancels the drop and says why', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { ws, xterm } = mountReady();

      let drop: Event;
      act(() => { drop = dispatchFileDrag(xterm, 'drop', [new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })]); });
      await flush();

      expect(drop!.defaultPrevented).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="terminal-image-notice"]')?.textContent)
        .toContain('notes.pdf: not a PNG, JPEG, GIF or WebP image');
    });

    test('reports a failed upload and pastes nothing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ error: 'request-body-too-large' }), { status: 413 })));
      const { ws, xterm } = mountReady();

      act(() => { dispatchFileDrag(xterm, 'drop', [PNG_FILE()]); });
      await flush();

      expect(ws.send).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="terminal-image-notice"]')?.textContent)
        .toContain('shot.png: larger than 10 MB');
    });

    test('never pastes into a different agent when the selection changes during the upload', async () => {
      let resolveUpload!: (response: Response) => void;
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveUpload = resolve; })));
      const { ws: wsA, xterm } = mountReady('agent-A');

      act(() => { dispatchFileDrag(xterm, 'drop', [PNG_FILE()]); });
      // The user (or auto-advance) switches to agent B while the image is uploading.
      act(() => {
        root.render(React.createElement(TerminalPanel, { tmuxName: 'agent-B', visible: true }));
      });
      const wsB = mocks.webSocketInstances.at(-1)!;
      expect(wsB).not.toBe(wsA);
      act(() => emitTerminalData(wsB, 'seed'));
      wsA.send.mockClear();
      wsB.send.mockClear();

      resolveUpload(savedImageResponse(IMG_PATH));
      await flush();

      expect(wsA.send).not.toHaveBeenCalled();
      expect(wsB.send).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="terminal-image-notice"]')?.textContent)
        .toContain('was not attached');
    });

    // A real `paste` event: macOS Cmd+V, Shift+Insert, or the browser's Edit ▸ Paste.
    // (Plain Ctrl+V never fires one here — see the Ctrl+V test below.)
    test('attaches an image delivered by a browser paste event when the clipboard carries no text', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(savedImageResponse(IMG_PATH)));
      const { ws, xterm } = mountReady();

      let evt: Event;
      act(() => { evt = dispatchFilePaste(xterm, [PNG_FILE()]); });
      await flush();

      expect(evt!.defaultPrevented).toBe(true);
      expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'paste', text: `${IMG_PATH} ` }));
    });

    test('leaves a clipboard that has text AND an image (e.g. spreadsheet cells) to the normal text paste', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { ws, xterm } = mountReady();

      let evt: Event;
      act(() => { evt = dispatchFilePaste(xterm, [PNG_FILE()], 'echo hello'); });
      await flush();

      expect(evt!.defaultPrevented).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalled();
    });

    const notice = () => container.querySelector('[data-testid="terminal-image-notice"]');
    const overlay = () => container.querySelector('[data-testid="terminal-drop-overlay"]');
    const PDF_FILE = () => new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' });
    /** A clipboard holding only a picture, as after a screenshot. */
    const imageOnlyClipboard = () => ({
      readText: vi.fn().mockResolvedValue(''),
      read: vi.fn().mockResolvedValue([{
        types: ['image/png'],
        getType: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
      }]),
    });

    test('shows "Uploading image…" while in flight and clears it once the image is attached', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(savedImageResponse(IMG_PATH)));
      const { ws, xterm } = mountReady();

      act(() => { dispatchFileDrag(xterm, 'drop', [PNG_FILE()]); });
      expect(notice()?.textContent).toBe('Uploading image…');
      // In-flight progress is not dismissible.
      expect(notice()?.querySelector('button')).toBeNull();

      await flush();
      expect(sentTypes(ws)).toEqual(['paste']);
      expect(notice()).toBeNull();
    });

    test('a mixed drop attaches the image and names the file it skipped', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(savedImageResponse(IMG_PATH)));
      const { ws, xterm } = mountReady();

      act(() => { dispatchFileDrag(xterm, 'drop', [PNG_FILE(), PDF_FILE()]); });
      await flush();

      expect(sentTypes(ws)).toEqual(['paste']);
      expect(notice()?.querySelector('span')?.textContent)
        .toBe('Attached 1 image; skipped: notes.pdf: not a PNG, JPEG, GIF or WebP image');
    });

    test('a result notice stays until dismissed (no timer) and its live region is always mounted', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const { xterm } = mountReady();
      const region = container.querySelector('[data-testid="terminal-image-notice-region"]');
      // Present before any notice exists, so screen readers announce the text when it arrives.
      expect(region?.getAttribute('role')).toBe('status');

      vi.useFakeTimers();
      try {
        act(() => { dispatchFileDrag(xterm, 'drop', [PDF_FILE()]); });
        act(() => { vi.advanceTimersByTime(10 * 60_000); });
        expect(notice()).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }

      const dismiss = notice()!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss image notice"]');
      act(() => { dismiss!.click(); });
      expect(notice()).toBeNull();
      expect(container.querySelector('[data-testid="terminal-image-notice-region"]')).toBe(region);
    });

    test('clears a lingering notice when the selected agent changes', () => {
      vi.stubGlobal('fetch', vi.fn());
      const { xterm } = mountReady('agent-A');
      act(() => { dispatchFileDrag(xterm, 'drop', [PDF_FILE()]); });
      expect(notice()).not.toBeNull();

      act(() => { root.render(React.createElement(TerminalPanel, { tmuxName: 'agent-B', visible: true })); });
      expect(notice()).toBeNull();
    });

    test('says so when a file drag carries no files', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const { xterm } = mountReady();
      act(() => { dispatchFileDrag(xterm, 'drop', []); });
      await flush();
      expect(notice()?.querySelector('span')?.textContent).toBe('No image to attach.');
    });

    test('keeps the overlay while the drag moves between the panel\'s own children, and hides it on drop', () => {
      vi.stubGlobal('fetch', vi.fn());
      const { xterm } = mountReady();
      act(() => { dispatchFileDrag(xterm, 'dragenter', [PNG_FILE()]); });
      expect(overlay()).not.toBeNull();

      // dragleave whose pointer is still inside the panel (xterm → the overlay sibling).
      const inside = new Event('dragleave', { bubbles: true, cancelable: true });
      Object.defineProperty(inside, 'relatedTarget', { value: overlay() });
      act(() => { xterm.dispatchEvent(inside); });
      expect(overlay()).not.toBeNull();

      act(() => { dispatchFileDrag(xterm, 'drop', [PDF_FILE()]); });
      expect(overlay()).toBeNull();
    });

    test('claims a drop that lands on a sibling of the terminal (the notice), not only on xterm', async () => {
      const fetchMock = vi.fn().mockResolvedValue(savedImageResponse(IMG_PATH));
      vi.stubGlobal('fetch', fetchMock);
      const { ws, xterm } = mountReady();
      act(() => { dispatchFileDrag(xterm, 'drop', [PDF_FILE()]); });
      expect(notice()).not.toBeNull();

      // The pointer is over the notice pill, which is outside the xterm element.
      let drop: Event;
      act(() => { drop = dispatchFileDrag(notice()!, 'drop', [PNG_FILE()]); });
      await flush();

      // Unclaimed, the browser would navigate the dashboard tab to the file.
      expect(drop!.defaultPrevented).toBe(true);
      expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'paste', text: `${IMG_PATH} ` }));
    });

    test('leaves a dropped text drag alone', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const { xterm } = mountReady();
      let drop: Event;
      act(() => { drop = dispatchFileDrag(xterm, 'drop', [], ['text/plain']); });
      await flush();
      expect(drop!.defaultPrevented).toBe(false);
      expect(notice()).toBeNull();
    });

    test('leaves a text-less paste that holds no image alone', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const { xterm } = mountReady();
      let paste: Event;
      act(() => { paste = dispatchFilePaste(xterm, [PDF_FILE()]); });
      await flush();
      expect(paste!.defaultPrevented).toBe(false);
      expect(notice()).toBeNull();
    });

    test('right-click ▸ Paste attaches a clipboard screenshot when the clipboard has no text', async () => {
      const fetchMock = vi.fn().mockResolvedValue(savedImageResponse(IMG_PATH));
      vi.stubGlobal('fetch', fetchMock);
      const clipboard = imageOnlyClipboard();
      vi.stubGlobal('navigator', { clipboard });
      const { ws, xterm } = mountReady();

      act(() => { xterm.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
      const pasteButton = [...container.querySelectorAll('.terminal-context-menu button')]
        .find((button) => button.textContent === 'Paste') as HTMLButtonElement;
      await act(async () => { pasteButton.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      await flush();

      expect(clipboard.read).toHaveBeenCalledTimes(1);
      const uploaded = fetchMock.mock.calls[0][1].body as File;
      expect(uploaded).toMatchObject({ name: 'clipboard.png', type: 'image/png' });
      expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'paste', text: `${IMG_PATH} ` }));
    });

    // Plain Ctrl+V belongs to the agent: xterm forwards it as ^V and Claude Code / Codex
    // paste an image from the host clipboard themselves. Uploading here as well would
    // attach the same screenshot twice wherever the agent can read that clipboard.
    test('does not upload a clipboard image on plain Ctrl+V (the agent handles that key itself)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const clipboard = imageOnlyClipboard();
      vi.stubGlobal('navigator', { clipboard });
      const { ws, xterm } = mountReady();

      act(() => {
        xterm.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
      });
      await flush();
      await flush();

      expect(clipboard.read).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalled();
    });

    test('"Paste raw" never uploads a clipboard image', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const clipboard = imageOnlyClipboard();
      vi.stubGlobal('navigator', { clipboard });
      const { xterm } = mountReady();

      act(() => { xterm.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
      const rawButton = [...container.querySelectorAll('.terminal-context-menu button')]
        .find((button) => button.textContent === 'Paste raw') as HTMLButtonElement;
      await act(async () => { rawButton.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      await flush();

      expect(clipboard.read).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('refuses to attach while the terminal is not connected', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      act(() => {
        root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
      });
      // No seed/hello yet: the stream is not established.
      const xterm = container.querySelector('.terminal-xterm')!;

      act(() => { dispatchFileDrag(xterm, 'drop', [PNG_FILE()]); });
      await flush();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="terminal-image-notice"]')?.textContent)
        .toContain('not connected');
    });
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

  test('initializes xterm with the persisted terminal font size', () => {
    localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, '17');

    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    expect(terminal.options.fontSize).toBe(17);
  });

  test('terminal-scoped font-size shortcuts update xterm, persist, refit, and repaint', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });

    const terminal = mocks.terminalInstances[0];
    const fitAddon = mocks.fitAddonInstances[0];
    const ws = mocks.webSocketInstances[0];
    act(() => {
      ws.onopen?.();
      emitTerminalData(ws, 'seed');
    });
    fitAddon.proposeDimensions.mockClear();
    fitAddon.proposeDimensions.mockReturnValue({ cols: 90, rows: 24 });
    terminal.refresh.mockClear();
    ws.send.mockClear();

    let shortcut: ReturnType<typeof dispatchTerminalShortcut> | null = null;
    act(() => {
      shortcut = dispatchTerminalShortcut(terminal, '=');
    });

    expect(shortcut?.handled).toBe(false);
    expect(shortcut?.preventDefault).toHaveBeenCalledOnce();
    expect(shortcut?.stopPropagation).toHaveBeenCalledOnce();
    expect(terminal.options.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE + 1);
    expect(localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)).toBe(String(DEFAULT_TERMINAL_FONT_SIZE + 1));
    expect(fitAddon.proposeDimensions).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'resize', cols: 90, rows: 24 }));

    act(() => {
      dispatchTerminalShortcut(terminal, '-');
    });
    expect(terminal.options.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)).toBe(String(DEFAULT_TERMINAL_FONT_SIZE));

    act(() => {
      dispatchTerminalShortcut(terminal, '+');
    });
    expect(terminal.options.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE + 1);

    act(() => {
      dispatchTerminalShortcut(terminal, '0');
    });
    expect(terminal.options.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)).toBe(String(DEFAULT_TERMINAL_FONT_SIZE));
  });

  test('terminal font-size shortcuts clamp to the supported range', () => {
    localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, String(MAX_TERMINAL_FONT_SIZE));
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });
    let terminal = mocks.terminalInstances[0];

    act(() => {
      dispatchTerminalShortcut(terminal, '=');
    });
    expect(terminal.options.fontSize).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)).toBe(String(MAX_TERMINAL_FONT_SIZE));

    act(() => {
      root.unmount();
    });
    container.innerHTML = '';
    root = createRoot(container);
    localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, String(MIN_TERMINAL_FONT_SIZE));
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
    });
    terminal = mocks.terminalInstances[mocks.terminalInstances.length - 1];

    act(() => {
      dispatchTerminalShortcut(terminal, '-');
    });
    expect(terminal.options.fontSize).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)).toBe(String(MIN_TERMINAL_FONT_SIZE));
  });

  test('terminal font-size shortcuts are ignored while hidden', () => {
    act(() => {
      root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: false }));
    });

    const terminal = mocks.terminalInstances[0];
    const shortcut = dispatchTerminalShortcut(terminal, '=');

    expect(shortcut.handled).toBe(false);
    expect(shortcut.preventDefault).not.toHaveBeenCalled();
    expect(shortcut.stopPropagation).not.toHaveBeenCalled();
    expect(terminal.options.fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)).toBeNull();
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
      act(() => { emitTerminalData(ws, '\r\n╭────────╮\r\n❯ \r\n'); });
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
    act(() => { emitTerminalData(wsC, '\r\n› \r\n  gpt-5.5 high · ~/git/kookr\r\n'); });
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
      emitTerminalData(ws, 'seed');
    });

    act(() => {
      terminal.dataHandler?.('h');
      terminal.dataHandler?.('i');
    });
    ws.send.mockClear();
    act(() => {
      terminal.dataHandler?.('\r');
    });

    expect(onEmptySubmit).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(terminalFrame(ws, { type: 'input', text: '\r' }));
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
    act(() => { emitTerminalData(wsA, '\r\n❯ \r\n'); });
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

  test('reconnects after an abnormal close without resetting a resumable parser', () => {
    // Server restart / host offline: the byte stream must come back on its
    // own. Reset is deferred until the first server byte of each attach so the
    // pane stays painted during the handshake (no blank flash).
    vi.useFakeTimers();
    try {
      act(() => {
        root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
      });
      const terminal = mocks.terminalInstances[0];
      const first = mocks.webSocketInstances[0];
      act(() => {
        first.onopen?.();
      });
      // Open alone must not blank the pane.
      expect(terminal.reset).toHaveBeenCalledTimes(0);

      act(() => {
        emitTerminalData(first, 'seed-a');
      });
      expect(terminal.reset).toHaveBeenCalledTimes(1);

      act(() => {
        first.onclose?.({ code: 1006 });
      });
      const written = terminal.write.mock.calls.map(([data]: [Uint8Array]) => new TextDecoder().decode(data)).join('');
      expect(written).toBe('seed-a');
      expect(container.textContent).toContain('Terminal connection unavailable.');
      expect(mocks.webSocketInstances).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(2_000); // past the 1s ± 20% first retry
      });
      expect(mocks.webSocketInstances).toHaveLength(2);

      const second = mocks.webSocketInstances[1];
      act(() => {
        second.onopen?.();
      });
      // Second open still defers reset until first byte of the new attach.
      expect(terminal.reset).toHaveBeenCalledTimes(1);
      act(() => {
        emitTerminalData(second, 'seed-b');
      });
      expect(terminal.reset).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    ['confirmed PTY exit', 4404],
  ])('a session-over close (%s, code %i) shows "Session ended." and never reconnects', (_label, code) => {
    vi.useFakeTimers();
    try {
      act(() => {
        root.render(React.createElement(TerminalPanel, { tmuxName: 'kookr-test', visible: true }));
      });
      const terminal = mocks.terminalInstances[0];
      const ws = mocks.webSocketInstances[0];
      act(() => {
        ws.onopen?.();
      });
      // No server bytes yet → no reset (keeps prior paint until attach fails).
      expect(terminal.reset).toHaveBeenCalledTimes(0);
      act(() => {
        ws.onclose?.({ code });
      });
      expect(terminal.write).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Session ended.');

      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(mocks.webSocketInstances).toHaveLength(1);
      // No reconnect and no first-byte paint ⇒ still no reset.
      expect(terminal.reset).toHaveBeenCalledTimes(0);
    } finally {
      vi.useRealTimers();
    }
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
    act(() => { emitTerminalData(ws, '\r\n❯ \r\n'); });

    for (let i = 1; i <= 5; i++) {
      ws.send.mockClear();
      act(() => { terminal.dataHandler?.('\r'); });
      expect(onEmptySubmit).toHaveBeenCalledTimes(i);
      expect(ws.send).not.toHaveBeenCalled();
    }
  });
});
