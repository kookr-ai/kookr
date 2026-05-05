/**
 * Ad-hoc harness: serve a minimal xterm.js page that attaches (via node-pty)
 * to a pre-existing tmux session. Used to test whether disabling tmux's
 * alternate-screen gives xterm.js scrollback through `tmux attach`.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node-pty';
import { WebSocketServer } from 'ws';

const PORT = 9998;
const SESSION = 'wheel-test';

const PAGE = `<!DOCTYPE html><html><head>
<meta charset=utf-8><title>tmux wheel probe</title>
<link rel=stylesheet href=https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css>
<style>body{background:#0a0c12;color:#b2bace;margin:0;font-family:monospace}
#status{padding:6px 10px;font-size:12px;border-bottom:1px solid #222}
#term{padding:10px}</style></head>
<body><div id=status>connecting…</div><div id=term></div>
<script type=module>
import { Terminal } from 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/+esm';
const term = new Terminal({ cols: 120, rows: 30, fontSize: 14, scrollback: 10000,
  theme: { background:'#0a0c12', foreground:'#b2bace' } });
term.open(document.getElementById('term'));
term.focus();
window.__term = term;
const ws = new WebSocket('ws://' + location.host);
ws.binaryType = 'arraybuffer';
ws.onopen = () => document.getElementById('status').textContent = 'connected — scroll the wheel to test';
ws.onmessage = ev => { if (typeof ev.data === 'string') term.write(ev.data); else term.write(new Uint8Array(ev.data)); };
const enc = new TextEncoder();
term.onData(d => ws.send(enc.encode(d)));
window.__readBufferState = () => ({
  type: term.buffer.active.type,
  length: term.buffer.active.length,
  viewportY: term.buffer.active.viewportY,
  baseY: term.buffer.active.baseY,
  cursorY: term.buffer.active.cursorY,
});
</script></body></html>`;

const server = createServer((req, res) => {
  if (!req.url || req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
    return;
  }
  res.writeHead(404).end();
});
server.listen(PORT, '127.0.0.1');
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  const pty = spawn('tmux', ['attach', '-t', SESSION], {
    name: 'xterm-256color', cols: 120, rows: 30,
    env: process.env as Record<string, string>, cwd: process.cwd(),
  });
  pty.onData((d) => ws.send(Buffer.from(d, 'binary')));
  pty.onExit(() => { try { ws.close(); } catch {} });
  ws.on('message', (d, isBinary) => {
    if (isBinary && Buffer.isBuffer(d)) pty.write(d.toString('binary'));
    else pty.write(d.toString());
  });
  ws.on('close', () => { try { pty.kill(); } catch {} });
});
console.log(`probe listening on ${PORT}, attaches to tmux session ${SESSION}`);
