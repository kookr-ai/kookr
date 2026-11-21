import { describe, it, expect } from 'vitest';
import {
  authorizeKeepAlive,
  parseKeepAliveRequest,
  resolveTaskIdRef,
  MAX_KEEP_ALIVE_REASON_CHARS,
} from './keep-alive-policy.js';

const worker = { id: 'worker-1', name: 'eval worker', parentTaskId: 'lead-1' };
const tasks = new Map([
  ['lead-1', { id: 'lead-1', name: 'the lead' }],
  ['other-1', { id: 'other-1', name: 'someone else' }],
  ['worker-1', worker],
]);
const getTask = (id: string) => tasks.get(id);

describe('authorizeKeepAlive (issue #4241)', () => {
  it('treats a call without a caller task id as the operator', () => {
    expect(authorizeKeepAlive({ target: worker, getTask })).toEqual({ ok: true, actor: 'operator', actorName: 'operator' });
    expect(authorizeKeepAlive({ target: worker, callerTaskId: '  ', getTask }).ok).toBe(true);
  });

  it('accepts the parent and names it', () => {
    expect(authorizeKeepAlive({ target: worker, callerTaskId: 'lead-1', getTask }))
      .toEqual({ ok: true, actor: 'task:lead-1', actorName: 'the lead' });
  });

  it('refuses the task itself', () => {
    expect(authorizeKeepAlive({ target: worker, callerTaskId: 'worker-1', getTask }))
      .toMatchObject({ ok: false, status: 403, code: 'self_keep_alive' });
  });

  it('refuses an unrelated task', () => {
    expect(authorizeKeepAlive({ target: worker, callerTaskId: 'other-1', getTask }))
      .toMatchObject({ ok: false, status: 403, code: 'not_parent' });
  });

  it('refuses every task for a target with no parent', () => {
    expect(authorizeKeepAlive({ target: { id: 'orphan' }, callerTaskId: 'lead-1', getTask }))
      .toMatchObject({ ok: false, code: 'not_parent' });
  });
});

describe('parseKeepAliveRequest', () => {
  it('accepts a valid body', () => {
    expect(parseKeepAliveRequest({ forMs: 1_800_000, reason: ' waiting\non CI ', callerTaskId: 'lead-1' }))
      .toEqual({ ok: true, forMs: 1_800_000, reason: 'waiting on CI', callerTaskId: 'lead-1' });
  });

  it.each([
    [null, 'body must be a JSON object'],
    [{ reason: 'x' }, 'forMs must be a positive number of milliseconds'],
    [{ forMs: 0, reason: 'x' }, 'forMs must be a positive number of milliseconds'],
    [{ forMs: 61 * 60_000, reason: 'x' }, 'one keep-alive is at most 60 minutes'],
    [{ forMs: 60_000 }, 'reason is required'],
    [{ forMs: 60_000, reason: '   ' }, 'reason is required'],
    [{ forMs: 60_000, reason: 'x', callerTaskId: 5 }, 'callerTaskId must be a string'],
  ])('refuses %j', (body, message) => {
    expect(parseKeepAliveRequest(body)).toEqual({ ok: false, message });
  });

  it('truncates a long reason', () => {
    const r = parseKeepAliveRequest({ forMs: 60_000, reason: 'x'.repeat(1000) });
    expect(r.ok && r.reason.length).toBe(MAX_KEEP_ALIVE_REASON_CHARS);
  });
});

describe('resolveTaskIdRef', () => {
  const ids = ['aaaaaaaa-1111', 'aaaaaaaa-2222', 'bbbbbbbb-3333'];
  it('resolves an exact id or a unique prefix of 8+ characters', () => {
    expect(resolveTaskIdRef(ids, 'bbbbbbbb-3333')).toEqual({ kind: 'found', id: 'bbbbbbbb-3333' });
    expect(resolveTaskIdRef(ids, 'bbbbbbbb')).toEqual({ kind: 'found', id: 'bbbbbbbb-3333' });
  });
  it('reports an ambiguous prefix, and ignores prefixes under 8 characters', () => {
    expect(resolveTaskIdRef(ids, 'aaaaaaaa')).toEqual({ kind: 'ambiguous', ids: ['aaaaaaaa-1111', 'aaaaaaaa-2222'] });
    expect(resolveTaskIdRef(ids, 'bbbb')).toEqual({ kind: 'none' });
  });
});
