import { describe, it, expect } from 'vitest';
import { migrateScheduleScopes, SCOPE_BY_PLAYBOOK_PATH } from './migrate-schedule-scopes.js';

function scheduleFixture(name: string, path: string, scope?: string) {
  return {
    id: `id-${name}`,
    name,
    cron: '0 3 * * *',
    cwd: '~/git/kookr-prod',
    playbook: { path, parameters: {}, ...(scope ? { scope } : {}) },
  };
}

describe('migrateScheduleScopes', () => {
  it('stamps the four enumerated schedules with their intended scopes', () => {
    // Real live names drift from the RFC table (e.g. "Knowledge Base MCP
    // Server …", "Local Research Agent …") — matching on the relocated
    // playbook path stamps them regardless of display name.
    const input = [
      scheduleFixture('Kookr Nightly Repository Idea Scout', 'repository-idea-scout.md'),
      scheduleFixture('Knowledge Base MCP Server Nightly Repository Idea Scout', 'repository-idea-scout.md'),
      scheduleFixture('Local Research Agent Nightly Repository Idea Scout', 'repository-idea-scout.md'),
      scheduleFixture('KB-Scout Eval Daily Self-Reflection', 'kb-scout-reflection.md'),
    ];

    const { changes, schedules, changed } = migrateScheduleScopes(input);

    expect(changed).toBe(true);
    expect(changes).toHaveLength(4);
    expect(schedules.map((s) => s.playbook?.scope)).toEqual(['plugin', 'plugin', 'plugin', 'user']);
    expect(changes.map((c) => ({ after: c.after, before: c.before }))).toEqual([
      { after: 'plugin', before: undefined },
      { after: 'plugin', before: undefined },
      { after: 'plugin', before: undefined },
      { after: 'user', before: undefined },
    ]);
  });

  it('is idempotent — a second run after stamping is a no-op', () => {
    const input = [
      scheduleFixture('Kookr Nightly Repository Idea Scout', 'repository-idea-scout.md'),
      scheduleFixture('KB-Scout Eval Daily Self-Reflection', 'kb-scout-reflection.md'),
    ];
    const first = migrateScheduleScopes(input);
    const second = migrateScheduleScopes(first.schedules);

    expect(second.changed).toBe(false);
    expect(second.changes).toHaveLength(0);
    expect(second.schedules).toEqual(first.schedules);
  });

  it('leaves unrelated schedules untouched', () => {
    const other = scheduleFixture('Some Other Schedule', 'whatever.md');
    const { changes, schedules, changed } = migrateScheduleScopes([other]);
    expect(changed).toBe(false);
    expect(changes).toHaveLength(0);
    expect(schedules[0]).toBe(other); // same instance, no copy
  });

  it('does not stamp a schedule whose playbook.path is not a relocated one', () => {
    const unrelated = scheduleFixture('Kookr Nightly Repository Idea Scout', 'something-else.md');
    const { changed } = migrateScheduleScopes([unrelated]);
    expect(changed).toBe(false);
  });

  it('re-stamps a schedule that drifted to the wrong scope', () => {
    const drifted = scheduleFixture('KB-Scout Eval Daily Self-Reflection', 'kb-scout-reflection.md', 'project');
    const { changes, schedules, changed } = migrateScheduleScopes([drifted]);
    expect(changed).toBe(true);
    expect(changes[0]).toMatchObject({ before: 'project', after: 'user' });
    expect(schedules[0].playbook?.scope).toBe('user');
  });

  it('maps the relocated playbooks to their intended tiers', () => {
    expect(SCOPE_BY_PLAYBOOK_PATH).toEqual({
      'repository-idea-scout.md': 'plugin',
      'kb-scout-reflection.md': 'user',
    });
  });
});
