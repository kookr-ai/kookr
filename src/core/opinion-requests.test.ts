import { describe, expect, it, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  followUpPrompt,
  handledMarkerBody,
  isAcceptingReply,
  parseOpinionReply,
  planOpinionSweep,
  type OpinionComment,
} from './opinion-requests.js';

let nextId = 100;
function comment(body: string, minute: number): OpinionComment {
  const id = nextId++;
  return { id, body, createdAt: `2026-11-16T10:${String(minute).padStart(2, '0')}:00Z`, url: `https://github.com/o/r/issues/1#issuecomment-${id}` };
}

const request = (minute = 0, recommended = 'A') =>
  comment(`<!-- kookr:opinion-request recommended=${recommended} -->\nWhich layout? A (recommended), B, C.\nReply with \`/opinion ok\`, \`/opinion B\`, or \`/opinion <change>\`.`, minute);

describe('planOpinionSweep', () => {
  it('turns a reply that picks another variant into one follow-up', () => {
    const req = request();
    const reply = comment('/opinion B', 5);
    const plan = planOpinionSweep([req, reply]);
    expect(plan.request).toEqual({ commentId: req.id, recommended: 'A' });
    expect(plan.actions).toEqual([{ kind: 'follow-up', reply: { commentId: reply.id, url: reply.url, text: 'B' } }]);
  });

  it('does nothing again once the sweep recorded the reply as handled', () => {
    const req = request();
    const reply = comment('/opinion B', 5);
    const first = planOpinionSweep([req, reply]);
    const marker = comment(handledMarkerBody(first.actions[0], 'task-1'), 6);
    expect(planOpinionSweep([req, reply, marker]).actions).toEqual([]);
  });

  it('treats ok, accept words and the recommended letter alone as acceptance', () => {
    const req = request(0, 'A');
    const plan = planOpinionSweep([req, comment('/opinion ok', 1), comment('/OPINION a.', 2), comment('/opinion LGTM', 3)]);
    expect(plan.actions.map((a) => a.kind)).toEqual(['accept', 'accept', 'accept']);
  });

  it('treats the recommended letter with more to say as a requested change', () => {
    const plan = planOpinionSweep([request(), comment('/opinion A, but make the badge bigger', 1)]);
    expect(plan.actions.map((a) => a.kind)).toEqual(['follow-up']);
  });

  it('keeps the lines after /opinion in the reply text', () => {
    const plan = planOpinionSweep([request(), comment('\n/opinion\nUse C.\nAnd keep the old icon.', 1)]);
    expect(plan.actions[0].reply.text).toBe('Use C.\nAnd keep the old icon.');
  });

  it('ignores comments without the /opinion prefix (workers post with the same account)', () => {
    const plan = planOpinionSweep([request(), comment('Delivered in #12. Use /opinion to answer.', 1), comment('B please', 2)]);
    expect(plan.actions).toEqual([]);
  });

  it('ignores replies posted before the first request and items with no request', () => {
    expect(planOpinionSweep([comment('/opinion B', 0)]).actions).toEqual([]);
    expect(planOpinionSweep([comment('/opinion B', 0), request(1)]).actions).toEqual([]);
  });

  it('never treats a comment that carries an opinion marker as a reply', () => {
    const req = request();
    const quoting = comment('/opinion B\n<!-- kookr:opinion-handled reply=1 action=follow-up -->', 1);
    expect(planOpinionSweep([req, quoting]).actions).toEqual([]);
  });

  it('makes every reply work, an accept included, when the task stopped before a hard-to-undo choice', () => {
    const stopped = comment('<!-- kookr:opinion-request recommended=A stopped -->\nMigrate the table now?', 0);
    const plan = planOpinionSweep([stopped, comment('/opinion ok', 1), comment('/opinion B', 2)]);
    expect(plan.request).toEqual({ commentId: stopped.id, recommended: 'A', stopped: true });
    expect(plan.actions.map((a) => a.kind)).toEqual(['follow-up', 'follow-up']);
  });

  it('judges each reply against the request it answered', () => {
    const plan = planOpinionSweep([request(0, 'A'), comment('/opinion B', 1), request(2, 'B'), comment('/opinion B', 3)]);
    expect(plan.actions.map((a) => a.kind)).toEqual(['follow-up', 'accept']);
    expect(plan.request?.recommended).toBe('B');
  });
});

describe('helpers', () => {
  it('needs a request with no recommendation to get an explicit accept word', () => {
    expect(isAcceptingReply('A', undefined)).toBe(false);
    expect(isAcceptingReply('ok', undefined)).toBe(true);
  });

  it('parses only a first line that starts with /opinion', () => {
    expect(parseOpinionReply(comment('/opinions are welcome', 0))).toBeUndefined();
    expect(parseOpinionReply(comment('/opinion B', 0))?.text).toBe('B');
  });

  it('writes a follow-up prompt that carries the reply and its link', () => {
    const reply = { commentId: 7, url: 'https://github.com/o/r/issues/1#issuecomment-7', text: 'B' };
    const prompt = followUpPrompt({ repo: 'o/r', number: 1, itemUrl: 'https://github.com/o/r/issues/1', isPullRequest: false, reply });
    expect(prompt).toContain('o/r issue #1');
    expect(prompt).toContain(reply.url);
    expect(prompt).toContain('\nB\n');
  });
});

describe('the skill documents the format the sweep parses', () => {
  const skill = readFileSync(join(import.meta.dirname, '..', '..', 'plugin', 'skills', 'asking-the-operator', 'SKILL.md'), 'utf-8');

  test('the request template marker and reply commands parse as documented', () => {
    const marker = /<!-- kookr:opinion-request recommended=A -->/.exec(skill)?.[0];
    expect(marker).toBeDefined();
    const req = comment(`${marker}\nOpinion wanted`, 0);
    expect(planOpinionSweep([req, comment('/opinion ok', 1)]).actions[0].kind).toBe('accept');
    expect(planOpinionSweep([req, comment('/opinion B', 1)]).actions[0].kind).toBe('follow-up');
    expect(skill).toContain('`<!-- kookr:opinion-request recommended=A stopped -->`');
    expect(skill).toContain('kookr opinion sweep --repo <owner/name>');
    expect(skill).toContain('--timeout 24h');
  });
});
