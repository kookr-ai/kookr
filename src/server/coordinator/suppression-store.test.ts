import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isAgentType, type AgentType } from '../../shared/contracts/agent-types.js';
import { CoordinatorSuppressionStore } from './suppression-store.js';

const NOW = new Date('2026-07-15T12:00:00.000Z');
const UNKNOWN_AGENT_TYPE = 'unknown-agent' as AgentType;

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coordinator-suppressions-'));
  tempDirectories.push(directory);
  return directory;
}

describe('TS-COORD-001: shared agent type validation', () => {
  test('accepts every concrete agent type and rejects unknown values', () => {
    expect(isAgentType('claude-code')).toBe(true);
    expect(isAgentType('codex-cli')).toBe(true);
    expect(isAgentType('grok-build')).toBe(true);
    expect(isAgentType(UNKNOWN_AGENT_TYPE)).toBe(false);
  });
});

describe('TS-COORD-002: coordinator suppression persistence', () => {
  test('preserves a grok-build suppression across a store round-trip', () => {
    const directory = createTempDirectory();
    const writer = new CoordinatorSuppressionStore(directory);

    const created = writer.suppress('stale', 'grok-build', NOW);
    const reader = new CoordinatorSuppressionStore(directory);

    expect(reader.isSuppressed('stale', 'grok-build', new Date('2026-07-16T12:00:00.000Z'))).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, 'coordinator-suppressions.json'), 'utf8'))).toEqual({
      version: 'coordinator-suppressions.v1',
      suppressions: [created],
    });
  });
});

describe('TS-COORD-003: invalid coordinator suppression types', () => {
  test('rejects an unknown agent type before writing a suppression', () => {
    const directory = createTempDirectory();
    const store = new CoordinatorSuppressionStore(directory);

    expect(() => store.suppress('stale', UNKNOWN_AGENT_TYPE, NOW)).toThrow('Unknown agent type: unknown-agent');
    expect(existsSync(join(directory, 'coordinator-suppressions.json'))).toBe(false);
  });

  test('ignores and logs a persisted suppression with an unknown agent type', () => {
    const directory = createTempDirectory();
    writeFileSync(join(directory, 'coordinator-suppressions.json'), JSON.stringify({
      version: 'coordinator-suppressions.v1',
      suppressions: [{
        key: 'stale:unknown-agent',
        detectorId: 'stale',
        agentType: UNKNOWN_AGENT_TYPE,
        suppressedUntil: '2026-07-22T12:00:00.000Z',
        dismissalCount: 1,
        lastDismissedAt: NOW.toISOString(),
      }],
    }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const store = new CoordinatorSuppressionStore(directory);

      expect(store.isSuppressed('stale', 'codex-cli', NOW)).toBe(false);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('unknown-agent'));
    } finally {
      warning.mockRestore();
    }
  });
});

describe('TS-COORD-004: prune expired coordinator suppressions (#2270)', () => {
  const ACTIVE = {
    key: 'stale:claude-code',
    detectorId: 'stale' as const,
    agentType: 'claude-code' as const,
    suppressedUntil: '2026-08-01T12:00:00.000Z',
    dismissalCount: 1,
    lastDismissedAt: '2026-07-14T12:00:00.000Z',
  };
  const EXPIRED = {
    key: 'stale:claude-code:task:task-old',
    detectorId: 'stale' as const,
    agentType: 'claude-code' as const,
    taskId: 'task-old',
    suppressedUntil: '2026-07-01T12:00:00.000Z',
    dismissalCount: 1,
    lastDismissedAt: '2026-06-01T12:00:00.000Z',
  };

  function seedMixed(directory: string): void {
    writeFileSync(join(directory, 'coordinator-suppressions.json'), `${JSON.stringify({
      version: 'coordinator-suppressions.v1',
      suppressions: [ACTIVE, EXPIRED],
    }, null, 2)}\n`);
  }

  test('load/write cycle drops expired entries and keeps active ones on disk', () => {
    const directory = createTempDirectory();
    seedMixed(directory);
    const store = new CoordinatorSuppressionStore(directory);

    // isSuppressed loads + prunes + rewrites when expired rows are present.
    expect(store.isSuppressed('stale', 'claude-code', NOW)).toBe(true);

    const onDisk = JSON.parse(readFileSync(join(directory, 'coordinator-suppressions.json'), 'utf8'));
    expect(onDisk).toEqual({
      version: 'coordinator-suppressions.v1',
      suppressions: [ACTIVE],
    });
  });

  test('suppress write path prunes expired peers while adding a new entry', () => {
    const directory = createTempDirectory();
    seedMixed(directory);
    const store = new CoordinatorSuppressionStore(directory);

    const created = store.suppress('duplicate', 'codex-cli', NOW);
    const onDisk = JSON.parse(readFileSync(join(directory, 'coordinator-suppressions.json'), 'utf8'));

    expect(onDisk.suppressions).toEqual(
      expect.arrayContaining([ACTIVE, created]),
    );
    expect(onDisk.suppressions).toHaveLength(2);
    expect(onDisk.suppressions.some((entry: { key: string }) => entry.key === EXPIRED.key)).toBe(false);
  });

  test('isSuppressed returns true for active keys and false for expired keys', () => {
    const directory = createTempDirectory();
    seedMixed(directory);
    const store = new CoordinatorSuppressionStore(directory);

    // Active class-level entry still suppresses.
    expect(store.isSuppressed('stale', 'claude-code', NOW)).toBe(true);
    // Expired task ack alone would not suppress; class-level peer keeps the key true.
    expect(store.isSuppressed('stale', 'claude-code', NOW, 'task-old')).toBe(true);
    // Unrelated agent type with no entry is not suppressed.
    expect(store.isSuppressed('stale', 'codex-cli', NOW)).toBe(false);

    // After the class-level window ends, both keys are inactive.
    const afterActive = new Date('2026-08-02T12:00:00.000Z');
    expect(store.isSuppressed('stale', 'claude-code', afterActive)).toBe(false);
    expect(store.isSuppressed('stale', 'claude-code', afterActive, 'task-old')).toBe(false);

    // Expired-only store: isSuppressed is false and the file is compacted empty.
    const expiredOnlyDir = createTempDirectory();
    writeFileSync(join(expiredOnlyDir, 'coordinator-suppressions.json'), `${JSON.stringify({
      version: 'coordinator-suppressions.v1',
      suppressions: [EXPIRED],
    }, null, 2)}\n`);
    const expiredOnly = new CoordinatorSuppressionStore(expiredOnlyDir);
    expect(expiredOnly.isSuppressed('stale', 'claude-code', NOW, 'task-old')).toBe(false);
    expect(JSON.parse(readFileSync(join(expiredOnlyDir, 'coordinator-suppressions.json'), 'utf8'))).toEqual({
      version: 'coordinator-suppressions.v1',
      suppressions: [],
    });
  });

  test('acknowledgeTask write path prunes expired peers', () => {
    const directory = createTempDirectory();
    seedMixed(directory);
    const store = new CoordinatorSuppressionStore(directory);

    const created = store.acknowledgeTask('stale', 'claude-code', 'task-new', NOW);
    const onDisk = JSON.parse(readFileSync(join(directory, 'coordinator-suppressions.json'), 'utf8'));

    expect(onDisk.suppressions).toEqual(
      expect.arrayContaining([ACTIVE, created]),
    );
    expect(onDisk.suppressions).toHaveLength(2);
    expect(onDisk.suppressions.some((entry: { key: string }) => entry.key === EXPIRED.key)).toBe(false);
  });
});
