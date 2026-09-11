// A deterministic, unpaid native PTY producer. Commands arrive on an independent
// loopback socket so measurements start before output waits in node-pty.
const net = require('node:net');
const socket = net.connect(Number(process.argv[2]), '127.0.0.1');
socket.on('connect', () => socket.write(JSON.stringify({ id: process.argv[3] }) + '\n'));
let pending = '';
let blocked = false;
socket.on('data', (bytes) => {
  pending += bytes.toString();
  if (pending.length > 256 * 1024) return socket.destroy(new Error('Producer command budget exceeded'));
  pump();
});
function pump() {
  if (blocked) return;
  let newline;
  while ((newline = pending.indexOf('\n')) !== -1) {
    const command = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    if (!process.stdout.write(Buffer.from(command.bytes, 'base64'))) {
      blocked = true;
      socket.pause();
      return;
    }
  }
}
process.stdout.on('drain', () => {
  blocked = false;
  pump();
  if (!blocked) socket.resume();
});
socket.on('close', () => process.exit(0));
socket.on('error', () => process.exit(1));
