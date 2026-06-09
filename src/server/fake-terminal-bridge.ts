import type { WebSocket } from 'ws';
import type { TerminalInputWriterPort } from '../core/ports/terminal-input-writer-port.js';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
} from './session-bridge.js';

const encoder = new TextEncoder();

/**
 * A fake terminal bridge that streams pre-scripted ANSI content to xterm.js
 * instead of spawning `tmux attach`. Used in E2E tests and demo mode where
 * no real tmux sessions exist.
 *
 * Supports two display modes:
 *   - **instant**: Dump all content at once (for blocked/stopped agents whose
 *     terminal output is already complete)
 *   - **streaming**: Stream line-by-line at a configurable speed (for healthy
 *     agents actively working — conveys "this agent is running")
 *
 * WebSocket protocol matches TerminalBridge:
 *   Browser → Server: raw text (keystrokes) or JSON { type: 'resize', cols, rows }
 *   Server → Browser: raw text (terminal output with ANSI escape codes)
 */

export interface FakeTerminalContent {
  text: string;
  /** 'instant' dumps everything at once; 'streaming' sends line-by-line. Default: 'streaming'. */
  mode?: 'instant' | 'streaming';
  /** Milliseconds between lines when streaming. Default: 150. Lower = faster. */
  lineDelayMs?: number;
  /** Whether to loop back to the start after finishing. Default: false. */
  loop?: boolean;
}

/** Construction options for {@link FakeTerminalBridge}. */
export interface FakeTerminalBridgeOptions {
  /**
   * When true the bridge is **output-only**: the inbound `ws.on('message')`
   * handler is never registered, so no keystroke, resize, or paste frame reaches
   * the fake backend (kookr #807, read-only shared view). Mirrors
   * {@link SessionBridgeOptions.readOnly} so E2E/demo viewer sockets exercise the
   * same write-suppression path as the real bridge. Default: false.
   */
  readOnly?: boolean;
}

export class FakeTerminalBridge {
  private lines: string[];
  private lineIndex = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private mode: 'instant' | 'streaming';
  private lineDelayMs: number;
  private loop: boolean;
  private readOnly: boolean;

  constructor(
    private tmuxName: string,
    private ws: WebSocket,
    opts?: FakeTerminalContent,
    private inputWriter?: TerminalInputWriterPort,
    options?: FakeTerminalBridgeOptions,
  ) {
    const resolved = opts ?? FakeTerminalBridge.getContent(tmuxName);
    const text = resolved?.text ?? FakeTerminalBridge.defaultContent(tmuxName);
    this.lines = text.split('\n');
    this.mode = resolved?.mode ?? 'streaming';
    this.lineDelayMs = resolved?.lineDelayMs ?? 150;
    this.loop = resolved?.loop ?? false;
    this.readOnly = options?.readOnly ?? false;
  }

  /** Start displaying content. */
  start(cols = 120, rows = 40): void {
    // Clear screen, cursor home
    this.sendRaw('\x1b[2J\x1b[H');

    if (this.mode === 'instant') {
      // Dump everything at once — agent is blocked, output is frozen
      this.sendRaw(this.lines.join('\r\n'));
    } else {
      // Stream line-by-line — agent is actively working
      this.interval = setInterval(() => {
        if (this.lineIndex >= this.lines.length) {
          if (this.loop) {
            // Reset and replay
            this.lineIndex = 0;
            this.sendRaw('\x1b[2J\x1b[H');
            return;
          }
          if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
          }
          return;
        }

        const line = this.lines[this.lineIndex++];
        this.sendRaw(line + '\r\n');
      }, this.lineDelayMs);
    }

    // Handle incoming messages. The fake bridge is display-oriented, but E2E
    // tests still need browser terminal input to reach FakeTerminalBackend so
    // they can assert on the same byte path as SessionBridge.
    //
    // Read-only (viewer) bridges skip wiring this handler entirely, so no
    // keystroke/resize/paste reaches the fake backend (#807). Output streaming
    // above is unaffected.
    if (!this.readOnly) {
      this.ws.on('message', (data) => {
        const msg = data.toString();
        if (msg.startsWith('{"type":"resize"')) {
          // Acknowledge resize but don't act on it
          return;
        }
        if (msg.startsWith('{"type":"paste"')) {
          try {
            const parsed = JSON.parse(msg) as { type?: unknown; text?: unknown };
            if (parsed.type === 'paste' && typeof parsed.text === 'string') {
              const sanitized = parsed.text
                .replaceAll(BRACKETED_PASTE_START, '')
                .replaceAll(BRACKETED_PASTE_END, '');
              this.forwardInput(BRACKETED_PASTE_START + sanitized + BRACKETED_PASTE_END);
            }
          } catch {
            // Treat malformed paste control frames as raw input.
            this.forwardInput(msg);
          }
          return;
        }
        this.forwardInput(data instanceof Buffer ? new Uint8Array(data) : msg);
      });
    }

    this.ws.on('close', () => {
      this.dispose();
    });
  }

  private forwardInput(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    this.inputWriter?.writeInput(this.tmuxName, bytes, { reason: 'fake-browser-terminal-input' })
      .catch(() => {
        // Fake bridge is test/demo support. Keep display streaming even if the
        // backing fake session was reset between websocket connect and input.
      });
  }

  /** Send raw text to the xterm.js client. */
  private sendRaw(data: string): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(data);
    }
  }

  /** Clean up timers. */
  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Per-session content registry
  // ---------------------------------------------------------------------------

  private static contentMap = new Map<string, FakeTerminalContent>();

  static setContent(tmuxName: string, content: FakeTerminalContent): void {
    FakeTerminalBridge.contentMap.set(tmuxName, content);
  }

  static getContent(tmuxName: string): FakeTerminalContent | undefined {
    return FakeTerminalBridge.contentMap.get(tmuxName);
  }

  static clearContent(): void {
    FakeTerminalBridge.contentMap.clear();
  }

  /** Fallback content when none is registered for a session. */
  static defaultContent(tmuxName: string): string {
    const R = '\x1b[0m';
    const B = '\x1b[1m';
    const D = '\x1b[2m';
    const C = '\x1b[36m';
    const G = '\x1b[32m';
    const W = '\x1b[37m';
    const GR = '\x1b[90m';

    return [
      `${D}╭──────────────────────────────────────────────────────────╮${R}`,
      `${D}│${R} ${B}${C}Claude Code${R} ${D}(claude-sonnet-4-6)${R}${D}                           │${R}`,
      `${D}╰──────────────────────────────────────────────────────────╯${R}`,
      ``,
      `${B}${W}> ${R}${G}Read${R} ${D}src/index.ts${R}`,
      ``,
      `${GR}  1 │${R} // Application entry point`,
      `${GR}  2 │${R} import { start } from './server.js';`,
      `${GR}  3 │${R} start();`,
      ``,
    ].join('\n');
  }
}
