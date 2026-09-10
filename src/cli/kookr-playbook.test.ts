import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
          { id: 'create-mr.md', name: 'create-mr', scope: 'project', description: 'Open a merge request' },
          { id: 'triage.md', name: 'triage', scope: 'user', description: 'Triage the backlog' },
          // the projection preserves the raw description; only the human line trims it
          { id: 'oss-bug-fix.md', name: 'oss-bug-fix', scope: 'plugin', description: '   ' },
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
  const savedUser = process.env.KOOKR_USER_PLAYBOOKS_DIR;
  const savedPlugin = process.env.KOOKR_PLUGIN_DIR;

  beforeEach(async () => {
    userDir = await mkdtemp(join(tmpdir(), 'kookr-pb-user-'));
    projectDir = await mkdtemp(join(tmpdir(), 'kookr-pb-project-'));
    // An empty temp dir is not a valid plugin dir (no manifest), so pointing
    // KOOKR_PLUGIN_DIR at it deterministically neutralizes the plugin tier —
    // otherwise real installed plugin playbooks would leak into the assertion.
    pluginDir = await mkdtemp(join(tmpdir(), 'kookr-pb-plugin-'));
    process.env.KOOKR_USER_PLAYBOOKS_DIR = userDir;
    process.env.KOOKR_PLUGIN_DIR = pluginDir;
  });

  afterEach(async () => {
    if (savedUser === undefined) delete process.env.KOOKR_USER_PLAYBOOKS_DIR;
    else process.env.KOOKR_USER_PLAYBOOKS_DIR = savedUser;
    if (savedPlugin === undefined) delete process.env.KOOKR_PLUGIN_DIR;
    else process.env.KOOKR_PLUGIN_DIR = savedPlugin;
    await Promise.all([
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
      { id: 'alpha.md', name: 'Alpha', scope: 'user', description: 'First by id' },
      { id: 'zebra.md', name: 'Zebra', scope: 'user', description: 'Last by id' },
    ]);
  });
});
