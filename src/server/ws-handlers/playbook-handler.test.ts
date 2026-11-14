import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Playbook } from '../../core/playbook.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';

const { mockPreparePlaybookList } = vi.hoisted(() => ({
  mockPreparePlaybookList: vi.fn(),
}));

vi.mock('../use-cases/playbook-list.js', () => ({
  preparePlaybookList: mockPreparePlaybookList,
}));

import { PlaybookHandler } from './playbook-handler.js';

function fakePlaybook(): Playbook {
  return {
    id: 'p.md',
    scope: 'project',
    name: 'p',
    description: '',
    parameters: [],
    checklist: [],
    tags: [],
    body: '',
    sourceCwd: '/cwd',
  };
}

describe('PlaybookHandler.listPlaybooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('forwards capabilities from preparePlaybookList onto the playbooks server message', async () => {
    const sent: ServerMessage[] = [];
    const playbooks = [fakePlaybook()];
    mockPreparePlaybookList.mockResolvedValueOnce({
      playbooks,
      capabilities: { kb: 'absent' },
    });

    const handler = new PlaybookHandler({ send: (msg) => sent.push(msg) });
    const result = await handler.handle({ type: 'listPlaybooks', cwd: '/cwd' });

    expect(result).toEqual({ duplicate: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'playbooks',
      cwd: '/cwd',
      playbooks,
      capabilities: { kb: 'absent' },
    });
  });

  test('omits capabilities when preparePlaybookList does not supply them', async () => {
    const sent: ServerMessage[] = [];
    const playbooks = [fakePlaybook()];
    mockPreparePlaybookList.mockResolvedValueOnce({ playbooks });

    const handler = new PlaybookHandler({ send: (msg) => sent.push(msg) });
    await handler.handle({ type: 'listPlaybooks', cwd: '/cwd' });

    expect(sent).toHaveLength(1);
    // capabilities is `undefined` (the field is present but unset) — the wire
    // schema treats this as fail-open.
    const playbooksMsg = sent[0] as Extract<ServerMessage, { type: 'playbooks' }>;
    expect(playbooksMsg.capabilities).toBeUndefined();
  });

  test('forwards effort and model pins from the message into launchTask opts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-handler-pins-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'scout.md'), `---\nname: Scout\n---\n\nScout it.\n`);
      const launchTask = vi.fn().mockResolvedValue({ task: { id: 'task-1' }, queued: false });
      const handler = new PlaybookHandler({ send: () => {}, launchTask });

      await handler.handle({
        type: 'launchPlaybook',
        cwd,
        playbookPath: 'scout.md',
        parameterValues: {},
        agentType: 'claude-code',
        effort: 'high',
        model: 'claude-fable-5-2',
      });
      expect(launchTask.mock.calls[0]![0]).toMatchObject({ effort: 'high', model: 'claude-fable-5-2' });

      await handler.handle({
        type: 'launchPlaybook',
        cwd,
        playbookPath: 'scout.md',
        parameterValues: {},
      });
      const unpinned = launchTask.mock.calls[1]![0];
      expect(unpinned).not.toHaveProperty('effort');
      expect(unpinned).not.toHaveProperty('model');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('passes parsed delivery and relaunch policy as server-only launch metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-handler-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'ship.md'), `---
name: Ship
deliveryPreAuthorized: true
autoCloseOnSignal: true
---

Ship it.
`);
      const sent: ServerMessage[] = [];
      const launchTask = vi.fn().mockResolvedValue({
        task: { id: 'task-1' },
        queued: false,
      });
      const handler = new PlaybookHandler({ send: (msg) => sent.push(msg), launchTask });

      await handler.handle({
        type: 'launchPlaybook',
        cwd,
        playbookPath: 'ship.md',
        parameterValues: {},
        parentTaskId: 'original-task',
      });

      expect(launchTask).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Ship',
          prompt: expect.stringContaining('Ship it.'),
          disableDedup: true,
          parentTaskId: 'original-task',
          userInitiatedRelaunch: true,
          autoCloseOnSignal: true,
        }),
        { deliveryPolicy: 'pre-authorized' },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('PlaybookHandler.launchPlaybook with a chain (RFC rfc-playbook-chains)', () => {
  const base = { type: 'launchPlaybook' as const, cwd: '/repo', playbookPath: 'research.md', parameterValues: { subject: 'x' } };

  test('starts a chain through the chain service with the validated bounds', async () => {
    const sent: ServerMessage[] = [];
    const startChain = vi.fn(async () => ({ task: { id: 't1', name: 'Research' }, queued: false }) as never);
    const launchTask = vi.fn();
    const handler = new PlaybookHandler({ send: (msg) => sent.push(msg), launchTask, playbookChainService: { startChain } });
    await handler.handle({ ...base, chain: { maxIterations: 4, durationMinutes: 360 } });
    expect(launchTask).not.toHaveBeenCalled();
    expect(startChain).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      playbookPath: 'research.md',
      parameterValues: { subject: 'x' },
      spec: { maxIterations: 4, durationMinutes: 360 },
      launchSource: 'websocket',
    }));
  });

  test('refuses an invalid spec, a relaunch, or a server without chains, without launching', async () => {
    const startChain = vi.fn();
    const cases = [
      { deps: { playbookChainService: { startChain } }, msg: { ...base, chain: {} } },
      { deps: { playbookChainService: { startChain } }, msg: { ...base, chain: { maxIterations: 2 }, parentTaskId: 'p' } },
      { deps: {}, msg: { ...base, chain: { maxIterations: 2 } } },
    ];
    for (const { deps, msg } of cases) {
      const sent: ServerMessage[] = [];
      const handler = new PlaybookHandler({ send: (m) => sent.push(m), ...deps });
      await handler.handle(msg as never);
      expect(sent.some((m) => JSON.stringify(m).toLowerCase().includes('error') || m.type === 'alert')).toBe(true);
    }
    expect(startChain).not.toHaveBeenCalled();
  });
});
