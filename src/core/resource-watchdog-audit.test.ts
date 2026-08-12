import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildAuditRecord,
  JsonlResourceWatchdogAuditSink,
  MemoryResourceWatchdogAuditSink,
} from './resource-watchdog-audit.js';
import { buildResourceWatchdogPrompt } from './resource-watchdog-prompt.js';
import type { ResourceWatchdogSample } from './resource-watchdog-types.js';

const sample: ResourceWatchdogSample = {
  sampledAt: '2026-07-31T12:00:00.000Z',
  swapUsedPercent: 80,
  memAvailableMb: 200,
  oomKillTotal: 2,
  processCounts: { claude: 10, grok: 5, codex: 3, dtach: 20 },
  orphanSessionCount: 6,
  terminalLeakCount: 1,
  topConsumers: [{ pid: 1, rssKb: 999, command: 'claude worker' }],
};

describe('resource-watchdog audit emission', () => {
  test('buildAuditRecord shapes a valid line payload', () => {
    const record = buildAuditRecord({
      action: 'spawn',
      timestamp: '2026-07-31T12:00:00.000Z',
      sample,
      triggers: [{ reason: 'swap_percent', detail: 'swap high', observed: 80, threshold: 50 }],
      kind: 'investigation',
      taskId: 'task-1',
      spawnsInWindow: 0,
    });
    expect(record.schemaVersion).toBe('resource-watchdog-audit.v1');
    expect(record.action).toBe('spawn');
    expect(record.sample?.swapUsedPercent).toBe(80);
    expect(record.triggers?.[0]?.reason).toBe('swap_percent');
  });

  test('MemoryResourceWatchdogAuditSink captures appends', () => {
    const sink = new MemoryResourceWatchdogAuditSink();
    sink.append(buildAuditRecord({
      action: 'suppress_throttled',
      timestamp: '2026-07-31T12:01:00.000Z',
      throttleRemainingMs: 1_000,
    }));
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.action).toBe('suppress_throttled');
  });

  test('JsonlResourceWatchdogAuditSink writes a JSONL line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rw-audit-'));
    const path = join(dir, 'resource-watchdog-audit.jsonl');
    try {
      const sink = new JsonlResourceWatchdogAuditSink(path);
      sink.append(buildAuditRecord({
        action: 'trigger',
        timestamp: '2026-07-31T12:00:00.000Z',
        sample,
        triggers: [{ reason: 'oom_kill_delta', detail: 'oom +1', observed: 1, threshold: 0 }],
      }));
      // Drain the internal queue.
      await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(path)).toBe(true);
      const lines = readFileSync(path, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.action).toBe('trigger');
      expect(parsed.schemaVersion).toBe('resource-watchdog-audit.v1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resource-watchdog prompt templates', () => {
  test('investigation prompt embeds hard-rules block', () => {
    const prompt = buildResourceWatchdogPrompt({
      kind: 'investigation',
      sample,
      triggers: [{ reason: 'swap_percent', detail: 'swap 80%', observed: 80, threshold: 50 }],
      spawnsInWindow: 1,
      spawnBudget24h: 4,
    });
    expect(prompt).toContain('NO INTERACTIVE PROMPTS');
    expect(prompt).toContain('WRITE-FILE-AND-STOP');
    expect(prompt).toContain('REVERSIBLE REMEDIATION ONLY');
    expect(prompt).toContain('NOT kill non-kookr-owned processes');
    expect(prompt).toMatch(/swapUsedPercent: 80\.0%/);
  });

  test('meta-reflection prompt names the chronic-firing goal', () => {
    const prompt = buildResourceWatchdogPrompt({
      kind: 'meta_reflection',
      sample,
      triggers: [{ reason: 'process_ceiling', detail: 'claude high', observed: 50, threshold: 40 }],
      spawnsInWindow: 4,
      spawnBudget24h: 4,
    });
    expect(prompt).toContain('meta-reflection');
    expect(prompt).toContain('Spawns in the last 24h before this one: 4');
    expect(prompt).toContain('NO INTERACTIVE PROMPTS');
  });

  // pragma: allowlist secret — synthetic redaction fixtures only; not live credentials.
  test('investigation prompt embeds only scrubbed server.log tails (issue #2346)', () => {
    const bearer = ['super-secret-bearer-value', '-0123456789abcdef'].join('');
    const ghPat = ['ghp', '_0123456789abcdefghij'].join('');
    const rawTail = [
      'pressure tick',
      `Authorization: Bearer ${bearer}`,
      `forward token=${ghPat}`,
      'Cookie: sessionid=abc123def456ghi789; path=/',
    ].join('\n');
    const prompt = buildResourceWatchdogPrompt({
      kind: 'investigation',
      sample,
      triggers: [{ reason: 'swap_percent', detail: 'swap 80%', observed: 80, threshold: 50 }],
      spawnsInWindow: 1,
      spawnBudget24h: 4,
      serverLogTail: rawTail,
    });
    expect(prompt).toContain('## Recent server.log (tail)');
    expect(prompt).toContain('pressure tick');
    expect(prompt).toContain('[REDACTED]');
    expect(prompt).not.toContain(bearer);
    expect(prompt).not.toContain(ghPat);
    expect(prompt).not.toContain('sessionid=abc123def456ghi789');
    expect(prompt).not.toMatch(/Bearer\s+super-secret/i);
  });
});
