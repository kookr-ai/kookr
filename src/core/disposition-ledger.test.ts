import { mkdtemp, open, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  appendDispositionEntry,
  auditRecoveryDispositions,
  queryDispositionsByIncident,
  queryDispositionsByWindow,
  readDispositionEntries,
  type DispositionEntry,
} from './disposition-ledger.js';

let dir: string;
let ledgerPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'disposition-ledger-'));
  ledgerPath = join(dir, 'nested', 'disposition-ledger.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<DispositionEntry> & Pick<DispositionEntry, 'taskId'>): DispositionEntry {
  return {
    schemaVersion: 'disposition-ledger.v1',
    disposition: 'respawned',
    detail: 'respawned-as: task-new-1',
    incidentId: 'incident-1',
    source: 'hung-task-reaper',
    at: '2026-07-24T09:19:00.000Z',
    ...overrides,
  };
}

describe('appendDispositionEntry / readDispositionEntries', () => {
  test('round-trips a single entry, creating the parent directory', async () => {
    const written = entry({ taskId: 'task-1' });
    await appendDispositionEntry(ledgerPath, written);

    const entries = await readDispositionEntries(ledgerPath);
    expect(entries).toEqual([written]);
  });

  test('appends multiple entries as separate JSONL lines', async () => {
    await appendDispositionEntry(ledgerPath, entry({ taskId: 'task-1' }));
    await appendDispositionEntry(ledgerPath, entry({ taskId: 'task-2', disposition: 'obsolete', detail: 'obsolete-because: superseded' }));

    const raw = await readFile(ledgerPath, 'utf-8');
    expect(raw.trim().split('\n')).toHaveLength(2);

    const entries = await readDispositionEntries(ledgerPath);
    expect(entries.map((e) => e.taskId)).toEqual(['task-1', 'task-2']);
  });

  test('reading a ledger that was never written to returns an empty array', async () => {
    await expect(readDispositionEntries(ledgerPath)).resolves.toEqual([]);
  });

  test('fsyncs the ledger handle before resolving so a crash cannot drop the last line', async () => {
    // Probe a real handle so we can spy FileHandle.prototype.sync without
    // mocking the whole node:fs/promises module (still used for open/readFile/rm).
    const probe = await open(join(dir, '.sync-probe'), 'a');
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const syncSpy = vi.spyOn(proto, 'sync');

    try {
      await appendDispositionEntry(ledgerPath, entry({ taskId: 'task-1' }));
      expect(syncSpy).toHaveBeenCalled();
    } finally {
      syncSpy.mockRestore();
    }

    await expect(readDispositionEntries(ledgerPath)).resolves.toEqual([entry({ taskId: 'task-1' })]);
  });
});

describe('queryDispositionsByIncident', () => {
  test('returns only entries matching the incident id', async () => {
    await appendDispositionEntry(ledgerPath, entry({ taskId: 'task-1', incidentId: 'incident-a' }));
    await appendDispositionEntry(ledgerPath, entry({ taskId: 'task-2', incidentId: 'incident-b' }));
    await appendDispositionEntry(ledgerPath, entry({ taskId: 'task-3', incidentId: 'incident-a' }));

    const found = await queryDispositionsByIncident(ledgerPath, 'incident-a');
    expect(found.map((e) => e.taskId).sort()).toEqual(['task-1', 'task-3']);
  });
});

describe('queryDispositionsByWindow', () => {
  test('returns only entries whose timestamp falls inside the window', async () => {
    await appendDispositionEntry(ledgerPath, entry({ taskId: 'before', at: '2026-07-24T08:00:00.000Z' }));
    await appendDispositionEntry(ledgerPath, entry({ taskId: 'inside', at: '2026-07-24T09:19:00.000Z' }));
    await appendDispositionEntry(ledgerPath, entry({ taskId: 'after', at: '2026-07-24T12:00:00.000Z' }));

    const found = await queryDispositionsByWindow(
      ledgerPath,
      Date.parse('2026-07-24T09:00:00.000Z'),
      Date.parse('2026-07-24T10:00:00.000Z'),
    );
    expect(found.map((e) => e.taskId)).toEqual(['inside']);
  });
});

describe('auditRecoveryDispositions', () => {
  const window = {
    startMs: Date.parse('2026-07-24T09:00:00.000Z'),
    endMs: Date.parse('2026-07-24T10:00:00.000Z'),
  };

  test('flags a cancelled task with no disposition entry in the window', async () => {
    // #1542 has a disposition; #1543 (the incident's actual gap) does not.
    await appendDispositionEntry(ledgerPath, entry({ taskId: '#1542', at: '2026-07-24T09:19:00.000Z' }));

    const result = await auditRecoveryDispositions(
      ledgerPath,
      [
        { taskId: '#1542', status: 'cancelled' },
        { taskId: '#1543', status: 'cancelled' },
      ],
      window,
    );

    expect(result.checkedTaskCount).toBe(2);
    expect(result.offenders).toEqual([{ taskId: '#1543', status: 'cancelled' }]);
  });

  test('passes with no offenders when every cancelled/degraded task has a disposition', async () => {
    await appendDispositionEntry(ledgerPath, entry({ taskId: '#1542', at: '2026-07-24T09:19:00.000Z' }));
    await appendDispositionEntry(ledgerPath, entry({
      taskId: '#1543',
      at: '2026-07-24T09:20:00.000Z',
      disposition: 'needs-human',
      detail: 'needs-human',
    }));

    const result = await auditRecoveryDispositions(
      ledgerPath,
      [
        { taskId: '#1542', status: 'cancelled' },
        { taskId: '#1543', status: 'cancelled' },
      ],
      window,
    );

    expect(result.offenders).toEqual([]);
  });

  test('a disposition entry recorded outside the window does not count as coverage', async () => {
    await appendDispositionEntry(ledgerPath, entry({ taskId: '#1543', at: '2026-07-25T09:19:00.000Z' }));

    const result = await auditRecoveryDispositions(
      ledgerPath,
      [{ taskId: '#1543', status: 'degraded' }],
      window,
    );

    expect(result.offenders).toEqual([{ taskId: '#1543', status: 'degraded' }]);
  });
});
