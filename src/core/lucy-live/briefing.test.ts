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
