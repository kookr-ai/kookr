import { describe, test, expect } from 'vitest';
import {
  probeAgentBinary,
  UNKNOWN_VERSION,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_VERSION_PROBE_TIMEOUT_MS,
  type ProbeExecRunner,
} from './probe-agent-binary.js';

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
      expect(result.probePath).toBe('--version');
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
      expect(result.probePath).toBe('--help');
    }
  });

  test('real version outputs still extract correctly', async () => {
    const cases: Array<[string, string]> = [
      ['2.1.220 (Claude Code)\n', '2.1.220'],
      ['1.2.3', '1.2.3'],
      ['1.2.3-beta.1', '1.2.3-beta.1'],
    ];
    for (const [stdout, expected] of cases) {
      const exec = fakeExec({ 'claude --version': async () => ({ stdout, stderr: '' }) });
      const result = await probeAgentBinary('claude', { exec });
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.version).toBe(expected);
        expect(result.probePath).toBe('--version');
      }
    }
  });

  test('--help usage text yields the explicit unknown marker, never the usage line', async () => {
    const usage = 'Usage: claude [options] [command] [prompt]\n\nOptions:\n  --version';
    const exec = fakeExec({
      'claude --version': async () => {
        throw Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
      },
      'claude --help': async () => ({ stdout: usage, stderr: '' }),
    });
    const result = await probeAgentBinary('claude', { exec });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.version).toBe(UNKNOWN_VERSION);
      expect(result.version).not.toContain('Usage');
      expect(result.probePath).toBe('--help');
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

  test('reports unknown marker when no numeric version is in stdout', async () => {
    const exec = fakeExec({
      'claude --version': async () => ({ stdout: 'Claude Code (development build)\n', stderr: '' }),
    });
    const result = await probeAgentBinary('claude', { exec });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.version).toBe(UNKNOWN_VERSION);
      expect(result.probePath).toBe('--version');
    }
  });

  test('--version attempt uses the longer default timeout for slow cold starts', async () => {
    const seen: Array<{ args: string; timeout: number }> = [];
    const exec: ProbeExecRunner = async (_file, args, options) => {
      seen.push({ args: args.join(' '), timeout: options.timeout });
      return { stdout: '1.0.0', stderr: '' };
    };
    await probeAgentBinary('claude', { exec });
    expect(seen[0]).toEqual({ args: '--version', timeout: DEFAULT_VERSION_PROBE_TIMEOUT_MS });
  });

  test('--help fallback uses the shorter default timeout', async () => {
    const seen: Array<{ args: string; timeout: number }> = [];
    const exec: ProbeExecRunner = async (_file, args, options) => {
      seen.push({ args: args.join(' '), timeout: options.timeout });
      if (args.join(' ') === '--version') throw Object.assign(new Error('nope'), { code: 1 });
      return { stdout: '1.0.0', stderr: '' };
    };
    await probeAgentBinary('claude', { exec });
    expect(seen).toEqual([
      { args: '--version', timeout: DEFAULT_VERSION_PROBE_TIMEOUT_MS },
      { args: '--help', timeout: DEFAULT_PROBE_TIMEOUT_MS },
    ]);
  });

  test('respects timeoutMs and versionTimeoutMs overrides', async () => {
    const seen: Array<{ args: string; timeout: number }> = [];
    const exec: ProbeExecRunner = async (_file, args, options) => {
      seen.push({ args: args.join(' '), timeout: options.timeout });
      if (args.join(' ') === '--version') throw Object.assign(new Error('nope'), { code: 1 });
      return { stdout: '1.0.0', stderr: '' };
    };
    await probeAgentBinary('claude', { exec, timeoutMs: 500, versionTimeoutMs: 750 });
    expect(seen).toEqual([
      { args: '--version', timeout: 750 },
      { args: '--help', timeout: 500 },
    ]);
  });
});
