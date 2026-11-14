/**
 * The text a terminal screen shows, as plain lines (issue #3683).
 *
 * Lucy's "read what a task is printing" look-up needs what the operator would see, not
 * the characters the terminal received. An agent that redraws its screen sends the same
 * lines again and again with cursor moves in between, and a secret can be split by a
 * terminal code. Replaying the stream through a headless terminal emulator (the parser
 * the browser's xterm uses) settles both: the result is the final screen and its
 * scrollback, with no terminal codes left, and the ordinary secret redaction can then
 * run on text that reads the way it displays.
 *
 * Lines the terminal wrapped at the screen edge are joined again, so a token that wrapped
 * is one token when the redaction looks at it.
 *
 * Like `streaming-attach-snapshot.ts`, this parses untrusted program output and must run
 * off the main thread in production: `terminal-snapshot-worker.ts` runs it in a worker
 * the host ends on a deadline. A stream that cannot be rendered in time gives
 * `unavailable`; the raw stream is never returned as a fallback.
 */

import { performance } from 'node:perf_hooks';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { redactSpeechSecrets, speechSecretSpans } from '../core/task-speech-summary.js';
import {
  acquireSlot,
  DEFAULT_MAX_MS,
  DEFAULT_MAX_QUEUE_WAIT_MS,
  EMULATE_CHUNK_BYTES,
  loadEmulator,
  releaseSlot,
  watchdogMs,
  writeChunk,
  type StreamingAttachSnapshotUnavailableReason,
} from './streaming-attach-snapshot.js';

/** Scrollback rows kept while replaying; older rows are not read. */
const SCROLLBACK_ROWS = 1000;

export type TerminalScreenTextResult =
  | { kind: 'text'; text: string; lines: number; elapsedMs: number }
  | { kind: 'unavailable'; reason: StreamingAttachSnapshotUnavailableReason; elapsedMs: number };

export interface TerminalScreenTextOptions {
  cols: number;
  rows: number;
  /** How many of the last lines to return (blank lines in the middle count; trailing ones do not). */
  maxLines: number;
  maxMs?: number;
  maxQueueWaitMs?: number;
  /** Used by the isolating worker to skip a ring that already stalled it. */
  sessionKey?: string;
}

/**
 * Read the buffer as lines: trailing blanks trimmed, wrapped rows joined to the row they
 * continue, trailing empty lines dropped.
 */
export function readBufferLines(terminal: HeadlessTerminal): string[] {
  const buffer = terminal.buffer.active;
  const logical: string[][] = [];
  for (let y = 0; y < buffer.length; y++) {
    const row = buffer.getLine(y);
    if (!row) continue;
    // A row that the next one continues is full to the edge: keep its trailing spaces.
    const continued = buffer.getLine(y + 1)?.isWrapped === true;
    const text = row.translateToString(!continued);
    if (row.isWrapped && logical.length > 0) logical[logical.length - 1]!.push(text);
    else logical.push([text]);
  }
  const lines = logical.map(hideSecretsAcrossRows);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.map((line) => line.trimEnd());
}

/**
 * Join the rows of one logical line and hide secrets, looking two ways and hiding the union.
 *
 * - On the joined line: finds a token that wrapped across the screen edge.
 * - On each row alone: a row the terminal marked as wrapped is not always a continuation on
 *   screen, because a program can write over it after the wrap (a carriage return, a cursor
 *   move). The joined text then glues a token to the row above, where the word-boundary rule
 *   misses it, but the row alone shows it.
 *
 * The two searches must not be run one after the other: hiding the part of a wrapped token
 * that one row holds leaves a remainder too short for any rule to recognise. Instead the
 * spans each search finds are merged, and every merged span is hidden in the joined text.
 */
function hideSecretsAcrossRows(rows: string[]): string {
  if (rows.length === 1) return redactSpeechSecrets(rows[0]!);
  const joined = rows.join('');
  const spans: Array<[number, number]> = [...speechSecretSpans(joined)];
  let offset = 0;
  for (const row of rows) {
    for (const [start, end] of speechSecretSpans(row)) spans.push([offset + start, offset + end]);
    offset += row.length;
  }
  spans.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    if (end <= cursor) continue;
    out += joined.slice(cursor, Math.max(cursor, start)) + '[redacted]';
    cursor = end;
  }
  // The ordinary redaction runs once more over what is left, as everywhere else.
  return redactSpeechSecrets(out + joined.slice(cursor));
}

/** Replay `bytes` into an emulator of the given size and return the last `maxLines` lines it shows. */
export async function renderTerminalScreenText(
  bytes: Uint8Array,
  options: TerminalScreenTextOptions,
): Promise<TerminalScreenTextResult> {
  const startedAt = performance.now();
  const unavailable = (reason: StreamingAttachSnapshotUnavailableReason): TerminalScreenTextResult =>
    ({ kind: 'unavailable', reason, elapsedMs: performance.now() - startedAt });

  if (bytes.length === 0) return unavailable('empty');
  const cols = Math.floor(options.cols);
  const rows = Math.floor(options.rows);
  const maxLines = Math.floor(options.maxLines);
  if (!(cols > 0) || !(rows > 0) || !(maxLines > 0)) return unavailable('invalid-geometry');

  const modules = await loadEmulator();
  if (!modules) return unavailable('load-failed');
  if (!(await acquireSlot(options.maxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS))) return unavailable('busy');

  const replayStartedAt = performance.now();
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  let terminal: HeadlessTerminal | null = null;

  const replay = async (): Promise<TerminalScreenTextResult> => {
    try {
      terminal = new modules.Terminal({ cols, rows, scrollback: SCROLLBACK_ROWS, allowProposedApi: true });
      for (let offset = 0; offset < bytes.length; offset += EMULATE_CHUNK_BYTES) {
        await writeChunk(terminal, bytes.subarray(offset, Math.min(offset + EMULATE_CHUNK_BYTES, bytes.length)));
        if (performance.now() - replayStartedAt > maxMs) return unavailable('budget-exceeded');
      }
      const lines = readBufferLines(terminal).slice(-maxLines);
      return { kind: 'text', text: lines.join('\n'), lines: lines.length, elapsedMs: performance.now() - startedAt };
    } catch (err) {
      console.error('[terminal-screen-text] render failed:', err);
      return unavailable('failed');
    }
  };

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<TerminalScreenTextResult>((resolve) => {
    watchdog = setTimeout(() => resolve(unavailable('failed')), watchdogMs(maxMs));
    watchdog.unref?.();
  });
  try {
    return await Promise.race([replay(), stalled]);
  } finally {
    clearTimeout(watchdog);
    try { (terminal as HeadlessTerminal | null)?.dispose(); } catch { /* discarded either way */ }
    releaseSlot();
  }
}
