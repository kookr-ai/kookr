import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHookEvent } from '../../core/hook-parser.js';
import type { AgentEvent } from '../../core/types.js';
import type { Task, TaskStore } from '../../core/tasks.js';
import { readArchivedTasks, MAX_ARCHIVE_PAGE_LIMIT } from './task-archive.js';

/**
 * Upper bound on bytes read from any one ledger / transcript file. Set above the
 * largest observed vendor transcript (~9.5 MB) with headroom, because the final
 * assistant answer sits at the END of the file — a cap below the file size would
 * silently drop exactly the content the viewer exists to surface.
 */
export const TRANSCRIPT_READ_MAX_BYTES = 32_000_000;

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** Read at most `maxBytes` from the start of a file; undefined when absent. */
async function readBounded(path: string, maxBytes: number): Promise<string | undefined> {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

function ledgerLines(text: string): string[] {
  const lines = text.split('\n');
  // A bounded read may cut the final line mid-way; drop it only if unparseable later.
  return lines.filter((l) => l.trim().length > 0);
}

/** Find the SessionStart `transcript_path` for a Kookr session's hook ledger. */
export async function resolveSessionTranscriptPointer(
  hooksDir: string,
  sessionTmuxName: string,
): Promise<{ transcriptPath?: string }> {
  if (!SAFE_NAME.test(sessionTmuxName)) return {};
  const text = await readBounded(join(hooksDir, `${sessionTmuxName}.jsonl`), TRANSCRIPT_READ_MAX_BYTES);
  if (text === undefined) return {};
  for (const line of ledgerLines(text)) {
    if (!line.includes('SessionStart')) continue;
    try {
      const parsed = JSON.parse(line) as { hook_event_name?: unknown; transcript_path?: unknown };
      if (parsed.hook_event_name === 'SessionStart' && typeof parsed.transcript_path === 'string' && parsed.transcript_path) {
        return { transcriptPath: parsed.transcript_path };
      }
    } catch {
      // skip malformed line
    }
  }
  return {};
}

/** Decode the hook ledger for a session into events (bounded, tolerant). */
export async function readLedgerMessages(hooksDir: string, sessionTmuxName: string): Promise<AgentEvent[]> {
  if (!SAFE_NAME.test(sessionTmuxName)) return [];
  const text = await readBounded(join(hooksDir, `${sessionTmuxName}.jsonl`), TRANSCRIPT_READ_MAX_BYTES);
  if (text === undefined) return [];
  const events: AgentEvent[] = [];
  for (const line of ledgerLines(text)) {
    try {
      const ev = parseHookEvent(line);
      if (ev) events.push(ev);
    } catch {
      // skip malformed line
    }
  }
  return events;
}

/** Read the vendor transcript JSONL (bounded); undefined when absent. */
export async function readVendorTranscript(transcriptPath: string): Promise<string[] | undefined> {
  const text = await readBounded(transcriptPath, TRANSCRIPT_READ_MAX_BYTES);
  if (text === undefined) return undefined;
  return ledgerLines(text);
}

/** READ-ONLY lookup: hot store first, then the durable archive. Never mutates. */
export async function findTaskAnywhere(
  taskStore: Pick<TaskStore, 'getTask'>,
  archiveDir: string | undefined,
  taskId: string,
): Promise<Task | undefined> {
  const hot = taskStore.getTask(taskId);
  if (hot) return hot;
  if (!archiveDir) return undefined;
  try {
    let cursor: string | undefined;
    do {
      const page = await readArchivedTasks(archiveDir, { limit: MAX_ARCHIVE_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
      const found = page.records.find((r) => r.task.id === taskId);
      if (found) return found.task;
      cursor = page.nextCursor;
    } while (cursor);
  } catch {
    return undefined;
  }
  return undefined;
}

