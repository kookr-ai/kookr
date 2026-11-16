import { describe, expect, it } from 'vitest';
import { OPINION_HELP_TEXT, parseOpinionArgs, runOpinionCli, type CommandRunner } from './kookr-opinion.js';
import { HELP_TEXT, main } from '../../bin/kookr.js';

interface FakeComment { id: number; body: string; createdAt: string; url: string }

/** A tiny stand-in for GitHub and `kookr spawn`, enough for the sweep's calls. */
function fakeHost(items: Array<{ number: number; isPullRequest?: boolean; labelled?: boolean; comments: string[] }>) {
  let id = 1000;
  let minute = 0;
  const stamp = () => `2026-11-16T10:${String(minute++).padStart(2, '0')}:00Z`;
  const state = items.map((it) => ({
    number: it.number,
    isPullRequest: it.isPullRequest ?? false,
    labelled: it.labelled ?? true,
    comments: it.comments.map((body): FakeComment => {
      const cid = id++;
      return { id: cid, body, createdAt: stamp(), url: `https://github.com/o/r/issues/${it.number}#issuecomment-${cid}` };
    }),
  }));
  const spawns: Array<{ args: string[]; prompt?: string }> = [];
  const labelRemovals: number[] = [];
  const find = (n: number) => {
    const item = state.find((s) => s.number === n);
    if (!item) throw new Error(`no item ${n}`);
    return item;
  };
  const run: CommandRunner = async (cmd, args, input) => {
    if (cmd !== 'gh') {
      spawns.push({ args, prompt: input });
      return { code: 0, stdout: JSON.stringify({ ok: true, details: { taskId: `task-${spawns.length}` } }), stderr: '' };
    }
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    if (path.startsWith('repos/o/r/issues?labels=')) {
      const lines = state.filter((s) => s.labelled).map((s) => JSON.stringify({ number: s.number, url: `https://github.com/o/r/issues/${s.number}`, isPullRequest: s.isPullRequest }));
      return { code: 0, stdout: lines.join('\n'), stderr: '' };
    }
    const m = /^repos\/o\/r\/issues\/(\d+)\/(comments|labels\/needs-operator-opinion)/.exec(path);
    if (!m) return { code: 1, stdout: '', stderr: `unexpected ${path}` };
    const item = find(Number(m[1]));
    if (m[2].startsWith('labels')) {
      labelRemovals.push(item.number);
      item.labelled = false;
      return { code: 0, stdout: '', stderr: '' };
    }
    const bodyArg = args.find((a) => a.startsWith('body='));
    if (bodyArg) {
      const cid = id++;
      item.comments.push({ id: cid, body: bodyArg.slice(5), createdAt: stamp(), url: `https://github.com/o/r/issues/${item.number}#issuecomment-${cid}` });
      return { code: 0, stdout: '{}', stderr: '' };
    }
    return { code: 0, stdout: item.comments.map((c) => JSON.stringify(c)).join('\n'), stderr: '' };
  };
  return { run, spawns, labelRemovals, state };
}

const REQUEST = '<!-- kookr:opinion-request recommended=A -->\nVariants: A (recommended), B, C.';

function io(run: CommandRunner) {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    io: { run, out: { log: (m: unknown) => logs.push(String(m)) }, err: { error: (m: unknown) => errors.push(String(m)) }, cwd: '/work', spawnBin: '/bin/kookr-spawn.js' },
    logs,
    errors,
  };
}

describe('kookr opinion sweep', () => {
  it('starts exactly one follow-up for a reply choosing another variant, and none on a second run', async () => {
    const host = fakeHost([{ number: 7, comments: [REQUEST, '/opinion B'] }]);
    const first = io(host.run);
    expect(await runOpinionCli(['sweep', '--repo', 'o/r'], first.io)).toBe(0);
    expect(host.spawns).toHaveLength(1);
    expect(host.spawns[0].args).toEqual(expect.arrayContaining(['--cwd', '/work', '--idempotency-key', 'opinion:o/r#7:1001']));
    expect(host.spawns[0].prompt).toContain('o/r issue #7');
    expect(host.state[0].comments.at(-1)?.body).toMatch(/^<!-- kookr:opinion-handled reply=1001 action=follow-up -->/);
    expect(host.state[0].comments.at(-1)?.body).toContain('task-1');
    expect(host.state[0].labelled).toBe(true);

    const second = io(host.run);
    expect(await runOpinionCli(['sweep', '--repo', 'o/r'], second.io)).toBe(0);
    expect(host.spawns).toHaveLength(1);
    expect(second.logs.join('\n')).toContain('0 new replies');
  });

  it('removes the label on an accepting reply and starts no task', async () => {
    const host = fakeHost([{ number: 8, isPullRequest: true, comments: [REQUEST, '/opinion ok'] }]);
    expect(await runOpinionCli(['sweep', '--repo', 'o/r'], io(host.run).io)).toBe(0);
    expect(host.labelRemovals).toEqual([8]);
    expect(host.spawns).toEqual([]);
    expect(host.state[0].comments.at(-1)?.body).toContain('action=accept');
  });

  it('changes nothing in a dry run', async () => {
    const host = fakeHost([{ number: 9, comments: [REQUEST, '/opinion C'] }]);
    const run = io(host.run);
    expect(await runOpinionCli(['sweep', '--repo', 'o/r', '--dry-run', '--json'], run.io)).toBe(0);
    expect(host.spawns).toEqual([]);
    expect(host.state[0].comments).toHaveLength(2);
    const envelope = JSON.parse(run.logs[0]) as { details: { swept: Array<{ action: string }> } };
    expect(envelope.details.swept.map((s) => s.action)).toEqual(['follow-up']);
  });

  it('does not record a reply whose follow-up failed to start, so the next run retries it', async () => {
    const host = fakeHost([{ number: 10, comments: [REQUEST, '/opinion B'] }]);
    const failing: CommandRunner = async (cmd, args, input) =>
      cmd === 'gh' ? host.run(cmd, args, input) : { code: 3, stdout: '', stderr: 'no server' };
    const run = io(failing);
    expect(await runOpinionCli(['sweep', '--repo', 'o/r'], run.io)).toBe(4);
    expect(host.state[0].comments).toHaveLength(2);
    expect(run.errors.join('\n')).toContain('no server');
  });

  it('stops on an item after a failed follow-up, so a later accept cannot hide the reply', async () => {
    const host = fakeHost([{ number: 11, comments: [REQUEST, '/opinion B', '/opinion ok'] }]);
    const failing: CommandRunner = async (cmd, args, input) =>
      cmd === 'gh' ? host.run(cmd, args, input) : { code: 4, stdout: '', stderr: 'server error' };
    expect(await runOpinionCli(['sweep', '--repo', 'o/r'], io(failing).io)).toBe(4);
    expect(host.state[0].labelled).toBe(true);
    expect(host.labelRemovals).toEqual([]);

    expect(await runOpinionCli(['sweep', '--repo', 'o/r'], io(host.run).io)).toBe(0);
    expect(host.spawns).toHaveLength(1);
    expect(host.labelRemovals).toEqual([11]);
  });

  it('asks GitHub for each comment author association, so outsiders can be ignored', async () => {
    const calls: string[][] = [];
    const host = fakeHost([{ number: 12, comments: [REQUEST] }]);
    const spy: CommandRunner = async (cmd, args, input) => { calls.push(args); return host.run(cmd, args, input); };
    await runOpinionCli(['sweep', '--repo', 'o/r'], io(spy).io);
    const commentFetch = calls.find((a) => a.some((x) => x.includes('/comments?')));
    expect(commentFetch?.join(' ')).toContain('authorAssociation: .author_association');
  });

  it('requires a valid --repo and the sweep verb', async () => {
    const run = io(fakeHost([]).run);
    expect(await runOpinionCli(['sweep'], run.io)).toBe(2);
    expect(await runOpinionCli(['nope', '--repo', 'o/r'], run.io)).toBe(2);
    expect(parseOpinionArgs(['sweep', '--repo'])).toMatchObject({ error: '--repo needs a value' });
  });

  it('dispatches opinion help through the main binary and lists it in root help', async () => {
    const logs: string[] = [];
    const codes: number[] = [];
    try {
      await main({
        argv: ['opinion', '--help'],
        env: {},
        out: { log: (m: string) => logs.push(m), error: () => undefined },
        err: { error: () => undefined },
        exit: ((c: number) => { codes.push(c); }) as (code: number) => never,
      });
      expect(codes).toEqual([0]);
      expect(logs).toEqual([OPINION_HELP_TEXT]);
      expect(HELP_TEXT).toContain('kookr opinion sweep');
    } finally {
      process.exitCode = undefined;
    }
  });
});
