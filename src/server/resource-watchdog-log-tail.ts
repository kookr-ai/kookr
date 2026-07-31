/**
 * Byte-capped file tail for the resource-watchdog brief (issue #1724).
 *
 * Under host pressure we must not `readFileSync` multi-GB `server.log` files
 * (issue #1553 lesson). Open + fstat + read the last N bytes only.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Return the last `maxBytes` of `filePath` as utf-8 text, or `null` on any
 * I/O error / empty file. When the file is larger than `maxBytes`, the result
 * may start mid-line; a leading partial line is dropped for readability.
 */
export function readTrailingFileBytes(
  filePath: string,
  maxBytes: number,
): string | null {
  const budget = Math.max(1, Math.floor(maxBytes));
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const size = fstatSync(fd).size;
    if (size <= 0) return null;
    const start = size > budget ? size - budget : 0;
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buf, 0, length, start);
    let text = buf.subarray(0, bytesRead).toString('utf-8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0 && nl + 1 < text.length) text = text.slice(nl + 1);
    }
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}
