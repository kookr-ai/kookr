import { findStaleDtachAttachers, listRealProcesses, type ProcessTableEntry } from '../adapters/dtach-attach-reaper.js';

/**
 * Child exit releases manifest ownership, but an orphaned attach may linger.
 * Wait for all instance-local attach clients to disappear before replacement.
 * A surviving/manual attach blocks restart; this check never signals a process
 * whose generation cannot be proved.
 */
export async function waitForTerminalAttachExit(instanceDir: string, options: {
  list?: () => ProcessTableEntry[]; sleep?: () => Promise<void>; attempts?: number;
} = {}): Promise<boolean> {
  if (!instanceDir) return true;
  const list = options.list ?? listRealProcesses;
  const sleep = options.sleep ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  const attempts = options.attempts ?? 20;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Reuse the exact instance-path matcher; treating every socket as missing
    // selects all attach candidates without running the reaper's kill path.
    if (findStaleDtachAttachers(instanceDir, list(), () => false).length === 0) return true;
    if (attempt + 1 < attempts) await sleep();
  }
  return false;
}
