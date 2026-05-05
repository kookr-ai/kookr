#!/usr/bin/env python3
"""Stand-in for a mouse-aware TUI (like Claude Code).

On start:
  - enters alt-screen
  - enables DECSET mouse reporting (1000 normal tracking + 1002 button-event + 1006 SGR extended coordinates)
  - writes "READY" to stdout (visible in xterm.js) so tests can wait for mode enable

On stdin:
  - parses incoming bytes for SGR mouse sequences (CSI < ... M/m)
  - also parses legacy-format mouse (CSI M ...) just in case
  - appends each parsed event as one line to $TEST_APP_LOG

On SIGTERM / stdin close / SIGWINCH alt-screen exit: writes EXITING and quits.

The log file is the ground truth for the POC:
    MOUSE wheel_up col=<C> row=<R> mode=sgr
means the byte stream for a mousewheel-up CSI arrived at this process's
controlling PTY. That is the end-to-end assertion the Playwright test makes.
"""
import os
import re
import signal
import sys
import tty
import termios
import time


def main() -> int:
    log_path = os.environ.get("TEST_APP_LOG")
    if not log_path:
        print("TEST_APP_LOG env var required", file=sys.stderr)
        return 2

    log = open(log_path, "w", buffering=1)  # line-buffered
    log.write(f"STARTED pid={os.getpid()} time={time.time()}\n")

    # Enter alt-screen, enable mouse reporting (three modes so xterm.js
    # recognizes any of them; SGR 1006 is what xterm.js should emit).
    sys.stdout.write("\x1b[?1049h")
    sys.stdout.write("\x1b[?1000h")  # X11 mouse reporting
    sys.stdout.write("\x1b[?1002h")  # button-event tracking
    sys.stdout.write("\x1b[?1006h")  # SGR extended mode
    sys.stdout.write("READY\r\n")
    sys.stdout.flush()
    log.write("READY — alt-screen + mouse 1000/1002/1006 enabled\n")

    # Put stdin in raw mode so bytes arrive immediately and are not line-buffered.
    fd_in = sys.stdin.fileno()
    try:
        old_attr = termios.tcgetattr(fd_in)
    except Exception:
        old_attr = None
    try:
        tty.setraw(fd_in)
    except Exception as e:
        log.write(f"WARN setraw failed: {e}\n")

    # Repaint READY on SIGWINCH so alt-screen-aware backends (dtach -r winch)
    # redraw after a fresh attach — this mimics what real TUIs like Claude Code
    # do. Without this, pre-attach output is invisible to the first client.
    def repaint_on_winch(*_a):
        # Re-enable mouse modes on every SIGWINCH so clients that attach
        # AFTER the child already emitted them (the dtach case) pick them up.
        sys.stdout.write(
            "\x1b[?1000h\x1b[?1002h\x1b[?1006h"
            "\x1b[H\x1b[2JREADY\r\n"
        )
        sys.stdout.flush()

    signal.signal(signal.SIGWINCH, repaint_on_winch)

    # SGR mouse: CSI < button;col;row (M=press/wheel, m=release)
    sgr_re = re.compile(rb"\x1b\[<(\d+);(\d+);(\d+)([Mm])")
    # Legacy mouse: CSI M <btn+32> <col+32> <row+32>  (one escape + 'M' + 3 raw bytes)
    legacy_re = re.compile(rb"\x1b\[M(.)(.)(.)", re.DOTALL)

    def deadline_hit(buf: bytes) -> bool:
        return b"QUIT" in buf

    def button_name(btn: int) -> str:
        # SGR 1006 encoding:
        #   0=left, 1=middle, 2=right, 3=release (in legacy only)
        #   64=wheel up, 65=wheel down, 66=wheel left, 67=wheel right
        if btn == 64:
            return "wheel_up"
        if btn == 65:
            return "wheel_down"
        if btn == 0:
            return "left"
        if btn == 1:
            return "middle"
        if btn == 2:
            return "right"
        return f"btn{btn}"

    buf = b""
    # Graceful stop on SIGTERM.
    stopping = {"flag": False}

    def stop(*_a):
        stopping["flag"] = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

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
                # EOF — stdin closed
                log.write("EOF_STDIN\n")
                break
            buf += chunk

            # Try SGR first.
            progressed = True
            while progressed:
                progressed = False
                m = sgr_re.search(buf)
                if m:
                    btn = int(m.group(1))
                    col = int(m.group(2))
                    row = int(m.group(3))
                    tail = m.group(4).decode()
                    log.write(
                        f"MOUSE {button_name(btn)} col={col} row={row} mode=sgr "
                        f"press={'M' if tail == 'M' else 'm'}\n"
                    )
                    buf = buf[m.end():]
                    progressed = True
                    continue
                m = legacy_re.search(buf)
                if m:
                    btn = m.group(1)[0] - 32
                    col = m.group(2)[0] - 32
                    row = m.group(3)[0] - 32
                    log.write(
                        f"MOUSE {button_name(btn)} col={col} row={row} mode=legacy\n"
                    )
                    buf = buf[m.end():]
                    progressed = True
                    continue

            if deadline_hit(buf):
                log.write("QUIT_SEEN\n")
                break
            # Trim the buffer so a malformed prefix doesn't grow forever.
            if len(buf) > 8192:
                buf = buf[-1024:]
    finally:
        # Leave the PTY in a sane state.
        try:
            if old_attr is not None:
                termios.tcsetattr(fd_in, termios.TCSADRAIN, old_attr)
        except Exception:
            pass
        # Exit alt-screen; disable modes.
        sys.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l")
        sys.stdout.flush()
        log.write(f"EXITING time={time.time()}\n")
        log.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
