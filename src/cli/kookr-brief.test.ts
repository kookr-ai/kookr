import { describe, expect, test } from 'vitest';
import { fixtureInbox, NOW, PLANTED_COMMAND } from '../../test/fixtures/operator-inbox.js';
import { BRIEF_HELP_TEXT, EXIT_NO_SERVER, EXIT_OK, EXIT_SERVER_ERROR, EXIT_USER_ERROR, formatBrief, runBriefCli } from './kookr-brief.js';

function io(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' }) {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      env,
      out: { log: (...a: unknown[]) => logs.push(a.join(' ')) },
      err: { error: (...a: unknown[]) => errors.push(a.join(' ')) },
      fetchImpl,
      now: () => NOW,
    },
  };
}

const respond = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('kookr brief', () => {
  test('prints the totals line, then the five items oldest first, with the command and links', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify(fixtureInbox()), { status: 200 });
    }) as typeof fetch;
    const t = io(fetchImpl);
    expect(await runBriefCli([], t.io)).toBe(EXIT_OK);
    expect(urls).toEqual(['http://127.0.0.1:4800/api/operator/inbox']);
    const text = t.logs.join('\n');
    expect(text.split('\n')[0]).toBe('5 waiting: 1 permission prompt, 1 question, 1 flagged task, 1 review, train halted');
    const order = ['permission ', 'question ', 'flagged ', 'review ', 'train '].map((label) => text.indexOf(`  ${label}`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain(`Bash: ${PLANTED_COMMAND}`);
    expect(text).toContain('Options: Compact list | Cards');
    expect(text).toContain('http://127.0.0.1:4800/?task=perm');
    expect(text).toContain('50 min');
  });

  test('formatBrief prints only the summary for an empty inbox', () => {
    const empty = { ...fixtureInbox(), items: [], summary: 'Nothing is waiting on you. 2 tasks are working in 1 project.' };
    expect(formatBrief(empty, 'http://x', NOW)).toBe('Nothing is waiting on you. 2 tasks are working in 1 project.');
  });

  test('--json prints one envelope carrying the inbox', async () => {
    const t = io(respond(200, fixtureInbox()));
    expect(await runBriefCli(['--json'], t.io)).toBe(EXIT_OK);
    expect(t.logs).toHaveLength(1);
    const envelope = JSON.parse(t.logs[0]);
    expect(envelope).toMatchObject({ ok: true, code: 'OK', details: { schema: 'kookr.operator-inbox.v1' } });
    expect(envelope.details.items).toHaveLength(5);
  });

  test('--help prints the help', async () => {
    const t = io(respond(200, {}));
    expect(await runBriefCli(['--help'], t.io)).toBe(EXIT_OK);
    expect(t.logs).toEqual([BRIEF_HELP_TEXT]);
  });

  test('an unknown flag or argument is a user error', async () => {
    const t = io(respond(200, {}));
    expect(await runBriefCli(['--wat'], t.io)).toBe(EXIT_USER_ERROR);
    expect(await runBriefCli(['extra'], t.io)).toBe(EXIT_USER_ERROR);
    expect(t.errors.join('\n')).toContain('unknown option: --wat');
  });

  test('a bad KOOKR_PORT is a user error', async () => {
    const t = io(respond(200, {}), { KOOKR_PORT: 'abc' });
    expect(await runBriefCli(['--json'], t.io)).toBe(EXIT_USER_ERROR);
    expect(JSON.parse(t.logs[0])).toMatchObject({ ok: false, code: 'USER_ERROR' });
  });

  test('no reachable server exits 3', async () => {
    const t = io((async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch, {});
    expect(await runBriefCli([], t.io)).toBe(EXIT_NO_SERVER);
    expect(t.errors.join('\n')).toContain('no Kookr server reachable');
  });

  test('a refused request (a viewer token) exits 4', async () => {
    const t = io(respond(403, { error: 'forbidden' }));
    expect(await runBriefCli([], t.io)).toBe(EXIT_SERVER_ERROR);
    expect(t.errors.join('\n')).toContain('HTTP 403');
  });

  test('a server without the route (404) exits 4 with a hint', async () => {
    const t = io(respond(404, 'not found'));
    expect(await runBriefCli([], t.io)).toBe(EXIT_SERVER_ERROR);
  });
});
