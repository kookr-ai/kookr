import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlaybookHandler } from './playbook-handler.js';
import type { LaunchOpts, LaunchResult } from '../launch-service.js';
import type { ClientMessage } from '../../shared/contracts/messages.js';
import type { Task } from '../../core/tasks.js';

describe('PlaybookHandler updateProjectLocalPath gate', () => {
  let cwd: string;
  let captured: LaunchOpts[] = [];
  let handler: PlaybookHandler;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'playbook-handler-test-'));
    await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
    captured = [];
    const launchTask = vi.fn(async (opts: LaunchOpts): Promise<LaunchResult> => {
      captured.push(opts);
      return { task: { id: 't1', cwd: opts.cwd, prompt: opts.prompt } as Task, queued: false };
    });
    handler = new PlaybookHandler({ send: () => {}, launchTask });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function writePlaybook(name: string, frontmatter: string, body = 'do it'): Promise<void> {
    await writeFile(
      join(cwd, '.kookr', 'playbooks', name),
      `---\n${frontmatter}\n---\n\n${body}\n`,
    );
  }

  test('forwards updateProjectLocalPath: true when playbook does NOT pin a cwd', async () => {
    await writePlaybook('plain.md', 'name: Plain\ndescription: x');
    const msg: ClientMessage = {
      type: 'launchPlaybook',
      playbookPath: 'plain.md',
      cwd,
      parameterValues: {},
      updateProjectLocalPath: true,
    };
    await handler.handle(msg as Extract<ClientMessage, { type: 'launchPlaybook' }>);
    expect(captured).toHaveLength(1);
    expect(captured[0].updateProjectLocalPath).toBe(true);
  });

  test('SUPPRESSES updateProjectLocalPath when the playbook pins its own cwd (defense-in-depth)', async () => {
    // Even when the client sends updateProjectLocalPath: true, the server
    // refuses to honor it for pinned-cwd playbooks — otherwise the
    // playbook's hardcoded path would be stamped as the project's
    // localPath, never the user's intent.
    const pinned = join(cwd, 'pinned-elsewhere');
    await mkdir(pinned, { recursive: true });
    await writePlaybook('pinned.md', `name: Pinned\ndescription: x\ncwd: ${pinned}`);

    const msg: ClientMessage = {
      type: 'launchPlaybook',
      playbookPath: 'pinned.md',
      cwd,
      parameterValues: {},
      updateProjectLocalPath: true,
    };
    await handler.handle(msg as Extract<ClientMessage, { type: 'launchPlaybook' }>);
    expect(captured).toHaveLength(1);
    expect(captured[0].updateProjectLocalPath).toBeUndefined();
  });

  test('omits updateProjectLocalPath when client does not send it', async () => {
    await writePlaybook('plain.md', 'name: Plain\ndescription: x');
    const msg: ClientMessage = {
      type: 'launchPlaybook',
      playbookPath: 'plain.md',
      cwd,
      parameterValues: {},
    };
    await handler.handle(msg as Extract<ClientMessage, { type: 'launchPlaybook' }>);
    expect(captured).toHaveLength(1);
    expect(captured[0].updateProjectLocalPath).toBeUndefined();
  });
});
