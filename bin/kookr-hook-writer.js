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

import { closeSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// Bound per-session hook JSONL growth (issue #1433). The live HookFileWatcher
// re-reads the WHOLE active file on every append/poll (hook-watcher.ts
// readNewLines), so an unbounded file makes each hook event cost O(file size)
// and starves ingestion under load (observed files at 40–58 MB, lagMs ~8 s on a
// new session's first event). Rotating the active file at a cap keeps that
// per-event read bounded while preserving append-only JSONL semantics: each
// generation is itself append-only, and rotation is a plain rename under the
// existing per-file lock. The watcher already treats a rotated-to-fresh file as
// a truncation (offset > length → reset to 0), and HookIngestion's content-hash
// dedup absorbs any boundary overlap, so no record is lost or double-counted.
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024; // 32 MiB active-file cap
const DEFAULT_ROTATE_KEEP = 4; // rotated generations retained (.1 … .N)

/**
 * Parse an env override as a finite number, treating unset / empty / whitespace
 * / non-numeric as "not provided" so it falls back to the default. `Number('')`
 * and `Number('   ')` are `0` (finite), so a bare `Number()` would let an empty
 * `KOOKR_HOOK_MAX_BYTES=` silently disable rotation or an empty
 * `KOOKR_HOOK_ROTATE_KEEP=` silently hard-truncate history — this guards against
 * that footgun. A deliberate literal `0` is still honored (rotation off /
 * no retained generations, as documented).
 */
function parseEnvNumber(raw) {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Resolve the rotation cap + retained-generation count. Explicit `options`
 * win (used by tests), then `KOOKR_HOOK_MAX_BYTES` / `KOOKR_HOOK_ROTATE_KEEP`
 * env overrides for operators, then the built-in defaults. A non-positive
 * `maxBytes` disables rotation entirely (pure append, legacy behavior).
 */
export function resolveRotationConfig(options = {}) {
  const maxBytes = options.maxBytes ?? parseEnvNumber(process.env.KOOKR_HOOK_MAX_BYTES) ?? DEFAULT_MAX_BYTES;
  const keep = options.keep ?? parseEnvNumber(process.env.KOOKR_HOOK_ROTATE_KEEP) ?? DEFAULT_ROTATE_KEEP;
  return {
    maxBytes: Math.floor(maxBytes),
    keep: Math.max(0, Math.floor(keep)),
  };
}

function currentSize(file) {
  try {
    return statSync(file).size;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * Roll the active file out to `<file>.1`, shifting older generations up and
 * dropping anything beyond `keep`. Called under the per-file lock, so no
 * concurrent writer can append or rotate at the same time. Missing generations
 * are skipped (ENOENT is not an error) so a partially-rotated set self-heals.
 * When `keep <= 0` the active file is simply removed, hard-capping disk to one
 * generation's worth.
 */
export function rotateHookFile(file, keep) {
  if (keep <= 0) {
    try { unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return;
  }
  // Drop the oldest kept slot so the shift below cannot exceed `keep`.
  try { unlinkSync(`${file}.${keep}`); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  for (let i = keep - 1; i >= 1; i -= 1) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  renameSync(file, `${file}.1`);
}

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

export async function appendRecord(file, payload, options = {}) {
  const record = payload.endsWith('\n') ? payload : `${payload}\n`;
  const { maxBytes, keep } = resolveRotationConfig(options);
  await withLock(`${file}.lock`, () => {
    if (maxBytes > 0) {
      const size = currentSize(file);
      // Rotate only a non-empty file that this record would push past the cap.
      // A single record larger than the cap still lands in its own fresh
      // generation rather than being dropped — append-only semantics are never
      // sacrificed to enforce the bound.
      if (size > 0 && size + Buffer.byteLength(record, 'utf8') > maxBytes) {
        rotateHookFile(file, keep);
      }
    }
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
