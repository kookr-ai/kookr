#!/usr/bin/env node
// Kookr hook writer.
//
// Reads a complete hook payload from stdin, appends exactly one newline-
// terminated record to the per-Kookr-session JSONL file under a per-session
// lock, and POSTs the same payload to the Kookr server's hook endpoint as a
// fast active-delivery path. The local append is the durable source; the
// HTTP push gives the monitor an in-memory copy without waiting for the file
// watcher. Fails open on HTTP failure so a slow/dead server cannot break
// agent execution.
//
// Invocation (from generated hook settings):
//
//   node <kookr>/bin/kookr-hook-writer.js \
//     --session kookr-020f33cb \
//     --file ~/.kookr/hooks/kookr-020f33cb.jsonl \
//     [--url http://localhost:4800/api/hook-event/kookr-020f33cb]
//
// Replaces the legacy `awk '{ print >> file; print }' | curl ...` shell
// pipeline, which can interleave records when concurrent hook processes
// write payloads larger than PIPE_BUF (4096 bytes on Linux). See
// rfc-activity-log-reliability §6.
//
// Shipped as a checked-in JavaScript file (not a TypeScript compile target)
// to match bin/kookr-spawn.js and friends, and to keep the runtime contract
// independent of the project's CommonJS vs ESM build resolution.

import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

function parseArgs(argv) {
  let file;
  let session;
  let url;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') { file = argv[++i]; continue; }
    if (arg === '--session') { session = argv[++i]; continue; }
    if (arg === '--url') { url = argv[++i]; continue; }
  }
  if (!file) throw new Error('kookr-hook-writer: --file is required');
  if (!session) throw new Error('kookr-hook-writer: --session is required');
  return { file, session, url };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Acquire a per-file advisory lock by creating an exclusive marker file.
 * Bounded waits with jittered backoff. Stale locks older than `staleMs` are
 * reclaimed — writer is short-lived (~tens of ms), so any lock older than 5
 * seconds belonged to a crashed process.
 */
async function withLock(lockPath, fn, opts = {}) {
  const maxWaitMs = opts.maxWaitMs ?? 2000;
  const staleMs = opts.staleMs ?? 5000;
  const deadline = Date.now() + maxWaitMs;
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      try {
        return await fn();
      } finally {
        try { unlinkSync(lockPath); } catch { /* lock already gone */ }
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { unlinkSync(lockPath); } catch { /* race: gone already */ }
          continue;
        }
      } catch { /* lock disappeared between EEXIST and stat */ }
      if (Date.now() >= deadline) {
        throw new Error(`kookr-hook-writer: lock timeout on ${lockPath}`);
      }
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
}

export async function appendRecord(file, payload) {
  const record = payload.endsWith('\n') ? payload : `${payload}\n`;
  await withLock(`${file}.lock`, () => {
    const fd = openSync(file, 'a');
    try {
      writeSync(fd, record);
    } finally {
      closeSync(fd);
    }
  });
}

async function postHttp(url, payload, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function runWriter(args, payload) {
  await appendRecord(args.file, payload);
  if (args.url) {
    try {
      await postHttp(args.url, payload);
    } catch {
      // Fail open — durable file write already succeeded.
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = await readStdin();
  if (!payload) return;
  await runWriter(args, payload);
}

const entrypoint = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
if (import.meta.url === entrypoint) {
  main().catch((err) => {
    process.stderr.write(`kookr-hook-writer: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
