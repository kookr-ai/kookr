import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseRetroVerifyArgs,
  runRetroVerifyCli,
  type RetroVerifyCliIo,
} from './kookr-retro-verify.js';
import { buildRetroVerifyEntry, enqueueRetroVerify } from '../core/retro-verify-queue.js';
import { CI_BLIND_DEBT_SCHEMA } from '../core/ci-blind-debt.js';

function mkIo(): RetroVerifyCliIo & { logs: string[]; errs: string[] } {
  const logs: string[] = [];
  const errs: string[] = [];
  return {
    logs,
    errs,
    out: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
    err: { error: (...a: unknown[]) => errs.push(a.map(String).join(' ')) },
    now: () => new Date('2026-07-30T12:00:00.000Z'),
  };
}

describe('parseRetroVerifyArgs', () => {
  it('parses status and drain flags', () => {
    expect(parseRetroVerifyArgs(['status', '--json', '--dir', '/tmp/q'])).toMatchObject({
      verb: 'status',
      json: true,
      dir: '/tmp/q',
    });
    expect(
      parseRetroVerifyArgs(['drain', '--limit', '3', '--dry-run', '--verify-cmd', 'true']),
    ).toMatchObject({
      verb: 'drain',
      limit: 3,
      dryRun: true,
      verifyCmd: 'true',
    });
  });
});

describe('runRetroVerifyCli (issue #1703)', () => {
  it('status reports zero ci_blind_debt on an empty queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-rv-'));
    const io = mkIo();
    try {
      const code = await runRetroVerifyCli(['status', '--dir', dir, '--json'], io);
      expect(code).toBe(0);
      const payload = JSON.parse(io.logs[0]!);
      expect(payload.ci_blind_debt.schemaVersion).toBe(CI_BLIND_DEBT_SCHEMA);
      expect(payload.ci_blind_debt.queueDepth).toBe(0);
      expect(payload.ciBlindDebt.blindMergeCount).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('status surfaces queue depth after enqueue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-rv-'));
    const io = mkIo();
    try {
      await enqueueRetroVerify(
        dir,
        buildRetroVerifyEntry({
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          prNumber: 42,
          repo: 'jeanibarz/lucy',
          reason: 'verified-locally',
          createdAt: '2026-07-28T00:00:00.000Z',
        }),
      );
      const code = await runRetroVerifyCli(['status', '--dir', dir, '--json'], {
        ...io,
        now: () => new Date('2026-07-30T00:00:00.000Z'),
      });
      expect(code).toBe(0);
      const payload = JSON.parse(io.logs[0]!);
      expect(payload.ci_blind_debt.queueDepth).toBe(1);
      expect(payload.ci_blind_debt.blindMergeCount).toBe(1);
      expect(payload.ci_blind_debt.byRepo['jeanibarz/lucy']).toBe(1);
      expect(payload.ci_blind_debt.oldestAgeMs).toBe(2 * 24 * 60 * 60 * 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drain pass dequeues; fail files a P1 and dequeues', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-rv-'));
    const io = mkIo();
    try {
      await enqueueRetroVerify(
        dir,
        buildRetroVerifyEntry({
          sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          prNumber: 7,
          repo: 'jeanibarz/lucy',
          reason: 'ci-signal-absent',
        }),
      );
      await enqueueRetroVerify(
        dir,
        buildRetroVerifyEntry({
          sha: 'cccccccccccccccccccccccccccccccccccccccc',
          prNumber: 8,
          repo: 'jeanibarz/lucy',
          reason: 'verified-locally',
        }),
      );

      const filed: string[] = [];
      const code = await runRetroVerifyCli(['drain', '--dir', dir, '--json'], {
        ...io,
        verify: async (entry) =>
          entry.sha.startsWith('b')
            ? { outcome: 'pass' }
            : { outcome: 'fail', error: 'suite red' },
        fileP1: async (entry) => {
          filed.push(entry.sha);
          return { filed: true, issueRef: `https://github.com/${entry.repo}/issues/99` };
        },
      });
      expect(code).toBe(4); // had a failure
      const payload = JSON.parse(io.logs[0]!);
      expect(payload.drain.passed).toBe(1);
      expect(payload.drain.failed).toBe(1);
      expect(payload.drain.p1Filed).toBe(1);
      expect(payload.drain.remaining).toBe(0);
      expect(payload.ci_blind_debt.queueDepth).toBe(0);
      expect(filed).toEqual(['cccccccccccccccccccccccccccccccccccccccc']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enqueue records a merge and is idempotent on SHA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-rv-'));
    const io = mkIo();
    try {
      const args = [
        'enqueue',
        '--dir',
        dir,
        '--sha',
        'dddddddddddddddddddddddddddddddddddddddd',
        '--repo',
        'kookr-ai/kookr',
        '--pr',
        '1703',
        '--reason',
        'verified-locally',
        '--json',
      ];
      expect(await runRetroVerifyCli(args, io)).toBe(0);
      expect(JSON.parse(io.logs[0]!).enqueued).toBe(true);
      io.logs.length = 0;
      expect(await runRetroVerifyCli(args, io)).toBe(0);
      expect(JSON.parse(io.logs[0]!).enqueued).toBe(false);
      expect(JSON.parse(io.logs[0]!).reason).toBe('duplicate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
