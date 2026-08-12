import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('./use-cases/get-snapshot.js', () => ({
  createSnapshotMessage: vi.fn(() => ({ type: 'snapshot' })),
}));
vi.mock('../core/settings-mutation-audit.js', () => ({
  appendSettingsMutationAudit: vi.fn(async () => {}),
  buildSettingsMutationAuditRow: vi.fn(() => ({ row: true })),
}));

import { applyDefaultAgentUpdate } from './settings-service.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import { appendSettingsMutationAudit } from '../core/settings-mutation-audit.js';
import { DEFAULT_SETTINGS } from '../core/settings-store.js';

function fakeDeps(current: string) {
  let stored = { ...DEFAULT_SETTINGS, defaultAgentType: current } as ReturnType<
    NonNullable<ReturnType<typeof makeSettings>>['get']
  >;
  const update = vi.fn(async (next: typeof stored) => {
    stored = { ...next, roundRobinIndex: stored.roundRobinIndex };
    return [] as string[];
  });
  const broadcastToAll = vi.fn();
  function makeSettings() {
    return {
      get: () => stored,
      update,
      getLoadError: () => undefined,
    };
  }
  return {
    settings: makeSettings(),
    auditLogPath: '/tmp/audit.jsonl',
    broadcastToAll,
    monitor: {} as never,
    serverCwd: '/s',
    taskStore: {} as never,
    getMaxActiveTasks: () => 4,
    update,
    broadcastToAll_: broadcastToAll,
  } as never;
}

describe('applyDefaultAgentUpdate', () => {
  beforeEach(() => vi.clearAllMocks());

  test('returns settings_not_configured when settings absent', async () => {
    const res = await applyDefaultAgentUpdate({ settings: undefined } as never, 'claude-code');
    expect(res).toEqual({ updated: false, reason: 'settings_not_configured' });
  });

  test('short-circuits when the default is already the target (no write/broadcast)', async () => {
    const deps = fakeDeps('claude-code');
    const res = await applyDefaultAgentUpdate(deps, 'claude-code');
    expect(res).toEqual({ updated: true });
    expect(deps.update).not.toHaveBeenCalled();
    expect(appendSettingsMutationAudit).not.toHaveBeenCalled();
    expect(createSnapshotMessage).not.toHaveBeenCalled();
  });

  test('writes, audits, and broadcasts on a real change', async () => {
    const deps = fakeDeps('grok-build');
    const res = await applyDefaultAgentUpdate(deps, 'claude-code', 'someactor');
    expect(res).toEqual({ updated: true });
    expect(deps.update).toHaveBeenCalledTimes(1);
    // the validated payload carried the new default
    expect(deps.update.mock.calls[0][0]).toMatchObject({ defaultAgentType: 'claude-code' });
    expect(appendSettingsMutationAudit).toHaveBeenCalledTimes(1);
    expect(deps.broadcastToAll_).toHaveBeenCalledTimes(1);
  });
});
