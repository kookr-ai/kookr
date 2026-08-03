import { describe, expect, it, vi } from 'vitest';

import { parseLaunchAllowlist } from '../launch-allowlist.js';
import {
  RemoteLaunchBroker,
  remoteLaunchFeatureEnabled,
  type RemoteLaunchCommand,
  type RemoteLaunchTaskOpts,
} from '../launch-broker.js';
import {
  asActorId,
  asClientId,
  asCommandId,
  asGrantId,
  asIdempotencyKey,
  asNodeEpoch,
  asNodeId,
  asSessionEpoch,
  asSessionId,
} from '../ids.js';

function command(overrides: Partial<RemoteLaunchCommand> = {}): RemoteLaunchCommand {
  return {
    actorId: asActorId('owner-1'),
    clientId: asClientId('client-1'),
    commandId: asCommandId('command-1'),
    nodeId: asNodeId('node-1'),
    nodeEpoch: asNodeEpoch('epoch-1'),
    sessionId: asSessionId('launch'),
    sessionEpoch: asSessionEpoch('launch'),
    action: 'launch',
    grantsChecked: ['launch'],
    grantId: asGrantId('grant-1'),
    baseRevision: 1,
    idempotencyKey: asIdempotencyKey('idem-1'),
    payload: {
      type: 'launch',
      projectId: 'github.com/kookr-ai/kookr',
      prompt: 'Fix the bug',
      agentType: 'claude-code',
    },
    ...overrides,
  };
}

function broker(opts: {
  maxConcurrent?: number;
  ownerId?: string;
  agents?: Array<'claude-code' | 'codex-cli' | 'grok-build'>;
  launchTask?: (opts: RemoteLaunchTaskOpts) => Promise<{ task: { id: string }; queued: boolean; duplicate?: boolean }>;
  getActiveLaunchCount?: () => number;
  getDefaultAgentType?: () => 'claude-code' | 'codex-cli' | 'grok-build' | 'round-robin';
  idempotencyTtlMs?: number;
  idempotencyMaxEntries?: number;
  allowCollaboratorGrants?: boolean;
} = {}): RemoteLaunchBroker {
  return new RemoteLaunchBroker({
    allowlist: {
      version: 1,
      ownerId: opts.ownerId ?? 'owner-1',
      projects: [{
        projectId: 'github.com/kookr-ai/kookr',
        cwd: '/tmp/kookr',
        agents: opts.agents ?? ['claude-code'],
        maxConcurrent: opts.maxConcurrent ?? 1,
      }],
    },
    launchTask: opts.launchTask ?? vi.fn().mockResolvedValue({ task: { id: 'task-1' }, queued: false }),
    getActiveLaunchCount: opts.getActiveLaunchCount,
    getDefaultAgentType: opts.getDefaultAgentType,
    idempotencyTtlMs: opts.idempotencyTtlMs,
    idempotencyMaxEntries: opts.idempotencyMaxEntries,
    allowCollaboratorGrants: opts.allowCollaboratorGrants,
  });
}

describe('remote launch allowlist schema', () => {
  it('accepts owner, project, agent, cwd, and concurrency cap', () => {
    const parsed = parseLaunchAllowlist({
      version: 1,
      ownerId: 'owner-1',
      projects: [{
        projectId: 'github.com/kookr-ai/kookr',
        cwd: '/tmp/kookr',
        agents: ['claude-code', 'codex-cli'],
        maxConcurrent: 2,
      }],
    });

    expect(parsed.ok).toBe(true);
  });

  it('rejects non-absolute project cwd entries', () => {
    const parsed = parseLaunchAllowlist({
      version: 1,
      ownerId: 'owner-1',
      projects: [{
        projectId: 'github.com/kookr-ai/kookr',
        cwd: 'relative',
        agents: ['claude-code'],
        maxConcurrent: 1,
      }],
    });

    expect(parsed.ok).toBe(false);
  });
});

describe('RemoteLaunchBroker', () => {
  it('rejects non-owner launches', async () => {
    const result = await broker().handle(command({ actorId: asActorId('collaborator-1') }));

    expect(result).toMatchObject({ ok: false, error: 'error.notOwner' });
  });

  it('allows non-owner launches only when the caller has already passed grant authorization', async () => {
    const launchTask = vi.fn().mockResolvedValue({ task: { id: 'task-1' }, queued: false });
    const result = await broker({ launchTask, allowCollaboratorGrants: true }).handle(command({
      actorId: asActorId('collaborator-1'),
    }));

    expect(result).toMatchObject({ ok: true, value: { taskId: 'task-1' } });
    expect(launchTask).toHaveBeenCalledTimes(1);
  });

  it('rejects project and agent combinations outside the allowlist', async () => {
    const result = await broker().handle(command({
      payload: {
        type: 'launch',
        projectId: 'github.com/kookr-ai/kookr',
        prompt: 'Fix the bug',
        agentType: 'codex-cli',
      },
    }));

    expect(result).toMatchObject({ ok: false, error: 'error.notAllowlisted' });
  });

  it('rejects unknown remote agent types instead of normalizing them', async () => {
    const result = await broker().handle(command({
      payload: {
        type: 'launch',
        projectId: 'github.com/kookr-ai/kookr',
        prompt: 'Fix the bug',
        agentType: 'unknown' as 'claude-code',
      },
    }));

    expect(result).toMatchObject({ ok: false, error: 'error.invalidRequest' });
  });

  it('launches with the allowlisted cwd rather than a caller-supplied path', async () => {
    const launchTask = vi.fn().mockResolvedValue({ task: { id: 'task-1' }, queued: false });
    const result = await broker({ launchTask }).handle(command({
      payload: {
        type: 'launch',
        projectId: 'github.com/kookr-ai/kookr',
        prompt: 'Fix the bug',
        agentType: 'claude-code',
        cwd: '/tmp/not-allowlisted',
      } as unknown as RemoteLaunchCommand['payload'],
    }));

    expect(result).toMatchObject({ ok: true, value: { taskId: 'task-1', queued: false } });
    expect(launchTask).toHaveBeenCalledWith({
      prompt: 'Fix the bug',
      cwd: '/tmp/kookr',
      criteria: undefined,
      agentType: 'claude-code',
      projectId: 'github.com/kookr-ai/kookr',
      disableDedup: false,
      launchSource: 'remote-relay',
    });
  });

  it('uses the configured default agent when payload omits agentType', async () => {
    const launchTask = vi.fn().mockResolvedValue({ task: { id: 'task-1' }, queued: false });
    const result = await broker({
      launchTask,
      agents: ['claude-code', 'grok-build'],
      getDefaultAgentType: () => 'grok-build',
    }).handle(command({
      payload: {
        type: 'launch',
        projectId: 'github.com/kookr-ai/kookr',
        prompt: 'Fix the bug',
      },
    }));

    expect(result).toMatchObject({ ok: true, value: { taskId: 'task-1' } });
    expect(launchTask).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'grok-build',
    }));
  });

  it('falls back to DEFAULT_AGENT_TYPE when payload omits agentType and no default getter is set', async () => {
    const launchTask = vi.fn().mockResolvedValue({ task: { id: 'task-1' }, queued: false });
    const result = await broker({ launchTask }).handle(command({
      payload: {
        type: 'launch',
        projectId: 'github.com/kookr-ai/kookr',
        prompt: 'Fix the bug',
      },
    }));

    expect(result).toMatchObject({ ok: true, value: { taskId: 'task-1' } });
    expect(launchTask).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'claude-code',
    }));
  });

  it('rejects N+1 simultaneous launches at the allowlist cap', async () => {
    let release!: () => void;
    const firstLaunch = new Promise<{ task: { id: string }; queued: boolean }>((resolve) => {
      release = () => resolve({ task: { id: 'task-1' }, queued: false });
    });
    const instance = broker({
      maxConcurrent: 1,
      launchTask: vi.fn().mockReturnValue(firstLaunch),
    });

    const first = instance.handle(command());
    const second = await instance.handle(command({ commandId: asCommandId('command-2'), idempotencyKey: asIdempotencyKey('idem-2') }));
    release();
    await first;

    expect(second).toMatchObject({ ok: false, error: 'error.concurrencyLimit' });
  });

  it('returns the original result when the same idempotency key is retried', async () => {
    const launchTask = vi.fn().mockResolvedValue({ task: { id: 'task-1' }, queued: false });
    const instance = broker({ launchTask });

    const first = await instance.handle(command());
    const second = await instance.handle(command({ commandId: asCommandId('command-retry') }));

    expect(first).toMatchObject({ ok: true, value: { taskId: 'task-1' } });
    expect(second).toEqual(first);
    expect(launchTask).toHaveBeenCalledTimes(1);
  });

  it('does not replay a successful result to a non-owner with the same tuple', async () => {
    const launchTask = vi.fn().mockResolvedValue({ task: { id: 'task-1' }, queued: false });
    const instance = broker({ launchTask });

    await instance.handle(command());
    const replay = await instance.handle(command({ actorId: asActorId('collaborator-1'), commandId: asCommandId('command-retry') }));

    expect(replay).toMatchObject({ ok: false, error: 'error.notOwner' });
    expect(launchTask).toHaveBeenCalledTimes(1);
  });

  it('does not let unauthorized rejects poison a later authorized retry tuple', async () => {
    const launchTask = vi.fn().mockResolvedValue({ task: { id: 'task-1' }, queued: false });
    const instance = broker({ launchTask });

    const reject = await instance.handle(command({ actorId: asActorId('collaborator-1') }));
    const accept = await instance.handle(command({ commandId: asCommandId('command-retry') }));

    expect(reject).toMatchObject({ ok: false, error: 'error.notOwner' });
    expect(accept).toMatchObject({ ok: true, value: { taskId: 'task-1' } });
    expect(launchTask).toHaveBeenCalledTimes(1);
  });

  it('evicts old idempotency entries when the cache reaches its bound', async () => {
    const launchTask = vi.fn()
      .mockResolvedValueOnce({ task: { id: 'task-1' }, queued: false })
      .mockResolvedValueOnce({ task: { id: 'task-2' }, queued: false })
      .mockResolvedValueOnce({ task: { id: 'task-1b' }, queued: false });
    const instance = broker({ launchTask, idempotencyMaxEntries: 1 });

    await instance.handle(command({ idempotencyKey: asIdempotencyKey('idem-1') }));
    await instance.handle(command({ idempotencyKey: asIdempotencyKey('idem-2') }));
    const replayEvicted = await instance.handle(command({ idempotencyKey: asIdempotencyKey('idem-1'), commandId: asCommandId('command-1b') }));

    expect(replayEvicted).toMatchObject({ ok: true, value: { taskId: 'task-1b' } });
    expect(launchTask).toHaveBeenCalledTimes(3);
  });

  it('includes active matching tasks in the concurrency cap', async () => {
    const getActiveLaunchCount = vi.fn().mockReturnValue(1);
    const result = await broker({ getActiveLaunchCount }).handle(command());

    expect(result).toMatchObject({ ok: false, error: 'error.concurrencyLimit' });
    expect(getActiveLaunchCount).toHaveBeenCalledWith({
      projectId: 'github.com/kookr-ai/kookr',
      agentType: 'claude-code',
    });
  });
});

describe('remote launch feature gate', () => {
  it('requires both a relay URL and the launch feature flag', () => {
    expect(remoteLaunchFeatureEnabled({ KOOKR_RELAY_URL: 'wss://relay', KOOKR_RELAY_FEATURES: 'terminal,launch' })).toBe(true);
    expect(remoteLaunchFeatureEnabled({ KOOKR_RELAY_FEATURES: 'launch' })).toBe(false);
    expect(remoteLaunchFeatureEnabled({ KOOKR_RELAY_URL: 'wss://relay', KOOKR_RELAY_FEATURES: 'terminal' })).toBe(false);
  });
});
