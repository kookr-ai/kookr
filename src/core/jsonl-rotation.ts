/**
 * Size-capped JSONL append with multi-generation rotation.
 *
 * Shared helper for append-only diagnostic/training logs that would otherwise
 * grow without bound (observed multi-MB → multi-GB growth on long-running prod
 * dogfood). Mirrors the rotation scheme already used by ShadowDetectorRegistry:
 * before an append that would push the file past `maxBytes`, the current file is
 * renamed to `.1`, older generations shift up (`.1`→`.2`, …) and anything beyond
 * `rotatedGenerations` is dropped.
 *
 * Fire-and-forget callers should serialize appends within a process (e.g. a
 * promise queue) so two same-process writers cannot race on the stat/rotate/
 * append sequence. This guarantee is intra-process only: like the existing
 * ShadowDetectorRegistry scheme it does not guard two separate processes sharing
 * one file, which assumes a single daemon per data directory.
 */

import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface JsonlRotationOptions {
  /** Rotate the log before an append would exceed this many bytes. */
  maxBytes: number;
  /** Number of rotated generations to retain, e.g. 2 keeps `.1` and `.2`. */
  rotatedGenerations: number;
}

/**
 * Append `lines` to `logFilePath`, rotating first if the append would exceed
 * `maxBytes`. Ensures the parent directory exists. Rejects on real I/O errors so
 * callers can decide whether to swallow them (diagnostics paths do).
 */
export async function appendJsonlWithRotation(
  logFilePath: string,
  lines: string,
  options: JsonlRotationOptions,
): Promise<void> {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes));
  const rotatedGenerations = Math.max(1, Math.floor(options.rotatedGenerations));

  await mkdir(dirname(logFilePath), { recursive: true });

  let currentSize = 0;
  try {
    currentSize = (await stat(logFilePath)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (currentSize > 0 && currentSize + Buffer.byteLength(lines, 'utf8') > maxBytes) {
    await rotateJsonl(logFilePath, rotatedGenerations);
  }

  await appendFile(logFilePath, lines, 'utf-8');
}

async function rotateJsonl(logFilePath: string, rotatedGenerations: number): Promise<void> {
  try {
    await unlink(`${logFilePath}.${rotatedGenerations}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  for (let generation = rotatedGenerations - 1; generation >= 1; generation--) {
    try {
      await rename(`${logFilePath}.${generation}`, `${logFilePath}.${generation + 1}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  try {
    await rename(logFilePath, `${logFilePath}.1`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
