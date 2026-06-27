#!/usr/bin/env node
const submitDelayMs = Number(process.env.KOOKR_CANARY_SUBMIT_READY_MS ?? '250');
let draft = '';
let readyAt = 0;
let pasteMode = false;
let controlBuffer = '';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function write(text) {
  process.stdout.write(text);
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
write('\x1b[?2004hCANARY READY\r\n> ');

function appendDraft(text) {
  draft += text;
  readyAt = Date.now() + submitDelayMs;
  write(text);
}

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

function handleChar(char) {
  const byte = char.charCodeAt(0);
  if (byte === 0x03) {
    write('\r\nCANARY EXIT\r\n');
    process.exit(0);
  }
  if ((byte === 0x0d || byte === 0x0a) && !pasteMode) {
    handleSubmit();
    return;
  }
  if (byte === 0x15 && !pasteMode) {
    // Ctrl-U — kill line, like the claude-code/codex composers. Adapters
    // prefix composer sends with it so an unsubmitted terminal-typed draft
    // cannot fuse into the message (F15).
    draft = '';
    readyAt = Date.now() + submitDelayMs;
    return;
  }
  appendDraft(char);
}

function maybeHandleControlChar(char) {
  if (!controlBuffer && char !== '\x1b') return false;
  controlBuffer += char;
  if (controlBuffer === PASTE_START) {
    pasteMode = true;
    controlBuffer = '';
    return true;
  }
  if (controlBuffer === PASTE_END) {
    pasteMode = false;
    controlBuffer = '';
    // An explicit paste exempts the next Enter from typed-burst
    // suppression, like the real composers: paste content arrives as a
    // paste *event*, not typed keystrokes, so a following Enter submits
    // even when the TUI drained everything in one late batch (#935).
    readyAt = 0;
    return true;
  }
  if (PASTE_START.startsWith(controlBuffer) || PASTE_END.startsWith(controlBuffer)) {
    return true;
  }
  const literal = controlBuffer;
  controlBuffer = '';
  for (const literalChar of literal) handleChar(literalChar);
  return true;
}

process.stdin.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  for (const char of text) {
    if (maybeHandleControlChar(char)) continue;
    handleChar(char);
  }
});
