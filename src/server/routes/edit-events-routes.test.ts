import { describe, test, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { Monitor } from '../../core/monitor.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { TaskStore } from '../../core/tasks.js';
import type { AgentEvent } from '../../core/types.js';
import { registerAgentRoutes } from './agent-routes.js';
import type { AgentRouteDeps } from './shared.js';

const SERVER_STARTED_AT = '2026-04-21T00:00:00.000Z';

function mkApp(monitor: Monitor): Hono {
  const app = new Hono();
  // Only fields the edit-events route reads — the rest are ignored at runtime.
  registerAgentRoutes(app, {
    monitor,
    serverStartedAt: SERVER_STARTED_AT,
  } as unknown as AgentRouteDeps);
  return app;
}

function pushEvent(monitor: Monitor, agentId: string, event: AgentEvent) {
  monitor.processEvents(agentId, [event]);
}

describe('GET /api/agents/:agentId/edit-events/:toolUseId', () => {
  let monitor: Monitor;
  let app: Hono;
  const agentId = 'kookr-abc123';
  const toolUseId = 'tu_abcdef01';

  beforeEach(() => {
    monitor = new Monitor(new TaskStore(), new AttentionQueue());
    monitor.registerAgent(agentId);
    app = mkApp(monitor);
  });

  test('400 on invalid agentId', async () => {
    const res = await app.request('/api/agents/bad!id/edit-events/' + toolUseId);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_param');
    expect(body.field).toBe('agentId');
  });

  test('400 on invalid toolUseId (bad chars)', async () => {
    const res = await app.request(`/api/agents/${agentId}/edit-events/bad!id`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('toolUseId');
  });

  test('400 on toolUseId over 128 chars', async () => {
    const huge = 'a'.repeat(129);
    const res = await app.request(`/api/agents/${agentId}/edit-events/${huge}`);
    expect(res.status).toBe(400);
  });

  test('404 agent_unknown when Monitor has no events for that agent', async () => {
    const res = await app.request(`/api/agents/ghost/edit-events/${toolUseId}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe('agent_unknown');
    expect(body.serverStartedAt).toBe(SERVER_STARTED_AT);
  });

  test('404 event_not_found when agent has events but no matching toolUseId', async () => {
    pushEvent(monitor, agentId, {
      type: 'tool_result',
      sessionId: 'sess-1',
      toolName: 'Edit',
      toolUseId: 'different-id',
      toolResponse: { filePath: '/x.ts', oldString: 'a', newString: 'b', structuredPatch: [] },
    });
    const res = await app.request(`/api/agents/${agentId}/edit-events/${toolUseId}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe('event_not_found');
    expect(body.serverStartedAt).toBe(SERVER_STARTED_AT);
  });

  test('200 edit hit returns structuredPatch + oldString + newString', async () => {
    pushEvent(monitor, agentId, {
      type: 'tool_result',
      sessionId: 'sess-1',
      toolName: 'Edit',
      toolUseId,
      toolResponse: {
        filePath: '/src/foo.ts',
        oldString: 'const x = 1;',
        newString: 'const x = 2;',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-const x = 1;', '+const x = 2;'] }],
      },
    });
    const res = await app.request(`/api/agents/${agentId}/edit-events/${toolUseId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe('edit');
    expect(body.filePath).toBe('/src/foo.ts');
    expect(body.oldString).toBe('const x = 1;');
    expect(body.newString).toBe('const x = 2;');
    expect(body.structuredPatch).toHaveLength(1);
    expect(body.serverStartedAt).toBe(SERVER_STARTED_AT);
  });

  test('200 write hit returns originalFile', async () => {
    pushEvent(monitor, agentId, {
      type: 'tool_result',
      sessionId: 'sess-1',
      toolName: 'Write',
      toolUseId,
      toolResponse: {
        filePath: '/new.ts',
        originalFile: '',
        structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new line'] }],
      },
    });
    const res = await app.request(`/api/agents/${agentId}/edit-events/${toolUseId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe('write');
    expect(body.filePath).toBe('/new.ts');
    expect(body.originalFile).toBe('');
  });

  test('200 unsupported for NotebookEdit', async () => {
    pushEvent(monitor, agentId, {
      type: 'tool_result',
      sessionId: 'sess-1',
      toolName: 'NotebookEdit',
      toolUseId,
      toolResponse: { filePath: '/x.ipynb' },
    });
    const res = await app.request(`/api/agents/${agentId}/edit-events/${toolUseId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe('unsupported');
  });

  test('picks the most recent match when the same toolUseId appears twice (defensive)', async () => {
    pushEvent(monitor, agentId, {
      type: 'tool_result',
      sessionId: 'sess-1',
      toolName: 'Edit',
      toolUseId,
      toolResponse: { filePath: '/a.ts', oldString: 'first', newString: 'X', structuredPatch: [] },
    });
    pushEvent(monitor, agentId, {
      type: 'tool_result',
      sessionId: 'sess-1',
      toolName: 'Edit',
      toolUseId,
      toolResponse: { filePath: '/a.ts', oldString: 'second', newString: 'Y', structuredPatch: [] },
    });
    const res = await app.request(`/api/agents/${agentId}/edit-events/${toolUseId}`);
    const body = await res.json();
    expect(body.oldString).toBe('second');
  });
});
