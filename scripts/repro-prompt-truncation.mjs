#!/usr/bin/env node
/**
 * Reproduce the initial-prompt truncation of kookr-ai/kookr#2977 against a real
 * Claude Code under dtach, and verify the fix.
 *
 * Two delivery timings, the same prompt:
 *
 *   node scripts/repro-prompt-truncation.mjs burst 12000
 *       writes the paste the moment the TUI advertises bracketed-paste mode
 *       (`ESC[?2004h`) — the pre-fix behaviour. The prompt lands in the boot
 *       window and is dropped, wholly or in part.
 *
 *   node scripts/repro-prompt-truncation.mjs ui 12000
 *       waits for the composer chrome to be painted first — the fix. The
 *       prompt arrives byte-for-byte.
 *
 * The body is a stream of self-locating 8-byte records, so any hole in the
 * received prompt is reported with its exact offset and length. Offsets are
 * expected to be multiples of 8: dtach carries keyboard input in packets whose
 * payload is `sizeof(struct winsize)` = 8 bytes, so whole packets are what go
 * missing while the TUI is not reading.
 *
 * Costs a few tokens per run: the launched agent answers a one-word prompt.
 */
import { spawn as ptySpawn } from 'node-pty';
import { spawn as cpSpawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = process.env.KOOKR_DTACH_VENDOR_DIR ?? join(repoRoot, 'vendor/dtach');
const DTACH = join(vendorDir, 'dtach');
const CLAUDE = process.env.KOOKR_AGENT_BIN ?? 'claude';

const mode = process.argv[2] ?? 'ui';
const size = Number(process.argv[3] ?? 12000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' };
delete env.CLAUDE_CODE_CHILD_SESSION;

const cwd = mkdtempSync(join(tmpdir(), 'kookr-prompt-repro-'));
const sock = join(cwd, 's.sock');

let body = '';
for (let i = 0; body.length < size; i += 1) body += String(i).padStart(7, '0') + '.';
const prompt = `Reply with the single word OK and nothing else. Ignore this payload: ${body.slice(0, size)} END.`;

cpSpawn(DTACH, ['-n', sock, '-r', 'winch', '-E', CLAUDE, '--dangerously-skip-permissions'],
  { cwd, stdio: 'ignore', detached: true, env }).unref();
await sleep(500);

const pty = ptySpawn(DTACH, ['-a', sock, '-E'], { name: 'xterm-256color', cols: 200, rows: 50, cwd, env });
let seen = '';
pty.onData((d) => { seen += d; });

const readyBy = Date.now() + 30_000;
while (Date.now() < readyBy && !seen.includes('\x1b[?2004h')) await sleep(100);
if (mode === 'ui') {
  // An approximation of what waitForPasteReady checks — deliberately
  // standalone so the script stays runnable against any checkout, which means
  // it can drift from `isClaudeComposerReady`. Read that as the contract.
  const painted = () => /shift\+tab|forshortcuts/.test(seen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, ''));
  while (Date.now() < readyBy && !painted()) await sleep(100);
  await sleep(1500);
}

pty.write(`\x1b[200~${prompt}\x1b[201~`);
await sleep(500);
pty.write('\r');

const dir = join(env.HOME, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
let received = null;
const transcriptBy = Date.now() + 45_000;
while (Date.now() < transcriptBy && received === null) {
  await sleep(1000);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === 'user' && typeof entry.message?.content === 'string') {
        received = entry.message.content;
        break;
      }
    }
    if (received !== null) break;
  }
}

pty.kill();
try { execFileSync('pkill', ['-f', `dtach -n ${sock}`]); } catch { /* already gone */ }

if (received === null) {
  console.log(`${mode}: sent ${prompt.length} chars, agent never submitted a prompt — the whole paste was dropped`);
  process.exit(1);
}

let sentAt = 0;
let recvAt = 0;
const holes = [];
while (recvAt < received.length) {
  if (sentAt < prompt.length && prompt[sentAt] === received[recvAt]) {
    while (sentAt < prompt.length && recvAt < received.length && prompt[sentAt] === received[recvAt]) { sentAt += 1; recvAt += 1; }
    continue;
  }
  const resume = prompt.indexOf(received.slice(recvAt, recvAt + 24), sentAt);
  if (resume === -1) { holes.push([sentAt, prompt.length]); break; }
  holes.push([sentAt, resume]);
  sentAt = resume;
}
if (sentAt < prompt.length) holes.push([sentAt, prompt.length]);

console.log(`${mode}: sent ${prompt.length} chars, received ${received.length}, lost ${prompt.length - received.length} in ${holes.length} hole(s)`);
for (const [from, to] of holes) {
  const byteFrom = Buffer.byteLength(prompt.slice(0, from));
  console.log(`  hole at byte ${byteFrom} (${byteFrom % 8 === 0 ? '8-byte aligned' : 'UNALIGNED'}), ${Buffer.byteLength(prompt.slice(from, to))} bytes`);
}
process.exit(holes.length === 0 ? 0 : 1);
