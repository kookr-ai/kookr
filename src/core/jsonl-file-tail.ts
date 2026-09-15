/**
 * Bounded JSONL log read (issue #3243).
 *
 * After a restart, dashboard and health views re-read session interaction and
 * telemetry logs. Those files grow for the life of a session; a full
 * `readFile` makes CPU and RSS scale with history rather than with the last
 * day's events. This helper reads at most the last `maxBytes`. Files at or
 * under the cap are unchanged. Larger files are tailed: the leading partial
 * line is dropped so a mid-record cut cannot parse as an event. The file is
 * never deleted or rotated.
 */

import { open } from 'node:fs/promises';

/**
 * Default byte cap for JSONL log reads.
 *
 * 256 KiB matches `LOCAL_INTERACTION_TAIL_MAX_BYTES` in the command-outcome
 * CLI and the last-assistant transcript window. That is large enough for a
 * day's skip/reply/telemetry events (the 24-hour StatusBar sample) and small
 * enough that restart-time reads stay cheap. Do not lower this without
 * re-checking that sample.
 */
export const JSONL_LOG_READ_MAX_BYTES = 256 * 1024;

/**
 * Read a JSONL file, returning parsed objects from at most the last `maxBytes`.
 *
 * Missing files and other I/O errors yield `[]`. Empty and malformed lines
 * are skipped. When the file is larger than `maxBytes`, the first line of the
 * tailed window is dropped because it almost always starts mid-record.
 */
export async function readJsonlLogTail(
  filePath: string,
  maxBytes: number = JSONL_LOG_READ_MAX_BYTES,
): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await readBoundedTailText(filePath, maxBytes);
  } catch {
    return [];
  }

  const events: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}

async function readBoundedTailText(filePath: string, maxBytes: number): Promise<string> {
  const budget = Math.max(1, Math.floor(maxBytes));
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= 0) return '';
    const truncated = size > budget;
    const length = truncated ? budget : size;
    const position = truncated ? size - budget : 0;
    const buffer = Buffer.alloc(length);
    // Decode only the bytes actually read: `Buffer.alloc` zero-fills, so a
    // short read would otherwise append trailing NUL bytes to (and corrupt)
    // the most-recent line.
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    let text = buffer.toString('utf8', 0, bytesRead);
    if (!truncated) return text;
    const nl = text.indexOf('\n');
    if (nl >= 0 && nl + 1 < text.length) return text.slice(nl + 1);
    if (nl === 0) return text.slice(1);
    if (nl < 0) return '';
    return text;
  } finally {
    await handle.close();
  }
}
