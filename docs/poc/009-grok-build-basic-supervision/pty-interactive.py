#!/usr/bin/env python3
"""PTY-based interactive readiness / byte-input / process-tree probe for Grok Build.

POC-A helper (docs/poc/009). Mirrors what Kookr's LocalDtachBackend does — run the
agent under a real PTY, gate on a readiness signal, write bytes at the byte level,
optionally approve a permission prompt, then abnormally kill and confirm the owned
process tree drains. Emits a JSON result to stdout.

Not production code: this is disposable POC evidence. `dtach` is Kookr's real
backend; where `dtach` is unavailable this stands in with a bare PTY so the Grok
side of the readiness/input/cleanup contract can still be observed.

Usage:
  pty-interactive.py --grok <bin> --home <synthetic_home> --grok-home <dir> \
      --repo <cwd> --model <model> [--prompt "..."] [--approve] [--idle-secs N]
"""
import argparse, json, os, pty, select, signal, subprocess, sys, time


def descendants(root_pid):
    """Return root_pid plus all transitive children by scanning /proc/*/stat ppid."""
    kids = {}
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            with open(f'/proc/{entry}/stat', 'rb') as f:
                data = f.read()
            rp = data.rfind(b')')
            ppid = int(data[rp + 2:].split()[1])
        except (OSError, ValueError, IndexError):
            continue
        kids.setdefault(ppid, []).append(int(entry))
    out, stack = [], [root_pid]
    while stack:
        p = stack.pop()
        out.append(p)
        stack.extend(kids.get(p, []))
    return out


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--grok', required=True)
    ap.add_argument('--home', required=True)
    ap.add_argument('--grok-home', required=True)
    ap.add_argument('--repo', required=True)
    ap.add_argument('--model', default='grok-build')
    ap.add_argument('--prompt', default='')
    ap.add_argument('--approve', action='store_true',
                    help='If a permission/approval prompt appears, send Enter/y to approve.')
    ap.add_argument('--ready-secs', type=float, default=25.0)
    ap.add_argument('--idle-secs', type=float, default=20.0)
    args = ap.parse_args()

    env = dict(os.environ)
    env.update({
        'HOME': args.home, 'GROK_HOME': args.grok_home,
        'GROK_DISABLE_AUTOUPDATER': '1', 'GROK_AUTO_UPDATE': '0',
        'GROK_WORKSPACE_DATA_COLLECTION_DISABLED': '1', 'GROK_FOLDER_TRUST': '1',
        'TERM': 'xterm-256color',
    })
    cmd = [args.grok, '--no-alt-screen', '--model', args.model]

    result = {
        'ready': False, 'ready_at': None, 'input_accepted': False,
        'approval_prompt_seen': False, 'bytes_captured': 0, 'exit_code': None,
        'tree_pids_before': [], 'tree_pids_after_kill': [], 'clean_drain': None,
        'readiness_markers': [], 'note': '',
    }
    captured = bytearray()

    pid, master = pty.fork()
    if pid == 0:  # child
        try:
            os.chdir(args.repo)
            os.execve(cmd[0], cmd, env)
        except Exception as exc:  # pragma: no cover
            sys.stderr.write(f'exec failed: {exc}\n')
            os._exit(127)

    start = time.time()
    ready_pat = (b'>', b'grok', b'help', b'esc', b'type', b'ready', b'\xe2')  # \xe2 = box-drawing UI

    def pump(deadline):
        while time.time() < deadline:
            r, _, _ = select.select([master], [], [], 0.3)
            if master in r:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    return False
                if not chunk:
                    return False
                captured.extend(chunk)
            else:
                return True
        return True

    # Phase 1: readiness
    while time.time() - start < args.ready_secs and not result['ready']:
        pump(time.time() + 0.5)
        low = bytes(captured).lower()
        hits = [p.decode('latin1') for p in ready_pat if p in low]
        if len(captured) > 40 and hits:
            result['ready'] = True
            result['ready_at'] = round(time.time() - start, 2)
            result['readiness_markers'] = hits

    result['tree_pids_before'] = descendants(pid)

    # Phase 2: byte-level input (only after readiness — KB lesson: gate input on readiness)
    if result['ready'] and args.prompt:
        try:
            os.write(master, args.prompt.encode() + b'\r')
            result['input_accepted'] = True
        except OSError as exc:
            result['note'] += f'input write failed: {exc}; '
        pump(time.time() + 4)
        # Detect an approval/permission prompt in the stream
        low = bytes(captured).lower()
        if any(k in low for k in (b'approve', b'permission', b'allow', b'y/n', b'deny', b'yes/no')):
            result['approval_prompt_seen'] = True
            if args.approve:
                try:
                    os.write(master, b'y\r')
                except OSError:
                    pass
        pump(time.time() + args.idle_secs)

    result['bytes_captured'] = len(captured)

    # Phase 3: abnormal kill of the owned tree, then verify drain
    tree = descendants(pid)
    for p in reversed(tree):
        try:
            os.kill(p, signal.SIGKILL)
        except OSError:
            pass
    time.sleep(2)
    try:
        wpid, status = os.waitpid(pid, os.WNOHANG)
        result['exit_code'] = status
    except OSError:
        pass
    still = [p for p in tree if alive(p)]
    result['tree_pids_after_kill'] = still
    result['clean_drain'] = len(still) == 0
    try:
        os.close(master)
    except OSError:
        pass

    # First/last sanitized bytes for the record (control chars escaped)
    head = bytes(captured[:400]).decode('latin1').encode('unicode_escape').decode('ascii')
    result['capture_head'] = head
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
