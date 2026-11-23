import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_DISCOVERY_ERROR, EXIT_OK, EXIT_USER_ERROR, runPlaybookCli } from './kookr-playbook.js';
import type { Playbook } from '../core/playbook.js';

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    out: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
    err: { error: (...a: unknown[]) => errors.push(a.map(String).join(' ')) },
  };
}

function playbook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: 'pb.md',
    scope: 'project',
    name: 'pb',
    description: '',
    parameters: [],
    checklist: [],
    tags: [],
    body: '',
    sourceCwd: '/p',
    ...overrides,
  };
}

const SAMPLE: Playbook[] = [
  playbook({ id: 'create-mr.md', name: 'create-mr', scope: 'project', description: 'Open a merge request' }),
  playbook({ id: 'triage.md', name: 'triage', scope: 'user', description: 'Triage the backlog' }),
  // Whitespace-only description so the `(no description)` sentinel depends on
  // formatPlaybookLine's `.trim()`, not merely on an empty string being falsy.
  playbook({ id: 'oss-bug-fix.md', name: 'oss-bug-fix', scope: 'plugin', description: '   ' }),
];

describe('kookr playbook (dispatch)', () => {
  it('no verb errors with usage guidance', async () => {
    const io = captureIo();
    const code = await runPlaybookCli([], { ...io, discover: async () => [] });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(io.errors.join('\n')).toContain('a verb is required');
  });

  it('no verb with --json emits a USER_ERROR envelope', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['--json'], { ...io, discover: async () => [] });
    expect(code).toBe(EXIT_USER_ERROR);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('USER_ERROR');
    expect(payload.message).toContain('a verb is required');
  });

  it('unknown verb errors', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['bogus'], { ...io, discover: async () => [] });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(io.errors.join('\n')).toContain('unknown verb: bogus');
  });

  it('unexpected trailing argument errors', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['list', 'extra'], { ...io, discover: async () => [] });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(io.errors.join('\n')).toContain('unexpected argument: extra');
  });

  it('unknown option errors', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['list', '--nope'], { ...io, discover: async () => [] });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(io.errors.join('\n')).toContain('unknown option: --nope');
  });

  it('--help prints usage and exits 0', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['--help'], { ...io, discover: async () => [] });
    expect(code).toBe(EXIT_OK);
    expect(io.logs.join('\n')).toContain('kookr playbook');
    expect(io.logs.join('\n')).toContain('kookr playbook list');
  });

  it('--json --help emits the help inside the shared envelope', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['list', '--json', '--help'], { ...io, discover: async () => [] });
    expect(code).toBe(EXIT_OK);
    expect(io.logs).toHaveLength(1);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ok).toBe(true);
    expect(payload.code).toBe('OK');
    expect(payload.message).toBe('Help');
    expect(payload.details.help).toContain('kookr playbook list');
  });
});

describe('kookr playbook list', () => {
  it('prints name · scope · description per playbook resolved from discovery', async () => {
    const io = captureIo();
    let seenCwd: string | undefined;
    const code = await runPlaybookCli(['list'], {
      ...io,
      cwd: '/work/project',
      discover: async (cwd) => {
        seenCwd = cwd;
        return SAMPLE;
      },
    });
    expect(code).toBe(EXIT_OK);
    expect(seenCwd).toBe('/work/project');
    expect(io.logs).toEqual([
      'create-mr · project · Open a merge request',
      'triage · user · Triage the backlog',
      // whitespace-only description collapses to the sentinel via `.trim()`
      'oss-bug-fix · plugin · (no description)',
    ]);
  });

  it('reports an empty catalog without failing', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['list'], { ...io, discover: async () => [] });
    expect(code).toBe(EXIT_OK);
    expect(io.logs).toEqual(['No playbooks found.']);
  });

  it('--json emits the shared envelope with a lean projected list', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['list', '--json'], {
      ...io,
      discover: async () => SAMPLE,
    });
    expect(code).toBe(EXIT_OK);
    expect(io.logs).toHaveLength(1);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload).toEqual({
      ok: true,
      code: 'OK',
      message: '3 playbook(s).',
      details: {
        playbooks: [
          {
            id: 'create-mr.md', name: 'create-mr', scope: 'project', description: 'Open a merge request',
            tiers: ['project'], tierContentDiffers: false,
          },
          {
            id: 'triage.md', name: 'triage', scope: 'user', description: 'Triage the backlog',
            tiers: ['user'], tierContentDiffers: false,
          },
          // the projection preserves the raw description; only the human line trims it
          {
            id: 'oss-bug-fix.md', name: 'oss-bug-fix', scope: 'plugin', description: '   ',
            tiers: ['plugin'], tierContentDiffers: false,
          },
        ],
      },
    });
    // The projection must not leak the heavy Playbook fields into the envelope.
    expect(payload.details.playbooks[0]).not.toHaveProperty('body');
    expect(payload.details.playbooks[0]).not.toHaveProperty('parameters');
  });

  it('--json reports an empty catalog as ok with an empty list', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['list', '--json'], { ...io, discover: async () => [] });
    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload).toEqual({
      ok: true,
      code: 'OK',
      message: '0 playbook(s).',
      details: { playbooks: [] },
    });
  });

  it('--json emits a USER_ERROR envelope for a bad flag', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['list', '--json', '--nope'], {
      ...io,
      discover: async () => SAMPLE,
    });
    expect(code).toBe(EXIT_USER_ERROR);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('USER_ERROR');
  });

  // --json is honored regardless of position, so a parse error before the flag
  // still yields the machine-readable envelope rather than plain-text stderr.
  it.each([
    ['bad flag before --json', ['list', '--nope', '--json'], 'unknown option: --nope'],
    ['unknown verb before --json', ['bogus', '--json'], 'unknown verb: bogus'],
    ['unexpected arg before --json', ['list', 'extra', '--json'], 'unexpected argument: extra'],
  ])('emits a USER_ERROR envelope when a %s', async (_label, argv, message) => {
    const io = captureIo();
    const code = await runPlaybookCli(argv, { ...io, discover: async () => SAMPLE });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(io.errors).toEqual([]);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('USER_ERROR');
    expect(payload.message).toContain(message);
  });

  it('surfaces a discovery filesystem failure as a DISCOVERY_ERROR envelope in --json mode', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['list', '--json'], {
      ...io,
      discover: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(code).toBe(EXIT_DISCOVERY_ERROR);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('DISCOVERY_ERROR');
    expect(payload.message).toContain('EACCES');
  });

  it('surfaces a discovery filesystem failure on stderr in human mode', async () => {
    const io = captureIo();
    const code = await runPlaybookCli(['list'], {
      ...io,
      discover: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(code).toBe(EXIT_DISCOVERY_ERROR);
    expect(io.logs).toEqual([]);
    expect(io.errors.join('\n')).toContain('failed to read playbook directories');
  });
});

// Exercises the real `discoverPlaybooks` default (no injected `discover`) so the
// default wiring — cwd threading, tier resolution, and the id-sort contract — is
// covered end to end, not just against a stub.
describe('kookr playbook list (real discovery, no injection)', () => {
  let userDir: string;
  let projectDir: string;
  let pluginDir: string;
  let homeDir: string;
  const savedUser = process.env.KOOKR_USER_PLAYBOOKS_DIR;
  const savedPlugin = process.env.KOOKR_PLUGIN_DIR;
  const savedHome = process.env.HOME;
  const savedPort = process.env.KOOKR_PORT;

  beforeEach(async () => {
    userDir = await mkdtemp(join(tmpdir(), 'kookr-pb-user-'));
    projectDir = await mkdtemp(join(tmpdir(), 'kookr-pb-project-'));
    // An empty temp dir is not a valid plugin dir (no manifest), so pointing
    // KOOKR_PLUGIN_DIR at it deterministically neutralizes the plugin tier —
    // otherwise real installed plugin playbooks would leak into the assertion.
    pluginDir = await mkdtemp(join(tmpdir(), 'kookr-pb-plugin-'));
    process.env.KOOKR_USER_PLAYBOOKS_DIR = userDir;
    process.env.KOOKR_PLUGIN_DIR = pluginDir;
    // The default schedule read is `$HOME/.kookr/schedules.json` (issue #4228):
    // point HOME at an empty temp dir so the host's real schedules never leak in.
    homeDir = await mkdtemp(join(tmpdir(), 'kookr-pb-home-'));
    process.env.HOME = homeDir;
    delete process.env.KOOKR_PORT;
  });

  afterEach(async () => {
    if (savedUser === undefined) delete process.env.KOOKR_USER_PLAYBOOKS_DIR;
    else process.env.KOOKR_USER_PLAYBOOKS_DIR = savedUser;
    if (savedPlugin === undefined) delete process.env.KOOKR_PLUGIN_DIR;
    else process.env.KOOKR_PLUGIN_DIR = savedPlugin;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPort === undefined) delete process.env.KOOKR_PORT;
    else process.env.KOOKR_PORT = savedPort;
    await Promise.all([
      rm(homeDir, { recursive: true, force: true }),
      rm(userDir, { recursive: true, force: true }),
      rm(projectDir, { recursive: true, force: true }),
      rm(pluginDir, { recursive: true, force: true }),
    ]);
  });

  it('reads user-tier playbooks from disk, id-sorted, with scope "user"', async () => {
    // Written out of id order to prove the id-sort comes from discoverPlaybooks.
    await writeFile(join(userDir, 'zebra.md'), '---\nname: Zebra\ndescription: Last by id\n---\nBody.\n');
    await writeFile(join(userDir, 'alpha.md'), '---\nname: Alpha\ndescription: First by id\n---\nBody.\n');

    const io = captureIo();
    const code = await runPlaybookCli(['list', '--json'], { ...io, cwd: projectDir });

    expect(code).toBe(EXIT_OK);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ok).toBe(true);
    expect(payload.details.playbooks).toEqual([
      { id: 'alpha.md', name: 'Alpha', scope: 'user', description: 'First by id', tiers: ['user'], tierContentDiffers: false },
      { id: 'zebra.md', name: 'Zebra', scope: 'user', description: 'Last by id', tiers: ['user'], tierContentDiffers: false },
    ]);
  });

  // Issue #4142 acceptance: the same file name in the user tier and the plugin
  // tier is marked when the contents differ, and not marked when they match.
  describe('a playbook in the user tier and the plugin tier', () => {
    let pluginRoot: string;
    let pluginPlaybooks: string;
    const USER_COPY = '---\nname: Goal Supervisor\ndescription: Supervise\n---\nUser body.\n';
    const PLUGIN_COPY = '---\nname: Goal Supervisor\ndescription: Supervise\n---\nPlugin body.\n';

    beforeEach(async () => {
      pluginRoot = await mkdtemp(join(tmpdir(), 'kookr-pb-plugin-tree-'));
      await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
      await writeFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fake', version: '0.0.0' }));
      pluginPlaybooks = join(pluginRoot, 'playbooks');
      await mkdir(pluginPlaybooks, { recursive: true });
      process.env.KOOKR_PLUGIN_DIR = pluginRoot;
    });

    afterEach(async () => {
      await rm(pluginRoot, { recursive: true, force: true });
    });

    it('marks different content in text and in the --json fields', async () => {
      await writeFile(join(userDir, 'goal-supervisor.md'), USER_COPY);
      await writeFile(join(pluginPlaybooks, 'goal-supervisor.md'), PLUGIN_COPY);

      const text = captureIo();
      expect(await runPlaybookCli(['list'], { ...text, cwd: projectDir })).toBe(EXIT_OK);
      expect(text.logs).toEqual([
        'Goal Supervisor · user · Supervise · also in plugin (different content; user runs; plugin ignored)',
      ]);

      const json = captureIo();
      expect(await runPlaybookCli(['list', '--json'], { ...json, cwd: projectDir })).toBe(EXIT_OK);
      expect(JSON.parse(json.logs[0]!).details.playbooks).toEqual([
        {
          id: 'goal-supervisor.md', name: 'Goal Supervisor', scope: 'user', description: 'Supervise',
          tiers: ['user', 'plugin'], tierContentDiffers: true,
        },
      ]);
    });

    it('shows identical copies without the different-content mark', async () => {
      await writeFile(join(userDir, 'goal-supervisor.md'), USER_COPY);
      await writeFile(join(pluginPlaybooks, 'goal-supervisor.md'), USER_COPY);

      const text = captureIo();
      expect(await runPlaybookCli(['list'], { ...text, cwd: projectDir })).toBe(EXIT_OK);
      expect(text.logs).toEqual(['Goal Supervisor · user · Supervise · also in plugin (identical)']);

      const json = captureIo();
      expect(await runPlaybookCli(['list', '--json'], { ...json, cwd: projectDir })).toBe(EXIT_OK);
      expect(JSON.parse(json.logs[0]!).details.playbooks[0]).toMatchObject({
        tiers: ['user', 'plugin'], tierContentDiffers: false,
      });
    });
  });
  // Issue #4228: a schedule runs the tier it pins, or the project tier of its
  // own cwd when unpinned. The note must not call the copy it runs ignored.
  describe('a playbook with a project copy and a different user copy, run by schedules', () => {
    const ID = 'queue-feeder.md';
    const PROJECT_COPY = '---\nname: Queue Feeder\ndescription: Feed\n---\nProject body.\n';
    const USER_COPY = '---\nname: Queue Feeder\ndescription: Feed\n---\nUser body.\n';

    beforeEach(async () => {
      await mkdir(join(projectDir, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(projectDir, '.kookr', 'playbooks', ID), PROJECT_COPY);
      await writeFile(join(userDir, ID), USER_COPY);
    });

    async function writeSchedules(schedules: unknown[]): Promise<void> {
      await mkdir(join(homeDir, '.kookr'), { recursive: true });
      await writeFile(join(homeDir, '.kookr', 'schedules.json'), JSON.stringify(schedules));
    }

    it('names the user copy as run by a schedule pinned to user', async () => {
      await writeSchedules([
        { id: 'feeder-1', name: 'Queue feeder', cron: '0 * * * *', cwd: homeDir, playbook: { path: ID, parameters: {}, scope: 'user' } },
      ]);

      const text = captureIo();
      expect(await runPlaybookCli(['list'], { ...text, cwd: projectDir })).toBe(EXIT_OK);
      expect(text.logs).toEqual([
        'Queue Feeder · project · Feed · also in user (different content; '
        + 'project runs only for launches from this directory; user runs for schedule "Queue feeder")',
      ]);

      const json = captureIo();
      expect(await runPlaybookCli(['list', '--json'], { ...json, cwd: projectDir })).toBe(EXIT_OK);
      expect(JSON.parse(json.logs[0]!).details.playbooks[0].scheduleRuns).toEqual([
        {
          scheduleId: 'feeder-1', name: 'Queue feeder', scope: 'user', pinned: true,
          filePath: join(userDir, ID), copyScope: 'user',
        },
      ]);
    });

    it('names the project copy as run by an unpinned schedule in this checkout', async () => {
      await writeSchedules([
        { id: 'nightly', name: 'Nightly', cron: '0 3 * * *', cwd: projectDir, playbook: { path: ID, parameters: {} } },
      ]);

      const text = captureIo();
      expect(await runPlaybookCli(['list'], { ...text, cwd: projectDir })).toBe(EXIT_OK);
      expect(text.logs).toEqual([
        'Queue Feeder · project · Feed · also in user (different content; '
        + 'project runs for launches from this directory and schedule "Nightly"; user ignored)',
      ]);

      const json = captureIo();
      expect(await runPlaybookCli(['list', '--json'], { ...json, cwd: projectDir })).toBe(EXIT_OK);
      expect(JSON.parse(json.logs[0]!).details.playbooks[0].scheduleRuns).toEqual([
        {
          scheduleId: 'nightly', name: 'Nightly', scope: 'project', pinned: false,
          filePath: join(projectDir, '.kookr', 'playbooks', ID), copyScope: 'project',
        },
      ]);
    });

    it('omits scheduleRuns and keeps "ignored" when no enabled schedule runs the id', async () => {
      await writeSchedules([
        { id: 'off', name: 'Off', enabled: false, cron: '0 * * * *', cwd: homeDir, playbook: { path: ID, parameters: {}, scope: 'user' } },
      ]);

      const text = captureIo();
      expect(await runPlaybookCli(['list'], { ...text, cwd: projectDir })).toBe(EXIT_OK);
      expect(text.logs).toEqual(['Queue Feeder · project · Feed · also in user (different content; project runs; user ignored)']);

      const json = captureIo();
      expect(await runPlaybookCli(['list', '--json'], { ...json, cwd: projectDir })).toBe(EXIT_OK);
      expect(JSON.parse(json.logs[0]!).details.playbooks[0]).not.toHaveProperty('scheduleRuns');
    });

    it('lists the playbooks and calls nothing ignored when schedules.json is unreadable', async () => {
      await mkdir(join(homeDir, '.kookr'), { recursive: true });
      await writeFile(join(homeDir, '.kookr', 'schedules.json'), '{not json');

      const text = captureIo();
      expect(await runPlaybookCli(['list'], { ...text, cwd: projectDir })).toBe(EXIT_OK);
      expect(text.logs).toEqual([
        'Queue Feeder · project · Feed · also in user (different content; '
        + 'project runs only for launches from this directory; user not run from this directory)',
      ]);
    });
  });
});
