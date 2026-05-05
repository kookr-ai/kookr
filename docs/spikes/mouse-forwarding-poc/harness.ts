/**
 * Minimal WebSocket ↔ PTY harness for the mouse-forwarding POC.
 *
 * Backends (select via --backend):
 *   - baseline:  node-pty spawns test-app.py directly. Ground-truth reference.
 *                If this fails, xterm.js's mouse reporting is broken end-to-end
 *                and nothing else we do matters.
 *   - tmux-on:   tmux new-session with `set mouse on`. Reproduces the
 *                pre-PR-#320 behavior (tmux eats wheel into copy-mode).
 *   - tmux-off:  tmux new-session with `set mouse off`. Reproduces today's
 *                behavior after PR #320.
 *   - dtach:     dtach -n <sock> -r winch -- test-app.py. Target architecture.
 *
 * WebSocket protocol (intentionally same shape as Kookr's real terminal WS):
 *   Browser → Server: binary frames (raw bytes) OR JSON {"type":"resize",...}
 *   Server → Browser: binary frames (raw bytes)
 *
 * No authentication, localhost only, dies on port conflict.
 */
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';
import { WebSocketServer } from 'ws';

type Backend = 'baseline' | 'tmux-on' | 'tmux-off' | 'dtach';

const { values } = parseArgs({
  options: {
    backend: { type: 'string' },
    port: { type: 'string', default: '9999' },
    log: { type: 'string' },
    app: { type: 'string', default: 'mouse' }, // 'mouse' | 'scrollable'
    page: { type: 'string', default: 'page.html' },
  },
});

const backend = (values.backend ?? 'baseline') as Backend;
const port = Number(values.port);
if (!values.log) {
  console.error('--log <path> required');
  process.exit(2);
}
const logPath = values.log;
const validBackends: Backend[] = ['baseline', 'tmux-on', 'tmux-off', 'dtach'];
if (!validBackends.includes(backend)) {
  console.error(`--backend must be one of ${validBackends.join(', ')}`);
  process.exit(2);
}

// Locate test-app relative to this file. --app can be:
//   'mouse'      : test-app.py (mouse-forwarding probe)
//   'scrollable' : test-app-scrollable.py (keyboard-driven scrollable TUI)
//   'claude'     : launch real Claude Code (binary resolved from PATH)
const useClaude = values.app === 'claude';
const appFile = values.app === 'scrollable' ? './test-app-scrollable.py' : './test-app.py';
const testApp = new URL(appFile, import.meta.url).pathname;
if (!existsSync(testApp)) {
  console.error(`test-app.py not found at ${testApp}`);
  process.exit(2);
}

const sockDir = join(tmpdir(), `poc-mouse-${process.pid}`);
mkdirSync(sockDir, { recursive: true });
const tmuxSession = `poc-mouse-${process.pid}`;
const dtachSock = join(sockDir, 'dtach.sock');

function cleanupBackend() {
  if (backend === 'tmux-on' || backend === 'tmux-off') {
    try {
      execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }
  if (backend === 'dtach') {
    try {
      if (existsSync(dtachSock)) unlinkSync(dtachSock);
    } catch {
      /* ignore */
    }
  }
}

process.on('exit', cleanupBackend);
process.on('SIGTERM', () => {
  cleanupBackend();
  process.exit(0);
});
process.on('SIGINT', () => {
  cleanupBackend();
  process.exit(0);
});

function spawnBaseline(env: NodeJS.ProcessEnv): IPty {
  if (useClaude) {
    return spawn('claude', ['--model', 'haiku'], {
      cols: 120, rows: 30, env, cwd: process.cwd(),
    });
  }
  if (values.app === 'scrollback') {
    // Normal-buffer flood: 200 lines to test xterm.js scrollback scroll.
    return spawn(
      'bash',
      [
        '-c',
        "for i in $(seq 1 200); do printf 'flood line %03d the quick brown fox jumps over the lazy dog\\n' $i; done; exec sleep 300",
      ],
      { cols: 80, rows: 24, env, cwd: process.cwd() },
    );
  }
  return spawn('python3', [testApp], { cols: 80, rows: 24, env, cwd: process.cwd() });
}

function spawnTmux(env: NodeJS.ProcessEnv, mouse: 'on' | 'off'): IPty {
  // tmux new-session runs the command via sh, so we have to quote carefully.
  // We pass the command as a single shell string that tmux's shell spawns.
  const cmd = `TEST_APP_LOG='${logPath.replace(/'/g, "'\\''")}' python3 '${testApp.replace(/'/g, "'\\''")}'`;
  execFileSync(
    'tmux',
    ['new-session', '-d', '-s', tmuxSession, '-x', '80', '-y', '24', cmd],
    { env, stdio: 'pipe' },
  );
  execFileSync('tmux', ['set-option', '-t', tmuxSession, 'mouse', mouse], { stdio: 'pipe' });
  return spawn('tmux', ['attach', '-t', tmuxSession], { cols: 80, rows: 24, env });
}

function spawnDtach(env: NodeJS.ProcessEnv): IPty {
  // dtach -n socket -r winch -E -- python3 test-app.py
  // -n: new session, don't attach in foreground
  // -r winch: on client attach, send SIGWINCH (Claude repaints)
  // -E: disable the escape char (we detach by closing the socket)
  const child = spawnChild(
    'dtach',
    ['-n', dtachSock, '-r', 'winch', '-E', 'python3', testApp],
    { env, stdio: 'ignore', detached: true },
  );
  child.unref();
  // Wait briefly for the socket to exist.
  const deadline = Date.now() + 2000;
  while (!existsSync(dtachSock) && Date.now() < deadline) {
    // busy wait, this is a test harness
    execFileSync('sleep', ['0.05']);
  }
  if (!existsSync(dtachSock)) {
    throw new Error(`dtach socket never appeared at ${dtachSock}`);
  }
  // dtach attach usage: `dtach -a <socket> <options>` — socket FIRST, options after.
  // Passing `-a -E <socket>` fails with "Invalid number of arguments" on dtach 0.9.
  return spawn('dtach', ['-a', dtachSock, '-E'], { cols: 80, rows: 24, env });
}

// Serve the chosen page on the same port as the WS.
const pagePath = new URL(`./${values.page}`, import.meta.url).pathname;
const http = createServer((req, res) => {
  if (!req.url || req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(pagePath));
    return;
  }
  // Allow fetching alternative pages by name for side-by-side comparison.
  if (req.url.startsWith('/page-') && req.url.endsWith('.html')) {
    const name = req.url.slice(1);
    const p = new URL(`./${name}`, import.meta.url).pathname;
    if (existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(p));
      return;
    }
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, backend, log: logPath }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
http.listen(port, '127.0.0.1');
const wss = new WebSocketServer({ server: http });
console.log(`[harness] backend=${backend} port=${port} log=${logPath}`);

wss.on('connection', (ws) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TEST_APP_LOG: logPath,
    TERM: 'xterm-256color',
  };
  let pty: IPty;
  try {
    if (backend === 'baseline') pty = spawnBaseline(env);
    else if (backend === 'tmux-on') pty = spawnTmux(env, 'on');
    else if (backend === 'tmux-off') pty = spawnTmux(env, 'off');
    else pty = spawnDtach(env);
  } catch (err) {
    console.error('[harness] spawn failed:', err);
    ws.close(1011, 'spawn failed');
    return;
  }

  pty.onData((data: string) => {
    // node-pty in binary mode still returns strings (latin-1 encoded).
    // ws accepts strings as text frames; we use Buffer for binary frames,
    // which is safer for xterm.js byte fidelity.
    ws.send(Buffer.from(data, 'binary'));
  });
  pty.onExit(({ exitCode }) => {
    try {
      ws.close(1000, `pty exited ${exitCode}`);
    } catch {
      /* ignore */
    }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary && Buffer.isBuffer(data)) {
      pty.write(data.toString('binary'));
      return;
    }
    // Control frames are JSON text.
    const text = data.toString();
    if (text.startsWith('{') && text.includes('"type"')) {
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          pty.resize(msg.cols, msg.rows);
          return;
        }
      } catch {
        /* fall through as keystrokes */
      }
    }
    pty.write(text);
  });

  ws.on('close', () => {
    try {
      pty.kill();
    } catch {
      /* already dead */
    }
  });
});

wss.on('listening', () => {
  console.log(`[harness] listening on ${port}`);
});
