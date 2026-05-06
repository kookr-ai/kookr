import { describe, it, expect } from 'vitest';
import { parseTaskCommand } from './parse-task.js';

const ONE_PROJECT = [{ name: 'kookr', cwd: '/workspace/kookr' }];
const TWO_PROJECTS = [
  { name: 'kookr', cwd: '/workspace/kookr' },
  { name: 'codex', cwd: '/workspace/codex' },
];

describe('parseTaskCommand', () => {
  it('returns spec for /task <prompt> with single project', () => {
    const r = parseTaskCommand('/task fix sweep', ONE_PROJECT);
    expect(r.kind).toBe('spec');
    if (r.kind === 'spec') {
      expect(r.prompt).toBe('fix sweep');
      expect(r.project.cwd).toBe('/workspace/kookr');
      expect(r.agentType).toBeUndefined();
    }
  });

  it('rejects /task <prompt> when multiple projects', () => {
    const r = parseTaskCommand('/task fix sweep', TWO_PROJECTS);
    expect(r.kind).toBe('usage_error');
    if (r.kind === 'usage_error') {
      expect(r.message).toMatch(/multiple/i);
    }
  });

  it('returns spec for /task@<project> <prompt>', () => {
    const r = parseTaskCommand('/task@codex fix the cli', TWO_PROJECTS);
    expect(r.kind).toBe('spec');
    if (r.kind === 'spec') {
      expect(r.project.cwd).toBe('/workspace/codex');
      expect(r.prompt).toBe('fix the cli');
    }
  });

  it('rejects /task@<unknown>', () => {
    const r = parseTaskCommand('/task@unknown fix it', TWO_PROJECTS);
    expect(r.kind).toBe('usage_error');
    if (r.kind === 'usage_error') {
      expect(r.message).toMatch(/Unknown project/);
    }
  });

  it('rejects empty /task', () => {
    expect(parseTaskCommand('/task', ONE_PROJECT).kind).toBe('usage_error');
    expect(parseTaskCommand('/task ', ONE_PROJECT).kind).toBe('usage_error');
    expect(parseTaskCommand('/task   ', ONE_PROJECT).kind).toBe('usage_error');
  });

  it('rejects /task@<project> with empty prompt', () => {
    const r = parseTaskCommand('/task@kookr   ', ONE_PROJECT);
    expect(r.kind).toBe('usage_error');
  });

  it('rejects /tasks (not /task)', () => {
    const r = parseTaskCommand('/tasks list', ONE_PROJECT);
    expect(r.kind).toBe('usage_error');
  });

  it('preserves multi-line prompts', () => {
    const r = parseTaskCommand('/task line1\nline2', ONE_PROJECT);
    expect(r.kind).toBe('spec');
    if (r.kind === 'spec') {
      expect(r.prompt).toBe('line1\nline2');
    }
  });

  it('parses explicit --agent option for /task', () => {
    const r = parseTaskCommand('/task --agent codex fix sweep', ONE_PROJECT);
    expect(r.kind).toBe('spec');
    if (r.kind === 'spec') {
      expect(r.agentType).toBe('codex-cli');
      expect(r.prompt).toBe('fix sweep');
    }
  });

  it('parses explicit --agent=<agent> option for /task@project', () => {
    const r = parseTaskCommand('/task@kookr --agent=claude fix sweep', TWO_PROJECTS);
    expect(r.kind).toBe('spec');
    if (r.kind === 'spec') {
      expect(r.agentType).toBe('claude-code');
      expect(r.project.cwd).toBe('/workspace/kookr');
      expect(r.prompt).toBe('fix sweep');
    }
  });

  it('rejects unknown --agent value', () => {
    const r = parseTaskCommand('/task --agent cursor fix sweep', ONE_PROJECT);
    expect(r.kind).toBe('usage_error');
    if (r.kind === 'usage_error') {
      expect(r.message).toMatch(/Unknown agent/);
    }
  });

  it('handles allowedProjects=[] for /task', () => {
    expect(parseTaskCommand('/task hi', []).kind).toBe('usage_error');
  });
});
