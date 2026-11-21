import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LONG_RUNNING_JOB_CAP_MS,
  MAX_PARENT_LINE_CHARS,
  evaluateLongRunningJobHold,
  formatReclaimKillLine,
  sanitizeCommand,
  selectSessionJobs,
  toKilledProcesses,
  type ProcessInfo,
  type SessionJob,
} from './long-running-jobs.js';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A fake process lister: dtach master 100 started 5 h ago, agent 101 right after it. */
function sessionTree(extra: ProcessInfo[] = []): ProcessInfo[] {
  const rootStart = NOW - 5 * HOUR;
  return [
    { pid: 1, ppid: 0, comm: 'systemd', command: '/sbin/init', startedAtMs: NOW - 100 * HOUR },
    { pid: 100, ppid: 1, comm: 'dtach', command: 'dtach -n /tmp/s.sock -E claude', startedAtMs: rootStart },
    { pid: 101, ppid: 100, comm: 'claude', command: 'claude --dangerously-skip-permissions', startedAtMs: rootStart + 1_000 },
    // An unrelated process elsewhere on the host is never part of the session.
    { pid: 900, ppid: 1, comm: 'python3', command: 'python3 other.py', startedAtMs: NOW - 3 * HOUR },
    ...extra,
  ];
}

const bash = (pid: number, ppid: number, startedAtMs: number): ProcessInfo => ({
  pid, ppid, comm: 'bash', command: '/bin/bash -c source snapshot.sh && python train.py', startedAtMs,
});

describe('selectSessionJobs (issue #4237)', () => {
  it('agent-only tree: no jobs', () => {
    expect(selectSessionJobs(100, sessionTree(), { nowMs: NOW })).toEqual([]);
  });

  it('a job under the Bash tool shell counts; the shell itself does not', () => {
    const jobs = selectSessionJobs(100, sessionTree([
      bash(200, 101, NOW - 2 * HOUR),
      { pid: 201, ppid: 200, comm: 'python', command: 'python train.py --epochs 3', startedAtMs: NOW - 2 * HOUR },
    ]), { nowMs: NOW });
    expect(jobs).toEqual([{ pid: 201, command: 'python train.py --epochs 3', ageMs: 2 * HOUR, holdsGpu: false }]);
  });

  it('a job the shell exec-ed straight under the agent counts', () => {
    const jobs = selectSessionJobs(100, sessionTree([
      { pid: 210, ppid: 101, comm: 'python', command: 'python eval.py', startedAtMs: NOW - 30 * MIN },
    ]), { nowMs: NOW });
    expect(jobs.map((j) => j.pid)).toEqual([210]);
  });

  it('ignores helpers started with the session (MCP servers) and pacing helpers like sleep', () => {
    const rootStart = NOW - 5 * HOUR;
    const jobs = selectSessionJobs(100, sessionTree([
      { pid: 220, ppid: 101, comm: 'node', command: 'node mcp-server.js', startedAtMs: rootStart + 20_000 },
      bash(221, 101, NOW - HOUR),
      { pid: 222, ppid: 221, comm: 'sleep', command: 'sleep 3600', startedAtMs: NOW - HOUR },
    ]), { nowMs: NOW });
    expect(jobs).toEqual([]);
  });

  it('marks a GPU holder, even one started with the session', () => {
    const rootStart = NOW - 5 * HOUR;
    const jobs = selectSessionJobs(100, sessionTree([
      { pid: 230, ppid: 101, comm: 'python', command: 'python serve.py', startedAtMs: rootStart + 5_000 },
    ]), { nowMs: NOW, gpuPids: new Set([230]) });
    expect(jobs).toEqual([expect.objectContaining({ pid: 230, holdsGpu: true })]);
  });

  it('never reports the agent itself, even when it holds the GPU', () => {
    expect(selectSessionJobs(100, sessionTree(), { nowMs: NOW, gpuPids: new Set([100, 101]) })).toEqual([]);
  });

  it('returns nothing when the root is not in the table', () => {
    expect(selectSessionJobs(4242, sessionTree(), { nowMs: NOW })).toEqual([]);
  });

  it('sanitizes the command and orders jobs oldest first', () => {
    const jobs = selectSessionJobs(100, sessionTree([
      { pid: 240, ppid: 101, comm: 'python', command: 'python a.py\nrm -rf /', startedAtMs: NOW - 20 * MIN },
      { pid: 241, ppid: 101, comm: 'python', command: 'python b.py', startedAtMs: NOW - 90 * MIN },
    ]), { nowMs: NOW });
    expect(jobs.map((j) => j.pid)).toEqual([241, 240]);
    expect(jobs[1]!.command).toBe('python a.py rm -rf /');
  });
});

describe('evaluateLongRunningJobHold (issue #4237)', () => {
  const job = (overrides: Partial<SessionJob>): SessionJob => ({
    pid: 300, command: 'python train.py', ageMs: 30 * MIN, holdsGpu: false, ...overrides,
  });

  it('young child: no hold', () => {
    expect(evaluateLongRunningJobHold([job({ ageMs: 9 * MIN })], { silentForMs: HOUR }))
      .toEqual({ hold: false, reason: 'no_long_running_job' });
  });

  it('old child: hold', () => {
    const decision = evaluateLongRunningJobHold([job({ ageMs: 10 * MIN })], { silentForMs: HOUR });
    expect(decision).toEqual({ hold: true, job: job({ ageMs: 10 * MIN }) });
  });

  it('GPU child: hold even when young', () => {
    expect(evaluateLongRunningJobHold([job({ ageMs: MIN, holdsGpu: true })], { silentForMs: HOUR }).hold).toBe(true);
  });

  it('past the cap: no hold', () => {
    expect(evaluateLongRunningJobHold([job({ holdsGpu: true })], { silentForMs: DEFAULT_LONG_RUNNING_JOB_CAP_MS }))
      .toEqual({ hold: false, reason: 'cap_reached' });
    expect(evaluateLongRunningJobHold([job({})], { silentForMs: 2 * HOUR, capMs: 2 * HOUR }).hold).toBe(false);
  });

  it('agent-only tree (no jobs, or no snapshot): no hold', () => {
    expect(evaluateLongRunningJobHold([], { silentForMs: HOUR }).hold).toBe(false);
    expect(evaluateLongRunningJobHold(undefined, { silentForMs: HOUR }).hold).toBe(false);
  });
});

describe('kill report formatting (issue #4237)', () => {
  it('sanitizeCommand strips control characters and truncates', () => {
    expect(sanitizeCommand('a\u0000b\r\n\tc\u001b[31m')).toBe('a b c [31m');
    expect(sanitizeCommand('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('formats one bounded line for the parent', () => {
    const killed = toKilledProcesses([
      { pid: 201, command: 'python train.py', ageMs: 2 * HOUR + 30 * MIN, holdsGpu: true },
      { pid: 202, command: 'tail -f log', ageMs: 45_000, holdsGpu: false },
    ]);
    expect(killed).toEqual([
      { pid: 201, command: 'python train.py', ageSeconds: 9000, holdsGpu: true },
      { pid: 202, command: 'tail -f log', ageSeconds: 45, holdsGpu: false },
    ]);
    expect(formatReclaimKillLine({ workerName: 'eval\nworker', silentForMs: 61 * MIN, killed })).toBe(
      '[kookr] worker eval worker was reclaimed after 61 min of silence; it killed: '
      + 'python train.py (pid 201, 2.5h, GPU); tail -f log (pid 202, 45s)',
    );
  });

  it('caps the parent line length', () => {
    const killed = toKilledProcesses(Array.from({ length: 8 }, (_, i) => ({
      pid: 1000 + i, command: 'y'.repeat(200), ageMs: HOUR, holdsGpu: false,
    })));
    const line = formatReclaimKillLine({ workerName: 'w', silentForMs: HOUR, killed });
    expect(line.length).toBeLessThanOrEqual(MAX_PARENT_LINE_CHARS);
    expect(line).not.toMatch(/\n/);
  });
});
