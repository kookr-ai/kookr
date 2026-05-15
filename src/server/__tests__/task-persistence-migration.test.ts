import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InteractionLogWriter, readInteractionLog } from '../../core/interaction-log.js';
import { loadTasks, saveTasks } from '../../core/task-persistence.js';
import { TaskStore } from '../../core/tasks.js';
import { CommandJournal } from '../../remote/command-journal.js';
import { asActorId, asClientId, asCommandId, asGrantId, asIdempotencyKey, asNodeEpoch, asNodeId, asSessionEpoch, asSessionId } from '../../remote/ids.js';

interface MainCompatibleTaskFile {
  version?: number;
  lifetimeSpendUsd?: number;
  tasks: unknown[];
}

const TASK_KEYS = new Set([
  'id',
  'prompt',
  'cwd',
  'criteria',
  'agentType',
  'parentTaskId',
  'status',
  'sessions',
  'createdAt',
  'updatedAt',
]);

const SESSION_KEYS = new Set([
  'tmuxSession',
  'agentType',
  'cwd',
  'createdAt',
]);

const INTERACTION_KEYS_BY_TYPE = new Map<string, Set<string>>([
  ['user_input', new Set(['type', 'agentId', 'content', 'timestamp'])],
  ['agent_selected', new Set(['type', 'agentId', 'source', 'timestamp'])],
]);

function assertOnlyKeys(obj: unknown, keys: Set<string>, label: string): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${label} is not an object`);
  }
  for (const key of Object.keys(obj)) {
    if (!keys.has(key)) throw new Error(`${label} has unexpected key: ${key}`);
  }
}

function assertTaskShapeUnchanged(task: unknown): void {
  assertOnlyKeys(task, TASK_KEYS, 'task');
  const sessions = (task as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) throw new Error('task.sessions is not an array');
  for (const session of sessions) {
    assertOnlyKeys(session, SESSION_KEYS, 'session');
  }
}

function readMainCompatibleTasks(path: string): MainCompatibleTaskFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (Array.isArray(parsed)) {
    for (const task of parsed) assertTaskShapeUnchanged(task);
    return { tasks: parsed };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    throw new Error('main-incompatible tasks.json');
  }
  assertOnlyKeys(parsed, new Set(['version', 'lifetimeSpendUsd', 'tasks']), 'tasks envelope');
  const envelope = parsed as MainCompatibleTaskFile;
  for (const task of envelope.tasks) assertTaskShapeUnchanged(task);
  return envelope;
}

function readMainCompatibleInteractionLog(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as { type?: unknown };
      if (typeof parsed.type !== 'string') throw new Error('interaction row missing type');
      const allowedKeys = INTERACTION_KEYS_BY_TYPE.get(parsed.type);
      if (!allowedKeys) throw new Error(`main-incompatible interaction row: ${parsed.type}`);
      assertOnlyKeys(parsed, allowedKeys, `interaction ${parsed.type}`);
      return parsed;
    });
}

describe('Phase 0a on-disk migration compatibility', () => {
  let tempDir: string;
  let tasksPath: string;
  let interactionsPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-phase0a-migration-'));
    tasksPath = join(tempDir, 'tasks.json');
    interactionsPath = join(tempDir, 'interaction-log.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps Phase 0a-saved tasks.json and interaction-log.jsonl readable by main', async () => {
    const store = new TaskStore();
    const task = store.createTask('Phase 0a task', '/repo');
    store.addSession(task.id, {
      tmuxSession: 'kookr-session',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-14T00:00:00.000Z'),
    });

    await saveTasks(store.getAllTasks(), tasksPath);
    const log = new InteractionLogWriter(interactionsPath);
    await log.append({
      type: 'user_input',
      agentId: 'kookr-session',
      content: 'continue',
      timestamp: '2026-05-14T00:00:01.000Z',
    });

    expect(readMainCompatibleTasks(tasksPath).tasks).toHaveLength(1);
    expect(readMainCompatibleInteractionLog(interactionsPath)).toHaveLength(1);
  });

  it('round-trips main envelope format through Phase 0a without adding remote artifacts', async () => {
    writeFileSync(tasksPath, JSON.stringify({
      version: 2,
      lifetimeSpendUsd: 0,
      tasks: [{
        id: 'main-task',
        prompt: 'main task',
        cwd: '/repo',
        status: 'open',
        sessions: [],
        agentType: 'claude-code',
        createdAt: '2026-05-14T00:00:00.000Z',
        updatedAt: '2026-05-14T00:00:00.000Z',
      }],
    }, null, 2));
    writeFileSync(interactionsPath, `${JSON.stringify({
      type: 'agent_selected',
      agentId: 'kookr-session',
      source: 'manual',
      timestamp: '2026-05-14T00:00:01.000Z',
    })}\n`);

    const loaded = await loadTasks(tasksPath);
    await saveTasks(loaded.tasks, tasksPath, loaded.lifetimeSpendUsd);
    const interactions = await readInteractionLog(interactionsPath);

    expect(readMainCompatibleTasks(tasksPath).tasks).toHaveLength(1);
    expect(interactions).toHaveLength(1);
    expect(readMainCompatibleInteractionLog(interactionsPath)).toHaveLength(1);
  });

  it('round-trips main v1 array format through Phase 0a back to a main-compatible envelope', async () => {
    writeFileSync(tasksPath, JSON.stringify([{
      id: 'v1-main-task',
      prompt: 'legacy task',
      cwd: '/repo',
      status: 'open',
      sessions: [],
      agentType: 'claude-code',
      createdAt: '2026-05-14T00:00:00.000Z',
      updatedAt: '2026-05-14T00:00:00.000Z',
    }]));

    const loaded = await loadTasks(tasksPath);
    await saveTasks(loaded.tasks, tasksPath, loaded.lifetimeSpendUsd);

    expect(readMainCompatibleTasks(tasksPath)).toMatchObject({
      version: 2,
      tasks: expect.any(Array),
    });
  });

  it('round-trips Phase 4a -> Phase 3 -> Phase 4a -> Phase 3 with audit.jsonl as a sidecar', async () => {
    const auditDir = tempDir;
    writeFileSync(tasksPath, JSON.stringify({
      version: 2,
      lifetimeSpendUsd: 0,
      tasks: [{
        id: 'phase-cycle-task',
        prompt: 'cycle task',
        cwd: '/repo',
        status: 'open',
        sessions: [],
        agentType: 'claude-code',
        createdAt: '2026-05-14T00:00:00.000Z',
        updatedAt: '2026-05-14T00:00:00.000Z',
      }],
    }, null, 2));

    const phase4a = await CommandJournal.open({
      kookrDir: auditDir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
    });
    await phase4a.appendIntent({
      commandId: asCommandId('cmd-cycle'),
      actorId: asActorId('local-owner'),
      clientId: asClientId('client-1'),
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
      sessionId: asSessionId('session-1'),
      sessionEpoch: asSessionEpoch('1'),
      grantId: asGrantId('grant-1'),
      idempotencyKey: asIdempotencyKey('idem-1'),
      action: 'presetReply',
    });

    const phase3Loaded = await loadTasks(tasksPath);
    await saveTasks(phase3Loaded.tasks, tasksPath, phase3Loaded.lifetimeSpendUsd);
    expect(readMainCompatibleTasks(tasksPath).tasks).toHaveLength(1);

    const phase4aAgain = await CommandJournal.open({
      kookrDir: auditDir,
      nodeId: asNodeId('node-1'),
      nodeEpoch: asNodeEpoch('1'),
    });
    expect(phase4aAgain.outcome(asCommandId('cmd-cycle')).outcome).toBe('unknown-intent-only');

    const phase3Again = await loadTasks(tasksPath);
    await saveTasks(phase3Again.tasks, tasksPath, phase3Again.lifetimeSpendUsd);
    expect(readMainCompatibleTasks(tasksPath).tasks).toHaveLength(1);
    expect(readFileSync(join(tempDir, 'audit.jsonl'), 'utf8')).toContain('cmd-cycle');
  });
});
