/**
 * Keeps the dtach instance directory alive for the life of the server process.
 *
 * Every dtach-backed session keeps three things on disk under one per-instance
 * directory — `/tmp/kookr-dtach/<uid>/<instanceId>/`: the Unix socket the agent's
 * terminal is bound to, the `manifest.json` that lets a restarted Kookr find
 * still-running agents, and the `rings/` replay buffers. That directory lives in
 * `/tmp`, which is shared and world-writable, so it can vanish underneath a
 * running server: an OS temp sweeper, `scripts/rollback-dtach.sh`, or a stray
 * `rm` in any shell on the machine will take it.
 *
 * Historically the directory was created exactly once, when `LocalDtachBackend`
 * was constructed at server startup. If it disappeared afterwards, the next
 * launch died writing the manifest with a bare `ENOENT`, before dtach was ever
 * spawned — and so did every launch after it, for the lifetime of the process.
 * The operator saw only "spawn failed"; the sole cure was a server restart
 * (kookr-ai/kookr#3042).
 *
 * Calling {@link ensureDtachDir} immediately before each write turns that
 * unrecoverable state into a self-healing one. `mkdirSync(…, { recursive: true })`
 * is a no-op when the directory is already there, so the steady-state cost is a
 * single syscall per write.
 */
import { mkdirSync } from 'node:fs';

/**
 * Create `dir` (and any missing parents) if it is not already present.
 *
 * Mode `0700` matches how the instance directory was first created, so a
 * directory this call creates is private to the user running Kookr — the
 * sockets and manifests inside identify running agent sessions.
 *
 * That is a property of directories *this call creates*, not a check on ones it
 * finds. `mkdirSync` never tightens the mode of an existing directory and
 * follows a symlink at any path component, so if something else already occupies
 * the path, Kookr adopts it as-is. What bounds that in practice is `/tmp`'s
 * sticky bit: another unprivileged user cannot remove `/tmp/kookr-dtach` to
 * plant a replacement. A root-level temp sweeper can, which leaves a real (if
 * narrow) window. Verifying owner and mode before adopting an existing directory
 * is deliberately not done here — this function sits on the launch path the fix
 * exists to keep working, and a new throw here would recreate the outage it
 * prevents. See kookr-ai/kookr#3042.
 */
export function ensureDtachDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
