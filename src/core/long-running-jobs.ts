/**
 * Long-running jobs under a task's session (issue #4237).
 *
 * A worker that starts a long GPU run (fine-tuning, evaluation) without
 * detaching it, then waits for it, is silent on every liveness channel. The
 * hungSuspect TTL reclaim and the 3h hung-task reaper used to close such a
 * task, and closing a task kills its whole process tree, so the run died with
 * it and the disposition ledger called the closure benign.
 *
 * This module is the pure part of the fix:
 *
 * - {@link selectSessionJobs} picks, from one process-table snapshot, the
 *   processes under a session that are the worker's own jobs, as opposed to
 *   the agent itself, its shells, or helpers it started with the session.
 * - {@link evaluateLongRunningJobHold} decides whether those jobs keep the
 *   task from being reclaimed: a job older than 10 minutes, or one holding
 *   the GPU, does, until the task has been silent for the hard cap.
 * - {@link toKilledProcesses} and {@link formatReclaimKillLine} report what a
 *   reclaim killed, with every command sanitized, because the text reaches
 *   the disposition ledger, `/api/health` and another agent's input.
 *
 * The process table and GPU process list are read by the adapter layer
 * (`adapters/process-tree.ts`); everything here is I/O-free.
 */

/** One process, as read from the host's process table. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Short executable name (`/proc/<pid>/comm`), e.g. `python3`. */
  comm: string;
  /** Full command line, arguments joined by spaces. May be empty (kernel threads, zombies). */
  command: string;
  /** Wall-clock start time in ms since epoch, or `null` when unknown. */
  startedAtMs: number | null;
}

/** A process under a task's session that is the worker's own job, not the agent or its shell. */
export interface SessionJob {
  pid: number;
  /** Sanitized, truncated command line (see {@link sanitizeCommand}). */
  command: string;
  /** Age at snapshot time, in ms. */
  ageMs: number;
  /** True when the process appears in `nvidia-smi --query-compute-apps`. */
  holdsGpu: boolean;
}

/** A job a reclaim killed, as recorded in the disposition entry. */
export interface KilledProcess {
  pid: number;
  command: string;
  ageSeconds: number;
  holdsGpu: boolean;
}

/** A job younger than this does not hold off a reclaim (unless it holds the GPU). */
export const LONG_RUNNING_JOB_MIN_AGE_MS = 10 * 60_000;

/** Default hard cap on the hold, measured as all-channel silence: 12 hours. */
export const DEFAULT_LONG_RUNNING_JOB_CAP_MS = 12 * 60 * 60_000;

/**
 * Processes that started within this window of the session root are treated
 * as part of the agent (an MCP server, a wrapper process), not as a job the
 * worker launched. Without it, a helper as old as the agent would hold every
 * task for the full cap.
 */
export const SESSION_STARTUP_WINDOW_MS = 2 * 60_000;

/** Executables that only host or pace a job; their children are the job. */
const NON_JOB_COMMS = new Set([
  'bash', 'sh', 'dash', 'zsh', 'ksh', 'fish', 'tcsh', 'csh', 'ash', 'busybox',
  'sleep', 'timeout', 'taskset', 'nice', 'env', 'setsid', 'nohup', 'script',
]);

/** Longest command kept for one process. */
export const MAX_JOB_COMMAND_CHARS = 120;
/** Most jobs recorded for one task. */
export const MAX_REPORTED_JOBS = 8;

/**
 * Make a command line safe to store and to type into another agent: control
 * characters (newlines included, which would submit a prompt early) become
 * spaces, runs of whitespace collapse, and the result is truncated.
 */
export function sanitizeCommand(command: string, maxChars: number = MAX_JOB_COMMAND_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = command.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

/**
 * Pick the worker's own jobs under the session rooted at `rootPid` (the dtach
 * master). Excluded: the root, its direct children (the agent), shells and
 * pacing helpers ({@link NON_JOB_COMMS}), and processes that started within
 * {@link SESSION_STARTUP_WINDOW_MS} of the root. A process holding the GPU is
 * always a job unless it is the root or the agent. A process with an unknown
 * start time is skipped, except when it holds the GPU (age then reads 0).
 *
 * Returns jobs oldest first, at most {@link MAX_REPORTED_JOBS}.
 */
export function selectSessionJobs(
  rootPid: number,
  processes: readonly ProcessInfo[],
  opts: { nowMs: number; gpuPids?: ReadonlySet<number> },
): SessionJob[] {
  const byPid = new Map<number, ProcessInfo>();
  const children = new Map<number, number[]>();
  for (const proc of processes) {
    byPid.set(proc.pid, proc);
    const list = children.get(proc.ppid);
    if (list) list.push(proc.pid);
    else children.set(proc.ppid, [proc.pid]);
  }
  const root = byPid.get(rootPid);
  if (!root) return [];
  const rootStartedAt = root.startedAtMs;
  const gpuPids = opts.gpuPids ?? new Set<number>();

  const jobs: SessionJob[] = [];
  const seen = new Set<number>([rootPid]);
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);

    const proc = byPid.get(pid);
    if (!proc || proc.ppid === rootPid) continue; // the agent itself
    const holdsGpu = gpuPids.has(pid);
    if (!holdsGpu) {
      if (NON_JOB_COMMS.has(proc.comm)) continue;
      if (proc.startedAtMs === null) continue;
      if (rootStartedAt !== null && proc.startedAtMs - rootStartedAt < SESSION_STARTUP_WINDOW_MS) continue;
    }
    const ageMs = proc.startedAtMs === null ? 0 : Math.max(0, opts.nowMs - proc.startedAtMs);
    jobs.push({
      pid,
      command: sanitizeCommand(proc.command || proc.comm),
      ageMs,
      holdsGpu,
    });
  }
  return jobs.sort((a, b) => b.ageMs - a.ageMs).slice(0, MAX_REPORTED_JOBS);
}

export type LongRunningJobHold =
  | { hold: true; job: SessionJob }
  | { hold: false; reason: 'no_long_running_job' | 'cap_reached' };

/**
 * Should a silent task be kept alive because it owns a live long-running job?
 * A job holds when it is at least {@link LONG_RUNNING_JOB_MIN_AGE_MS} old or
 * holds the GPU. The hold ends once the task has been silent for `capMs`.
 */
export function evaluateLongRunningJobHold(
  jobs: readonly SessionJob[] | undefined,
  opts: { silentForMs: number; capMs?: number; minAgeMs?: number },
): LongRunningJobHold {
  const minAgeMs = opts.minAgeMs ?? LONG_RUNNING_JOB_MIN_AGE_MS;
  const job = (jobs ?? []).find((j) => j.holdsGpu || j.ageMs >= minAgeMs);
  if (!job) return { hold: false, reason: 'no_long_running_job' };
  if (opts.silentForMs >= (opts.capMs ?? DEFAULT_LONG_RUNNING_JOB_CAP_MS)) {
    return { hold: false, reason: 'cap_reached' };
  }
  return { hold: true, job };
}

/** Convert snapshot jobs into the disposition-entry shape. */
export function toKilledProcesses(jobs: readonly SessionJob[]): KilledProcess[] {
  return jobs.slice(0, MAX_REPORTED_JOBS).map((job) => ({
    pid: job.pid,
    command: sanitizeCommand(job.command),
    ageSeconds: Math.round(job.ageMs / 1000),
    holdsGpu: job.holdsGpu,
  }));
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/** Longest line typed into a parent task. */
export const MAX_PARENT_LINE_CHARS = 600;

/**
 * The one line typed into the parent task after a reclaim killed jobs:
 * `[kookr] worker <name> was reclaimed after <N> min of silence; it killed: <cmd> (pid <p>, <age>)…`.
 * Single line, sanitized, bounded to {@link MAX_PARENT_LINE_CHARS}.
 */
export function formatReclaimKillLine(input: {
  workerName: string;
  silentForMs: number;
  killed: readonly KilledProcess[];
}): string {
  const name = sanitizeCommand(input.workerName, 80) || 'unnamed';
  const minutes = Math.round(input.silentForMs / 60_000);
  const items = input.killed.map((p) =>
    `${sanitizeCommand(p.command, 80)} (pid ${p.pid}, ${formatAge(p.ageSeconds)}${p.holdsGpu ? ', GPU' : ''})`);
  const line = `[kookr] worker ${name} was reclaimed after ${minutes} min of silence; it killed: ${items.join('; ')}`;
  return sanitizeCommand(line, MAX_PARENT_LINE_CHARS);
}

/** `HH:MM` in the server's local time zone, for a deadline in ms since epoch. */
export function formatClockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The one line typed into the parent task when the hungSuspect TTL reclaim
 * warns one of its workers (issue #4241):
 * `[kookr] worker <name> (<id8>) has been silent <N> min and will be closed at HH:MM. If it is
 * waiting on purpose: kookr keep-alive <id8> --for 30m --reason "<why>". It started: <jobs>.`
 * The jobs come last so a long list is what truncation cuts, never the command.
 */
export function formatReclaimWarningLine(input: {
  workerName: string;
  taskId: string;
  silentForMs: number;
  deadlineAtMs: number;
  jobs: readonly SessionJob[];
}): string {
  const name = sanitizeCommand(input.workerName, 80) || 'unnamed';
  const id8 = input.taskId.slice(0, 8);
  const minutes = Math.round(input.silentForMs / 60_000);
  const jobs = toKilledProcesses(input.jobs).map((p) =>
    `${sanitizeCommand(p.command, 80)} (pid ${p.pid}, ${formatAge(p.ageSeconds)}${p.holdsGpu ? ', GPU' : ''})`);
  const started = jobs.length > 0 ? ` It started: ${jobs.join('; ')}.` : ' It started no long-running process.';
  const line =
    `[kookr] worker ${name} (${id8}) has been silent ${minutes} min and will be closed at ` +
    `${formatClockTime(input.deadlineAtMs)}. If it is waiting on purpose: ` +
    `kookr keep-alive ${id8} --for 30m --reason "<why>".${started}`;
  return sanitizeCommand(line, MAX_PARENT_LINE_CHARS);
}
