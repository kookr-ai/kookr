import React, { useEffect, useRef, useState } from 'react';
import { Terminal, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useKookrStore } from '../store/useStore.js';
import { registerTerminalSend } from '../terminal-send.js';
import { isMultilinePaste, buildPasteFrame } from '../terminal-paste.js';
import { createReconnectingSocket, type ReconnectingSocket } from '../reconnecting-socket.js';
import { track } from '../telemetry.js';

interface Props {
  tmuxName: string | null;
  visible: boolean;
  onEmptySubmit?: () => void;
  /** Click handler for a viewable file path detected in terminal output. */
  onOpenFile?: (path: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

interface JumpLatestState {
  visible: boolean;
  lines: number;
}

// Matches file paths ending in a viewable extension, for click-to-view in the
// right pane. Requires a path prefix (/, ./, ../, ~/) to keep false positives
// out of ordinary prose. Absolute paths resolve cleanly server-side; relative
// ones are best-effort against the server cwd.
const VIEWABLE_FILE_RE = /(?:\.{0,2}\/|~\/)[\w./@+-]*\.(?:md|markdown|html?|png|jpe?g|gif|webp|svg)\b/gi;

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

function getValidatedResize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}

function isTerminalAtBottom(terminal: Terminal): boolean {
  try {
    const buffer = terminal.buffer.active;
    return buffer.viewportY >= buffer.baseY || buffer.viewportY + terminal.rows >= buffer.length;
  } catch {
    return true;
  }
}

function countTerminalNewLines(data: string | ArrayBuffer | Uint8Array): number {
  const text = typeof data === 'string'
    ? data
    : new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  return Math.max(1, text.match(/\r\n|\r|\n/g)?.length ?? 0);
}

// xterm.onData forwards more than user keystrokes — it also emits replies
// xterm generates on its own behalf in response to *agent* queries or DOM focus
// changes, none of which represent local input. Examples seen on real Claude
// Code / Codex sessions: focus tracking (`ESC [ I` / `ESC [ O` from DECSET 1004),
// Primary/Secondary Device Attribute replies (`ESC [ ? 1 ; 2 c`, `ESC [ > 0 ; … c`),
// Device Status Reports (`ESC [ … n`), Cursor Position Reports (`ESC [ row ; col R`),
// SGR mouse events, and bracketed-paste markers around xterm's native paste.
//
// Treating any of those bytes as draft input masks empty-Enter navigation: the
// draft looks non-empty even though the user hasn't typed anything. The first
// concrete symptom was `ESC [ I` on click; the deeper one is `ESC [ ? 1 ; 2 c`
// which xterm sends as soon as the agent issues `ESC [ c` (Primary DA query) at
// session start, so the draft is polluted before the user ever interacts.
//
// Strip the known xterm-emitted report sequences before accumulating; leave
// keystroke-driven CSI sequences (arrow keys, function keys) alone so
// up-arrow-recall + Enter still submits to the agent.
const TERMINAL_REPORT_PATTERN = new RegExp(
  [
    '\\x1b\\[[IO]',                  // focus tracking (DECSET 1004)
    '\\x1b\\[[?>][0-9;]*c',          // DA1 / DA2 replies (private prefix, final 'c')
    '\\x1b\\[\\??[0-9;]*n',          // DSR replies (status / cursor-status, final 'n')
    '\\x1b\\[[0-9]+;[0-9]+R',        // Cursor Position Report (final 'R')
    '\\x1b\\[<[0-9]+;[0-9]+;[0-9]+[Mm]', // SGR mouse press/release
    '\\x1b\\[20[01]~',               // bracketed-paste open/close markers
  ].join('|'),
  'g',
);

function stripTerminalReports(data: string): string {
  return data.replace(TERMINAL_REPORT_PATTERN, '');
}

function updateTerminalInputDraft(draft: string, data: string): string {
  let next = draft;
  const cleaned = stripTerminalReports(data);
  for (const char of cleaned) {
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

// Last visible rows of the rendered buffer — used only as a menu backstop, not
// to decide draft emptiness (that stays byte-tracked). `translateToString(true)`
// trims trailing whitespace per row.
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

// A selected menu row: a TUI selection marker (❯ › ▶ ▸ — deliberately NOT the
// ASCII ">", which is a common markdown blockquote in agent output) followed by
// a numbered/lettered option, e.g. "❯ 2. Dark mode" or "› 1. Yes, continue".
// The idle composer (marker alone, or marker + dim placeholder like `Try "…"`)
// has no digit/letter-then-delimiter after the marker, so it does not match.
const MENU_SELECTION_ROW_RE = /^\s*[❯›▶▸]\s*[0-9a-z][.)]\s*\S/i;
// Footer hint that Enter confirms a selection rather than submits a prompt.
// Claude: "Enter to select · Esc to cancel"; Codex: "Press enter to continue".
// `\bpress enter\b` is intentionally broad — if it false-positives on agent
// prose containing that phrase, the only effect is forwarding Enter to the
// agent instead of navigating, which is a safe degrade (no menu choice lost).
const MENU_FOOTER_RE = /\benter to (?:select|continue|confirm|submit|choose)\b|\bpress enter\b/i;
const COMPOSER_ROW_RE = /^\s*[❯›](?:\s+(.*?))?\s*$/;
const COMPOSER_PLACEHOLDER_RE = /^Try\s+["“]|^[─━╌\-—]+$/i;

function looksLikeInteractiveMenu(tail: string): boolean {
  return tail.split('\n').some((line) => MENU_SELECTION_ROW_RE.test(line) || MENU_FOOTER_RE.test(line));
}

function looksLikeVisibleComposerDraft(tail: string): boolean {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = COMPOSER_ROW_RE.exec(lines[i] ?? '');
    if (!match) continue;
    const draft = match[1]?.trim() ?? '';
    return draft.length > 0 && !COMPOSER_PLACEHOLDER_RE.test(draft);
  }
  return false;
}

function shouldHandleEmptyTerminalEnter(
  draft: string,
  terminal: Terminal,
  onEmptySubmit?: () => void,
): boolean {
  // Emptiness stays byte-tracked (reliable across streaming/session switches) —
  // this preserves the prior draft-only navigation behavior exactly.
  if (draft.length !== 0 || !onEmptySubmit) return false;
  // Rendered-buffer backstops catch agent UI states that xterm's local draft
  // tracker cannot observe. If the agent is showing a selection menu
  // (Claude/Codex render these inline, so there is no terminal-mode signal —
  // only the marked numbered row and the "enter to select"/"press enter"
  // footer distinguish it), forward Enter so the highlighted choice is
  // confirmed instead of being swallowed as task navigation.
  const tail = getVisibleTerminalTail(terminal);
  if (looksLikeInteractiveMenu(tail)) return false;
  // Adapter-injected prompt text is not visible to xterm's local onData draft
  // tracker. If the composer visibly contains a user draft, forward Enter to
  // the agent instead of consuming it as empty-task navigation.
  if (looksLikeVisibleComposerDraft(tail)) return false;
  return true;
}

export function TerminalPanel({ tmuxName, visible, onEmptySubmit, onOpenFile }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const controllerRef = useRef<ReconnectingSocket | null>(null);
  const currentTmuxRef = useRef<string | null>(null);
  const terminalInputDraftRef = useRef('');
  const onEmptySubmitRef = useRef(onEmptySubmit);
  const onOpenFileRef = useRef(onOpenFile);
  const searchOpenRef = useRef(false);
  const visibleRef = useRef(visible);
  const lastSafePasteAtRef = useRef(0);
  const atBottomRef = useRef(true);
  const pendingJumpLinesRef = useRef(0);
  const jumpLatestTimerRef = useRef<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [jumpLatest, setJumpLatest] = useState<JumpLatestState>({ visible: false, lines: 0 });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchFound, setSearchFound] = useState<boolean | null>(null);
  const [searchResult, setSearchResult] = useState<ISearchResultChangeEvent | null>(null);

  function clearJumpLatestTimer() {
    if (jumpLatestTimerRef.current === null) return;
    window.clearTimeout(jumpLatestTimerRef.current);
    jumpLatestTimerRef.current = null;
  }

  function resetJumpLatest() {
    clearJumpLatestTimer();
    pendingJumpLinesRef.current = 0;
    atBottomRef.current = true;
    setJumpLatest((prev) => (
      prev.visible || prev.lines !== 0 ? { visible: false, lines: 0 } : prev
    ));
  }

  function hideJumpLatestAtBottom() {
    clearJumpLatestTimer();
    pendingJumpLinesRef.current = 0;
    setJumpLatest((prev) => (
      prev.visible || prev.lines !== 0 ? { visible: false, lines: 0 } : prev
    ));
  }

  function scheduleJumpLatest(lines: number) {
    if (lines <= 0 || atBottomRef.current) return;
    pendingJumpLinesRef.current += lines;
    if (jumpLatestTimerRef.current !== null) return;

    jumpLatestTimerRef.current = window.setTimeout(() => {
      jumpLatestTimerRef.current = null;
      const pending = pendingJumpLinesRef.current;
      pendingJumpLinesRef.current = 0;
      if (pending <= 0 || atBottomRef.current) return;
      setJumpLatest((prev) => ({ visible: true, lines: prev.lines + pending }));
    }, 80);
  }

  function syncAtBottom(terminal: Terminal): boolean {
    const atBottom = isTerminalAtBottom(terminal);
    atBottomRef.current = atBottom;
    if (atBottom) hideJumpLatestAtBottom();
    return atBottom;
  }

  function handleJumpToLatest() {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.scrollToBottom();
    resetJumpLatest();
    terminal.focus();
  }

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

  function registerVisibleTerminalSend() {
    const controller = controllerRef.current;
    if (!visibleRef.current || !controller?.isEstablished()) {
      registerTerminalSend(null);
      return;
    }
    registerTerminalSend((data) => {
      if (visibleRef.current) controllerRef.current?.send(data);
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
    onOpenFileRef.current = onOpenFile;
  }, [onOpenFile]);

  useEffect(() => {
    visibleRef.current = visible;
    registerVisibleTerminalSend();
    if (visible) return;

    searchOpenRef.current = false;
    setSearchOpen(false);
    setSearchFound(null);
    setSearchResult(null);
    searchAddonRef.current?.clearDecorations();
    setMenu(null);
    hideJumpLatestAtBottom();
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

    // Make viewable file paths in terminal output clickable -> open the file
    // viewer pane. WebLinksAddon (above) still owns http(s) URLs; this only adds
    // local file paths. Single-row matches only (no wrapped-line stitching).
    const fileLinkDisposable = terminal.registerLinkProvider({
      provideLinks(y, callback) {
        if (!onOpenFileRef.current) {
          callback(undefined);
          return;
        }
        const line = terminal.buffer.active.getLine(y - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links: ILink[] = [];
        VIEWABLE_FILE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = VIEWABLE_FILE_RE.exec(text)) !== null) {
          const matched = m[0];
          const startX = m.index;
          links.push({
            text: matched,
            // xterm ranges are 1-based and inclusive on both ends.
            range: { start: { x: startX + 1, y }, end: { x: startX + matched.length, y } },
            activate: (_e, t) => onOpenFileRef.current?.(t),
          });
          if (VIEWABLE_FILE_RE.lastIndex === m.index) VIEWABLE_FILE_RE.lastIndex++;
        }
        callback(links.length > 0 ? links : undefined);
      },
    });

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
    const scrollDisposable = terminal.onScroll(() => {
      syncAtBottom(terminal);
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

    // DOM keyboard events arrive before xterm's `onData`. Use that early
    // phase for paste fallback and empty-Enter navigation before xterm can
    // forward ambiguous bytes to the agent.
    function handleKeyDownCapture(e: KeyboardEvent) {
      if (
        e.type === 'keydown'
        && e.key.toLowerCase() === 'v'
        && (e.ctrlKey || e.metaKey)
        && !e.altKey
        && !e.isComposing
      ) {
        const keydownAt = Date.now();
        window.setTimeout(() => {
          if (lastSafePasteAtRef.current >= keydownAt) return;
          void pasteFromClipboard((text) => {
            if (isMultilinePaste(text)) sendSafePaste(text);
          });
        }, 0);
        return;
      }
      if (e.key !== 'Enter' || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      if (!shouldHandleEmptyTerminalEnter(
        terminalInputDraftRef.current,
        terminal,
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
      scrollDisposable.dispose();
      clearJumpLatestTimer();
      fileLinkDisposable.dispose();
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
    controllerRef.current?.send(payload);
  }

  /**
   * Route a paste through the server's bracketed-paste path (kookr #356):
   * one structured WS frame the SessionBridge turns into a single atomic
   * paste, instead of raw bytes whose newlines each submit a prompt.
   */
  function sendSafePaste(text: string) {
    lastSafePasteAtRef.current = Date.now();
    terminalInputDraftRef.current += text;
    sendOverWs(buildPasteFrame(text));
  }

  /**
   * Escape hatch: forward a paste verbatim as raw PTY bytes. Newlines act as
   * Enter submissions — intended for shell-style workflows where that is what
   * the user wants. Sent as a binary frame so the payload can never be
   * misread as a JSON control frame.
   */
  function sendRawPaste(text: string) {
    terminalInputDraftRef.current = updateTerminalInputDraft(terminalInputDraftRef.current, text);
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

  // Connect/reconnect the byte stream only while the terminal is visible.
  // Keeping hidden panes unsubscribed avoids replay capture and live PTY byte
  // fan-out for tasks the user is not currently inspecting.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const sessionChanged = tmuxName !== currentTmuxRef.current;

    if (sessionChanged) {
      searchOpenRef.current = false;
      terminalInputDraftRef.current = '';
      resetJumpLatest();
      setSearchOpen(false);
      setSearchTerm('');
      setSearchFound(null);
      setSearchResult(null);
      searchAddonRef.current?.clearDecorations();
    }

    if (!visible) {
      registerTerminalSend(null);
      return;
    }

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

    // The byte stream auto-reconnects (with backoff) when the server restarts
    // or the host drops offline, instead of leaving a frozen terminal behind.
    // Two close codes mean the session itself is finished and must NOT retry:
    // 1000 (clean close) and 1011 — SessionBridge's closeBridgeForFailure uses
    // 1011 when the backend session is gone/dead, and the upgrade handshake is
    // accepted before that liveness check runs, so retrying 1011 would loop
    // open→close forever on a pane showing an ended session. Server restarts
    // close with 1001/1006, which do retry.
    const SESSION_OVER_CLOSE_CODES = [1000, 1011];
    let hasConnectedOnce = false;
    let notifiedOutage = false;

    const controller = createReconnectingSocket<WebSocket>({
      createSocket: () => {
        const ws = new WebSocket(url);
        // v7 SessionBridge sends binary frames. Legacy TerminalBridge (tmux) sends
        // string frames. `arraybuffer` is accepted by xterm.js's `.write` for both
        // Uint8Array and ArrayBuffer, and string frames still arrive as strings
        // on `event.data` regardless — so this is forward-compatible with both.
        ws.binaryType = 'arraybuffer';
        return ws;
      },
      shouldReconnect: (event) => !SESSION_OVER_CLOSE_CODES.includes(event.code ?? -1),
      backoff: { initialDelayMs: 1_000, maxDelayMs: 10_000 },
      onOpen: (ws) => {
        // The server replays the session's ring buffer on every connect, so a
        // reconnect must reset the terminal first or the replayed scrollback
        // would be appended twice.
        if (hasConnectedOnce) {
          terminal.reset();
        }
        hasConnectedOnce = true;
        notifiedOutage = false;
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
      },
      // Register send function so global shortcuts can write only when this
      // terminal is actually visible. Done here rather than in onOpen because
      // the connection counts as established only after onOpen returns.
      onEstablished: () => {
        registerVisibleTerminalSend();
      },
      onMessage: (event) => {
        const atBottomBeforeWrite = syncAtBottom(terminal);
        const newLineCount = atBottomBeforeWrite ? 0 : countTerminalNewLines(event.data);
        // Binary frames arrive as ArrayBuffer (because ws.binaryType = 'arraybuffer'
        // above). Convert to Uint8Array for byte-exact handoff to xterm.js — its
        // .write() accepts both Uint8Array and string. String frames (from the
        // legacy TerminalBridge path) pass through unchanged.
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          terminal.write(bytes);
        } else if (typeof event.data === 'string') {
          terminal.write(event.data);
        }
        scheduleJumpLatest(newLineCount);
      },
      onClose: (event, { wasEstablished }) => {
        registerTerminalSend(null);
        if (SESSION_OVER_CLOSE_CODES.includes(event.code ?? -1)) {
          // The PTY exited or the backend session is gone — show feedback.
          terminal.write('\r\n\x1b[90m  Session ended.\x1b[0m\r\n');
        } else if (!notifiedOutage) {
          // Say it once per outage; retries continue silently in the background.
          notifiedOutage = true;
          terminal.write(wasEstablished
            ? '\r\n\x1b[90m  Terminal connection lost — reconnecting…\x1b[0m\r\n'
            : '\r\n\x1b[90m  Could not connect to terminal — retrying…\x1b[0m\r\n');
        }
      },
    });
    controllerRef.current = controller;
    controller.start();

    // Terminal input → WebSocket
    const inputDisposable = terminal.onData((data) => {
      if (!visibleRef.current) return;
      if (
        data === '\r'
        && shouldHandleEmptyTerminalEnter(
          terminalInputDraftRef.current,
          terminal,
          onEmptySubmitRef.current,
        )
      ) {
        onEmptySubmitRef.current();
        return;
      }
      terminalInputDraftRef.current = updateTerminalInputDraft(terminalInputDraftRef.current, data);
      controller.send(data);
    });

    // Terminal resize → WebSocket
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!visibleRef.current) return;
      const resize = getValidatedResize(cols, rows);
      if (resize) {
        controller.send(JSON.stringify({ type: 'resize', cols: resize.cols, rows: resize.rows }));
      }
    });

    return () => {
      registerTerminalSend(null);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      controller.stop();
      controllerRef.current = null;
    };
  }, [tmuxName, visible]);

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
      if (resize) {
        controllerRef.current?.send(JSON.stringify({ type: 'resize', cols: resize.cols, rows: resize.rows }));
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
      {jumpLatest.visible && (
        <button
          type="button"
          className="terminal-search-btn"
          onClick={handleJumpToLatest}
          aria-label={`${jumpLatest.lines} new ${jumpLatest.lines === 1 ? 'line' : 'lines'}, jump to latest`}
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            zIndex: 45,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 10px',
            background: 'rgba(15, 17, 23, 0.96)',
            border: '1px solid var(--border)',
            borderRadius: 999,
            color: 'var(--text-bright)',
            boxShadow: '0 8px 18px rgba(0, 0, 0, 0.35)',
          }}
        >
          <span aria-hidden="true">⌄</span>
          {jumpLatest.lines} new {jumpLatest.lines === 1 ? 'line' : 'lines'}, jump to latest
        </button>
      )}
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
