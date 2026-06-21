import { describe, expect, it } from 'vitest';
import { parseArgs, toReplaySessionId, resolveBaseUrl, classify, splitReplayRecords } from './replay-hooks.js';
import { REPLAY_SESSION_PREFIX } from '../src/server/hook-ingestion.js';

describe('replay-hooks — toReplaySessionId (synthetic replay scoping)', () => {
  it('derives a kookr-replay- session id from the file name', () => {
    expect(toReplaySessionId(undefined, '/tmp/kookr-task-abc.jsonl')).toBe(
      `${REPLAY_SESSION_PREFIX}kookr-task-abc`,
    );
  });

  it('is idempotent when the id already carries the replay prefix', () => {
    const id = `${REPLAY_SESSION_PREFIX}repro-660`;
    expect(toReplaySessionId(id, 'ignored.jsonl')).toBe(id);
  });

  it('prefixes and sanitizes a non-prefixed --session value', () => {
    expect(toReplaySessionId('My Repro!', 'ignored.jsonl')).toBe(
      `${REPLAY_SESSION_PREFIX}My-Repro`,
    );
  });

  it('falls back to "session" when the stem sanitizes to empty', () => {
    expect(toReplaySessionId('!!!', 'ignored.jsonl')).toBe(`${REPLAY_SESSION_PREFIX}session`);
  });

  it('caps the result at the server session-id limit (128 chars)', () => {
    const long = 'a'.repeat(500);
    expect(toReplaySessionId(long, 'ignored.jsonl')).toHaveLength(128);
    expect(toReplaySessionId(`${REPLAY_SESSION_PREFIX}${long}`, 'x.jsonl')).toHaveLength(128);
  });
});

describe('replay-hooks — parseArgs', () => {
  it('parses a file positional with defaults', () => {
    expect(parseArgs(['hooks.jsonl'])).toMatchObject({
      file: 'hooks.jsonl',
      delayMs: 0,
      dryRun: false,
    });
  });

  it('parses options', () => {
    expect(parseArgs(['f.jsonl', '--session', 's', '--delay-ms', '50', '--limit', '3', '--dry-run'])).toEqual({
      file: 'f.jsonl',
      session: 's',
      delayMs: 50,
      limit: 3,
      dryRun: true,
    });
  });

  it('returns help for -h/--help', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });

  it('throws on unknown options', () => {
    expect(() => parseArgs(['f.jsonl', '--bogus'])).toThrow(/Unknown option/);
  });

  it('throws when not exactly one positional', () => {
    expect(() => parseArgs([])).toThrow(/exactly one/);
    expect(() => parseArgs(['a.jsonl', 'b.jsonl'])).toThrow(/exactly one/);
  });

  it('rejects negative / non-integer numeric flags', () => {
    expect(() => parseArgs(['f.jsonl', '--delay-ms', '-1'])).toThrow(/non-negative integer/);
    expect(() => parseArgs(['f.jsonl', '--limit', 'x'])).toThrow(/non-negative integer/);
  });
});

describe('replay-hooks — classify', () => {
  it('returns parsed for a known hook event', () => {
    expect(classify(JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart', cwd: '/' }))).toBe('parsed');
  });

  it('returns unknown for an unrecognized hook event name', () => {
    expect(classify(JSON.stringify({ session_id: 'x', hook_event_name: 'Nope' }))).toBe('unknown');
  });

  it('returns malformed for invalid JSON', () => {
    expect(classify('{not json}')).toBe('malformed');
  });
});

describe('replay-hooks — splitReplayRecords', () => {
  it('continues after malformed JSONL records that start with an opening brace', () => {
    const event = JSON.stringify({
      session_id: 'x',
      hook_event_name: 'SessionStart',
      cwd: '/',
    });

    expect(splitReplayRecords(`${event}\n{"broken":\n${event}\n`)).toEqual([
      event,
      '{"broken":',
      event,
    ]);
  });
});

describe('replay-hooks — resolveBaseUrl precedence', () => {
  it('prefers an explicit base url and trims a trailing slash', async () => {
    await expect(resolveBaseUrl('http://host:9/', {})).resolves.toBe('http://host:9');
  });

  it('uses KOOKR_API_BASE_URL over KOOKR_PORT', async () => {
    await expect(
      resolveBaseUrl(undefined, { KOOKR_API_BASE_URL: 'http://api:1', KOOKR_PORT: '4800' }),
    ).resolves.toBe('http://api:1');
  });

  it('uses KOOKR_PORT when no base url is set', async () => {
    await expect(resolveBaseUrl(undefined, { KOOKR_PORT: '4815' })).resolves.toBe('http://127.0.0.1:4815');
  });

  it('rejects an invalid KOOKR_PORT', async () => {
    await expect(resolveBaseUrl(undefined, { KOOKR_PORT: '99999' })).rejects.toThrow(/KOOKR_PORT/);
  });
});
