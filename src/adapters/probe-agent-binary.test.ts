import { describe, test, expect } from 'vitest';
import { probeAgentBinary, type ProbeExecRunner } from './probe-agent-binary.js';

function fakeExec(behavior: Record<string, () => Promise<{ stdout: string; stderr: string }>>): ProbeExecRunner {
  return async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    const handler = behavior[key];
    if (!handler) {
      const err = new Error(`unexpected exec call: ${key}`);
      throw err;
    }
    return handler();
  };
}

describe('probeAgentBinary', () => {
  test('returns ok with extracted version when --version succeeds', async () => {
    const exec = fakeExec({
      'claude --version': async () => ({ stdout: '1.0.86 (Claude Code)\n', stderr: '' }),
    });
    const result = await probeAgentBinary('claude', { exec });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.resolvedPath).toBe('claude');
      expect(result.version).toBe('1.0.86');
    }
  });

  test('falls back to --help when --version fails', async () => {
    const exec = fakeExec({
      'codex --version': async () => {
        throw Object.assign(new Error('unknown flag'), { code: 1 });
      },
      'codex --help': async () => ({ stdout: 'codex 0.2.1 — usage:\n  codex [opts]', stderr: '' }),
    });
    const result = await probeAgentBinary('codex', { exec });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.version).toBe('0.2.1');
    }
  });

  test('returns absent with ENOENT message when binary missing', async () => {
    const enoent = Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' });
    const exec: ProbeExecRunner = async () => { throw enoent; };
    const result = await probeAgentBinary('nope', { exec });
    expect(result.kind).toBe('absent');
    if (result.kind === 'absent') {
      expect(result.reason).toContain('not found on PATH');
    }
  });

  test('returns absent with EACCES message when binary not executable', async () => {
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const exec: ProbeExecRunner = async () => { throw eacces; };
    const result = await probeAgentBinary('/usr/local/bin/claude', { exec });
    expect(result.kind).toBe('absent');
    if (result.kind === 'absent') {
      expect(result.reason).toContain('not executable');
    }
  });

  test('returns absent when both --version and --help yield empty stdout', async () => {
    const exec = fakeExec({
      'claude --version': async () => ({ stdout: '   \n', stderr: '' }),
      'claude --help': async () => ({ stdout: '', stderr: '' }),
    });
    const result = await probeAgentBinary('claude', { exec });
    expect(result.kind).toBe('absent');
  });

  test('falls back to first line when no numeric version is in stdout', async () => {
    const exec = fakeExec({
      'claude --version': async () => ({ stdout: 'Claude Code (development build)\n', stderr: '' }),
    });
    const result = await probeAgentBinary('claude', { exec });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.version).toBe('Claude Code (development build)');
    }
  });

  test('uses default 2 s timeout via injected runner', async () => {
    const seen: number[] = [];
    const exec: ProbeExecRunner = async (_file, _args, options) => {
      seen.push(options.timeout);
      return { stdout: '1.0.0', stderr: '' };
    };
    await probeAgentBinary('claude', { exec });
    expect(seen[0]).toBe(2000);
  });

  test('respects timeoutMs override', async () => {
    const seen: number[] = [];
    const exec: ProbeExecRunner = async (_file, _args, options) => {
      seen.push(options.timeout);
      return { stdout: '1.0.0', stderr: '' };
    };
    await probeAgentBinary('claude', { exec, timeoutMs: 500 });
    expect(seen[0]).toBe(500);
  });
});
