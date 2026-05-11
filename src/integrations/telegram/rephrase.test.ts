import { describe, it, expect, vi } from 'vitest';
import type { LlmClient } from '../../core/llm-client.js';
import { rephrase } from './rephrase.js';

function fakeLlm(response: string | null): LlmClient {
  return {
    provider: 'fake',
    model: 'fake-1',
    complete: vi.fn().mockResolvedValue(response),
  };
}

const PROJECTS = [
  { name: 'kookr', cwd: '/workspace/kookr' },
  { name: 'codex', cwd: '/workspace/codex' },
];

describe('rephrase', () => {
  it('returns failed when no LLM is configured', async () => {
    const r = await rephrase('fix the bug', { allowedProjects: PROJECTS, llm: null });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.reason).toMatch(/no LLM provider configured/i);
    }
  });

  it('returns spec when LLM emits a valid TaskSpec with cwd in allowlist', async () => {
    const llm = fakeLlm(JSON.stringify({
      prompt: 'Investigate sweep button placement and fix it.',
      cwd: '/workspace/kookr',
      suggestedBranch: 'fix/sweep-button',
    }));
    const r = await rephrase('fix sweep button', { allowedProjects: PROJECTS, llm });
    expect(r.kind).toBe('spec');
    if (r.kind === 'spec') {
      expect(r.spec.cwd).toBe('/workspace/kookr');
      expect(r.spec.agentType).toBe('claude-code');
      expect(r.spec.suggestedBranch).toBe('fix/sweep-button');
    }
  });

  it('uses the caller default agent when LLM emits no agentType', async () => {
    const llm = fakeLlm(JSON.stringify({
      prompt: 'Investigate Codex prompt handling.',
      cwd: '/workspace/kookr',
    }));
    const r = await rephrase('fix it', { allowedProjects: PROJECTS, llm, defaultAgentType: 'codex-cli' });
    expect(r.kind).toBe('spec');
    if (r.kind === 'spec') {
      expect(r.spec.agentType).toBe('codex-cli');
    }
  });

  it('accepts structured agentType metadata from the LLM', async () => {
    const llm = fakeLlm(JSON.stringify({
      prompt: 'Fix the sweep button.',
      cwd: '/workspace/kookr',
      agentType: 'codex-cli',
    }));
    const r = await rephrase('use codex to fix sweep button', { allowedProjects: PROJECTS, llm, defaultAgentType: 'claude-code' });
    expect(r.kind).toBe('spec');
    if (r.kind === 'spec') {
      expect(r.spec.agentType).toBe('codex-cli');
      expect(r.spec.prompt).toBe('Fix the sweep button.');
    }
  });

  it('returns ambiguous when LLM emits {ambiguous: ...}', async () => {
    const llm = fakeLlm(JSON.stringify({
      prompt: 'placeholder',  // schema requires prompt; ambiguous can coexist
      cwd: '/workspace/kookr',
      ambiguous: 'Which project?',
    }));
    const r = await rephrase('do the thing', { allowedProjects: PROJECTS, llm });
    expect(r.kind).toBe('ambiguous');
  });

  it('rejects cwd not in allowlist (string equality)', async () => {
    const llm = fakeLlm(JSON.stringify({
      prompt: 'x',
      cwd: '/etc',  // not in projects
    }));
    const r = await rephrase('do x', { allowedProjects: PROJECTS, llm });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.reason).toMatch(/not in allowedProjects/);
    }
  });

  it('rejects prefix-similar cwd (NOT prefix matching)', async () => {
    const llm = fakeLlm(JSON.stringify({
      prompt: 'x',
      cwd: '/workspace/kookr/src',  // inside kookr but not exact
    }));
    const r = await rephrase('x', { allowedProjects: PROJECTS, llm });
    expect(r.kind).toBe('failed');
  });

  it('rejects unknown fields at schema level (Zod strict)', async () => {
    const llm = fakeLlm(JSON.stringify({
      prompt: 'x',
      cwd: '/workspace/kookr',
      somethingExtra: 'nope',           // unknown — schema is strict
    }));
    const r = await rephrase('x', { allowedProjects: PROJECTS, llm });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.reason).toMatch(/schema validation/i);
    }
  });

  it('rejects unknown agentType values at schema level', async () => {
    const llm = fakeLlm(JSON.stringify({
      prompt: 'x',
      cwd: '/workspace/kookr',
      agentType: 'cursor',
    }));
    const r = await rephrase('x', { allowedProjects: PROJECTS, llm });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.reason).toMatch(/schema validation/i);
    }
  });

  it('rejects oversize prompts (max 2000)', async () => {
    const llm = fakeLlm(JSON.stringify({
      prompt: 'x'.repeat(2001),
      cwd: '/workspace/kookr',
    }));
    const r = await rephrase('big', { allowedProjects: PROJECTS, llm });
    expect(r.kind).toBe('failed');
  });

  it('rejects shell-meta in suggestedBranch (regex)', async () => {
    const llm = fakeLlm(JSON.stringify({
      prompt: 'x',
      cwd: '/workspace/kookr',
      suggestedBranch: 'fix; rm -rf /',
    }));
    const r = await rephrase('x', { allowedProjects: PROJECTS, llm });
    expect(r.kind).toBe('failed');
  });

  it('returns failed on non-JSON output', async () => {
    const llm = fakeLlm('not JSON');
    const r = await rephrase('x', { allowedProjects: PROJECTS, llm });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.reason).toMatch(/not valid JSON/i);
    }
  });

  it('returns failed on null (timeout/all-providers-exhausted)', async () => {
    const llm = fakeLlm(null);
    const r = await rephrase('x', { allowedProjects: PROJECTS, llm });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.reason).toMatch(/timeout|exhausted/i);
    }
  });
});
