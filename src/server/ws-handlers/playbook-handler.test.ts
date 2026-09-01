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
