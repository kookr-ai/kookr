import { describe, expect, it } from 'vitest';
import { buildLucyLiveBriefing, MAX_BRIEFING_CHARS, type BriefingTask } from './briefing.js';
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
    expect(text.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS + 20);
    expect(text).toContain('and 85 more not listed');
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
    expect(text).toContain('not by voice');
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
    expect(text.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS + 20);
    expect(text).toContain('Ship the migration now?');
    expect(buildLucyLiveBriefing([], NOW, [ask()])).toMatch(/Ship the migration now\?[\s\S]*There are no tasks at all\./);
  });

  it('says when the task ended before an answer, and keeps the task counts when questions are long', () => {
    const long = `${'Should the nightly migration be allowed to proceed on the production cluster '.repeat(4)}?`;
    const pending = Array.from({ length: 4 }, (_, i) => ask({ id: `p${i}`, question: long, options: ['Option number one here', 'Option number two here', 'Option number three', 'Option number four'] }));
    const closed = Array.from({ length: 4 }, (_, i) => ask({ id: `c${i}`, question: long, state: 'cancelled', resolution: 'task_gone', resolvedAt: NOW - 60_000 }));
    const text = buildLucyLiveBriefing(tasks, NOW, [...pending, ...closed]);
    // Not every long question fits, but she still knows how many are waiting.
    expect(text).toContain('Questions from tasks waiting for the operator: 4 (');
    expect(text).toContain('Task counts: 1 in progress.');
    expect(text).toContain('"Fix login": in progress');
    expect(buildLucyLiveBriefing(tasks, NOW, [closed[0]])).toContain('Outcome: the task ended before an answer was given 1 minute ago.');
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

  it('the persona tells her she cannot take an answer by voice', () => {
    expect(buildLucyLivePersona('x')).toMatch(/cannot record an answer/);
  });
});
