import { describe, expect, it } from 'vitest';
import { buildLucyLiveBriefing, capLines, MAX_BRIEFING_CHARS, MAX_LISTED_NEEDS, type BriefingNeed, type BriefingTask, type BriefingTrainHealth } from './briefing.js';
import { buildLucyLivePersona } from './persona.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const ago = (min: number): Date => new Date(NOW - min * 60_000);

describe('buildLucyLiveBriefing', () => {
  it('handles no tasks', () => {
    expect(buildLucyLiveBriefing([], NOW)).toBe('There are no tasks at all.');
  });

  it('counts by status, lists unfinished tasks with age and recent endings with reasons', () => {
    const tasks: BriefingTask[] = [
      { name: 'Fix login', status: 'inProgress', updatedAt: ago(5) },
      { name: 'Write docs', status: 'open', updatedAt: ago(30) },
      { name: 'Old build', status: 'terminated', terminationReason: 'timeout', updatedAt: ago(100), terminatedAt: ago(90) },
      { name: 'Ship it', status: 'completed', updatedAt: ago(10), finishedAt: ago(2) },
    ];
    const text = buildLucyLiveBriefing(tasks, NOW);
    expect(text).toContain('Task counts: 1 in progress, 1 open, 1 completed, 1 terminated.');
    expect(text).toMatch(/"Fix login": in progress, last updated 5 minutes ago/);
    expect(text.indexOf('Fix login')).toBeLessThan(text.indexOf('Write docs'));
    expect(text).toMatch(/"Old build": terminated \(reason: timeout\) 90 minutes ago/);
    expect(text.indexOf('Ship it')).toBeLessThan(text.indexOf('Old build'));
  });

  it('keeps only the last six ended tasks', () => {
    const tasks: BriefingTask[] = Array.from({ length: 9 }, (_, i) => ({
      name: `Done ${i}`, status: 'completed' as const, updatedAt: ago(i), finishedAt: ago(i),
    }));
    const text = buildLucyLiveBriefing(tasks, NOW);
    expect(text).toContain('Done 5');
    expect(text).not.toContain('Done 6');
  });

  it('never exposes long titles or secrets', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const text = buildLucyLiveBriefing([
      { name: 'Please investigate why the nightly build keeps failing on the staging cluster', status: 'inProgress', updatedAt: ago(1) },
      { name: `Use ${secret}`, status: 'open', updatedAt: ago(1) },
    ], NOW);
    expect(text).not.toContain('investigate');
    expect(text).not.toContain(secret);
    expect(text).toContain('a task with no short name');
  });

  it('caps the text without cutting a line in half', () => {
    const tasks: BriefingTask[] = Array.from({ length: 400 }, (_, i) => ({
      name: `Task number ${i}`, status: 'completed' as const, updatedAt: ago(i), finishedAt: ago(i),
    })).concat(Array.from({ length: 100 }, (_, i) => ({ name: `Live ${i}`, status: 'inProgress' as const, updatedAt: ago(i) })));
    const text = buildLucyLiveBriefing(tasks, NOW);
    expect(text.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS);
    expect(text).toContain('and 85 more not listed');
  });
});

describe('buildLucyLiveBriefing: what needs the operator (#3927)', () => {
  const need = (name: string, attention: BriefingNeed['attention'], project = 'kookr'): BriefingNeed => ({ name, project, attention });
  const healthy: BriefingTrainHealth = { running: true, halted: null, pendingSince: null, alerting: false };

  it('names the task, the project, the tool of the permission prompt and how long it has waited', () => {
    const text = buildLucyLiveBriefing(
      [{ name: 'Fix login', status: 'inProgress', updatedAt: ago(1) }],
      NOW,
      [],
      { needs: [need('Fix login', { kind: 'permission_blocked', tool: 'Bash', sinceMs: ago(12).getTime() })] },
    );
    expect(text.split('\n')[0]).toBe('Needs the operator: 1 task is waiting on the operator (longest first; the operator answers in the dashboard, you cannot):');
    expect(text).toContain('- "Fix login" in project kookr: waiting for permission to use Bash, for 12 minutes');
  });

  it('says why in Kookr\'s words for each kind of wait, longest first', () => {
    const text = buildLucyLiveBriefing([], NOW, [], {
      needs: [
        need('Review me', { kind: 'wants_review', sinceMs: ago(3).getTime() }),
        need('Quiet one', { kind: 'stale_agent', sinceMs: ago(40).getTime() }),
        need('Curious', { kind: 'asked_question', sinceMs: ago(1).getTime() }),
        need('No tool', { kind: 'permission_blocked' }),
      ],
    });
    expect(text).toContain('"Quiet one" in project kookr: it has stalled and gone quiet, for 40 minutes');
    expect(text).toContain('"Review me" in project kookr: it says it is finished and wants review, for 3 minutes');
    expect(text).toContain('"Curious" in project kookr: it asked a question in its session, for 1 minute');
    expect(text).toContain('"No tool" in project kookr: waiting for permission to use a tool, for an unknown time');
    const order = ['Quiet one', 'Review me', 'Curious', 'No tool'].map((n) => text.indexOf(n));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('states "none" when the source is wired and nothing waits, and says nothing when it is not wired', () => {
    expect(buildLucyLiveBriefing([], NOW, [], { needs: [] })).toContain('Needs the operator: no task is waiting on the operator.');
    expect(buildLucyLiveBriefing([], NOW)).not.toContain('Needs the operator');
  });

  it('comes before the questions from tasks and the task list', () => {
    const text = buildLucyLiveBriefing(
      [{ name: 'Fix login', status: 'inProgress', updatedAt: ago(1) }],
      NOW,
      [{ id: 'q', taskId: 't', taskName: 'Deploy', question: 'Which region?', options: ['EU', 'US'], allowText: false, state: 'pending', createdAt: ago(2).getTime(), expiresAt: NOW + 60_000 }],
      { needs: [need('Fix login', { kind: 'needs_input', sinceMs: ago(5).getTime() })], train: healthy },
    );
    const at = (s: string): number => text.indexOf(s);
    expect(at('Needs the operator')).toBe(0);
    expect(at('Needs the operator')).toBeLessThan(at('Integration train'));
    expect(at('Integration train')).toBeLessThan(at('Questions from tasks'));
    expect(at('Questions from tasks')).toBeLessThan(at('Task counts'));
  });

  it('cleans and cuts the name and the project, which a task can shape', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const text = buildLucyLiveBriefing([], NOW, [], {
      needs: [need(`Use ${secret}`, { kind: 'needs_input' }, `proj ${secret} \u001b[31mred\u001b[0m`)],
    });
    expect(text).not.toContain(secret);
    expect(text).not.toContain('\u001b');
  });

  it('lists at most a few tasks and says how many more wait', () => {
    const needs = Array.from({ length: MAX_LISTED_NEEDS + 3 }, (_, i) => need(`Wait ${i}`, { kind: 'needs_input', sinceMs: ago(100 - i).getTime() }));
    const text = buildLucyLiveBriefing([], NOW, [], { needs });
    expect(text).toContain(`Needs the operator: ${MAX_LISTED_NEEDS + 3} tasks are waiting`);
    expect(text).toContain('- and 3 more not listed');
    expect(text).not.toContain(`Wait ${MAX_LISTED_NEEDS}"`);
  });

  it('stays within the limit with everything full, and the "Needs the operator" section is cut last', () => {
    const tasks: BriefingTask[] = Array.from({ length: 300 }, (_, i) => ({ name: `Live task ${i}`, status: 'inProgress' as const, updatedAt: ago(i) }));
    const asks = Array.from({ length: 10 }, (_, i) => ({
      id: `q${i}`, taskId: `t${i}`, taskName: `Asker ${i}`, question: `Question ${i} ${'x'.repeat(200)}`, options: ['Yes', 'No'], allowText: false,
      state: 'pending' as const, createdAt: ago(i).getTime(), expiresAt: NOW + 60_000,
    }));
    const needs = Array.from({ length: 30 }, (_, i) => need(`Waiting task ${i}`, { kind: 'permission_blocked', tool: 'mcp__github__create_pull_request', sinceMs: ago(60 - i).getTime() }, 'a-rather-long-project-name-here'));
    const text = buildLucyLiveBriefing(tasks, NOW, asks, { needs, train: { running: false, halted: null, pendingSince: ago(45).toISOString(), alerting: true } });
    expect(text.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS);
    expect(text.startsWith('Needs the operator: 30 tasks are waiting')).toBe(true);
    // The whole section survives, every listed task and the count of the rest: the questions and the task list gave way.
    for (let i = 0; i < MAX_LISTED_NEEDS; i++) expect(text).toContain(`"Waiting task ${i}" in project a-rather-long-project-name-here: waiting for permission to use mcp__github__create_pull_request`);
    expect(text).toContain('- and 22 more not listed');
    expect(text.indexOf('- and 22 more not listed')).toBeLessThan(text.indexOf('Integration train'));
    // Questions are cut from their end, not dropped all at once.
    expect(text).toContain('Questions from tasks waiting for the operator: 10');
    expect(text).toContain('(list cut short)');
  });
});

describe('buildLucyLiveBriefing: the integration train (#3927)', () => {
  const brief = (train: BriefingTrainHealth | null | undefined): string => buildLucyLiveBriefing([], NOW, [], train === undefined ? {} : { train });

  it('says it is halted, since when, and why in plain words', () => {
    expect(brief({ running: true, halted: { reason: 'base-red', at: ago(20).toISOString() }, pendingSince: ago(25).toISOString(), alerting: false }))
      .toContain('Integration train: halted for 20 minutes because main itself fails the full test suite; merged changes do not reach main until someone fixes it.');
  });

  it('never repeats an unknown halt reason as it was written', () => {
    const text = brief({ running: true, halted: { reason: 'weird /home/jean/secret-path', at: ago(5).toISOString() }, pendingSince: null, alerting: false });
    expect(text).toContain('because of a problem it reported');
    expect(text).not.toContain('secret-path');
  });

  it('says it is stalled when the monitor raised the alarm', () => {
    expect(brief({ running: false, halted: null, pendingSince: ago(45).toISOString(), alerting: true }))
      .toContain('Integration train: stalled, not running; merged changes have waited for 45 minutes to reach main.');
  });

  it('says it is not running when a merged change waits and no alarm is out yet', () => {
    expect(brief({ running: false, halted: null, pendingSince: ago(20).toISOString(), alerting: false }))
      .toContain('Integration train: not running; merged changes have waited for 20 minutes to reach main.');
  });

  it('a train that runs again is said to run, even while the monitor\'s alarm from its last check is still set', () => {
    const text = brief({ running: true, halted: null, pendingSince: ago(40).toISOString(), alerting: true });
    expect(text).toContain('Integration train: running, no problem reported.');
    expect(text).not.toContain('not running');
  });

  it('gives a short all-clear otherwise, and nothing when no train is watched', () => {
    expect(brief({ running: true, halted: null, pendingSince: null, alerting: false })).toContain('Integration train: running, no problem reported.');
    expect(brief({ running: false, halted: null, pendingSince: null, alerting: false })).toContain('Integration train: not running, and no merged change is waiting for it.');
    expect(brief(null)).not.toContain('Integration train');
    expect(brief(undefined)).not.toContain('Integration train');
  });
});

describe('capLines', () => {
  it('keeps the cut note inside the limit', () => {
    const lines = Array.from({ length: 10 }, () => 'aaaaaaaaaa');
    const text = capLines(lines, 50);
    expect(text.length).toBeLessThanOrEqual(50);
    expect(text.endsWith('(list cut short)')).toBe(true);
    expect(text.split('\n').filter((l) => l === 'aaaaaaaaaa')).toHaveLength(3);
  });

  it('leaves text that fits as it is', () => {
    expect(capLines(['abc', 'def'], 7)).toBe('abc\ndef');
  });
});

describe('buildLucyLivePersona', () => {
  it('carries the briefing and the load-bearing rules', () => {
    const p = buildLucyLivePersona('BRIEFING-TEXT');
    expect(p).toContain('BRIEFING-TEXT');
    expect(p).toMatch(/ONLY the task status/);
    expect(p).toMatch(/do not have that/);
    expect(p).toMatch(/one or two short spoken sentences/);
    expect(p).toMatch(/cannot act/);
    expect(p).toMatch(/ALWAYS answer in English/);
  });
});

describe('buildLucyLiveBriefing: questions from tasks (kookr ask)', () => {
  const ask = (over: Record<string, unknown> = {}) => ({
    id: 'a1b2c3d4e5f6', taskId: 't1', taskName: 'Fix login', question: 'Ship the migration now?',
    options: ['Yes, ship it', 'No, wait'], allowText: true, state: 'pending' as const,
    createdAt: NOW - 3 * 60_000, expiresAt: NOW + 27 * 60_000, ...over,
  });
  const tasks: BriefingTask[] = [{ name: 'Fix login', status: 'inProgress', updatedAt: ago(5) }];

  it('says nothing about questions when there are none', () => {
    expect(buildLucyLiveBriefing(tasks, NOW, [])).not.toMatch(/Questions/);
    expect(buildLucyLiveBriefing(tasks, NOW)).toBe(buildLucyLiveBriefing(tasks, NOW, []));
  });

  it('lists a waiting question with its choices, before the task list', () => {
    const text = buildLucyLiveBriefing(tasks, NOW, [ask()]);
    expect(text).toContain('- The task "Fix login" asked 3 minutes ago: Ship the migration now? Choices: Yes, ship it; No, wait.');
    expect(text).toContain('which she reads back before sending');
    expect(text).toContain('Questions from tasks waiting for the operator: 1 (');
    expect(text.indexOf('Questions from tasks waiting')).toBeLessThan(text.indexOf('Task counts'));
  });

  it('says where a question was answered, so she knows the operator already replied on Telegram', () => {
    const text = buildLucyLiveBriefing(tasks, NOW, [
      ask({ state: 'answered', answeredVia: 'telegram', resolvedAt: NOW - 2 * 60_000, answer: { kind: 'option', index: 0, label: 'Yes, ship it' } }),
      ask({ id: 'b', taskName: undefined, state: 'answered', answeredVia: 'dashboard', resolvedAt: NOW - 60_000, answer: { kind: 'text', text: 'do both' } }),
      ask({ id: 'c', state: 'expired', expiresAt: NOW - 4 * 60_000 }),
    ]);
    expect(text).toContain('Questions from tasks waiting for the operator: none.');
    expect(text).toContain('Outcome: the operator answered "Yes, ship it" on Telegram 2 minutes ago.');
    expect(text).toContain('- A task asked: Ship the migration now? Outcome: the operator answered "do both" in Kookr 1 minute ago.');
    expect(text).toContain('Outcome: it expired with no answer 4 minutes ago.');
  });

  it('keeps the questions when a long task list is cut, and still works with no tasks', () => {
    const many: BriefingTask[] = Array.from({ length: 200 }, (_, i) => ({ name: `Task number ${i} with a fairly long name`, status: 'inProgress' as const, updatedAt: ago(i) }));
    const text = buildLucyLiveBriefing(many, NOW, [ask()]);
    expect(text.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS);
    expect(text).toContain('Ship the migration now?');
    expect(buildLucyLiveBriefing([], NOW, [ask()])).toMatch(/Ship the migration now\?[\s\S]*There are no tasks at all\./);
  });

  it('says when the asking session ended before an answer, and keeps the task counts when questions are long', () => {
    const long = `${'Should the nightly migration be allowed to proceed on the production cluster '.repeat(4)}?`;
    const pending = Array.from({ length: 4 }, (_, i) => ask({ id: `p${i}`, question: long, options: ['Option number one here', 'Option number two here', 'Option number three', 'Option number four'] }));
    const closed = Array.from({ length: 4 }, (_, i) => ask({ id: `c${i}`, question: long, state: 'cancelled', resolution: 'task_gone', resolvedAt: NOW - 60_000 }));
    const text = buildLucyLiveBriefing(tasks, NOW, [...pending, ...closed]);
    // Not every long question fits, but she still knows how many are waiting.
    expect(text).toContain('Questions from tasks waiting for the operator: 4 (');
    expect(text).toContain('Task counts: 1 in progress.');
    expect(text).toContain('"Fix login": in progress');
    expect(buildLucyLiveBriefing(tasks, NOW, [closed[0]])).toContain('Outcome: the session that asked ended before an answer was given 1 minute ago.');
  });

  it('lists four waiting questions and says how many more there are', () => {
    const six = Array.from({ length: 6 }, (_, i) => ask({ id: `p${i}`, question: `Question ${i}?` }));
    const text = buildLucyLiveBriefing(tasks, NOW, six);
    expect(text).toContain('Question 3?');
    expect(text).not.toContain('Question 4?');
    expect(text).toContain('- and 2 more questions not listed');
  });

  it('says a withdrawn question was withdrawn, and keeps a choice of the longest allowed length whole', () => {
    const text = buildLucyLiveBriefing(tasks, NOW, [
      ask({ id: 'w', state: 'cancelled', resolution: 'cancelled', resolvedAt: NOW - 60_000 }),
      ask({ id: 'p', options: ['Delete the one hundred and one merged worktrees', 'No'] }),
    ]);
    expect(text).toContain('Outcome: the task withdrew it 1 minute ago.');
    expect(text).toContain('Choices: Delete the one hundred and one merged worktrees; No.');
  });

  it('redacts a secret and shortens a very long question', () => {
    const text = buildLucyLiveBriefing(tasks, NOW, [
      ask({ question: `Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 here? ${'really '.repeat(80)}` }),
    ]);
    expect(text).not.toContain('sk-ant-api03');
    expect(text).toContain('…');
    // The rest of the briefing is still there: the redaction did not empty it.
    expect(text).toContain('The task "Fix login" asked 3 minutes ago: Use');
    expect(text).toContain('Choices: Yes, ship it; No, wait.');
  });

  it('the persona says she never records an answer herself and what to tell the operator when she is still asked', () => {
    const persona = buildLucyLivePersona('x');
    expect(persona).toMatch(/never record an answer yourself/);
    expect(persona).toMatch(/press it in your panel or answer on Telegram/);
  });
});
