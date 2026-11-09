import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Host-side ingest of a container worker's hook ledger (RFC #3541, S2c).
 *
 * A container's hook command appends events to a ledger file inside a per-task spool dir that is bind-mounted into the
 * container. The host tails that file with the existing `HookFileWatcher` (the same framing, dedup and ingestion as TUI
 * sessions), under a session key derived from taskId + launch token rather than a terminal name. Because the key is a
 * pure function of persisted values, adopting a container after a Kookr restart yields the same event identity.
 *
 * The spool is worker-writable, so everything read from it is untrusted: the watcher is told `untrusted`, which makes it
 * refuse symlinks and non-regular files, and the paths are built only from validated ids.
 */

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LAUNCH_TOKEN = /^[A-Za-z0-9]{6,32}$/;

export interface LedgerWatcherPort {
  watch(
    sessionKey: string,
    options: {
      filePath: string;
      untrusted: boolean;
      replayExisting?: boolean;
      suppressParseAlertsForExisting?: boolean;
      useReplayCheckpoint?: boolean;
    },
  ): void;
  stop(sessionKey: string): void;
  isWatching(sessionKey: string): boolean;
}

function check(taskId: string, launchToken: string): void {
  if (!TASK_ID.test(taskId)) throw new Error(`invalid task id for ledger: ${JSON.stringify(taskId)}`);
  if (!LAUNCH_TOKEN.test(launchToken)) throw new Error(`invalid launch token for ledger: ${JSON.stringify(launchToken)}`);
}

/** Stable event-session identity for a container launch. Matches the container's name (`kookr-oc-<task8>-<token>`). */
export function containerSessionKey(taskId: string, launchToken: string): string {
  check(taskId, launchToken);
  return `kookr-oc-${taskId.slice(0, 8)}-${launchToken}`;
}

export interface LedgerLocation {
  sessionKey: string;
  /** Directory to bind-mount read-write at `/kookr-spool`. */
  dir: string;
  /** The ledger file the hook command appends to. */
  file: string;
}

export function ledgerLocation(spoolRoot: string, taskId: string, launchToken: string): LedgerLocation {
  const sessionKey = containerSessionKey(taskId, launchToken);
  const dir = join(spoolRoot, taskId, launchToken);
  return { sessionKey, dir, file: join(dir, 'ledger.jsonl') };
}

export class ContainerLedgerIngest {
  constructor(private readonly spoolRoot: string, private readonly watcher: LedgerWatcherPort) {}

  /**
   * Create the spool dir and an empty ledger file (0700 / 0600, owned by this host user), refusing symlinked
   * components. Safe to call again for the same launch. Called before `docker run`.
   */
  async prepare(taskId: string, launchToken: string): Promise<LedgerLocation> {
    const loc = ledgerLocation(this.spoolRoot, taskId, launchToken);
    await mkdir(this.spoolRoot, { recursive: true, mode: 0o700 });
    for (const d of [join(this.spoolRoot, taskId), loc.dir]) {
      await mkdir(d, { recursive: false, mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      const st = await lstat(d);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`spool path ${d} is not a plain directory`);
    }
    // `a` creates if missing and never truncates; O_NOFOLLOW (via `wx` on a fresh path, else lstat below) keeps a
    // pre-planted symlink from being followed.
    const existing = await lstat(loc.file).catch(() => undefined);
    if (existing) {
      if (!existing.isFile()) throw new Error(`ledger ${loc.file} exists but is not a regular file`);
    } else {
      const h = await open(loc.file, 'wx', 0o600);
      await h.close();
    }
    return loc;
  }

  /**
   * Start tailing the ledger. `adopt: true` is for a container that already ran (Kookr restarted): replay from the
   * durable checkpoint without re-raising startup parse alerts, exactly like TUI session recovery.
   */
  attach(taskId: string, launchToken: string, opts: { adopt?: boolean } = {}): string {
    const loc = ledgerLocation(this.spoolRoot, taskId, launchToken);
    if (this.watcher.isWatching(loc.sessionKey)) return loc.sessionKey;
    this.watcher.watch(loc.sessionKey, {
      filePath: loc.file,
      untrusted: true,
      replayExisting: opts.adopt === true,
      ...(opts.adopt ? { suppressParseAlertsForExisting: true, useReplayCheckpoint: true } : {}),
    });
    return loc.sessionKey;
  }

  detach(taskId: string, launchToken: string): void {
    this.watcher.stop(containerSessionKey(taskId, launchToken));
  }
}
