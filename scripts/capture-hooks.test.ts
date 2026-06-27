import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseHookEvent } from '../src/core/hook-parser.js';
import {
  FIXTURE_PREFIX,
  captureHooks,
  captureRecords,
  parseArgs,
  redactJson,
  sanitizeFixtureName,
  splitJsonRecords,
} from './capture-hooks.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-capture-hooks-'));
}

describe('capture-hooks - argument parsing', () => {
  it('derives an input hook log from --session and writes a prefixed fixture name', () => {
    const parsed = parseArgs(
      ['--session', 'kookr-task-abc', '--name', 'Stuck Loop!', '--hooks-dir', 'hooks', '--out-dir', 'fixtures'],
      '/repo',
      '/home/dev',
    );

    expect(parsed).toMatchObject({
      inputFile: '/repo/hooks/kookr-task-abc.jsonl',
      outFile: `/repo/fixtures/${FIXTURE_PREFIX}Stuck-Loop.jsonl`,
      force: false,
    });
  });

  it('accepts an explicit hook JSONL file positional', () => {
    const parsed = parseArgs(['logs/session.jsonl', '--name', 'repro'], '/repo', '/home/dev');
    expect(parsed).toMatchObject({
      inputFile: '/repo/logs/session.jsonl',
      outFile: `/repo/src/__fixtures__/${FIXTURE_PREFIX}repro.jsonl`,
    });
  });

  it('rejects ambiguous or unnamed captures', () => {
    expect(() => parseArgs(['--session', 's', 'hooks.jsonl', '--name', 'x'])).toThrow(/exactly one input/);
    expect(() => parseArgs(['--session', 's'])).toThrow(/--name is required/);
    expect(() => parseArgs(['--session', 's', '--name', '!!!'])).toThrow(/--name is required/);
  });

  it('returns help for -h/--help', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });
});

describe('capture-hooks - fixture names', () => {
  it('keeps fixture names filesystem-safe and bounded', () => {
    expect(sanitizeFixtureName(' Permission denied / Bash ')).toBe('Permission-denied-Bash');
    expect(sanitizeFixtureName('a'.repeat(200))).toHaveLength(96);
  });
});

describe('capture-hooks - redaction', () => {
  it('redacts nested string values with existing secret primitives', () => {
    const redacted = redactJson({
      prompt: 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      tool_input: {
        command: 'curl -H "Authorization: Bearer untouched" --token ghp_abcdefghijklmnopqrstuvwxyz',
        env: ['AWS=AKIAABCDEFGHIJKLMNOP'],
      },
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    expect(serialized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(serialized).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(serialized).toContain('[REDACTED]');
  });
});

describe('capture-hooks - replay-ready output', () => {
  it('writes redacted JSONL records that split and parse through the replay path', async () => {
    const dir = await tempDir();
    const inputFile = join(dir, 'session.jsonl');
    const outFile = join(dir, `${FIXTURE_PREFIX}fixture.jsonl`);
    const inputRecords = [
      {
        session_id: 'claude-parent',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/workspace/kookr',
        hook_event_name: 'SessionStart',
        model: 'claude-opus',
      },
      {
        session_id: 'claude-parent',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/workspace/kookr',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz' },
        tool_use_id: 'tool-1',
      },
      {
        session_id: 'claude-parent',
        transcript_path: null,
        cwd: '/workspace/kookr',
        hook_event_name: 'Stop',
        last_assistant_message: 'done ghp_abcdefghijklmnopqrstuvwxyz',
      },
    ];
    await writeFile(inputFile, `${inputRecords.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');

    const result = await captureHooks({
      inputFile,
      outFile,
      force: false,
    });

    expect(result.recordsWritten).toBe(3);
    const output = await readFile(outFile, 'utf-8');
    expect(output).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    expect(output).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');

    const { records } = splitJsonRecords(output);
    expect(records).toHaveLength(3);
    expect(records.map((record) => parseHookEvent(record)?.type)).toEqual([
      'session_start',
      'tool_use',
      'stop',
    ]);
  });

  it('preserves unknown hook events as JSON so replay can classify them as unknown', () => {
    const records = captureRecords(JSON.stringify({
      session_id: 'x',
      transcript_path: null,
      cwd: '/workspace/kookr',
      hook_event_name: 'FutureHook',
      message: 'npm_abcdefghijklmnopqrstuvwxyz',
    }));

    expect(records).toHaveLength(1);
    expect(records[0]).not.toContain('npm_abcdefghijklmnopqrstuvwxyz');
    expect(parseHookEvent(records[0])).toBeNull();
  });

  it('refuses malformed records instead of producing a non-replay-ready fixture', () => {
    expect(() => captureRecords('{"session_id":"ok"}\nnot-json\n')).toThrow(/Record 2 is not valid JSON/);
  });

  it('refuses to overwrite an existing fixture unless force is set', async () => {
    const dir = await tempDir();
    const inputFile = join(dir, 'session.jsonl');
    const outFile = join(dir, `${FIXTURE_PREFIX}fixture.jsonl`);
    await writeFile(inputFile, '{"session_id":"x","hook_event_name":"SessionEnd","reason":"other"}\n', 'utf-8');
    await writeFile(outFile, 'existing\n', 'utf-8');

    await expect(captureHooks({ inputFile, outFile, force: false })).rejects.toThrow(
      /already exists/,
    );

    await expect(captureHooks({ inputFile, outFile, force: true })).resolves.toMatchObject({
      recordsWritten: 1,
      outFile,
    });
    expect(await readFile(outFile, 'utf-8')).toBe('{"session_id":"x","hook_event_name":"SessionEnd","reason":"other"}\n');
  });

  it('refuses empty input instead of creating an empty fixture', async () => {
    const dir = await tempDir();
    const inputFile = join(dir, 'empty.jsonl');
    const outFile = join(dir, `${FIXTURE_PREFIX}empty.jsonl`);
    await writeFile(inputFile, '\n  \n', 'utf-8');

    await expect(captureHooks({ inputFile, outFile, force: false })).rejects.toThrow(
      /No hook records/,
    );
  });

  it('refuses incomplete trailing JSON instead of silently dropping the last event', () => {
    expect(() => captureRecords('{"session_id":"ok"}\n{"session_id":')).toThrow(/incomplete hook record/);
  });

  it('captures adjacent JSON records from hook logs without requiring newline delimiters', () => {
    const records = captureRecords(
      '{"session_id":"x","hook_event_name":"SessionEnd","reason":"other"}{"session_id":"y","hook_event_name":"SessionEnd","reason":"other"}',
    );

    expect(records).toHaveLength(2);
    expect(records.map((record) => parseHookEvent(record)?.type)).toEqual(['session_end', 'session_end']);
  });
});

describe('capture-hooks - CLI entrypoint', () => {
  it('captures through node --import tsx with process argv and stdout wiring', async () => {
    const dir = await tempDir();
    const inputFile = join(dir, 'session.jsonl');
    const outFile = join(dir, `${FIXTURE_PREFIX}cli.jsonl`);
    await writeFile(
      inputFile,
      '{"session_id":"x","transcript_path":null,"cwd":"/workspace/kookr","hook_event_name":"UserPromptSubmit","prompt":"sk-ant-api03-abcdefghijklmnopqrstuvwxyz"}\n',
      'utf-8',
    );

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/capture-hooks.ts', inputFile, '--name', 'cli', '--out', outFile],
      { cwd: process.cwd(), encoding: 'utf-8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Captured 1 hook record(s).');
    expect(result.stdout).toContain(outFile);
    expect(result.stderr).toBe('');

    const output = await readFile(outFile, 'utf-8');
    expect(output).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    const { records } = splitJsonRecords(output);
    expect(parseHookEvent(records[0])?.type).toBe('user_prompt');
  });
});
