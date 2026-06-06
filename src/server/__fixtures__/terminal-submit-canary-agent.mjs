#!/usr/bin/env node
const encoder = new TextEncoder();
const submitDelayMs = Number(process.env.KOOKR_CANARY_SUBMIT_READY_MS ?? '250');
let draft = '';
let readyAt = 0;

function write(text) {
  process.stdout.write(text);
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
write('\x1b[?2004hCANARY READY\r\n> ');

function handleSubmit() {
  const now = Date.now();
  if (!draft) {
    write('\r\nEMPTY_ENTER\r\n> ');
    return;
  }
  if (now < readyAt) {
    write(`\r\nIGNORED_EARLY_ENTER:${draft}\r\n> ${draft}`);
    return;
  }
  write(`\r\nSUBMITTED:${draft}\r\n> `);
  draft = '';
}

process.stdin.on('data', (chunk) => {
  const bytes = new Uint8Array(chunk);
  for (const byte of bytes) {
    if (byte === 0x03) {
      write('\r\nCANARY EXIT\r\n');
      process.exit(0);
    }
    if (byte === 0x0d || byte === 0x0a) {
      handleSubmit();
      continue;
    }
    const text = new TextDecoder().decode(encoder.encode(String.fromCharCode(byte)));
    draft += text;
    readyAt = Date.now() + submitDelayMs;
    write(text);
  }
});
