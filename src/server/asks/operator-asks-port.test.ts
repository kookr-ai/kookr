import { describe, expect, it, vi } from 'vitest';
import type { AnswerResult, AskChange, AskRecord, OperatorAskView } from '../../shared/contracts/asks.js';
import type { Actor } from '../auth.js';
import { createOperatorAsksPort, pushOperatorAsks, type DashboardConnectionLike } from './operator-asks-port.js';

const NOW = 2_000_000_000_000;
const OWNER: Actor = { kind: 'owner' };
const VIEWER_ALL: Actor = { kind: 'viewer', grantId: 'g1', scope: { kind: 'all' } };
const VIEWER_PROJECTS: Actor = { kind: 'viewer', grantId: 'g2', scope: { kind: 'projects', projectIds: ['p1'] } };

function record(over: Partial<AskRecord> = {}): AskRecord {
  return {
    id: 'a1b2c3d4e5f6', taskId: 't1', question: 'Ship it?', options: ['Yes', 'No'], allowText: true,
    state: 'pending', createdAt: NOW - 1000, expiresAt: NOW + 60_000, nonce: 'n', delivery: { chatId: 1, messageId: 2 }, ...over,
  };
}
const view: OperatorAskView = {
  id: 'a1b2c3d4e5f6', taskId: 't1', question: 'Ship it?', options: ['Yes', 'No'], allowText: true,
  state: 'pending', createdAt: NOW - 1000, expiresAt: NOW + 60_000,
};

function socket(actor: Actor, readyState = 1): DashboardConnectionLike & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { actor, sent, ws: { readyState, send: (data: string) => { sent.push(JSON.parse(data)); } } };
}
const change = (kind: AskChange['kind']): AskChange => ({ kind, ask: record() });

describe('pushOperatorAsks: who is told about a question', () => {
  it('sends the list to an owner, naming the question only when it was just created', () => {
    const owner = socket(OWNER);
    expect(pushOperatorAsks([owner], [view], change('created'))).toBe(1);
    pushOperatorAsks([owner], [view], change('resolved'));
    pushOperatorAsks([owner], [view], change('updated'));
    expect(owner.sent).toEqual([
      { type: 'operatorAsks', asks: [view], serverNow: expect.any(Number), announce: 'a1b2c3d4e5f6' },
      { type: 'operatorAsks', asks: [view], serverNow: expect.any(Number) },
      { type: 'operatorAsks', asks: [view], serverNow: expect.any(Number) },
    ]);
  });

  it('never sends a question to a read-only viewer, not even one that sees every project', () => {
    const all = socket(VIEWER_ALL);
    const projects = socket(VIEWER_PROJECTS);
    expect(pushOperatorAsks([all, projects], [view], change('created'))).toBe(0);
    expect(all.sent).toEqual([]);
    expect(projects.sent).toEqual([]);
  });

  it('skips a connection that is not open', () => {
    const closing = socket(OWNER, 2);
    const open = socket(OWNER);
    expect(pushOperatorAsks([closing, open], [view], change('created'))).toBe(1);
    expect(closing.sent).toEqual([]);
    expect(open.sent).toHaveLength(1);
  });

  it('a connection whose send throws does not stop the next owner from being told', () => {
    const broken: DashboardConnectionLike = { actor: OWNER, ws: { readyState: 1, send: () => { throw new Error('socket gone'); } } };
    const healthy = socket(OWNER);
    const warn = vi.fn();
    expect(pushOperatorAsks([broken, healthy], [view], change('created'), warn)).toBe(1);
    expect(healthy.sent).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('createOperatorAsksPort', () => {
  function port(result: AnswerResult, appendAudit = vi.fn(async () => undefined)) {
    const service = { all: vi.fn(() => [record()]), answerFromDashboard: vi.fn(async () => result) };
    const p = createOperatorAsksPort({
      service, taskName: (id) => (id === 't1' ? 'Fix login' : undefined), auditLogPath: '/data/audit.jsonl', now: () => NOW, appendAudit,
    });
    return { port: p, service, appendAudit };
  }
  const answered = record({ state: 'answered', answeredVia: 'dashboard', taskDelivery: 'delivered', answer: { kind: 'text', text: 'the secret plan' } });

  it('lists the questions as the dashboard shows them', () => {
    const { port: p } = port({ ok: true, ask: answered });
    expect(p.list()).toEqual([{ ...view, taskName: 'Fix login' }]);
  });

  it('records an accepted answer in the audit log without the answer text', async () => {
    const { port: p, service, appendAudit } = port({ ok: true, ask: answered });
    expect(await p.answer({ askId: 'a1b2c3d4e5f6', text: 'the secret plan' })).toEqual({ ok: true, ask: answered });
    expect(service.answerFromDashboard).toHaveBeenCalledWith({ askId: 'a1b2c3d4e5f6', text: 'the secret plan' });
    expect(appendAudit).toHaveBeenCalledWith('/data/audit.jsonl', {
      type: 'ask.dashboardAnswer', timestamp: new Date(NOW).toISOString(), actor: 'owner:dashboard',
      askId: 'a1b2c3d4e5f6', taskId: 't1', choice: 'text', outcome: 'recorded', taskDelivery: 'delivered',
    });
    expect(JSON.stringify(appendAudit.mock.calls)).not.toContain('secret plan');
  });

  it('records a refused answer too, with the reason and the button pressed', async () => {
    const { port: p, appendAudit } = port({ ok: false, reason: 'already_answered', ask: answered });
    await p.answer({ askId: 'a1b2c3d4e5f6', optionIndex: 0 });
    expect(appendAudit).toHaveBeenCalledWith('/data/audit.jsonl', expect.objectContaining({ choice: 'option:0', outcome: 'already_answered', taskId: 't1' }));
    const unknown = port({ ok: false, reason: 'not_found' });
    await unknown.port.answer({ askId: 'ffffffffffff', optionIndex: 1 });
    expect(unknown.appendAudit.mock.calls[0][1]).toMatchObject({ askId: 'ffffffffffff', outcome: 'not_found' });
    expect(unknown.appendAudit.mock.calls[0][1]).not.toHaveProperty('taskId');
  });

  it('still returns the recorded answer when the audit write fails', async () => {
    const { port: p } = port({ ok: true, ask: answered }, vi.fn(async () => { throw new Error('disk full'); }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await p.answer({ askId: 'a1b2c3d4e5f6', optionIndex: 0 })).toEqual({ ok: true, ask: answered });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
