// Phase 3 integration tests — exercises the full ingestion → ledger →
// diagnostics path through a real adapter so the acceptance bullets in
// rfc-activity-log-reliability §7–§9 are pinned end-to-end.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLedger } from '../core/activity-ledger.js';
import { HookIngestion } from './hook-ingestion.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { TaskStore } from '../core/tasks.js';
import { Monitor } from '../core/monitor.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { getSnapshotAgentsForClient } from './use-cases/get-snapshot.js';

interface Fixture {
  ledger: ActivityLedger;
  ingestion: HookIngestion;
  adapter: ClaudeCodeAdapter;
  monitor: Monitor;
  taskStore: TaskStore;
  cleanup: () => void;
  sessionId: string;
  taskId: string;
}

async function makeFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'activity-diag-'));
  const taskStore = new TaskStore();
  const backend = new FakeTerminalBackend();
  const adapter = new ClaudeCodeAdapter(backend, taskStore);
  const monitor = new Monitor(taskStore, new AttentionQueue());
  // Adapter emits AgentEvent + EventMeta to handlers; forward parents to monitor
  // so the snapshot reflects "windowed" state, matching production gate.
  adapter.onEvent((tmux, event, meta) => {
    if (meta.parentage === 'parent') monitor.processEvents(tmux, [event]);
  });
  const ledger = new ActivityLedger(dir);
  const ingestion = new HookIngestion({ adapter, activityLedger: ledger, taskStore });

  const task = taskStore.createTask('Fix bug', '/cwd');
  const sessionId = await adapter.launch(task.id, 'Fix bug', '/cwd');

  return {
    ledger, ingestion, adapter, monitor, taskStore, sessionId, taskId: task.id,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function sessionStart(sid: string): string {
  return JSON.stringify({
    session_id: sid,
    transcript_path: `/t/${sid}.jsonl`,
    cwd: '/cwd',
    hook_event_name: 'SessionStart',
  });
}

function toolUse(sid: string, toolName = 'Read'): string {
  return JSON.stringify({
    session_id: sid,
    transcript_path: `/t/${sid}.jsonl`,
    cwd: '/cwd',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {},
    tool_use_id: `tu-${Math.random().toString(36).slice(2, 9)}`,
  });
}

describe('activity-diagnostics — Phase 3 acceptance', () => {
  it('reports parent / child / malformed / duplicate counts from ledger', async () => {
    const f = await makeFixture();
    try {
      const inj = (raw: string) => f.ingestion.ingestFromHttp(f.sessionId, raw);

      inj(sessionStart('parent-1'));                      // parent
      inj(toolUse('parent-1'));                           // parent
      inj(toolUse('parent-1'));                           // parent (different toolUseId)
      inj(sessionStart('child-1'));                       // child
      inj(toolUse('child-1'));                            // child

      inj('{not json');                                   // malformed — does NOT crash
      inj(JSON.stringify({ session_id: 'x', hook_event_name: 'WeirdNewEvent' })); // dropped

      // Same payload arrives a second time (file-replay of an HTTP-delivered record).
      const dup = sessionStart('parent-1');
      f.ingestion.injectHookEvent(f.sessionId, dup);

      await f.ledger.flush(f.sessionId);
      const stats = await f.ledger.stats(f.sessionId);

      expect(stats.parentEventCount).toBe(3);
      expect(stats.childEventCount).toBe(2);
      expect(stats.malformedRecordCount).toBe(1);
      expect(stats.droppedRecordCount).toBe(1);
      expect(stats.duplicateRecordCount).toBe(1);
      // RFC §8: ledger keeps a full count regardless of monitor window cap.
      expect(stats.rawRecordCount).toBe(8);
    } finally {
      f.cleanup();
    }
  });

  it('monitor window can be capped while ledger reports the full count', async () => {
    const f = await makeFixture();
    try {
      f.ingestion.ingestFromHttp(f.sessionId, sessionStart('parent-1'));
      // Burst well above the 50-event monitor window.
      for (let i = 0; i < 75; i += 1) {
        f.ingestion.ingestFromHttp(f.sessionId, toolUse('parent-1'));
      }

      await f.ledger.flush(f.sessionId);
      const stats = await f.ledger.stats(f.sessionId);
      const monitorEvents = f.monitor.getAgentEvents(f.sessionId);

      // Monitor caps at 50; ledger keeps all 76 parent events.
      expect(monitorEvents.length).toBeLessThanOrEqual(50);
      expect(stats.parentEventCount).toBe(76);
    } finally {
      f.cleanup();
    }
  });

  it('malformed rows are visible in the ledger and do not crash ingestion', async () => {
    const f = await makeFixture();
    try {
      // Interleave good + bad payloads — bad ones must not break the good ones.
      f.ingestion.ingestFromHttp(f.sessionId, sessionStart('parent-1'));
      f.ingestion.ingestFromHttp(f.sessionId, '}}}');                  // malformed
      f.ingestion.ingestFromHttp(f.sessionId, '{"session_id":');       // malformed (truncated)
      f.ingestion.ingestFromHttp(f.sessionId, toolUse('parent-1'));

      await f.ledger.flush(f.sessionId);
      const stats = await f.ledger.stats(f.sessionId);
      expect(stats.malformedRecordCount).toBe(2);
      // The good records still landed.
      expect(stats.parentEventCount).toBe(2);
    } finally {
      f.cleanup();
    }
  });

  it('browser snapshots do not include raw hook payloads', async () => {
    const f = await makeFixture();
    try {
      // Pre-tool-use carries an Edit-like input containing a file_path string;
      // event-projection strips toolResponse and caps strings. The snapshot
      // contract must never surface a raw envelope or full toolResponse payload.
      const raw = JSON.stringify({
        session_id: 'parent-1',
        transcript_path: '/t/parent-1.jsonl',
        cwd: '/cwd',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/secret.txt' },
        tool_response: 'SECRET-PASSWORD\n'.repeat(5000),
      });
      f.ingestion.ingestFromHttp(f.sessionId, sessionStart('parent-1'));
      f.ingestion.ingestFromHttp(f.sessionId, raw);

      const snap = getSnapshotAgentsForClient({
        monitor: f.monitor,
        activityMetaProvider: f.ingestion,
      });
      const me = snap.find((a) => a.agentId === f.sessionId)!;
      // RFC §11 / §9: snapshot carries projected events with NO toolResponse,
      // and an activityMeta block but no raw envelope text.
      const serialized = JSON.stringify(me);
      expect(serialized).not.toContain('SECRET-PASSWORD');
      expect(serialized).not.toContain('hook_event_name');
      expect(me.activityMeta?.totalEventsSeen).toBeGreaterThan(0);
    } finally {
      f.cleanup();
    }
  });

  it('AgentState.activityMeta on snapshot reports parent vs child counts', async () => {
    const f = await makeFixture();
    try {
      f.ingestion.ingestFromHttp(f.sessionId, sessionStart('parent-1'));
      f.ingestion.ingestFromHttp(f.sessionId, toolUse('parent-1'));
      f.ingestion.ingestFromHttp(f.sessionId, sessionStart('child-1'));
      f.ingestion.ingestFromHttp(f.sessionId, toolUse('child-1'));
      f.ingestion.ingestFromHttp(f.sessionId, toolUse('child-1'));

      const snap = getSnapshotAgentsForClient({
        monitor: f.monitor,
        activityMetaProvider: f.ingestion,
      });
      const me = snap.find((a) => a.agentId === f.sessionId)!;
      expect(me.activityMeta).toBeDefined();
      expect(me.activityMeta!.parentEventCount).toBe(2);
      expect(me.activityMeta!.childEventCount).toBe(3);
      expect(me.activityMeta!.totalEventsSeen).toBe(5);
    } finally {
      f.cleanup();
    }
  });
});
