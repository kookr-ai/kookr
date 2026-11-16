import { describe, expect, it } from 'vitest';
import {
  defaultIdempotencyKey, parseAskArgs, parseDuration, runAskCli,
  EXIT_CANCELLED, EXIT_EXPIRED, EXIT_NO_SERVER, EXIT_NOT_CONFIGURED, EXIT_OK, EXIT_REJECTED, EXIT_STILL_PENDING, EXIT_USER_ERROR,
} from './kookr-ask.js';

function capture() {
  const logs: string[] = []; const errors: string[] = [];
  return { logs, errors, out: { log: (m: unknown) => logs.push(String(m)) }, err: { error: (m: unknown) => errors.push(String(m)) } };
}

const ASK = { id: 'abc123abc123', taskId: 't1', state: 'pending', expiresAt: 10_000_000 };
const ENV = { KOOKR_API_BASE_URL: 'http://k', KOOKR_TASK_ID: 't1' } as NodeJS.ProcessEnv;
const ARGS = ['--question', 'Ship it?', '--option', 'Yes', '--option', 'No'];

interface Req { url: string; method: string; body?: Record<string, unknown>; auth?: string }

/** Fetch double: POST /api/asks gets `post`, GET /api/asks/:id walks through `polls` (last one repeats). */
function fake(post: { status: number; body: unknown } | Error[] , polls: Array<{ status: number; body: unknown } | 'throw'> = []) {
  const reqs: Req[] = [];
  let postCalls = 0; let pollCalls = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    reqs.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const res = (r: { status: number; body: unknown }) => new Response(JSON.stringify(r.body), { status: r.status });
    if (method === 'POST') {
      postCalls++;
      if (Array.isArray(post)) { if (postCalls <= post.length) throw post[postCalls - 1]; return res({ status: 201, body: { ask: ASK, deduped: false, redacted: [] } }); }
      return res(post);
    }
    const p = polls[Math.min(pollCalls++, polls.length - 1)];
    if (p === 'throw') throw new Error('ECONNREFUSED');
    return res(p);
  }) as unknown as typeof fetch;
  return { impl, reqs };
}
const created = { status: 201, body: { ask: ASK, deduped: false, redacted: [] } };
const pollWith = (patch: Record<string, unknown>) => ({ status: 200, body: { ask: { ...ASK, ...patch } } });

function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('parseAskArgs / parseDuration', () => {
  it('parses flags in both --k v and --k=v forms, repeatable options and wait variants', () => {
    const a = parseAskArgs(['--question=Q?', '--option', 'A', '--option=B', '--context', 'c', '--timeout', '10m', '--task-id', 'x', '--no-other', '--wait', '--json']);
    expect(a).toMatchObject({ question: 'Q?', options: ['A', 'B'], context: 'c', timeoutSec: 600, taskId: 'x', allowText: false, waitSec: null, json: true });
    expect(parseAskArgs(['--wait=90']).waitSec).toBe(90);
    expect(parseAskArgs([]).waitSec).toBeUndefined();
  });
  it('a bare --wait does not swallow the next flag', () => {
    expect(parseAskArgs(['--wait', '--question', 'Q']).question).toBe('Q');
  });
  it.each([['30s', 30], ['10m', 600], ['2h', 7200], ['1d', 86400], ['45', 45], ['1.5m', 90]])('duration %s', (raw, sec) => {
    expect(parseDuration(raw)).toBe(sec);
  });
  it.each(['', 'abc', '-5', '0', '5x'])('rejects duration %j', (raw) => expect(parseDuration(raw)).toBeUndefined());
  it('reports unknown flags, stray args and missing values', () => {
    expect(parseAskArgs(['--bogus']).error).toMatch(/unknown option/);
    expect(parseAskArgs(['stray']).error).toMatch(/unexpected argument/);
    expect(parseAskArgs(['--question']).error).toMatch(/needs a value/);
    expect(parseAskArgs(['--timeout', 'soon']).error).toMatch(/--timeout/);
    expect(parseAskArgs(['--wait=soon']).error).toMatch(/--wait/);
  });
});

describe('runAskCli usage errors (no network)', () => {
  const run = async (argv: string[], env = ENV) => { const io = capture(); const f = fake(created); const code = await runAskCli(argv, { env, ...io, fetchImpl: f.impl }); return { code, io, reqs: f.reqs }; };
  it('requires a question, 2-4 options and a task id', async () => {
    for (const argv of [['--option', 'a', '--option', 'b'], ['--question', 'Q', '--option', 'a'], ['--question', 'Q', '--option', 'a', '--option', 'b', '--option', 'c', '--option', 'd', '--option', 'e']]) {
      const r = await run(argv); expect(r.code).toBe(EXIT_USER_ERROR); expect(r.reqs).toEqual([]);
    }
    const noTask = await run(ARGS, { KOOKR_API_BASE_URL: 'http://k' } as NodeJS.ProcessEnv);
    expect(noTask.code).toBe(EXIT_USER_ERROR); expect(noTask.io.errors.join()).toMatch(/KOOKR_TASK_ID/);
  });
  it('rejects an empty option label client-side and prints the error before the hint', async () => {
    const r = await run(['--question', 'Q', '--option', 'a', '--option=']);
    expect(r.code).toBe(EXIT_USER_ERROR);
    expect(r.reqs).toEqual([]);
    expect(r.io.errors[0]).toMatch(/empty/);
    expect(r.io.errors[1]).toMatch(/--help/);
  });
  it.each(['29', '29s', '604801', '169h', '8d'])('rejects --timeout %s outside 30s..7d with exit 2 and no request', async (raw) => {
    const r = await run([...ARGS, '--timeout', raw]);
    expect(r.code).toBe(EXIT_USER_ERROR);
    expect(r.reqs).toEqual([]);
    expect(r.io.errors[0]).toMatch(/--timeout must be between 30s and 7d/);
  });
  it.each([['30', 30], ['24h', 86400], ['48h', 172800], ['7d', 604800], ['168h', 604800]])('accepts the --timeout %s (inclusive bounds)', async (raw, sec) => {
    const r = await run([...ARGS, '--timeout', raw]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.reqs[0]).toMatchObject({ body: { timeoutSec: sec } });
  });
  it('reports an out-of-range --timeout as USER_ERROR in --json mode', async () => {
    const r = await run([...ARGS, '--timeout', '10s', '--json']);
    expect(r.code).toBe(EXIT_USER_ERROR);
    expect(r.reqs).toEqual([]);
    expect(JSON.parse(r.io.logs[0])).toMatchObject({ ok: false, code: 'USER_ERROR' });
  });
  it.each([
    ['http://example.com/mockups', /https/],
    ['ftp://example.com/x', /https/],
    ['not a url', /https/],
    [`https://example.com/${'a'.repeat(481)}`, /1\.\.500 characters/],
  ])('rejects --link %s with exit 2 and no request', async (url, message) => {
    const r = await run([...ARGS, '--link', url]);
    expect(r.code).toBe(EXIT_USER_ERROR);
    expect(r.reqs).toEqual([]);
    expect(r.io.errors[0]).toMatch(message);
  });
  it('accepts a 500-character https link, the longest allowed', async () => {
    const url = `https://example.com/${'a'.repeat(480)}`;
    expect(url).toHaveLength(500);
    const r = await run([...ARGS, '--link', url]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.reqs[0]).toMatchObject({ body: { links: [{ url }] } });
  });
  it('refuses a third --link, a --link-label with no --link before it, and a second label for one link', async () => {
    const third = await run([...ARGS, '--link', 'https://a.example', '--link', 'https://b.example', '--link', 'https://c.example']);
    expect(third.code).toBe(EXIT_USER_ERROR);
    expect(third.io.errors[0]).toMatch(/at most 2/);
    const orphan = await run([...ARGS, '--link-label', 'Open mockups', '--link', 'https://a.example']);
    expect(orphan.code).toBe(EXIT_USER_ERROR);
    expect(orphan.io.errors[0]).toMatch(/must follow the --link/);
    const twice = await run([...ARGS, '--link', 'https://a.example', '--link-label', 'One', '--link-label', 'Two']);
    expect(twice.code).toBe(EXIT_USER_ERROR);
    const long = await run([...ARGS, '--link', 'https://a.example', '--link-label', 'x'.repeat(41)]);
    expect(long.code).toBe(EXIT_USER_ERROR);
    expect(long.io.errors[0]).toMatch(/label/);
    const twoLines = await run([...ARGS, '--link', 'https://a.example', '--link-label', 'Open\nmockups']);
    expect(twoLines.code).toBe(EXIT_USER_ERROR);
    expect(twoLines.reqs).toEqual([]);
    expect(twoLines.io.errors[0]).toMatch(/single line/);
  });
  it('prints help with exit 0', async () => {
    const r = await run(['--help']); expect(r.code).toBe(EXIT_OK); expect(r.io.logs.join()).toMatch(/Exit codes/);
  });
});

describe('runAskCli without --wait', () => {
  it('posts the ask for KOOKR_TASK_ID with a stable idempotency key and prints only the id', async () => {
    const f = fake(created); const io = capture();
    const code = await runAskCli([...ARGS, '--context', 'ctx', '--timeout', '5m'], { env: ENV, ...io, fetchImpl: f.impl });
    expect(code).toBe(EXIT_OK);
    expect(io.logs).toEqual(['abc123abc123']);
    expect(f.reqs).toHaveLength(1);
    expect(f.reqs[0]).toMatchObject({ url: 'http://k/api/asks', method: 'POST', body: { taskId: 't1', question: 'Ship it?', options: ['Yes', 'No'], context: 'ctx', timeoutSec: 300, allowText: true, idempotencyKey: defaultIdempotencyKey('t1', 'Ship it?', ['Yes', 'No'], 'ctx') } });
    expect(defaultIdempotencyKey('t1', 'Q', ['a', 'b'])).not.toBe(defaultIdempotencyKey('t2', 'Q', ['a', 'b']));
    expect(defaultIdempotencyKey('t1', 'Q', ['a', 'b'])).not.toBe(defaultIdempotencyKey('t1', 'Q', ['b', 'a']));
  });
  it('sends each --link with the label after it, and folds links into the idempotency key', async () => {
    const f = fake(created);
    const code = await runAskCli([...ARGS, '--link', 'https://claude.ai/artifact/abc', '--link-label', 'Open mockups', '--link=https://github.com/o/r/pull/1'], { env: ENV, ...capture(), fetchImpl: f.impl });
    expect(code).toBe(EXIT_OK);
    const links = [{ url: 'https://claude.ai/artifact/abc', label: 'Open mockups' }, { url: 'https://github.com/o/r/pull/1' }];
    expect(f.reqs[0].body).toMatchObject({ links, idempotencyKey: defaultIdempotencyKey('t1', 'Ship it?', ['Yes', 'No'], undefined, links) });
    // A question without links keeps the key it always had; adding a link makes it another question.
    expect(defaultIdempotencyKey('t1', 'Q', ['a', 'b'], undefined, [])).toBe(defaultIdempotencyKey('t1', 'Q', ['a', 'b']));
    expect(defaultIdempotencyKey('t1', 'Q', ['a', 'b'], undefined, links)).not.toBe(defaultIdempotencyKey('t1', 'Q', ['a', 'b']));
  });
  it('sends no links field without --link', async () => {
    const f = fake(created);
    await runAskCli(ARGS, { env: ENV, ...capture(), fetchImpl: f.impl });
    expect(f.reqs[0].body).not.toHaveProperty('links');
  });
  it('--task-id overrides KOOKR_TASK_ID and --no-other is forwarded', async () => {
    const f = fake(created);
    await runAskCli([...ARGS, '--task-id', 'other', '--no-other'], { env: ENV, ...capture(), fetchImpl: f.impl });
    expect(f.reqs[0].body).toMatchObject({ taskId: 'other', allowText: false });
  });
  it('emits a JSON envelope', async () => {
    const io = capture();
    await runAskCli([...ARGS, '--json'], { env: ENV, ...io, fetchImpl: fake(created).impl });
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: true, code: 'OK', details: { askId: 'abc123abc123', state: 'pending' } });
  });
  it('forwards a bearer token and warns (stderr, not stdout) when text was redacted', async () => {
    const f = fake({ status: 201, body: { ask: ASK, deduped: false, redacted: ['question'] } }); const io = capture();
    await runAskCli(ARGS, { env: { ...ENV, KOOKR_API_TOKEN: 'tok' } as NodeJS.ProcessEnv, ...io, fetchImpl: f.impl });
    expect(f.reqs[0].auth).toBe('Bearer tok');
    expect(io.logs).toEqual(['abc123abc123']);
    expect(io.errors.join()).toMatch(/credential/);
  });
  it('maps 503 not_configured to exit 7 with guidance', async () => {
    const io = capture();
    const code = await runAskCli(ARGS, { env: ENV, ...io, fetchImpl: fake({ status: 503, body: { error: 'x', code: 'not_configured' } }).impl });
    expect(code).toBe(EXIT_NOT_CONFIGURED);
    expect(io.errors.join()).toMatch(/not configured/);
  });
  it.each([[404, 'unknown_task'], [409, 'terminal_task'], [429, 'rate_limited'], [502, 'delivery_failed'], [400, 'invalid']])('maps HTTP %i to exit 4', async (status, code) => {
    const io = capture();
    expect(await runAskCli(ARGS, { env: ENV, ...io, fetchImpl: fake({ status, body: { error: `E ${code}`, code } }).impl })).toBe(EXIT_REJECTED);
    expect(io.errors.join()).toContain(`E ${code}`);
  });
  it('retries one network failure (the idempotency key makes it safe) and then succeeds', async () => {
    const c = clock(); const f = fake([new Error('ECONNRESET')]); const io = capture();
    expect(await runAskCli(ARGS, { env: ENV, ...io, fetchImpl: f.impl, sleep: c.sleep, now: c.now })).toBe(EXIT_OK);
    expect(f.reqs.filter((r) => r.method === 'POST')).toHaveLength(2);
    expect(f.reqs[0].body?.idempotencyKey).toBe(f.reqs[1].body?.idempotencyKey);
  });
  it('exits 3 when the server stays unreachable', async () => {
    const c = clock();
    expect(await runAskCli(ARGS, { env: ENV, ...capture(), fetchImpl: fake([new Error('a'), new Error('b')]).impl, sleep: c.sleep, now: c.now })).toBe(EXIT_NO_SERVER);
  });
});

describe('runAskCli --wait', () => {
  const wait = async (polls: Parameters<typeof fake>[1], extra: string[] = ['--wait']) => {
    const c = clock(); const io = capture(); const f = fake(created, polls);
    const code = await runAskCli([...ARGS, ...extra], { env: ENV, ...io, fetchImpl: f.impl, sleep: c.sleep, now: c.now });
    return { code, io, f };
  };
  it('prints the chosen label once answered', async () => {
    const r = await wait([pollWith({}), pollWith({ state: 'answered', answer: { kind: 'option', index: 1, label: 'No' } })]);
    expect(r.code).toBe(EXIT_OK); expect(r.io.logs).toEqual(['No']);
  });
  it('marks every poll as a --wait poll, so the server does not also type the answer (#3824)', async () => {
    const r = await wait([pollWith({}), pollWith({ state: 'answered', answer: { kind: 'option', index: 0, label: 'Yes' } })]);
    const polls = r.f.reqs.filter((q) => q.method === 'GET');
    expect(polls.map((q) => q.url)).toEqual(['http://k/api/asks/abc123abc123?wait=1', 'http://k/api/asks/abc123abc123?wait=1']);
  });
  it('prints free text answers and puts the answer in the JSON envelope', async () => {
    const text = await wait([pollWith({ state: 'answered', answer: { kind: 'text', text: 'later please' } })]);
    expect(text.io.logs).toEqual(['later please']);
    const json = await wait([pollWith({ state: 'answered', answer: { kind: 'option', index: 0, label: 'Yes' }, taskDelivery: 'delivered' })], ['--wait', '--json']);
    expect(JSON.parse(json.io.logs[0])).toMatchObject({ ok: true, details: { answer: { label: 'Yes' }, taskDelivery: 'delivered' } });
  });
  it('exits 5 on expiry and 6 on cancellation (task gone)', async () => {
    expect((await wait([pollWith({ state: 'expired' })])).code).toBe(EXIT_EXPIRED);
    const gone = await wait([pollWith({ state: 'cancelled', resolution: 'task_gone' })]);
    expect(gone.code).toBe(EXIT_CANCELLED); expect(gone.io.errors.join()).toMatch(/task_gone/);
  });
  it('exits 8 when --wait=<s> elapses first, without polling forever', async () => {
    const r = await wait([pollWith({})], ['--wait=5']);
    expect(r.code).toBe(EXIT_STILL_PENDING);
    expect(r.f.reqs.filter((q) => q.method === 'GET').length).toBeLessThanOrEqual(4);
  });
  it('polls once right after the ask is created, before its first sleep, so the server knows it waits (#4040)', async () => {
    for (const deduped of [false, true]) {
      const c = clock(); const events: string[] = [];
      const f = fake({ status: deduped ? 200 : 201, body: { ask: ASK, deduped, redacted: [] } }, [pollWith({}), pollWith({ state: 'answered', answer: { kind: 'option', index: 0, label: 'Yes' } })]);
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        events.push(init?.method ?? 'GET');
        return f.impl(input, init);
      }) as unknown as typeof fetch;
      const sleep = async (ms: number) => { events.push(`sleep ${ms}`); await c.sleep(ms); };
      expect(await runAskCli([...ARGS, '--wait'], { env: ENV, ...capture(), fetchImpl, sleep, now: c.now })).toBe(EXIT_OK);
      expect(events).toEqual(['POST', 'GET', 'sleep 2000', 'GET']);
    }
  });
  it('survives transient poll failures (server restart) and non-OK polls', async () => {
    const r = await wait(['throw', { status: 500, body: {} }, pollWith({ state: 'answered', answer: { kind: 'option', index: 0, label: 'Yes' } })]);
    expect(r.code).toBe(EXIT_OK); expect(r.io.logs).toEqual(['Yes']);
  });
  it('fails fast with exit 4 when the ask disappears (404)', async () => {
    expect((await wait([{ status: 404, body: {} }])).code).toBe(EXIT_REJECTED);
  });
  it('a bare --wait is bounded by the ask expiry (+ grace), not infinite', async () => {
    const r = await wait([pollWith({})]);
    expect(r.code).toBe(EXIT_STILL_PENDING);
  });
});
