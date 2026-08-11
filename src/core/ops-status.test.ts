import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  OPS_STATUS_FILE_NAME,
  OPS_STATUS_MAX_EDGES,
  OPS_STATUS_SCHEMA_VERSION,
  OpsStatusWriter,
  appendOpsStatusEdge,
  buildOpsStatusSnapshot,
  isOpsStatusSnapshot,
  opsStatusEdgeFromOperationalAlert,
  opsStatusPath,
  type OpsStatusEdge,
  type OpsStatusLiveFields,
  type OpsStatusSnapshot,
} from './ops-status.js';
import { atomicWriteFile } from './persistence-utils.js';

const LIVE: OpsStatusLiveFields = {
  sha: 'abc1234deadbeef',
  hungSuspectCount: 2,
  dataDirectoryFreePercent: 41.5,
  dataDirectoryFreeBytes: 12_000_000_000,
  safeMode: { engaged: false },
};

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

describe('ops-status schema', () => {
  it('buildOpsStatusSnapshot produces a schema-valid card with read-only fields only', () => {
    const edges: OpsStatusEdge[] = [
      { kind: 'dead_man_fire', at: '2026-08-03T12:00:00.000Z', detail: 'schedule starved' },
    ];
    const snap = buildOpsStatusSnapshot(LIVE, edges, '2026-08-03T12:00:00.000Z');

    expect(isOpsStatusSnapshot(snap)).toBe(true);
    expect(snap).toEqual<OpsStatusSnapshot>({
      schemaVersion: OPS_STATUS_SCHEMA_VERSION,
      updatedAt: '2026-08-03T12:00:00.000Z',
      sha: 'abc1234deadbeef',
      hungSuspectCount: 2,
      dataDirectoryFreePercent: 41.5,
      dataDirectoryFreeBytes: 12_000_000_000,
      safeMode: { engaged: false },
      lastEdges: [
        { kind: 'dead_man_fire', at: '2026-08-03T12:00:00.000Z', detail: 'schedule starved' },
      ],
    });

    // No secret-shaped keys may appear on the card.
    const keys = Object.keys(snap);
    expect(keys).toEqual([
      'schemaVersion',
      'updatedAt',
      'sha',
      'hungSuspectCount',
      'dataDirectoryFreePercent',
      'dataDirectoryFreeBytes',
      'safeMode',
      'lastEdges',
    ]);
    expect(JSON.stringify(snap)).not.toMatch(/token|password|secret|api[_-]?key|authorization/i);
  });

  it('isOpsStatusSnapshot rejects wrong version, missing fields, and bad edges', () => {
    const good = buildOpsStatusSnapshot(LIVE, [], '2026-08-03T12:00:00.000Z');
    expect(isOpsStatusSnapshot(good)).toBe(true);
    expect(isOpsStatusSnapshot({ ...good, schemaVersion: 'ops-status.v0' })).toBe(false);
    expect(isOpsStatusSnapshot({ ...good, hungSuspectCount: -1 })).toBe(false);
    expect(isOpsStatusSnapshot({ ...good, lastEdges: [{ kind: 'nope', at: 'x' }] })).toBe(false);
    expect(isOpsStatusSnapshot(null)).toBe(false);
    expect(isOpsStatusSnapshot('not-an-object')).toBe(false);
  });

  it('appendOpsStatusEdge keeps a newest-last ring within maxEdges', () => {
    let edges: OpsStatusEdge[] = [];
    for (let i = 0; i < OPS_STATUS_MAX_EDGES + 3; i++) {
      edges = appendOpsStatusEdge(edges, {
        kind: 'ready_degrade',
        at: `2026-08-03T12:00:${String(i).padStart(2, '0')}.000Z`,
      }, OPS_STATUS_MAX_EDGES);
    }
    expect(edges).toHaveLength(OPS_STATUS_MAX_EDGES);
    expect(edges[0]?.at).toBe('2026-08-03T12:00:03.000Z');
    expect(edges[edges.length - 1]?.at).toBe(
      `2026-08-03T12:00:${String(OPS_STATUS_MAX_EDGES + 2).padStart(2, '0')}.000Z`,
    );
  });

  it('opsStatusPath points at ~/.kookr/ops-status.json convention', () => {
    expect(opsStatusPath('/home/jean/.kookr')).toBe(join('/home/jean/.kookr', OPS_STATUS_FILE_NAME));
  });
});

describe('opsStatusEdgeFromOperationalAlert', () => {
  it('maps dead-man and pipeline starvation fires; ignores recovery and other metrics', () => {
    expect(
      opsStatusEdgeFromOperationalAlert({
        summary: 'Schedule starvation',
        operationalAlert: { key: 'schedule:dead_man', metric: 'schedule_starvation', state: 'fired' },
      }),
    ).toEqual({ kind: 'dead_man_fire', detail: 'Schedule starvation' });

    expect(
      opsStatusEdgeFromOperationalAlert({
        summary: 'Pipeline starvation: kookr-ai/kookr',
        operationalAlert: {
          key: 'pipeline:starvation:kookr-ai/kookr',
          metric: 'pipeline_starvation',
          state: 'fired',
        },
      }),
    ).toEqual({ kind: 'starvation_fire', detail: 'Pipeline starvation: kookr-ai/kookr' });

    expect(
      opsStatusEdgeFromOperationalAlert({
        operationalAlert: { key: 'schedule:dead_man', metric: 'schedule_starvation', state: 'recovered' },
      }),
    ).toBeNull();

    expect(
      opsStatusEdgeFromOperationalAlert({
        operationalAlert: { key: 'host:cpu', metric: 'cpu_percent', state: 'fired' },
      }),
    ).toBeNull();

    expect(opsStatusEdgeFromOperationalAlert({})).toBeNull();
  });

  it('maps prod_smoke_tick fire and recover (issue #2032)', () => {
    expect(
      opsStatusEdgeFromOperationalAlert({
        summary: 'Prod smoke tick failing: health, ready',
        operationalAlert: { key: 'smoke:hourly', metric: 'prod_smoke_tick', state: 'fired' },
      }),
    ).toEqual({ kind: 'smoke_tick_fire', detail: 'Prod smoke tick failing: health, ready' });

    expect(
      opsStatusEdgeFromOperationalAlert({
        summary: 'Prod smoke tick recovered',
        operationalAlert: { key: 'smoke:hourly', metric: 'prod_smoke_tick', state: 'recovered' },
      }),
    ).toEqual({ kind: 'smoke_tick_clear', detail: 'Prod smoke tick recovered' });
  });
});

describe('OpsStatusWriter', () => {
  async function makeWriter(opts?: {
    fields?: OpsStatusLiveFields;
    nowIso?: string;
    writeFileAtomically?: (filePath: string, data: string) => Promise<void>;
  }): Promise<{ writer: OpsStatusWriter; filePath: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'ops-status-'));
    const filePath = opsStatusPath(dir);
    const writer = new OpsStatusWriter({
      filePath,
      getLiveFields: () => opts?.fields ?? LIVE,
      now: fixedNow(opts?.nowIso ?? '2026-08-03T15:00:00.000Z'),
      ...(opts?.writeFileAtomically ? { writeFileAtomically: opts.writeFileAtomically } : {}),
      logger: { warn: vi.fn() },
    });
    return { writer, filePath, dir };
  }

  it('atomically writes a schema-valid card on a synthetic edge', async () => {
    const { writer, filePath } = await makeWriter();
    const snap = await writer.noteEdge('starvation_fire', 'synthetic edge');

    expect(snap).not.toBeNull();
    expect(isOpsStatusSnapshot(snap)).toBe(true);
    expect(snap?.lastEdges).toEqual([
      {
        kind: 'starvation_fire',
        at: '2026-08-03T15:00:00.000Z',
        detail: 'synthetic edge',
      },
    ]);

    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    expect(isOpsStatusSnapshot(parsed)).toBe(true);
    expect(parsed).toEqual(snap);
    // Compact JSON with trailing newline (machine-read card; issue #2253).
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toBe(`${JSON.stringify(snap)}\n`);
    expect(raw).not.toMatch(/\n {2}"/);
  });

  it('accumulates edges across successive critical events', async () => {
    let tick = 0;
    const dir = await mkdtemp(join(tmpdir(), 'ops-status-'));
    const filePath = opsStatusPath(dir);
    const writer = new OpsStatusWriter({
      filePath,
      getLiveFields: () => LIVE,
      now: () => new Date(`2026-08-03T15:00:0${tick++}.000Z`),
      logger: { warn: vi.fn() },
    });

    await writer.noteEdge('ready_degrade', 'persistence unwritable');
    await writer.noteFromAlert({
      summary: 'dead man',
      operationalAlert: { key: 'schedule:dead_man', metric: 'schedule_starvation', state: 'fired' },
    });
    await writer.noteSafeModeEngaged(true, 'operator kill-switch');
    await writer.noteFromAlert({
      summary: 'starved',
      operationalAlert: {
        key: 'pipeline:starvation:kookr-ai/kookr',
        metric: 'pipeline_starvation',
        state: 'fired',
      },
    });
    await writer.noteEdge('smoke_tick_fire', 'health, version-probe');
    const final = await writer.noteEdge('smoke_tick_clear');

    expect(final?.lastEdges.map((e) => e.kind)).toEqual([
      'ready_degrade',
      'dead_man_fire',
      'safe_mode_engage',
      'starvation_fire',
      'smoke_tick_fire',
      'smoke_tick_clear',
    ]);
    expect(isOpsStatusSnapshot(JSON.parse(await readFile(filePath, 'utf-8')))).toBe(true);
  });

  it('schema guard accepts smoke_tick_fire/clear and ring-caps them (issue #2032)', async () => {
    let tick = 0;
    const dir = await mkdtemp(join(tmpdir(), 'ops-status-'));
    const filePath = opsStatusPath(dir);
    const writer = new OpsStatusWriter({
      filePath,
      getLiveFields: () => LIVE,
      now: () => new Date(`2026-08-03T16:${String(tick++).padStart(2, '0')}:00.000Z`),
      logger: { warn: vi.fn() },
      maxEdges: 3,
    });

    // Overflow the ring with smoke fire/clear pairs so older edges drop.
    await writer.noteEdge('smoke_tick_fire', 'health');
    await writer.noteEdge('smoke_tick_clear');
    await writer.noteEdge('smoke_tick_fire', 'ready, tasks-latency');
    const final = await writer.noteEdge('smoke_tick_clear');

    expect(final?.lastEdges).toHaveLength(3);
    expect(final?.lastEdges.map((e) => e.kind)).toEqual([
      'smoke_tick_clear',
      'smoke_tick_fire',
      'smoke_tick_clear',
    ]);
    expect(final?.lastEdges[1]?.detail).toBe('ready, tasks-latency');
    expect(isOpsStatusSnapshot(final)).toBe(true);
    expect(isOpsStatusSnapshot(JSON.parse(await readFile(filePath, 'utf-8')))).toBe(true);
  });

  it('ready verdict writes only on the degrade edge', async () => {
    const { writer, filePath } = await makeWriter();

    expect(await writer.noteReadyVerdict(true)).toBeNull();
    expect(await writer.noteReadyVerdict(true)).toBeNull();

    const first = await writer.noteReadyVerdict(false, 'drain-mode');
    expect(first?.lastEdges).toHaveLength(1);
    expect(first?.lastEdges[0]?.kind).toBe('ready_degrade');

    // Still not ready → no second write.
    expect(await writer.noteReadyVerdict(false)).toBeNull();

    // Recover then degrade again → second edge.
    expect(await writer.noteReadyVerdict(true)).toBeNull();
    const second = await writer.noteReadyVerdict(false, 'schedulerTick stale');
    expect(second?.lastEdges).toHaveLength(2);

    const onDisk = JSON.parse(await readFile(filePath, 'utf-8')) as OpsStatusSnapshot;
    expect(onDisk.lastEdges).toHaveLength(2);
  });

  it('safeMode writes only on the engage edge', async () => {
    const { writer } = await makeWriter({
      fields: { ...LIVE, safeMode: { engaged: true, since: '2026-08-03T14:00:00.000Z' } },
    });

    const first = await writer.noteSafeModeEngaged(true);
    expect(first?.lastEdges[0]?.kind).toBe('safe_mode_engage');
    expect(first?.safeMode).toEqual({ engaged: true, since: '2026-08-03T14:00:00.000Z' });

    expect(await writer.noteSafeModeEngaged(true)).toBeNull();
    expect(await writer.noteSafeModeEngaged(false)).toBeNull();
    const reengage = await writer.noteSafeModeEngaged(true);
    expect(reengage?.lastEdges).toHaveLength(2);
  });

  it('swallows write failures (disk-full) without throwing', async () => {
    const warn = vi.fn();
    const dir = await mkdtemp(join(tmpdir(), 'ops-status-'));
    const writer = new OpsStatusWriter({
      filePath: opsStatusPath(dir),
      getLiveFields: () => LIVE,
      now: fixedNow('2026-08-03T15:00:00.000Z'),
      writeFileAtomically: async () => {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      },
      logger: { warn },
    });

    await expect(writer.noteEdge('dead_man_fire')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(writer.getLastWritten()).toBeNull();
  });

  it('retries ready_degrade after ENOSPC so disk-full does not suppress the episode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-status-'));
    const filePath = opsStatusPath(dir);
    let failOnce = true;
    const writer = new OpsStatusWriter({
      filePath,
      getLiveFields: () => LIVE,
      now: fixedNow('2026-08-03T15:00:00.000Z'),
      writeFileAtomically: async (path, data) => {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        }
        await atomicWriteFile(path, data);
      },
      logger: { warn: vi.fn() },
    });

    // First degrade while disk is full — de-dupe must NOT lock.
    await expect(writer.noteReadyVerdict(false, 'persistence unwritable')).resolves.toBeNull();
    // Still degraded: retry and land the card once space is free.
    const snap = await writer.noteReadyVerdict(false, 'persistence unwritable');
    expect(snap).not.toBeNull();
    expect(snap?.lastEdges[0]?.kind).toBe('ready_degrade');
    expect(isOpsStatusSnapshot(JSON.parse(await readFile(filePath, 'utf-8')))).toBe(true);
    // Now locked: further degraded polls do not re-write.
    expect(await writer.noteReadyVerdict(false)).toBeNull();
  });

  it('ignores recovered operational alerts so the card is not flapped', async () => {
    const { writer, filePath } = await makeWriter();
    await writer.noteFromAlert({
      operationalAlert: { key: 'schedule:dead_man', metric: 'schedule_starvation', state: 'recovered' },
    });
    await expect(readFile(filePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses atomic write (injected seam receives full JSON body)', async () => {
    const writes: string[] = [];
    const { writer } = await makeWriter({
      writeFileAtomically: async (_path, data) => {
        writes.push(data);
        // Also prove a real atomic path works by writing via the default helper
        // is not required here — we only assert the writer routes through the seam.
        await writeFile(_path, data, 'utf-8');
      },
    });
    await writer.noteEdge('ready_degrade');
    expect(writes).toHaveLength(1);
    expect(isOpsStatusSnapshot(JSON.parse(writes[0]!))).toBe(true);
  });
});
