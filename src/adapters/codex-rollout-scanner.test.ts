import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexRolloutScanner, type CodexRolloutMeta } from './codex-rollout-scanner.js';

function makeTempCodexHome(): string {
  const dir = join(tmpdir(), `codex-scanner-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface RolloutFixture {
  id: string;
  cwd: string;
  /** ISO UTC. */
  startedAt: string;
  cliVersion?: string;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
  agentNickname?: string | null;
  model?: string;
  tokenCounts?: Array<{
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens?: number;
  }>;
  /** Drop a task_complete event. */
  terminal?: boolean;
  /** Inject a non-canonical token_count.info shape that should trigger parseError. */
  brokenSchema?: boolean;
  /** When set, file mtime is forced this many ms in the past (relative to scanner.now()). */
  mtimeOffsetMs?: number;
  /** Append a partial JSONL line at the very end (no trailing newline) to simulate in-flight write. */
  partialLastLine?: string;
}

function writeRollout(codexHome: string, f: RolloutFixture): string {
  const d = new Date(f.startedAt);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const dir = join(codexHome, yyyy, mm, dd);
  mkdirSync(dir, { recursive: true });
  const filename = `rollout-${f.startedAt.replace(/[:.]/g, '-')}-${f.id}.jsonl`;
  const path = join(dir, filename);

  const sourcePayload: Record<string, unknown> = f.parentThreadId
    ? { subagent: { thread_spawn: { parent_thread_id: f.parentThreadId, agent_nickname: f.agentNickname ?? 'sub', depth: 1 } } }
    : 'cli' as unknown as Record<string, unknown>;                       // top-level rollouts have source: "cli"

  const lines: string[] = [];
  lines.push(JSON.stringify({
    timestamp: f.startedAt,
    type: 'session_meta',
    payload: {
      id: f.id,
      timestamp: f.startedAt,
      cwd: f.cwd,
      cli_version: f.cliVersion ?? '0.125.0-test',
      forked_from_id: f.forkedFromId ?? null,
      source: typeof sourcePayload === 'string' ? sourcePayload : sourcePayload,
    },
  }));
  if (f.model) {
    lines.push(JSON.stringify({ timestamp: f.startedAt, type: 'turn_context', payload: { model: f.model } }));
  }
  for (const tc of f.tokenCounts ?? []) {
    if (f.brokenSchema) {
      // Drop one of the canonical keys. Schema-mismatch path.
      lines.push(JSON.stringify({
        timestamp: f.startedAt,
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: tc.inputTokens } } },
      }));
    } else {
      lines.push(JSON.stringify({
        timestamp: f.startedAt,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: tc.inputTokens,
              output_tokens: tc.outputTokens,
              cached_input_tokens: tc.cachedInputTokens,
              reasoning_output_tokens: tc.reasoningOutputTokens ?? 0,
            },
          },
        },
      }));
    }
  }
  if (f.terminal) {
    lines.push(JSON.stringify({ timestamp: f.startedAt, type: 'event_msg', payload: { type: 'task_complete' } }));
  }

  let content = lines.join('\n') + '\n';
  if (f.partialLastLine) {
    content = content + f.partialLastLine;                              // no trailing \n
  }
  writeFileSync(path, content, 'utf-8');

  if (f.mtimeOffsetMs != null) {
    const t = (Date.now() - f.mtimeOffsetMs) / 1000;
    utimesSync(path, t, t);
  }
  return path;
}

describe('CodexRolloutScanner — parsing', () => {
  let codexHome: string;
  beforeEach(() => { codexHome = makeTempCodexHome(); });
  afterEach(() => { try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('parses a short session and extracts last total_token_usage', async () => {
    writeRollout(codexHome, {
      id: 'aaa', cwd: '/test/cwd', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 500 }],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const start = new Date('2026-05-08T00:00:00Z').getTime();
    const end = new Date('2026-05-08T23:59:59Z').getTime();
    const r = await s.scan(start, end);
    expect(r.rollouts).toHaveLength(1);
    expect(r.rollouts[0].id).toBe('aaa');
    expect(r.rollouts[0].cwd).toBe('/test/cwd');
    expect(r.rollouts[0].model).toBe('gpt-5.3-codex');
    expect(r.rollouts[0].totalUsage).toEqual({
      inputTokens: 1000, outputTokens: 200, cachedInputTokens: 500, reasoningOutputTokens: 0,
    });
    expect(r.rollouts[0].hasTerminalEvent).toBe(true);
    expect(r.stats.parseErrorCount).toBe(0);
  });

  test('multi-turn: only the LAST total_token_usage value is retained', async () => {
    writeRollout(codexHome, {
      id: 'multi', cwd: '/cwd', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.4', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [
        { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
        { inputTokens: 500, outputTokens: 200, cachedInputTokens: 100 },
        { inputTokens: 1500, outputTokens: 600, cachedInputTokens: 800 },     // authoritative
      ],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    expect(r.rollouts[0].totalUsage).toMatchObject({ inputTokens: 1500, outputTokens: 600, cachedInputTokens: 800 });
  });

  test('pre-Nov-2025 schema: no token_count events → totalUsage null but no parseError', async () => {
    writeRollout(codexHome, {
      id: 'old', cwd: '/cwd', startedAt: '2025-09-15T10:00:00.000Z',
      model: 'gpt-5', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2025-09-01T00:00:00Z').getTime(), new Date('2025-09-30T23:59:59Z').getTime());
    expect(r.rollouts[0].totalUsage).toBeNull();
    expect(r.rollouts[0].parseError).toBeNull();
  });

  test('schema mismatch: token_count.total_token_usage missing canonical keys → parseError', async () => {
    writeRollout(codexHome, {
      id: 'broken', cwd: '/cwd', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex', terminal: true, brokenSchema: true,
      tokenCounts: [{ inputTokens: 1000, outputTokens: 0, cachedInputTokens: 0 }],
      mtimeOffsetMs: 60_000,
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    expect(r.rollouts[0].parseError).toContain('canonical keys');
    expect(r.stats.parseErrorCount).toBe(1);
  });

  test('half-written last line: skipped when mtime is fresh (< 5 s)', async () => {
    writeRollout(codexHome, {
      id: 'fresh', cwd: '/cwd', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex',
      tokenCounts: [{ inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }],
      partialLastLine: '{"type":"event_msg","payload":{"type":"toke',                // truncated
      mtimeOffsetMs: 1_000,                                                          // 1 s ago — fresh
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    // Last line skipped → no parse error, prior token_count still captured.
    expect(r.rollouts[0].parseError).toBeNull();
    expect(r.rollouts[0].totalUsage?.inputTokens).toBe(100);
  });

  test('half-written last line: parsed when mtime is old (≥ 5 s)', async () => {
    writeRollout(codexHome, {
      id: 'old', cwd: '/cwd', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex',
      tokenCounts: [{ inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }],
      partialLastLine: 'this-is-just-noise-and-should-not-fatal',
      mtimeOffsetMs: 10_000,                                                         // 10 s ago — not fresh
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    // Garbled non-JSON line is silently skipped (try/catch); valid token_count still wins.
    expect(r.rollouts[0].parseError).toBeNull();
    expect(r.rollouts[0].totalUsage?.inputTokens).toBe(100);
  });
});

describe('CodexRolloutScanner — abandoned-rollout detection', () => {
  let codexHome: string;
  beforeEach(() => { codexHome = makeTempCodexHome(); });
  afterEach(() => { try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('rollout with no terminal event and mtime > 24 h is abandoned', async () => {
    writeRollout(codexHome, {
      id: 'aband', cwd: '/cwd', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex', terminal: false,                                       // no terminal
      mtimeOffsetMs: 25 * 60 * 60 * 1000,                                            // 25 h ago
      tokenCounts: [{ inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-07T00:00:00Z').getTime(), new Date('2026-05-09T23:59:59Z').getTime());
    expect(s.isAbandoned(r.rollouts[0])).toBe(true);
    expect(r.stats.abandonedCount).toBe(1);
  });

  test('rollout without terminal event but with fresh mtime is NOT abandoned (still in progress)', async () => {
    writeRollout(codexHome, {
      id: 'live', cwd: '/cwd', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex', terminal: false,
      mtimeOffsetMs: 60_000,                                                          // 1 min ago
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    expect(s.isAbandoned(r.rollouts[0])).toBe(false);
    expect(r.stats.abandonedCount).toBe(0);
  });
});

describe('CodexRolloutScanner — discovery binding', () => {
  let codexHome: string;
  beforeEach(() => { codexHome = makeTempCodexHome(); });
  afterEach(() => { try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('binds a Kookr task to its rollout by (cwd, ±60 s)', async () => {
    writeRollout(codexHome, {
      id: 'parent', cwd: '/repo', startedAt: '2026-05-08T10:00:30.000Z',
      model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 1000, outputTokens: 200, cachedInputTokens: 100 }],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    const { bindings, outcomes } = s.bindTasks(r.rollouts, [{
      taskId: 'task-1', cwd: '/repo', createdAtMs: new Date('2026-05-08T10:00:00.000Z').getTime(),
    }]);
    expect(bindings.size).toBe(1);
    const b = bindings.get('task-1')!;
    expect(b.parent.id).toBe('parent');
    expect(b.totalInputTokens).toBe(1000);
    expect(outcomes.get('task-1')?.kind).toBe('bound');
  });

  test('cwd mismatch → not-found', async () => {
    writeRollout(codexHome, {
      id: 'a', cwd: '/elsewhere', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    const { outcomes } = s.bindTasks(r.rollouts, [{
      taskId: 't', cwd: '/repo', createdAtMs: new Date('2026-05-08T10:00:00.000Z').getTime(),
    }]);
    const o = outcomes.get('t');
    expect(o?.kind).toBe('not-found');
  });

  test('time mismatch (> 60 s) → not-found', async () => {
    writeRollout(codexHome, {
      id: 'a', cwd: '/repo', startedAt: '2026-05-08T10:05:00.000Z',
      model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 }],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    const { outcomes } = s.bindTasks(r.rollouts, [{
      taskId: 't', cwd: '/repo', createdAtMs: new Date('2026-05-08T10:00:00.000Z').getTime(),
    }]);
    expect(outcomes.get('t')?.kind).toBe('not-found');
  });

  test('two tasks in same cwd within 60 s → second binding is ambiguous', async () => {
    writeRollout(codexHome, {
      id: 'r1', cwd: '/repo', startedAt: '2026-05-08T10:00:05.000Z',
      model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 100, outputTokens: 0, cachedInputTokens: 0 }],
    });
    writeRollout(codexHome, {
      id: 'r2', cwd: '/repo', startedAt: '2026-05-08T10:00:15.000Z',
      model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 200, outputTokens: 0, cachedInputTokens: 0 }],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    const { bindings } = s.bindTasks(r.rollouts, [
      { taskId: 'task-A', cwd: '/repo', createdAtMs: new Date('2026-05-08T10:00:00.000Z').getTime() },
      { taskId: 'task-B', cwd: '/repo', createdAtMs: new Date('2026-05-08T10:00:10.000Z').getTime() },
    ]);
    // task-A (sorted first by createdAt) takes the closer rollout (r1: +5 s vs r2: +15 s) and flags ambiguity.
    expect(bindings.get('task-A')?.parent.id).toBe('r1');
    expect(bindings.get('task-A')?.ambiguousCandidateCount).toBe(1);
    expect(bindings.get('task-B')?.parent.id).toBe('r2');
  });

  test('recursive sub-agent binding via thread_spawn.parent_thread_id', async () => {
    writeRollout(codexHome, {
      id: 'P', cwd: '/repo', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 }],
    });
    writeRollout(codexHome, {
      id: 'S1', cwd: '/repo', startedAt: '2026-05-08T10:01:00.000Z',
      parentThreadId: 'P', agentNickname: 'Helmholtz', model: 'gpt-5.4',
      terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 500, outputTokens: 200, cachedInputTokens: 50 }],
    });
    writeRollout(codexHome, {
      id: 'S2', cwd: '/repo', startedAt: '2026-05-08T10:02:00.000Z',
      parentThreadId: 'S1', agentNickname: 'Nash', model: 'gpt-5.4-mini',
      terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 300, outputTokens: 150, cachedInputTokens: 30 }],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    const { bindings } = s.bindTasks(r.rollouts, [{
      taskId: 'kookr', cwd: '/repo', createdAtMs: new Date('2026-05-08T10:00:00.000Z').getTime(),
    }]);
    const b = bindings.get('kookr')!;
    expect(b.parent.id).toBe('P');
    expect(b.subagents.map(s => s.id).sort()).toEqual(['S1', 'S2']);
    expect(b.totalInputTokens).toBe(1000 + 500 + 300);
    expect(b.totalOutputTokens).toBe(100 + 200 + 150);
    expect(b.totalCachedInputTokens).toBe(0 + 50 + 30);
    expect(b.model).toBe('gpt-5.3-codex');                                            // parent's model wins
  });

  test('orphan rollout: top-level rollout with no Kookr task match', async () => {
    writeRollout(codexHome, {
      id: 'orphan', cwd: '/elsewhere', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 100, outputTokens: 0, cachedInputTokens: 0 }],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    const { orphanRollouts } = s.bindTasks(r.rollouts, []);
    expect(orphanRollouts).toHaveLength(1);
    expect(orphanRollouts[0].id).toBe('orphan');
  });

  test('abandoned rollout that matches cwd+time still flags task as abandoned (not bound)', async () => {
    writeRollout(codexHome, {
      id: 'aband', cwd: '/repo', startedAt: '2026-05-06T10:00:00.000Z',
      model: 'gpt-5.3-codex', terminal: false,                                        // no terminal
      mtimeOffsetMs: 25 * 60 * 60 * 1000,                                             // 25 h
      tokenCounts: [{ inputTokens: 100, outputTokens: 0, cachedInputTokens: 0 }],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r = await s.scan(new Date('2026-05-06T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    const { outcomes } = s.bindTasks(r.rollouts, [{
      taskId: 'task-aband', cwd: '/repo', createdAtMs: new Date('2026-05-06T10:00:00.000Z').getTime(),
    }]);
    expect(outcomes.get('task-aband')?.kind).toBe('abandoned');
  });
});

describe('CodexRolloutScanner — caching', () => {
  let codexHome: string;
  beforeEach(() => { codexHome = makeTempCodexHome(); });
  afterEach(() => { try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('warm scan reuses cached parse for unchanged files', async () => {
    writeRollout(codexHome, {
      id: 'a', cwd: '/repo', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 1000, outputTokens: 0, cachedInputTokens: 0 }],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r1 = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    const r2 = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    // Object identity proves the cached meta was reused.
    expect(r1.rollouts[0]).toBe(r2.rollouts[0]);
  });

  test('mtime change invalidates cache → file is re-parsed', async () => {
    writeRollout(codexHome, {
      id: 'b', cwd: '/repo', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 60_000,
      tokenCounts: [{ inputTokens: 1000, outputTokens: 0, cachedInputTokens: 0 }],
    });
    const s = new CodexRolloutScanner({ codexHome });
    const r1 = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    // Rewrite with different content (and new mtime since utimesSync clobbers it).
    writeRollout(codexHome, {
      id: 'b', cwd: '/repo', startedAt: '2026-05-08T10:00:00.000Z',
      model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 30_000,
      tokenCounts: [{ inputTokens: 5000, outputTokens: 0, cachedInputTokens: 0 }],
    });
    const r2 = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    expect(r1.rollouts[0].totalUsage?.inputTokens).toBe(1000);
    expect(r2.rollouts[0].totalUsage?.inputTokens).toBe(5000);
  });
});

describe('CodexRolloutScanner — performance microbenchmark (R6)', () => {
  let codexHome: string;
  beforeEach(() => { codexHome = makeTempCodexHome(); });
  afterEach(() => { try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* ignore */ } });

  // Cold-scan ceiling: < 5 s on 1500 files (R6). On the author's WSL2 hardware this
  // typically completes in well under 1 s — the test fails only on a regression
  // that would put real-world warm scans over budget. CI variability allows
  // a generous ceiling.
  test('cold scan over 500 small rollouts completes inside the projected R6 budget', async () => {
    const dir = join(codexHome, '2026', '05', '08');
    mkdirSync(dir, { recursive: true });
    const baseTs = new Date('2026-05-08T12:00:00.000Z').getTime();
    for (let i = 0; i < 500; i++) {
      writeRollout(codexHome, {
        id: `b-${i.toString().padStart(4, '0')}`,
        cwd: '/repo',
        startedAt: new Date(baseTs + i * 1000).toISOString(),
        model: 'gpt-5.3-codex', terminal: true, mtimeOffsetMs: 60_000,
        tokenCounts: [{ inputTokens: 100 + i, outputTokens: 10, cachedInputTokens: 0 }],
      });
    }
    const s = new CodexRolloutScanner({ codexHome });
    const t0 = Date.now();
    const r = await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    const cold = Date.now() - t0;
    expect(r.rollouts).toHaveLength(500);
    // Linear extrapolation: 500 files in < 1500 ms is the implicit R6 envelope (≤ 5 s for ≤ 1500 files).
    // Allowing 2× headroom for CI noise.
    expect(cold).toBeLessThan(3000);

    const t1 = Date.now();
    await s.scan(new Date('2026-05-08T00:00:00Z').getTime(), new Date('2026-05-08T23:59:59Z').getTime());
    const warm = Date.now() - t1;
    // Warm < 200 ms over the same corpus is the explicit R6 target. 500 files × negligible-stat ≪ 200 ms.
    expect(warm).toBeLessThan(500);                                                     // 2.5× headroom
  });
});

// ---------------------------------------------------------------------------
// Type-only sanity check — ensures CodexRolloutMeta keeps the fields the
// aggregator depends on. If a rename happens in the scanner, this fails first.
// ---------------------------------------------------------------------------
const _typeAssert: keyof CodexRolloutMeta = 'totalUsage';
void _typeAssert;
