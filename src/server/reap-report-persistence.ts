/**
 * Bounded, best-effort persistence of a reap evidence report (issue #2852).
 *
 * Both the hung-task reaper and the first-hook-miss reaper terminate a task and
 * release its capacity, then want to leave behind a markdown evidence report.
 * The report is a diagnostic nicety, not part of lifecycle correctness: if the
 * Kookr data directory is full, slow, or wedged, a report write can be slow or
 * never settle at all. Letting the reaper `await` such a write before (or
 * instead of) terminating would stall capacity release precisely during disk
 * pressure — a dead task keeps holding a slot while no operator is watching.
 *
 * This helper is called AFTER termination has already released the slot. It
 * runs the write with a wall-clock bound so a never-settling write cannot delay
 * the caller's remaining work (audit row, alert, pending-task refill), and it
 * catches every failure — including a late rejection that arrives after the
 * bound has elapsed — so a wedged directory can never surface as an unhandled
 * promise rejection. The returned status is the report-persistence failure
 * signal callers fold into their audit row.
 */
import { withTimeout } from '../core/with-timeout.js';

/**
 * Default bound for a reap report write. The write is normally sub-millisecond;
 * this is a generous ceiling that still guarantees capacity refill proceeds
 * within a few seconds even when the data directory is pathologically slow.
 */
export const DEFAULT_REAP_REPORT_PERSIST_TIMEOUT_MS = 5_000;

/**
 * Outcome of a bounded report-persist attempt.
 * - `ok`: the report was written; `reportPath` points at it.
 * - `skipped`: no reports directory configured — nothing to write (not a failure).
 * - `error`: the write rejected and was caught.
 * - `timeout`: the write did not settle within the bound; it was abandoned
 *   (its eventual settlement is caught so it cannot leak as an unhandled
 *   rejection).
 */
export type ReapReportPersistOutcome =
  | { status: 'ok'; reportPath: string }
  | { status: 'skipped' }
  | { status: 'error' }
  | { status: 'timeout' };

/**
 * Run `write` (which resolves the written report path) under a wall-clock
 * bound. `write` is expected to perform its own directory/file I/O and may
 * reject; this helper never rejects.
 *
 * A `timeoutMs <= 0` disables the bound and simply awaits the write — useful
 * only in tests that want the classic "await the write" behavior.
 */
export async function persistReapReport(
  write: () => Promise<string>,
  timeoutMs: number = DEFAULT_REAP_REPORT_PERSIST_TIMEOUT_MS,
  logPrefix = '[reap-report]',
): Promise<ReapReportPersistOutcome> {
  // Attach the success/failure handlers up front so the write promise can never
  // reject unobserved: even if the bound below elapses first and this promise
  // settles later, its rejection is already handled here (resolving to
  // `{ status: 'error' }`), so no unhandled rejection can escape.
  const settled: Promise<ReapReportPersistOutcome> = write().then(
    (reportPath) => ({ status: 'ok', reportPath }) as ReapReportPersistOutcome,
    (err) => {
      console.warn(`${logPrefix} failed to write report:`, err);
      return { status: 'error' } as ReapReportPersistOutcome;
    },
  );

  if (timeoutMs <= 0) return settled;

  const TIMED_OUT: ReapReportPersistOutcome = { status: 'timeout' };
  const raced = await withTimeout(settled, timeoutMs, TIMED_OUT);
  if (raced === TIMED_OUT) {
    console.error(
      `${logPrefix} report write did not settle within ${timeoutMs}ms — ` +
        'capacity already released; report abandoned',
    );
  }
  return raced;
}
