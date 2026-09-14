import { open } from 'node:fs/promises';

import { redactRelaySecret } from './relay-secret-redaction.js';

const CHUNK_BYTES = 64 * 1024;

export async function readRecentRelayLogs(logPath: string, maxLines = 80): Promise<string[]> {
  try {
    const file = await open(logPath, 'r');
    try {
      const stats = await file.stat();
      if (!stats.isFile()) return [];
      let position = stats.size;
      // Nonpositive and NaN limits need all lines to preserve the final Array.slice behavior.
      const limit = Math.trunc(maxLines) > 0 ? Math.trunc(maxLines) : Infinity;
      const lines: string[] = [];
      const fragments: Buffer[] = [];
      let hasFollowingNewline = false;

      const finishLine = (prefix: Buffer): void => {
        fragments.push(prefix);
        // Decode only complete lines so chunk boundaries cannot split UTF-8.
        let line = fragments.length === 1
          ? prefix.toString('utf8')
          : Buffer.concat(fragments.reverse()).toString('utf8');
        fragments.length = 0;
        if (hasFollowingNewline && line.endsWith('\r')) line = line.slice(0, -1);
        if (line) lines.push(line);
        hasFollowingNewline = true;
      };

      while (position > 0 && lines.length < limit) {
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, position));
        position -= chunk.length;
        let filled = 0;
        while (filled < chunk.length) {
          const { bytesRead } = await file.read({
            buffer: chunk, offset: filled, length: chunk.length - filled, position: position + filled,
          });
          // Unexpected EOF can mean concurrent truncation; discard incomplete output.
          if (bytesRead === 0) return [];
          filled += bytesRead;
        }
        let end = chunk.length;
        for (let index = chunk.length - 1; index >= 0; index--) {
          if (chunk[index] !== 10) continue;
          finishLine(chunk.subarray(index + 1, end));
          end = index;
          if (lines.length >= limit) break;
        }
        if (lines.length < limit) fragments.push(chunk.subarray(0, end));
      }
      if (lines.length < limit) finishLine(Buffer.alloc(0));
      return lines.reverse().slice(-maxLines).map(redactRelaySecret);
    } finally {
      await file.close();
    }
  } catch {
    return [];
  }
}
