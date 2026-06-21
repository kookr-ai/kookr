import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { HELP_TEXT, main } from '../../bin/kookr.js';
import { HELP_TEXT as RALPH_HELP_TEXT } from '../../bin/kookr-ralph.js';
import { HELP_TEXT as SPAWN_HELP_TEXT } from '../../bin/kookr-spawn.js';
import { HELP_TEXT as STATUS_HELP_TEXT } from '../../bin/kookr-status.js';

const execFileAsync = promisify(execFile);

function makeDeps() {
  const logs: string[] = [];
  const errors: string[] = [];
  const codes: number[] = [];
  return {
    out: {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    },
    err: { error: (msg: string) => errors.push(msg) },
    exit: ((code: number) => {
      codes.push(code);
    }) as (code: number) => never,
    logs,
    errors,
    codes,
  };
}

describe('kookr dispatcher', () => {
  it('prints root help', async () => {
    const deps = makeDeps();
    await main({ argv: ['--help'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.logs).toEqual([HELP_TEXT]);
  });

  it('dispatches spawn help through the main binary', async () => {
    const deps = makeDeps();
    await main({ argv: ['spawn', '--help'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.logs).toEqual([SPAWN_HELP_TEXT]);
    expect(deps.errors).toEqual([]);
  });

  it('dispatches status help through the main binary', async () => {
    const deps = makeDeps();
    await main({ argv: ['status', '--help'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.logs).toEqual([STATUS_HELP_TEXT]);
    expect(deps.errors).toEqual([]);
  });

  it('dispatches Ralph help through the main binary', async () => {
    const deps = makeDeps();
    await main({ argv: ['ralph', '--help'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.logs).toEqual([RALPH_HELP_TEXT]);
    expect(deps.errors).toEqual([]);
  });

  it('rejects unknown subcommands instead of starting the server', async () => {
    const deps = makeDeps();
    await main({ argv: ['wat'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([2]);
    expect(deps.errors.join('\n')).toContain('Unknown command: wat');
  });

  it('dispatches doctor help through the main binary', async () => {
    const deps = makeDeps();
    await main({ argv: ['doctor', '--help'], env: {}, out: deps.out, err: deps.err, exit: deps.exit });
    expect(deps.codes).toEqual([0]);
    expect(deps.logs.join('\n')).toContain('kookr doctor');
    expect(deps.errors).toEqual([]);
  });

  it.each([
    [['--help'], 'kookr - local AI agent supervisor'],
    [['spawn', '--help'], 'kookr spawn'],
    [['status', '--help'], 'kookr status'],
    [['doctor', '--help'], 'kookr doctor'],
    [['ralph', '--help'], 'kookr ralph'],
    [['completion', 'bash'], 'complete -F _kookr kookr'],
  ])('prints command output through bin/kookr.js %s', async (argv, helpNeedle) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['bin/kookr.js', ...argv], {
      cwd: process.cwd(),
    });
    expect(stderr).toBe('');
    expect(stdout).toContain(helpNeedle);
  });

  it('dispatches subcommand JSON help through the main binary', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['bin/kookr.js', 'status', '--json', '--help'], {
      cwd: process.cwd(),
    });
    const envelope = JSON.parse(stdout);
    expect(stderr).toBe('');
    expect(envelope).toMatchObject({
      ok: true,
      code: 'OK',
      message: 'Help',
    });
    expect(envelope.details.help).toContain('kookr status');
  });
});

describe('deprecated standalone aliases', () => {
  it.each([
    ['bin/kookr-spawn.js', '`kookr-spawn` is deprecated; use `kookr spawn`.', 'kookr spawn'],
    ['bin/kookr-status.js', '`kookr-status` is deprecated; use `kookr status`.', 'kookr status'],
    ['bin/kookr-ralph.js', '`kookr-ralph` is deprecated; use `kookr ralph`.', 'kookr ralph'],
  ])('%s warns and still prints help', async (script, warning, helpNeedle) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, '--help'], {
      cwd: process.cwd(),
    });
    expect(stderr).toContain(warning);
    expect(stdout).toContain(helpNeedle);
  });

  it.each([
    ['bin/kookr-spawn.js', 'kookr spawn'],
    ['bin/kookr-status.js', 'kookr status'],
    ['bin/kookr-ralph.js', 'kookr ralph'],
  ])('%s suppresses the deprecation warning in JSON mode', async (script, helpNeedle) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, '--json', '--help'], {
      cwd: process.cwd(),
    });
    const envelope = JSON.parse(stdout);
    expect(stderr).toBe('');
    expect(envelope).toMatchObject({ ok: true, code: 'OK' });
    expect(envelope.details.help).toContain(helpNeedle);
  });
});
