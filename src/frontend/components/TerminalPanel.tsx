import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useKookrStore } from '../store/useStore.js';
import { registerTerminalSend } from '../terminal-send.js';
import { isMultilinePaste, buildPasteFrame } from '../terminal-paste.js';
import { track } from '../telemetry.js';
import { analyzePaneSemantics, hasVisibleComposerDraft } from '../../shared/pane-semantics.js';

interface Props {
  tmuxName: string | null;
  visible: boolean;
  onEmptySubmit?: () => void;
}

interface MenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

const SEARCH_OPTIONS: ISearchOptions = {
  decorations: {
    matchBackground: '#164e63',
    matchBorder: '#22d3ee',
    matchOverviewRuler: '#22d3ee',
    activeMatchBackground: '#f59e0b',
    activeMatchBorder: '#fef3c7',
    activeMatchColorOverviewRuler: '#f59e0b',
  },
};

const CTRL_C = '\u0003';
const CTRL_U = '\u0015';
const BACKSPACE = '\b';
const DELETE = '\u007f';
const TERMINAL_OUTPUT_TAIL_LIMIT = 20_000;

function getValidatedResize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}

function updateTerminalInputDraft(draft: string, data: string): string {
  let next = draft;
  for (const char of data) {
    if (char === '\r' || char === '\n' || char === CTRL_C || char === CTRL_U) {
      next = '';
    } else if (char === DELETE || char === BACKSPACE) {
      next = next.slice(0, -1);
    } else {
      next += char;
    }
  }
  return next;
}

function getVisibleTerminalTail(terminal: Terminal): string {
  try {
    const buffer = terminal.buffer.active;
    const start = Math.max(0, buffer.length - 15);
    const lines: string[] = [];
    for (let i = start; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

function shouldHandleEmptyTerminalEnter(
  terminal: Terminal,
  draft: string,
  outputTail: string,
  onEmptySubmit?: () => void,
): boolean {
  if (draft.length !== 0 || !onEmptySubmit) return false;
  const visibleTail = getVisibleTerminalTail(terminal);
  if (hasVisibleComposerDraft(visibleTail) || hasVisibleComposerDraft(outputTail)) return false;

  const visibleSemantics = analyzePaneSemantics(visibleTail);
  const outputSemantics = analyzePaneSemantics(outputTail);
  const disallowedStates = new Set(['permission_dialog', 'shell_prompt']);
  if (disallowedStates.has(visibleSemantics.state) || disallowedStates.has(outputSemantics.state)) return false;

  // Empty terminal Enter is a navigation shortcut whenever no draft is present.
  // That keeps rapid task triage reliable even while an agent is streaming.
  return true;
}

export function TerminalPanel({ tmuxName, visible, onEmptySubmit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const currentTmuxRef = useRef<string | null>(null);
  const terminalInputDraftRef = useRef('');
  const terminalOutputTailRef = useRef('');
  const terminalOutputDecoderRef = useRef(new TextDecoder());
  const onEmptySubmitRef = useRef(onEmptySubmit);
  const searchOpenRef = useRef(false);
  const visibleRef = useRef(visible);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchFound, setSearchFound] = useState<boolean | null>(null);
  const [searchResult, setSearchResult] = useState<ISearchResultChangeEvent | null>(null);

  function openSearch() {
    searchOpenRef.current = true;
    setSearchOpen(true);
    setMenu(null);
  }

  function closeSearch() {
    searchOpenRef.current = false;
    setSearchOpen(false);
    setSearchFound(null);
    setSearchResult(null);
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.focus();
  }

  function registerVisibleTerminalSend(ws: WebSocket | null) {
    if (!visibleRef.current || !ws || ws.readyState !== WebSocket.OPEN) {
      registerTerminalSend(null);
      return;
    }
    registerTerminalSend((data) => {
      if (visibleRef.current && ws.readyState === WebSocket.OPEN) ws.send(data);
    });
  }

  function runSearch(term: string, direction: 'next' | 'previous', incremental = false) {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon || term.length === 0) {
      searchAddon?.clearDecorations();
      setSearchFound(null);
      setSearchResult(null);
      return;
    }

    const options = direction === 'next' ? { ...SEARCH_OPTIONS, incremental } : SEARCH_OPTIONS;
    const found = direction === 'next'
      ? searchAddon.findNext(term, options)
      : searchAddon.findPrevious(term, options);
    setSearchFound(found);
  }

  useEffect(() => {
    onEmptySubmitRef.current = onEmptySubmit;
  }, [onEmptySubmit]);

  useEffect(() => {
    visibleRef.current = visible;
    registerVisibleTerminalSend(wsRef.current);
    if (visible) return;

    searchOpenRef.current = false;
    setSearchOpen(false);
    setSearchFound(null);
    setSearchResult(null);
    searchAddonRef.current?.clearDecorations();
    setMenu(null);
    if (useKookrStore.getState().focusZone === 'terminal') {
      useKookrStore.getState().setFocusZone('none');
    }
  }, [visible]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create terminal instance
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      scrollback: 10000,
      // Scroll tuning cribbed from the VS Code / JupyterLab / Hyper / Theia
      // comparison in ~/git/deepresearch/deepresearch_report2.md:
      // - fastScrollSensitivity: Alt+wheel → 5× base speed (VS Code default).
      // - scrollSensitivity: baseline wheel step in lines.
      // - scrollOnEraseInDisplay: clear-screen scrolls output into scrollback
      //   instead of discarding it (VS Code sets this explicitly).
      // - scrollOnUserInput: false — don't yank the viewport to the bottom
      //   when the user types while scrolled up. Added in xterm.js 5.1.0 for
      //   this exact UX.
      fastScrollSensitivity: 5,
      scrollSensitivity: 1,
      scrollOnEraseInDisplay: true,
      scrollOnUserInput: false,
      theme: {
        background: '#0a0c12',
        foreground: '#b2bace',
        cursor: '#2dd4bf',
        cursorAccent: '#0a0c12',
        selectionBackground: 'rgba(45, 212, 191, 0.2)',
        black: '#0f1117',
        red: '#f87171',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#a78bfa',
        cyan: '#2dd4bf',
        white: '#dfe4f0',
        brightBlack: '#3f4a62',
        brightRed: '#fca5a5',
        brightGreen: '#6ee7b7',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#c4b5fd',
        brightCyan: '#5eead4',
        brightWhite: '#f1f5f9',
      },
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(new WebLinksAddon());

    // Let Alt+key combinations bubble to the global shortcut handler
    // instead of being swallowed by xterm.js
    terminal.attachCustomKeyEventHandler((e) => {
      if (!visibleRef.current) return false;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.type === 'keydown' && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
        return false;
      }
      if (searchOpenRef.current && e.type === 'keydown' && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSearch();
        return false;
      }
      if (e.altKey && e.type === 'keydown') return false;
      if (e.metaKey && e.ctrlKey && e.type === 'keydown') return false;
      return true;
    });

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    const searchResultDisposable = searchAddon.onDidChangeResults((event) => {
      setSearchResult(event);
      if (event.resultCount === 0) {
        setSearchFound(false);
      }
    });

    // Track focus zone via DOM events (xterm v6 removed onFocus/onBlur)
    const container = containerRef.current;
    function handleTermFocus() {
      if (!visibleRef.current) return;
      const prev = useKookrStore.getState().focusZone;
      useKookrStore.getState().setFocusZone('terminal');
      track({ type: 'focus_zone_changed', from: prev, to: 'terminal' });
    }
    function handleTermBlur() {
      const current = useKookrStore.getState().focusZone;
      if (current === 'terminal') {
        useKookrStore.getState().setFocusZone('none');
        track({ type: 'focus_zone_changed', from: 'terminal', to: 'none' });
      }
    }
    container.addEventListener('focusin', handleTermFocus);
    container.addEventListener('focusout', handleTermBlur);

    // Right-click → custom Copy/Paste popover. With terminal mouse tracking off,
    // the browser would otherwise show its default page context menu, which
    // is not what terminal users expect for copy/paste.
    function handleContextMenu(e: Event) {
      const mouseEvent = e as MouseEvent;
      mouseEvent.preventDefault();
      if (!visibleRef.current) return;
      const rect = container.getBoundingClientRect();
      setMenu({
        x: mouseEvent.clientX - rect.left,
        y: mouseEvent.clientY - rect.top,
        hasSelection: terminal.hasSelection(),
      });
    }
    container.addEventListener('contextmenu', handleContextMenu);

    // Paste interception — capture phase, before xterm.js.
    //
    // xterm streams a pasted blob to the PTY as raw bytes, newlines included.
    // Agent TUIs (Codex, Claude Code) treat each newline as an Enter submit,
    // so one paste of JSON / logs / a stack trace becomes dozens of prompts
    // (kookr #356). Intercept the browser paste here: multiline content goes
    // through a structured `paste` WS frame the server delivers as one atomic
    // bracketed paste. Single-line pastes are byte-identical to typing and are
    // left on xterm's raw path untouched. Raw multiline paste stays available
    // through the explicit "Paste raw" context-menu action.
    function handlePasteCapture(e: ClipboardEvent) {
      const pasted = e.clipboardData?.getData('text') ?? '';
      if (!pasted || !isMultilinePaste(pasted)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      sendSafePaste(pasted);
    }
    container.addEventListener('paste', handlePasteCapture, { capture: true });

    // Real keyboard Enter reaches xterm as a DOM event before `onData`. Catch
    // empty prompts here so xterm never forwards the newline to the agent.
    function handleKeyDownCapture(e: KeyboardEvent) {
      if (e.key !== 'Enter' || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      if (!shouldHandleEmptyTerminalEnter(
        terminal,
        terminalInputDraftRef.current,
        terminalOutputTailRef.current,
        onEmptySubmitRef.current,
      )) {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      onEmptySubmitRef.current?.();
    }
    container.addEventListener('keydown', handleKeyDownCapture, { capture: true });

    // Wheel override — capture phase, before xterm.js.
    // Without this, xterm.js converts wheel to application-cursor-key bytes
    // (ESC O A / ESC O B) whenever the child has enabled DECSET ?1 or is in
    // alt-screen. Those bytes reach Claude Code / Codex and cycle the agent's
    // prompt history instead of scrolling the terminal — the user-visible
    // "scrolling doesn't work" bug. Scroll xterm.js's own scrollback instead.
    function handleWheelOverride(e: WheelEvent) {
      const lines = Math.round(e.deltaY / 40);
      if (lines !== 0) {
        terminal.scrollLines(lines);
      }
      e.stopImmediatePropagation();
      e.preventDefault();
    }
    container.addEventListener('wheel', handleWheelOverride, {
      capture: true,
      passive: false,
    });

    // Handle container resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(container);

    return () => {
      container.removeEventListener('focusin', handleTermFocus);
      container.removeEventListener('focusout', handleTermBlur);
      container.removeEventListener('wheel', handleWheelOverride, { capture: true });
      container.removeEventListener('contextmenu', handleContextMenu);
      container.removeEventListener('paste', handlePasteCapture, { capture: true });
      container.removeEventListener('keydown', handleKeyDownCapture, { capture: true });
      resizeObserver.disconnect();
      searchResultDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    const rafId = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => cancelAnimationFrame(rafId);
  }, [searchOpen]);

  // Close the context menu on any click or Escape outside it.
  useEffect(() => {
    if (!menu) return;
    function closeMenu() { setMenu(null); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setMenu(null); }
    window.addEventListener('mousedown', closeMenu);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', closeMenu);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  /** Send a frame on the live terminal WebSocket, if one is open. */
  function sendOverWs(payload: string | Uint8Array) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(payload);
  }

  /**
   * Route a paste through the server's bracketed-paste path (kookr #356):
   * one structured WS frame the SessionBridge turns into a single atomic
   * paste, instead of raw bytes whose newlines each submit a prompt.
   */
  function sendSafePaste(text: string) {
    sendOverWs(buildPasteFrame(text));
  }

  /**
   * Escape hatch: forward a paste verbatim as raw PTY bytes. Newlines act as
   * Enter submissions — intended for shell-style workflows where that is what
   * the user wants. Sent as a binary frame so the payload can never be
   * misread as a JSON control frame.
   */
  function sendRawPaste(text: string) {
    sendOverWs(new TextEncoder().encode(text));
  }

  async function handleCopy() {
    const sel = terminalRef.current?.getSelection();
    if (sel) {
      try { await navigator.clipboard.writeText(sel); } catch { /* clipboard denied */ }
    }
    setMenu(null);
  }

  /**
   * Read the clipboard and hand the text to `route`. Shared by the two
   * context-menu paste actions so their clipboard-permission handling and
   * menu dismissal cannot drift apart.
   */
  async function pasteFromClipboard(route: (text: string) => void) {
    try {
      const text = await navigator.clipboard.readText();
      if (text) route(text);
    } catch { /* clipboard denied */ }
    setMenu(null);
  }

  function handlePaste() {
    // Multiline → safe path; a single-line paste is byte-identical to typing,
    // so xterm's raw path is fine and stays untouched.
    void pasteFromClipboard((text) => {
      if (isMultilinePaste(text)) sendSafePaste(text);
      else terminalRef.current?.paste(text);
    });
  }

  function handlePasteRaw() {
    void pasteFromClipboard(sendRawPaste);
  }

  // Connect/reconnect WebSocket when tmuxName changes
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    // Clean up previous connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    searchOpenRef.current = false;
    terminalInputDraftRef.current = '';
    terminalOutputTailRef.current = '';
    terminalOutputDecoderRef.current = new TextDecoder();
    setSearchOpen(false);
    setSearchTerm('');
    setSearchFound(null);
    setSearchResult(null);
    searchAddonRef.current?.clearDecorations();

    if (!tmuxName) {
      terminal.clear();
      terminal.write('\r\n  Select an agent to view its terminal.\r\n');
      currentTmuxRef.current = null;
      return;
    }

    if (tmuxName !== currentTmuxRef.current) {
      terminal.clear();
      currentTmuxRef.current = tmuxName;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/terminal/${encodeURIComponent(tmuxName)}`;
    const ws = new WebSocket(url);
    // v7 SessionBridge sends binary frames. Legacy TerminalBridge (tmux) sends
    // string frames. `arraybuffer` is accepted by xterm.js's `.write` for both
    // Uint8Array and ArrayBuffer, and string frames still arrive as strings
    // on `event.data` regardless — so this is forward-compatible with both.
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      if (!visibleRef.current) {
        registerTerminalSend(null);
        return;
      }
      // Send initial size
      const fitAddon = fitAddonRef.current;
      if (fitAddon) {
        fitAddon.fit();
        const dims = fitAddon.proposeDimensions();
        const resize = getValidatedResize(dims?.cols, dims?.rows);
        if (resize) {
          ws.send(JSON.stringify({ type: 'resize', cols: resize.cols, rows: resize.rows }));
        }
      }
      // Register send function so global shortcuts can write only when this
      // terminal is actually visible.
      registerVisibleTerminalSend(ws);
    };

    ws.onmessage = (event) => {
      // Binary frames arrive as ArrayBuffer (because ws.binaryType = 'arraybuffer'
      // above). Convert to Uint8Array for byte-exact handoff to xterm.js — its
      // .write() accepts both Uint8Array and string. String frames (from the
      // legacy TerminalBridge path) pass through unchanged.
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        terminalOutputTailRef.current = (terminalOutputTailRef.current + terminalOutputDecoderRef.current.decode(bytes, { stream: true }))
          .slice(-TERMINAL_OUTPUT_TAIL_LIMIT);
        terminal.write(bytes);
      } else {
        terminalOutputTailRef.current = (terminalOutputTailRef.current + event.data).slice(-TERMINAL_OUTPUT_TAIL_LIMIT);
        terminal.write(event.data);
      }
    };

    ws.onclose = (event) => {
      // If the PTY exited (e.g. dead terminal session), show feedback
      if (event.code === 1000 && terminal) {
        terminal.write('\r\n\x1b[90m  Session ended.\x1b[0m\r\n');
      }
    };

    ws.onerror = () => {
      if (terminal) {
        terminal.write('\r\n\x1b[90m  Could not connect to terminal.\x1b[0m\r\n');
      }
      ws.close();
    };

    // Terminal input → WebSocket
    const inputDisposable = terminal.onData((data) => {
      if (!visibleRef.current) return;
      if (
        data === '\r'
        && shouldHandleEmptyTerminalEnter(
          terminal,
          terminalInputDraftRef.current,
          terminalOutputTailRef.current,
          onEmptySubmitRef.current,
        )
      ) {
        onEmptySubmitRef.current();
        return;
      }
      terminalInputDraftRef.current = updateTerminalInputDraft(terminalInputDraftRef.current, data);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Terminal resize → WebSocket
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!visibleRef.current) return;
      const resize = getValidatedResize(cols, rows);
      if (resize && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: resize.cols, rows: resize.rows }));
      }
    });

    return () => {
      registerTerminalSend(null);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      ws.close();
      wsRef.current = null;
    };
  }, [tmuxName]);

  // Refit + repaint when the parent explicitly reveals the terminal. Driving
  // this from the real pane/tab state is more reliable than observing
  // intersections after ancestor display:none toggles. The refresh() call is
  // load-bearing: xterm keeps its old canvas across a display:none cycle, so
  // Codex's static screen stays stale until fresh bytes arrive unless we
  // force a redraw of the retained buffer.
  useEffect(() => {
    if (!visible) return;

    const rafId = requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!fitAddon || !terminal) return;
      fitAddon.fit();
      if (terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
      const dims = fitAddon.proposeDimensions();
      const resize = getValidatedResize(dims?.cols, dims?.rows);
      const ws = wsRef.current;
      if (resize && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: resize.cols, rows: resize.rows }));
      }
    });

    return () => cancelAnimationFrame(rafId);
  }, [visible]);

  const focusZone = useKookrStore((s) => s.focusZone);
  const searchStatus = searchTerm.length === 0
    ? ''
    : searchFound === false || searchResult?.resultCount === 0
      ? 'No matches'
      : searchResult && searchResult.resultCount > 0 && searchResult.resultIndex >= 0
        ? `${searchResult.resultIndex + 1}/${searchResult.resultCount}`
        : '';

  return (
    <div className={`terminal-col kookr-tour-target-layout${focusZone === 'terminal' ? ' zone-active' : ''}`}>
      {searchOpen && (
        <form
          className="terminal-search"
          role="search"
          aria-label="Search terminal scrollback"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(searchTerm, 'next');
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            ref={searchInputRef}
            value={searchTerm}
            placeholder="Find scrollback"
            aria-label="Search terminal scrollback"
            onChange={(e) => {
              const nextTerm = e.target.value;
              setSearchTerm(nextTerm);
              runSearch(nextTerm, 'next', true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeSearch();
              } else if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                runSearch(searchTerm, 'previous');
              }
            }}
          />
          <span className="terminal-search-status" aria-live="polite">
            {searchStatus}
          </span>
          <button
            type="button"
            className="terminal-search-btn"
            onClick={() => runSearch(searchTerm, 'previous')}
            title="Previous match"
            aria-label="Previous match"
          >
            Previous
          </button>
          <button
            type="submit"
            className="terminal-search-btn"
            title="Next match"
            aria-label="Next match"
          >
            Next
          </button>
          <button
            type="button"
            className="terminal-search-btn terminal-search-close"
            onClick={closeSearch}
            title="Close search"
            aria-label="Close search"
          >
            &times;
          </button>
        </form>
      )}
      <div className="terminal-xterm" ref={containerRef} />
      {menu && (
        // Plain popover, not role="menu". The full ARIA menu pattern requires
        // focus trapping, arrow-key navigation, and keyboard-open support
        // that this minimal popover does not provide. Using plain <button>
        // elements here keeps the DOM honest: they are reachable via Tab and
        // activate via Enter/Space/click.
        <div
          className="terminal-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="Terminal actions"
        >
          <button
            type="button"
            disabled={!menu.hasSelection}
            onClick={handleCopy}
          >
            Copy
          </button>
          <button type="button" onClick={handlePaste}>
            Paste
          </button>
          <button
            type="button"
            onClick={handlePasteRaw}
            title="Paste raw bytes — newlines submit as Enter (shell workflows)"
          >
            Paste raw
          </button>
        </div>
      )}
    </div>
  );
}
