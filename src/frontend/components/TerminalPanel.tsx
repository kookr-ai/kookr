import React, { useEffect, useRef, useState } from 'react';
import { Terminal, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useKookrStore } from '../store/useStore.js';
import { registerTerminalSend } from '../terminal-send.js';
import { isMultilinePaste } from '../terminal-paste.js';
import { TERMINAL_V2_PROTOCOL } from '../../shared/terminal-protocol.js';
import { createTerminalStreamClient, type TerminalStreamClient, type TerminalContinuity,
  type TerminalStreamState, type TerminalRetryBudget } from '../terminal-stream-client.js';
import { createTerminalWriter } from '../terminal-writer.js';
import { createTerminalFitScheduler } from '../terminal-fit.js';
import { createTerminalLineCounter } from '../terminal-line-counter.js';
import { createTerminalScrollbackGuard } from '../terminal-scrollback.js';
import { track } from '../telemetry.js';
import { installTerminalRenderer, type InstalledTerminalRenderer } from '../terminal-renderer.js';
import { createTerminalWheelScroller, type TerminalWheelScroller } from '../terminal-wheel.js';
import {
  looksLikeInteractiveMenu,
  looksLikeVisibleComposerDraft,
  updateTerminalInputDraft,
} from '../terminal-input-draft.js';
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  usePersistedTerminalFontSize,
} from '../hooks/usePersistedTerminalFontSize.js';

interface Props {
  tmuxName: string | null;
  visible: boolean;
  /**
   * When set to an absolute-position TUI agent (Grok Build), the panel pins
   * xterm columns to the agent's paint width (~200) with horizontal scroll
   * instead of FitAddon-shrinking to the container. Grok paints CUP cells out
   * near col 180–200 regardless of a short FitAddon width; fitting to ~70–100
   * cols leaves the browser pane nearly blank (only left-edge chrome).
   */
  agentType?: string | null;
  onEmptySubmit?: () => void;
  /** Click handler for a viewable file path detected in terminal output. */
  onOpenFile?: (path: string) => void;
}

/** Grok Build (and similar absolute-position TUIs) paint near this width. */
const ABSOLUTE_TUI_COLS = 200;

function usesAbsoluteTuiGeometry(agentType: string | null | undefined): boolean {
  return agentType === 'grok-build';
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

function getValidatedResize(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (typeof cols !== 'number' || typeof rows !== 'number') return null;
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

export const TerminalPanel = React.memo(function TerminalPanel({ tmuxName, visible, agentType, onEmptySubmit, onOpenFile }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const writerRef = useRef<ReturnType<typeof createTerminalWriter> | null>(null);
  const continuityRef = useRef<TerminalContinuity>({ cursor: null, hadView: false });
  const retryBudgetRef = useRef<TerminalRetryBudget>({ attempts: [] });
  const [terminalRevision, setTerminalRevision] = useState(0);
  const [streamState, setStreamState] = useState<TerminalStreamState>({ kind: 'negotiating' });
  const [historyDiscarded, setHistoryDiscarded] = useState(false);
  const rendererRef = useRef<InstalledTerminalRenderer | null>(null);
  const wheelScrollerRef = useRef<TerminalWheelScroller | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const fitSchedulerRef = useRef<ReturnType<typeof createTerminalFitScheduler> | null>(null);
  const lineCounterRef = useRef(createTerminalLineCounter());
  const absoluteTuiRef = useRef(usesAbsoluteTuiGeometry(agentType));
  absoluteTuiRef.current = usesAbsoluteTuiGeometry(agentType);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const controllerRef = useRef<TerminalStreamClient | null>(null);
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
  const [terminalFontSize, setTerminalFontSize] = usePersistedTerminalFontSize();
  /**
   * R3: block terminal send and show pending chrome until the new session's
   * complete parsed seed (wrong-agent mitigation during retained-screen attach).
   */
  const [attachPending, setAttachPending] = useState(false);
  const attachPendingRef = useRef(false);

  function clearJumpLatestTimer() {
    if (jumpLatestTimerRef.current === null) return;
    window.clearTimeout(jumpLatestTimerRef.current);
    jumpLatestTimerRef.current = null;
  }

  function resetJumpLatest() {
    lineCounterRef.current.reset();
    clearJumpLatestTimer();
    pendingJumpLinesRef.current = 0;
    atBottomRef.current = true;
    setJumpLatest((prev) => (
      prev.visible || prev.lines !== 0 ? { visible: false, lines: 0 } : prev
    ));
  }

  function hideJumpLatestAtBottom() {
    lineCounterRef.current.reset();
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
    if (!visibleRef.current || !controller?.isEstablished() || attachPendingRef.current) {
      registerTerminalSend(null);
      return;
    }
    registerTerminalSend((data) => {
      if (!visibleRef.current || attachPendingRef.current) return;
      controllerRef.current?.sendInput(data);
    });
  }

  function markAttachPending(pending: boolean) {
    attachPendingRef.current = pending;
    setAttachPending(pending);
  }

  /**
   * Resolve the size to apply/send. Absolute-position TUIs (Grok) keep a
   * pinned column count so CUP cells land on-screen; FitAddon only drives rows.
   */
  function resolveTerminalSize(dims: { cols: number; rows: number } | undefined | null): { cols: number; rows: number } | null {
    if (!dims) return null;
    if (absoluteTuiRef.current) {
      return getValidatedResize(ABSOLUTE_TUI_COLS, dims.rows);
    }
    return getValidatedResize(dims.cols, dims.rows);
  }

  function refitRefreshAndNotifyResize() {
    fitSchedulerRef.current?.request(true);
  }

  function handleTerminalFontSizeShortcut(e: KeyboardEvent): boolean {
    if (!visibleRef.current || e.type !== 'keydown' || e.altKey || !(e.ctrlKey || e.metaKey)) {
      return false;
    }
    if (e.key === '+' || e.key === '=') {
      setTerminalFontSize((current) => current + 1);
    } else if (e.key === '-' || e.key === '_') {
      setTerminalFontSize((current) => current - 1);
    } else if (e.key === '0') {
      setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
    } else {
      return false;
    }

    e.preventDefault();
    e.stopPropagation();
    return true;
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
      fontSize: terminalFontSize,
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
      if (handleTerminalFontSizeShortcut(e)) return false;
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
    const renderer = installTerminalRenderer(terminal, {
      onChange: (status) => track({ type: 'terminal_renderer_changed', ...status }),
    });
    rendererRef.current = renderer;

    const fitScheduler = createTerminalFitScheduler({
      canFit: () => visibleRef.current
        && (!continuityRef.current.hadView || !!controllerRef.current?.isEstablished()),
      getDimensions: () => resolveTerminalSize(fitAddon.proposeDimensions()),
      getCurrentDimensions: () => ({ cols: terminal.cols, rows: terminal.rows }),
      resize: (cols, rows) => terminal.resize(cols, rows),
      refresh: () => { if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1); },
    });
    fitSchedulerRef.current = fitScheduler;
    fitScheduler.flush();

    terminalRef.current = terminal;
    const scrollbackGuard = createTerminalScrollbackGuard(terminal, () => setHistoryDiscarded(true));
    const writer = createTerminalWriter({
      terminal: {
        write: (bytes, done) => terminal.write(bytes, done),
        reset: () => {
          scrollbackGuard.reset();
          setHistoryDiscarded(false);
          terminal.reset();
        },
      },
      onStall: () => {
        controllerRef.current?.stop();
        continuityRef.current.cursor = null;
        continuityRef.current.hadView = true;
        setTerminalRevision((revision) => revision + 1);
      },
    });
    writerRef.current = writer;
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
      scrollbackGuard.viewportChanged();
    });
    const selectionDisposable = terminal.onSelectionChange(() => scrollbackGuard.selectionChanged());

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
    const wheelScroller = createTerminalWheelScroller({
      getViewport: () => ({
        rows: terminal.rows,
        viewportY: terminal.buffer.active.viewportY,
        baseY: terminal.buffer.active.baseY,
      }),
      scrollLines: (lines) => terminal.scrollLines(lines),
    });
    wheelScrollerRef.current = wheelScroller;
    function handleWheelOverride(e: WheelEvent) {
      if (visibleRef.current) wheelScroller.handleWheel(e);
      e.stopImmediatePropagation();
      e.preventDefault();
    }
    container.addEventListener('wheel', handleWheelOverride, {
      capture: true,
      passive: false,
    });

    // Handle container resize
    const resizeObserver = new ResizeObserver(() => {
      fitScheduler.request();
    });
    resizeObserver.observe(container);

    return () => {
      container.removeEventListener('focusin', handleTermFocus);
      container.removeEventListener('focusout', handleTermBlur);
      container.removeEventListener('wheel', handleWheelOverride, { capture: true });
      wheelScroller.dispose();
      wheelScrollerRef.current = null;
      container.removeEventListener('contextmenu', handleContextMenu);
      container.removeEventListener('paste', handlePasteCapture, { capture: true });
      container.removeEventListener('keydown', handleKeyDownCapture, { capture: true });
      resizeObserver.disconnect();
      fitScheduler.dispose();
      fitSchedulerRef.current = null;
      searchResultDisposable.dispose();
      scrollDisposable.dispose();
      selectionDisposable.dispose();
      scrollbackGuard.dispose();
      renderer.dispose();
      rendererRef.current = null;
      clearJumpLatestTimer();
      fileLinkDisposable.dispose();
      writer.dispose();
      writerRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [terminalRevision]);

  useEffect(() => {
    wheelScrollerRef.current?.reset();
    return () => wheelScrollerRef.current?.reset();
  }, [tmuxName, visible]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = terminalFontSize;
    refitRefreshAndNotifyResize();
  }, [terminalFontSize, terminalRevision]);

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

  /**
   * Route a paste through the server's bracketed-paste path (kookr #356):
   * one structured WS frame the SessionBridge turns into a single atomic
   * paste, instead of raw bytes whose newlines each submit a prompt.
   */
  function sendSafePaste(text: string) {
    if (controllerRef.current?.paste(text)) {
      lastSafePasteAtRef.current = Date.now();
      terminalInputDraftRef.current += text;
    }
  }

  /**
   * Escape hatch: forward a paste verbatim as raw PTY bytes. Newlines act as
   * Enter submissions — intended for shell-style workflows where that is what
   * the user wants. Sent as a binary frame so the payload can never be
   * misread as a JSON control frame.
   */
  function sendRawPaste(text: string) {
    if (controllerRef.current?.sendInput(new TextEncoder().encode(text))) {
      terminalInputDraftRef.current = updateTerminalInputDraft(terminalInputDraftRef.current, text);
    }
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
    const controller = controllerRef.current;
    if (!visibleRef.current || !controller?.isEstablished()) return;
    try {
      const text = await navigator.clipboard.readText();
      // Clipboard permission prompts can outlive a selection change. Never send
      // their result to the newly selected agent, even if it is already ready.
      if (text && visibleRef.current && controllerRef.current === controller
        && controller.isEstablished()) route(text);
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

  // One protocol owner per selected, visible terminal. The writer itself lives
  // with xterm, so a previous socket's parser must drain before replacement.
  useEffect(() => {
    const terminal = terminalRef.current;
    const writer = writerRef.current;
    if (!terminal || !writer) return;
    const previousSessionId = currentTmuxRef.current;
    const sessionChanged = tmuxName !== previousSessionId;
    if (sessionChanged) {
      continuityRef.current = { cursor: null, hadView: false };
      retryBudgetRef.current = { attempts: [] };
      terminalInputDraftRef.current = '';
      resetJumpLatest();
      searchOpenRef.current = false;
      setSearchOpen(false);
      setSearchTerm('');
      setSearchFound(null);
      setSearchResult(null);
      searchAddonRef.current?.clearDecorations();
      currentTmuxRef.current = tmuxName;
    }
    if (!visible || !tmuxName) {
      registerTerminalSend(null);
      markAttachPending(false);
      if (!tmuxName) writer.begin().barrier(() => {});
      return;
    }

    const continuity = continuityRef.current;
    // A retained parser must keep its dimensions until the resume decision.
    if (!continuity.hadView) fitSchedulerRef.current?.flush();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/terminal/${encodeURIComponent(tmuxName)}`;
    const renderer = rendererRef.current;
    const controller = createTerminalStreamClient({
      writer, continuity, retryBudget: retryBudgetRef.current,
      createSocket: () => new WebSocket(url, TERMINAL_V2_PROTOCOL),
      getSize: () => getValidatedResize(terminal.cols, terminal.rows)
        ?? resolveTerminalSize(fitAddonRef.current?.proposeDimensions())
        ?? { cols: 80, rows: 24 },
      onState: (next) => {
        setStreamState(next);
        markAttachPending(next.kind !== 'live');
        registerVisibleTerminalSend();
        if (next.kind === 'live') fitSchedulerRef.current?.request(true);
      },
      onOutput: (bytes) => {
        const atBottom = syncAtBottom(terminal);
        scheduleJumpLatest(atBottom ? 0 : lineCounterRef.current.count(bytes));
      },
      getMetadata: () => ({
        fromSessionId: previousSessionId, toSessionId: tmuxName, agentType: agentType ?? null,
        clientWarm: continuity.hadView, warmLabel: continuity.hadView ? 'warm' : 'cold',
        renderer: renderer?.renderer ?? 'dom', rendererFallback: renderer?.fallbackReason ?? null,
      }),
      onTelemetry: track,
    });
    controllerRef.current = controller;
    controller.start();

    const inputDisposable = terminal.onData((data) => {
      if (!visibleRef.current) return;
      if (data === '\r' && shouldHandleEmptyTerminalEnter(
        terminalInputDraftRef.current, terminal, onEmptySubmitRef.current,
      )) {
        onEmptySubmitRef.current?.();
        return;
      }
      if (!controller.isEstablished()) return;
      if (controller.sendInput(data)) {
        terminalInputDraftRef.current = updateTerminalInputDraft(terminalInputDraftRef.current, data);
      }
    });

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!visibleRef.current) return;
      const size = getValidatedResize(cols, rows);
      if (!size) return;
      controller.resize(size.cols, size.rows);
    });
    return () => {
      registerTerminalSend(null);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      controller.stop();
      controllerRef.current = null;
    };
  }, [tmuxName, visible, terminalRevision]);

  // Refit + repaint when the parent explicitly reveals the terminal. Driving
  // this from the real pane/tab state is more reliable than observing
  // intersections after ancestor display:none toggles. The refresh() call is
  // load-bearing: xterm keeps its old canvas across a display:none cycle, so
  // Codex's static screen stays stale until fresh bytes arrive unless we
  // force a redraw of the retained buffer.
  useEffect(() => {
    if (!visible) return;
    refitRefreshAndNotifyResize();
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
      {historyDiscarded && (
        <div className="terminal-history-notice" role="status">
          Older terminal lines were discarded.
          <button type="button" onClick={() => setHistoryDiscarded(false)} aria-label="Dismiss discarded history notice">×</button>
        </div>
      )}
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
      <div
        className={`terminal-xterm${usesAbsoluteTuiGeometry(agentType) ? ' terminal-xterm--absolute-tui' : ''}`}
        ref={containerRef}
      />
      {attachPending && (
        <div
          className={`terminal-attach-pending${streamState.kind === 'negotiating' || streamState.kind === 'seeding' ? '' : ' terminal-attach-notice'}`}
          role="status"
          aria-live="polite"
          data-testid="terminal-attach-pending"
        >
          {streamState.kind === 'negotiating' ? 'Connecting to session…'
            : streamState.kind === 'seeding' ? 'Preparing terminal — input paused…'
              : streamState.kind === 'lagged' ? 'Terminal view fell behind. Only this view was disconnected.'
                : streamState.kind === 'continuity-unavailable' ? 'Some output could not be recovered. Start a new view to continue.'
                  : streamState.kind === 'incompatible' ? 'Terminal protocol changed. Reload Kookr.'
                    : streamState.kind === 'access-denied' ? 'Terminal access denied.'
                      : streamState.kind === 'ended' ? 'Session ended.'
                        : streamState.kind === 'suspended' ? 'Terminal view paused while this tab is hidden.'
                          : 'Terminal connection unavailable.'}
          {(streamState.kind === 'lagged' || streamState.kind === 'continuity-unavailable' || streamState.kind === 'unavailable') && (
            <button type="button" onClick={() => controllerRef.current?.retry(
              streamState.kind === 'continuity-unavailable' || !continuityRef.current.cursor,
            )}>
              {streamState.kind === 'continuity-unavailable' || !continuityRef.current.cursor ? 'Start a new view' : 'Reconnect terminal'}
            </button>
          )}
          {streamState.kind === 'incompatible' && <button type="button" onClick={() => window.location.reload()}>Reload Kookr</button>}
        </div>
      )}
      {!tmuxName && <div className="terminal-attach-pending terminal-attach-notice" role="status">Select an agent to view its terminal.</div>}
      {!attachPending && streamState.approximate && <div className="terminal-attach-pending terminal-attach-notice" role="status">Some earlier terminal output is unavailable.</div>}
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
});
