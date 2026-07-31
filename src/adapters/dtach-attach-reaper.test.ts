import { describe, expect, it } from 'vitest';
import {
  findStaleDtachAttachers,
  reapStaleDtachAttachers,
  type ProcessTableEntry,
} from './dtach-attach-reaper.js';
import type { ProcessSignaler } from './process-signal-escalation.js';

const INSTANCE_DIR = '/tmp/kookr-dtach/1000/port-4800';

describe('findStaleDtachAttachers', () => {
  it('ignores processes that do not mention dtach at all', () => {
    const entries: ProcessTableEntry[] = [
      { pid: 1, command: `bash -c "cat ${INSTANCE_DIR}/kookr-abc.sock"` },
    ];
    expect(findStaleDtachAttachers(INSTANCE_DIR, entries, () => false)).toEqual([]);
  });

  it('ignores dtach MASTER processes (`-n`, not `-a`)', () => {
    const entries: ProcessTableEntry[] = [
      { pid: 2, command: `dtach -n ${INSTANCE_DIR}/kookr-abc.sock -r winch -E claude` },
    ];
    expect(findStaleDtachAttachers(INSTANCE_DIR, entries, () => false)).toEqual([]);
  });

  it('ignores an attach client outside this instance\'s socket directory (never touch another port or a user terminal)', () => {
    const entries: ProcessTableEntry[] = [
      { pid: 3, command: 'dtach -a /tmp/kookr-dtach/1000/port-4801/kookr-xyz.sock -E' },
      { pid: 4, command: 'dtach -a /home/user/.dtach/my-session.sock -E' },
    ];
    expect(findStaleDtachAttachers(INSTANCE_DIR, entries, () => false)).toEqual([]);
  });

  it('ignores an in-scope attach client whose socket still exists (a live attach, not stale)', () => {
    const sock = `${INSTANCE_DIR}/kookr-abc.sock`;
    const entries: ProcessTableEntry[] = [{ pid: 5, command: `dtach -a ${sock} -E` }];
    expect(findStaleDtachAttachers(INSTANCE_DIR, entries, (s) => s === sock)).toEqual([]);
  });

  it('flags an in-scope attach client whose socket no longer exists (issue #1720 leak class 3)', () => {
    const sock = `${INSTANCE_DIR}/kookr-abc.sock`;
    const entries: ProcessTableEntry[] = [{ pid: 6, command: `dtach -a ${sock} -E` }];
    expect(findStaleDtachAttachers(INSTANCE_DIR, entries, () => false)).toEqual([{ pid: 6, sock }]);
  });

  it('flags a vendored-binary-path attach client the same way', () => {
    const sock = `${INSTANCE_DIR}/kookr-def.sock`;
    const entries: ProcessTableEntry[] = [
      { pid: 7, command: `/repo/vendor/dtach/dtach -a ${sock} -E` },
    ];
    expect(findStaleDtachAttachers(INSTANCE_DIR, entries, () => false)).toEqual([{ pid: 7, sock }]);
  });

  it('scans a mixed process table and returns only the stale, in-scope attach clients', () => {
    const staleSock = `${INSTANCE_DIR}/kookr-stale.sock`;
    const liveSock = `${INSTANCE_DIR}/kookr-live.sock`;
    const entries: ProcessTableEntry[] = [
      { pid: 10, command: `dtach -n ${liveSock} -r winch -E claude` }, // master — never touched
      { pid: 11, command: `dtach -a ${liveSock} -E` }, // live attach — socket present
      { pid: 12, command: `dtach -a ${staleSock} -E` }, // stale — socket gone
      { pid: 13, command: 'bash' }, // unrelated
      { pid: 14, command: 'dtach -a /tmp/kookr-dtach/1000/port-9999/kookr-other.sock -E' }, // other instance
    ];
    const socketExists = (sock: string) => sock === liveSock;
    expect(findStaleDtachAttachers(INSTANCE_DIR, entries, socketExists)).toEqual([
      { pid: 12, sock: staleSock },
    ]);
  });
});

describe('reapStaleDtachAttachers', () => {
  it('is a no-op when nothing is stale — never signals anything', async () => {
    const signaler: ProcessSignaler = {
      isAlive: () => true,
      signal: () => {
        throw new Error('should not signal when nothing is stale');
      },
    };
    const result = await reapStaleDtachAttachers(INSTANCE_DIR, {
      listProcesses: () => [{ pid: 1, command: 'bash' }],
      socketExists: () => true,
      signaler,
    });
    expect(result).toEqual([]);
  });

  it('escalates TERM before KILL, in order, for identified stale attachers (issue #1720 acceptance criteria)', async () => {
    const sock = `${INSTANCE_DIR}/kookr-stale.sock`;
    const calls: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    let aliveAfterTerm = true;
    const signaler: ProcessSignaler = {
      isAlive: (pid) => (pid === 99 ? aliveAfterTerm : false),
      signal: (pid, sig) => {
        calls.push({ pid, sig });
        if (sig === 'SIGTERM') aliveAfterTerm = false; // model the process exiting on TERM
      },
    };

    const result = await reapStaleDtachAttachers(INSTANCE_DIR, {
      listProcesses: () => [{ pid: 99, command: `dtach -a ${sock} -E` }],
      socketExists: () => false,
      signaler,
      graceMs: 5,
      sleep: async () => {},
    });

    expect(result).toEqual([{ pid: 99, sock }]);
    // TERM was sent, and since the process died before the grace window
    // elapsed, KILL is never sent — no redundant signal.
    expect(calls).toEqual([{ pid: 99, sig: 'SIGTERM' }]);
  });

  it('escalates to SIGKILL only for survivors past the grace period, after SIGTERM', async () => {
    const sock = `${INSTANCE_DIR}/kookr-stubborn.sock`;
    const calls: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const signaler: ProcessSignaler = {
      isAlive: () => true, // never dies on its own — ignores SIGTERM
      signal: (pid, sig) => {
        calls.push({ pid, sig });
      },
    };

    await reapStaleDtachAttachers(INSTANCE_DIR, {
      listProcesses: () => [{ pid: 100, command: `dtach -a ${sock} -E` }],
      socketExists: () => false,
      signaler,
      graceMs: 5,
      sleep: async () => {},
    });

    expect(calls).toEqual([
      { pid: 100, sig: 'SIGTERM' },
      { pid: 100, sig: 'SIGKILL' },
    ]);
  });

  it('sends SIGTERM to every stale attacher before sending SIGKILL to any of them', async () => {
    // Multi-pid guarantee: even when one process dies quickly on SIGTERM and
    // another does not, the second pid's SIGKILL must never be sent before
    // ALL pids have received their SIGTERM.
    const sockA = `${INSTANCE_DIR}/kookr-a.sock`;
    const sockB = `${INSTANCE_DIR}/kookr-b.sock`;
    const calls: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    const alive = new Map<number, boolean>([[201, true], [202, true]]);
    const signaler: ProcessSignaler = {
      isAlive: (pid) => alive.get(pid) ?? false,
      signal: (pid, sig) => {
        calls.push({ pid, sig });
        if (sig === 'SIGTERM' && pid === 201) alive.set(201, false); // pid 201 dies on TERM
        // pid 202 ignores SIGTERM entirely — only SIGKILL takes it down.
        if (sig === 'SIGKILL') alive.set(pid, false);
      },
    };

    await reapStaleDtachAttachers(INSTANCE_DIR, {
      listProcesses: () => [
        { pid: 201, command: `dtach -a ${sockA} -E` },
        { pid: 202, command: `dtach -a ${sockB} -E` },
      ],
      socketExists: () => false,
      signaler,
      graceMs: 5,
      sleep: async () => {},
    });

    const termCalls = calls.filter((c) => c.sig === 'SIGTERM');
    const killCalls = calls.filter((c) => c.sig === 'SIGKILL');
    expect(termCalls).toEqual([{ pid: 201, sig: 'SIGTERM' }, { pid: 202, sig: 'SIGTERM' }]);
    // Only the survivor (202) is escalated to KILL.
    expect(killCalls).toEqual([{ pid: 202, sig: 'SIGKILL' }]);
    // Ordering: every TERM call precedes every KILL call in the overall trace.
    const lastTermIndex = calls.map((c) => c.sig).lastIndexOf('SIGTERM');
    const firstKillIndex = calls.map((c) => c.sig).indexOf('SIGKILL');
    expect(lastTermIndex).toBeLessThan(firstKillIndex);
  });
});
