#!/usr/bin/env python3
"""A more realistic alt-screen TUI that mimics Claude Code's scroll situation.

Behaviors:
  - enters alt-screen (1049)
  - does NOT enable mouse reporting (matches real Claude Code / Codex CLI)
  - draws a scrollable "conversation" (50 numbered lines)
  - tracks a viewport offset
  - handles Up/Down/PgUp/PgDn/ESC [A/B to scroll the viewport
  - logs every keystroke to $TEST_APP_LOG so tests can verify what arrived

This reproduces the actual pain: a keyboard-driven TUI in alt-screen with
content that doesn't fit the viewport. The question under test is: when the
user scrolls with the mouse wheel, does ANYTHING scroll the conversation?

  - With tmux or dtach byte-transparent: wheel hits xterm.js; xterm.js may or
    may not translate to arrow keys; may or may not reach us.
  - With a Kookr-side shim: wheel -> up/down keys synthesized.

The log file records every input byte sequence received so we can measure.
"""
import os
import signal
import sys
import tty
import termios


def main() -> int:
    log_path = os.environ.get("TEST_APP_LOG")
    if not log_path:
        print("TEST_APP_LOG env var required", file=sys.stderr)
        return 2

    log = open(log_path, "w", buffering=1)
    log.write(f"STARTED pid={os.getpid()}\n")

    TOTAL_LINES = 50
    VIEWPORT = 20
    offset = 0  # top line visible

    def draw():
        sys.stdout.write("\x1b[H\x1b[2J")  # home + clear
        sys.stdout.write(
            f"=== Mock Claude conversation (offset={offset}/{TOTAL_LINES-VIEWPORT})\r\n"
        )
        for i in range(VIEWPORT):
            ln = offset + i
            if ln < TOTAL_LINES:
                sys.stdout.write(f"line {ln:02d}: conversation text goes here...\r\n")
        sys.stdout.write("\x1b[H")
        sys.stdout.flush()

    # Alt-screen, NO mouse modes (matches real agents).
    sys.stdout.write("\x1b[?1049h")
    sys.stdout.flush()
    draw()
    sys.stdout.write("READY\r\n")
    sys.stdout.flush()

    def repaint_on_winch(*_a):
        draw()

    signal.signal(signal.SIGWINCH, repaint_on_winch)

    fd_in = sys.stdin.fileno()
    try:
        old_attr = termios.tcgetattr(fd_in)
    except Exception:
        old_attr = None
    try:
        tty.setraw(fd_in)
    except Exception as e:
        log.write(f"WARN setraw failed: {e}\n")

    stopping = {"flag": False}

    def stop(*_a):
        stopping["flag"] = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    buf = b""
    try:
        while not stopping["flag"]:
            try:
                chunk = os.read(fd_in, 1024)
            except InterruptedError:
                continue
            except Exception as e:
                log.write(f"READ_ERR {e}\n")
                break
            if not chunk:
                log.write("EOF_STDIN\n")
                break
            buf += chunk
            log.write(f"RX {chunk!r}\n")

            # Handle common scroll keys. Accept both normal and application
            # cursor forms (ESC [ A vs ESC O A).
            while buf:
                matched = False
                for seq, action in [
                    (b"\x1b[A", "UP"),
                    (b"\x1b[B", "DOWN"),
                    (b"\x1bOA", "UP"),
                    (b"\x1bOB", "DOWN"),
                    (b"\x1b[5~", "PGUP"),
                    (b"\x1b[6~", "PGDN"),
                    (b"\x1bv", "PGUP"),
                    (b"\x16", "PGDN"),  # Ctrl-V
                    (b"k", "UP"),
                    (b"j", "DOWN"),
                    (b"q", "QUIT"),
                ]:
                    if buf.startswith(seq):
                        if action == "UP":
                            offset = max(0, offset - 1)
                            draw()
                            log.write(f"ACTION UP -> offset={offset}\n")
                        elif action == "DOWN":
                            offset = min(TOTAL_LINES - VIEWPORT, offset + 1)
                            draw()
                            log.write(f"ACTION DOWN -> offset={offset}\n")
                        elif action == "PGUP":
                            offset = max(0, offset - VIEWPORT)
                            draw()
                            log.write(f"ACTION PGUP -> offset={offset}\n")
                        elif action == "PGDN":
                            offset = min(TOTAL_LINES - VIEWPORT, offset + VIEWPORT)
                            draw()
                            log.write(f"ACTION PGDN -> offset={offset}\n")
                        elif action == "QUIT":
                            log.write("ACTION QUIT\n")
                            stopping["flag"] = True
                            break
                        buf = buf[len(seq):]
                        matched = True
                        break
                if not matched:
                    # Drop the first byte so a stray byte doesn't wedge us.
                    buf = buf[1:]
    finally:
        try:
            if old_attr is not None:
                termios.tcsetattr(fd_in, termios.TCSADRAIN, old_attr)
        except Exception:
            pass
        sys.stdout.write("\x1b[?1049l")
        sys.stdout.flush()
        log.write(f"EXITING offset={offset}\n")
        log.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
