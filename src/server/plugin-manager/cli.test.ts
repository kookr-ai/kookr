import { describe, it, expect } from 'vitest';
import { ClaudePluginCli, parseListOutput, parseAlwaysOnTokens, type PluginCliRunner } from './cli.js';

describe('parseListOutput', () => {
  it('parses the bare-array shape', () => {
    const out = parseListOutput(
      JSON.stringify([{ id: 'a@m', version: '1.0.0', scope: 'user', installPath: '/p' }]),
    );
    expect(out).toEqual([{ id: 'a@m', version: '1.0.0', scope: 'user', installPath: '/p' }]);
  });

  it('parses the { installed: [...] } wrapper (--available)', () => {
    const out = parseListOutput(JSON.stringify({ installed: [{ id: 'a@m', version: '1.0.0' }] }));
    expect(out).toEqual([{ id: 'a@m', version: '1.0.0', scope: null, installPath: null }]);
  });

  it('drops records without a string id and returns [] on malformed json', () => {
    expect(parseListOutput(JSON.stringify([{ version: '1' }, { id: 'ok@m' }]))).toEqual([
      { id: 'ok@m', version: null, scope: null, installPath: null },
    ]);
    expect(parseListOutput('{not json')).toEqual([]);
  });
});

describe('parseAlwaysOnTokens', () => {
  it('parses "~8,994 tok" with thousands separators', () => {
    expect(parseAlwaysOnTokens('  Always-on:   ~8,994 tok   added to every session')).toBe(8994);
  });
  it('parses without separators or tilde', () => {
    expect(parseAlwaysOnTokens('Always-on: 120 tok')).toBe(120);
  });
  it('returns null when the figure is absent', () => {
    expect(parseAlwaysOnTokens('no token line here')).toBeNull();
  });
});

describe('ClaudePluginCli', () => {
  const runner = (stdoutByJoin: Record<string, string>): PluginCliRunner => ({
    async run(args) {
      return { stdout: stdoutByJoin[args.join(' ')] ?? '', stderr: '' };
    },
  });

  it('list() returns [] when the runner throws (fallback to registry)', async () => {
    const cli = new ClaudePluginCli({
      async run() {
        throw new Error('boom');
      },
    });
    expect(await cli.list()).toEqual([]);
  });

  it('update() invokes `plugin update <id> -y --json`', async () => {
    const calls: string[][] = [];
    const cli = new ClaudePluginCli({
      async run(args) {
        calls.push(args);
        return { stdout: '', stderr: '' };
      },
    });
    await cli.update('a@m');
    expect(calls).toEqual([['plugin', 'update', 'a@m', '-y', '--json']]);
  });

  it('details() returns null tokens when the runner throws', async () => {
    const cli = new ClaudePluginCli({
      async run() {
        throw new Error('no such plugin');
      },
    });
    expect(await cli.details('x@m')).toEqual({ alwaysOnTokens: null });
  });

  it('list() parses real output through the runner', async () => {
    const cli = new ClaudePluginCli(
      runner({ 'plugin list --json': JSON.stringify([{ id: 'a@m', version: '1.0.0' }]) }),
    );
    expect(await cli.list()).toEqual([{ id: 'a@m', version: '1.0.0', scope: null, installPath: null }]);
  });
});
