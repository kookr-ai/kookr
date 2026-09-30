import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('./use-cases/get-snapshot.js', () => ({
  createSnapshotMessage: vi.fn(() => ({ type: 'snapshot' })),
}));
vi.mock('../core/settings-mutation-audit.js', () => ({
  appendSettingsMutationAudit: vi.fn(async () => {}),
  buildSettingsMutationAuditRow: vi.fn(() => ({ row: true })),
}));

import { applyDefaultAgentUpdate, type SettingsMutationDeps } from './settings-service.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import { appendSettingsMutationAudit } from '../core/settings-mutation-audit.js';
import { DEFAULT_SETTINGS, type KookrSettings } from '../core/settings-store.js';
import type { AgentType } from '../shared/contracts/agent-types.js';

// A minimal, fully-typed SettingsMutationDeps — no whole-object `as never`
// escape hatch (issue #1463). The narrow contract lets the compiler check that
// the fixture satisfies the real collaborator shape the helper reads.
function fakeDeps(current: AgentType) {
  let stored: KookrSettings = { ...DEFAULT_SETTINGS, defaultAgentType: current };
  const update = vi.fn(async (next: KookrSettings) => {
    stored = { ...next, roundRobinIndex: stored.roundRobinIndex };
    return [] as string[];
  });
  const broadcastToAll = vi.fn();
  const deps: SettingsMutationDeps = {
    settings: {
      get: () => stored,
      update,
      getLoadError: () => undefined,
    },
    auditLogPath: '/tmp/audit.jsonl',
    broadcastToAll,
    monitor: { getSnapshot: () => [] },
    serverCwd: '/s',
    taskStore: { listRelations: () => [], getPendingSignal: () => undefined },
    getMaxActiveTasks: () => 4,
  };
  return { deps, update, broadcastToAll };
}

describe('applyDefaultAgentUpdate', () => {
  beforeEach(() => vi.clearAllMocks());

  test('returns settings_not_configured when settings absent', async () => {
    const res = await applyDefaultAgentUpdate(
      { ...fakeDeps('claude-code').deps, settings: undefined },
      'claude-code',
    );
    expect(res).toEqual({ updated: false, reason: 'settings_not_configured' });
  });

  test('short-circuits when the default is already the target (no write/broadcast)', async () => {
    const { deps, update } = fakeDeps('claude-code');
    const res = await applyDefaultAgentUpdate(deps, 'claude-code');
    expect(res).toEqual({ updated: true });
    expect(update).not.toHaveBeenCalled();
    expect(appendSettingsMutationAudit).not.toHaveBeenCalled();
    expect(createSnapshotMessage).not.toHaveBeenCalled();
  });

  test('writes, audits, and broadcasts on a real change', async () => {
    const { deps, update, broadcastToAll } = fakeDeps('grok-build');
    const res = await applyDefaultAgentUpdate(deps, 'claude-code', 'someactor');
    expect(res).toEqual({ updated: true });
    expect(update).toHaveBeenCalledTimes(1);
    // the validated payload carried the new default
    expect(update.mock.calls[0][0]).toMatchObject({ defaultAgentType: 'claude-code' });
    expect(appendSettingsMutationAudit).toHaveBeenCalledTimes(1);
    expect(broadcastToAll).toHaveBeenCalledTimes(1);
  });
});
