import { describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeTaskSnapshotBundle } from './write-task-snapshot-bundle.js';
import type { Task } from '../../core/tasks.js';
import type { InteractionEvent } from '../../core/interaction-log.js';

function makeTask(): Task {
  return {
    id: 'task-1',
    name: 'Reflect target',
    prompt: 'Fix the thing',
    cwd: '/tmp/project',
    criteria: 'tests pass',
    agentType: 'claude-code',
    status: 'inProgress',
    sessions: [{
      tmuxSession: 'sess-1',
      agentType: 'claude-code',
      cwd: '/tmp/project',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('writeTaskSnapshotBundle', () => {
  test('writes an immutable snapshot bundle for task reflection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-snapshot-bundle-'));
    const snapshotDir = join(dir, 'snapshots');
    const hooksDir = join(dir, 'hooks');
    await mkdir(hooksDir);
    await writeFile(join(hooksDir, 'sess-1.jsonl'), '{"type":"SessionStart"}\n', 'utf-8');

    const events: InteractionEvent[] = [
      { type: 'task_reflect_requested', taskId: 'task-1', agentId: 'sess-1', mode: 'snapshot', timestamp: '2026-01-01T00:00:01.000Z' },
      { type: 'user_input', agentId: 'other', content: 'noise', timestamp: '2026-01-01T00:00:02.000Z' },
    ];

    try {
      const result = await writeTaskSnapshotBundle(makeTask(), {
        taskSnapshotDir: snapshotDir,
        hooksDir,
        readInteractionLog: async () => events,
        agentStates: [{
          agentId: 'sess-1',
          taskId: 'task-1',
          taskStatus: 'inProgress',
          events: [],
          anomaly: null,
          cwd: '/tmp/project',
        }],
        sessionEvents: {
          'sess-1': [{ type: 'tool_use', sessionId: 'sess-1', toolName: 'Bash' }],
        },
      });

      const bundle = JSON.parse(await readFile(join(result.bundlePath, 'bundle.json'), 'utf-8')) as {
        schemaVersion: string;
        taskId: string;
        taskStatus: string;
        sessions: Array<{ hookFile?: string; eventFile: string; eventCount: number }>;
        interactionFile: string;
        agentStates: Array<{ agentId: string }>;
      };
      expect(bundle.schemaVersion).toBe('task-snapshot-reflect.v1');
      expect(bundle.taskId).toBe('task-1');
      expect(bundle.taskStatus).toBe('inProgress');
      expect(bundle.sessions[0]).toMatchObject({
        hookFile: 'hook-sess-1.jsonl',
        eventFile: 'agent-events-sess-1.json',
        eventCount: 1,
      });
      expect(bundle.agentStates[0].agentId).toBe('sess-1');

      const interactionSlice = await readFile(join(result.bundlePath, bundle.interactionFile), 'utf-8');
      expect(interactionSlice).toContain('task_reflect_requested');
      expect(interactionSlice).not.toContain('noise');
      expect(await readFile(join(result.bundlePath, 'hook-sess-1.jsonl'), 'utf-8')).toContain('SessionStart');
      expect(await readFile(join(result.bundlePath, 'agent-events-sess-1.json'), 'utf-8')).toContain('tool_use');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('persists the optional user hint into bundle.json when provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-snapshot-bundle-'));
    const snapshotDir = join(dir, 'snapshots');
    const hooksDir = join(dir, 'hooks');
    await mkdir(hooksDir);

    try {
      const result = await writeTaskSnapshotBundle(makeTask(), {
        taskSnapshotDir: snapshotDir,
        hooksDir,
        readInteractionLog: async () => [],
        agentStates: [],
        sessionEvents: {},
        userHint: 'liked being asked for e2e tests',
      });

      const bundle = JSON.parse(await readFile(join(result.bundlePath, 'bundle.json'), 'utf-8')) as {
        userHint?: string;
      };
      expect(bundle.userHint).toBe('liked being asked for e2e tests');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('omits userHint from bundle.json when not provided', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'task-snapshot-bundle-'));
    const snapshotDir = join(dir, 'snapshots');
    const hooksDir = join(dir, 'hooks');
    await mkdir(hooksDir);

    try {
      const result = await writeTaskSnapshotBundle(makeTask(), {
        taskSnapshotDir: snapshotDir,
        hooksDir,
        readInteractionLog: async () => [],
        agentStates: [],
        sessionEvents: {},
      });

      const bundle = JSON.parse(await readFile(join(result.bundlePath, 'bundle.json'), 'utf-8')) as Record<string, unknown>;
      expect(bundle).not.toHaveProperty('userHint');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
