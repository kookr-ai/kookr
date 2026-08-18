import { describe, expect, it } from 'vitest';

import {
  parseLaunchAllowlist,
  parseLaunchAllowlistJson,
} from '../launch-allowlist.js';

const validProject = {
  projectId: 'github.com/kookr-ai/kookr',
  cwd: '/tmp/kookr',
  agents: ['claude-code'],
  maxConcurrent: 1,
};

const validAllowlist = {
  version: 1 as const,
  ownerId: 'owner-1',
  projects: [validProject],
};

describe('parseLaunchAllowlist', () => {
  it.each([
    {
      name: 'owner, project, agents, cwd, and concurrency cap',
      input: {
        version: 1,
        ownerId: 'owner-1',
        projects: [{
          projectId: 'github.com/kookr-ai/kookr',
          cwd: '/tmp/kookr',
          agents: ['claude-code', 'codex-cli'],
          maxConcurrent: 2,
        }],
      },
      config: {
        version: 1,
        ownerId: 'owner-1',
        projects: [{
          projectId: 'github.com/kookr-ai/kookr',
          cwd: '/tmp/kookr',
          agents: ['claude-code', 'codex-cli'],
          maxConcurrent: 2,
        }],
      },
    },
    {
      name: 'every supported agent type',
      input: {
        version: 1,
        ownerId: 'owner-1',
        projects: [{
          projectId: 'github.com/kookr-ai/kookr',
          cwd: '/tmp/kookr',
          agents: ['claude-code', 'codex-cli', 'grok-build'],
          maxConcurrent: 3,
        }],
      },
      config: {
        version: 1,
        ownerId: 'owner-1',
        projects: [{
          projectId: 'github.com/kookr-ai/kookr',
          cwd: '/tmp/kookr',
          agents: ['claude-code', 'codex-cli', 'grok-build'],
          maxConcurrent: 3,
        }],
      },
    },
    {
      name: 'empty projects array',
      input: { version: 1, ownerId: 'owner-1', projects: [] },
      config: { version: 1, ownerId: 'owner-1', projects: [] },
    },
    {
      name: 'trimmed ownerId/projectId and deduped agents',
      input: {
        version: 1,
        ownerId: '  owner-1  ',
        projects: [{
          projectId: '  github.com/kookr-ai/kookr  ',
          cwd: '/tmp/kookr',
          agents: ['claude-code', 'claude-code'],
          maxConcurrent: 1,
        }],
      },
      config: {
        version: 1,
        ownerId: 'owner-1',
        projects: [{
          projectId: 'github.com/kookr-ai/kookr',
          cwd: '/tmp/kookr',
          agents: ['claude-code'],
          maxConcurrent: 1,
        }],
      },
    },
  ])('accepts $name', ({ input, config }) => {
    expect(parseLaunchAllowlist(input)).toEqual({ ok: true, config });
  });

  it.each([
    {
      name: 'non-object value',
      input: ['not', 'an', 'object'],
      error: 'allowlist must be an object',
    },
    {
      name: 'bad version',
      input: { ...validAllowlist, version: 2 },
      error: 'allowlist version must be 1',
    },
    {
      name: 'string version 1',
      input: { ...validAllowlist, version: '1' },
      error: 'allowlist version must be 1',
    },
    {
      name: 'empty owner',
      input: { ...validAllowlist, ownerId: '' },
      error: 'allowlist ownerId must be a non-empty string',
    },
    {
      name: 'whitespace-only owner',
      input: { ...validAllowlist, ownerId: '   ' },
      error: 'allowlist ownerId must be a non-empty string',
    },
    {
      name: 'missing projects',
      input: { version: 1, ownerId: 'owner-1' },
      error: 'allowlist projects must be an array',
    },
    {
      name: 'relative cwd',
      input: {
        ...validAllowlist,
        projects: [{ ...validProject, cwd: 'relative' }],
      },
      error: 'projects[0].cwd must be an absolute path',
    },
    {
      name: 'empty projectId',
      input: {
        ...validAllowlist,
        projects: [{ ...validProject, projectId: '' }],
      },
      error: 'projects[0].projectId must be a non-empty string',
    },
    {
      name: 'empty agents',
      input: {
        ...validAllowlist,
        projects: [{ ...validProject, agents: [] }],
      },
      error: 'projects[0].agents must be a non-empty array',
    },
    {
      name: 'unknown agent',
      input: {
        ...validAllowlist,
        projects: [{ ...validProject, agents: ['unknown'] }],
      },
      error: 'projects[0].agents[0] is not supported',
    },
    {
      name: 'mixed allowed and unknown agent',
      input: {
        ...validAllowlist,
        projects: [{ ...validProject, agents: ['claude-code', 'unknown'] }],
      },
      error: 'projects[0].agents[1] is not supported',
    },
    {
      name: 'round-robin selection is not a concrete agent',
      input: {
        ...validAllowlist,
        projects: [{ ...validProject, agents: ['round-robin'] }],
      },
      error: 'projects[0].agents[0] is not supported',
    },
    {
      name: 'maxConcurrent below 1',
      input: {
        ...validAllowlist,
        projects: [{ ...validProject, maxConcurrent: 0 }],
      },
      error: 'projects[0].maxConcurrent must be a positive integer',
    },
    {
      name: 'non-integer maxConcurrent',
      input: {
        ...validAllowlist,
        projects: [{ ...validProject, maxConcurrent: 1.5 }],
      },
      error: 'projects[0].maxConcurrent must be a positive integer',
    },
  ])('rejects $name', ({ input, error }) => {
    expect(parseLaunchAllowlist(input)).toEqual({ ok: false, error });
  });
});

describe('parseLaunchAllowlistJson', () => {
  it('accepts a valid JSON allowlist', () => {
    expect(parseLaunchAllowlistJson(JSON.stringify(validAllowlist))).toEqual({
      ok: true,
      config: validAllowlist,
    });
  });

  it.each([
    ['not JSON text', 'not-json'],
    ['truncated object', '{'],
    ['empty string', ''],
  ])('rejects invalid JSON (%s)', (_name, raw) => {
    const parsed = parseLaunchAllowlistJson(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it('rejects valid JSON that fails the allowlist schema with the same error', () => {
    expect(parseLaunchAllowlistJson(JSON.stringify({
      ...validAllowlist,
      version: 2,
    }))).toEqual({ ok: false, error: 'allowlist version must be 1' });
  });
});
