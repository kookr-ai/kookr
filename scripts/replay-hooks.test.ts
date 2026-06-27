import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  parseArgs,
  toReplaySessionId,
  resolveBaseUrl,
  classify,
  splitReplayRecords,
  parseScenarioManifest,
  loadScenarios,
  resolveScenario,
  scenarioFixturePath,
  formatScenarioList,
} from './replay-hooks.js';
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

  it('returns unknown for an intentionally dropped UserPromptSubmit task-notification', () => {
    // parseHookEvent deliberately drops the synthetic <task-notification> re-entry
    // (returns null), so the harness classifies the task-notification scenario as
    // unknown — not parsed. Guards the suppression path in hook-parser.ts.
    expect(
      classify(JSON.stringify({
        session_id: 'x',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/',
        prompt: '<task-notification><status>completed</status></task-notification>',
      })),
    ).toBe('unknown');
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

describe('replay-hooks — scenario catalog argument parsing', () => {
  it('parses --list-scenarios with no positional', () => {
    expect(parseArgs(['--list-scenarios'])).toMatchObject({ listScenarios: true });
  });

  it('parses --scenario <name> with no positional', () => {
    expect(parseArgs(['--scenario', 'billing-stop', '--dry-run'])).toMatchObject({
      scenario: 'billing-stop',
      dryRun: true,
    });
  });

  it('rejects --scenario combined with a file positional', () => {
    expect(() => parseArgs(['f.jsonl', '--scenario', 'x'])).toThrow(/not both/);
  });

  it('rejects --scenario with a missing value or a following flag', () => {
    expect(() => parseArgs(['--scenario'])).toThrow(/--scenario expects a value/);
    expect(() => parseArgs(['--scenario', '--dry-run'])).toThrow(/--scenario expects a value/);
  });

  it('rejects --list-scenarios combined with a file positional or --scenario', () => {
    expect(() => parseArgs(['--list-scenarios', 'f.jsonl'])).toThrow(/--list-scenarios/);
    expect(() => parseArgs(['--list-scenarios', '--scenario', 'x'])).toThrow(/--list-scenarios/);
  });
});

describe('replay-hooks — parseScenarioManifest validation', () => {
  const ok = { scenarios: [{ name: 'a', fixture: 'a.json', purpose: 'p', expected: 'e' }] };

  it('accepts a well-formed manifest', () => {
    expect(parseScenarioManifest(ok)).toEqual([{ name: 'a', fixture: 'a.json', purpose: 'p', expected: 'e' }]);
  });

  it('ignores unknown manifest keys (e.g. $comment)', () => {
    expect(parseScenarioManifest({ $comment: 'x', ...ok })).toHaveLength(1);
  });

  it('rejects a non-object / missing / non-array scenarios', () => {
    expect(() => parseScenarioManifest(null)).toThrow(/scenarios/);
    expect(() => parseScenarioManifest({})).toThrow(/scenarios/);
    expect(() => parseScenarioManifest({ scenarios: 'nope' })).toThrow(/scenarios/);
  });

  it('rejects an entry missing a required string field', () => {
    expect(() => parseScenarioManifest({ scenarios: [{ name: 'a', fixture: 'a.json', purpose: 'p' }] }))
      .toThrow(/expected/);
    expect(() => parseScenarioManifest({ scenarios: [{ name: '', fixture: 'a.json', purpose: 'p', expected: 'e' }] }))
      .toThrow(/name/);
  });

  it('rejects a fixture that is not a bare filename (path escape)', () => {
    for (const fixture of ['../../etc/passwd', '/etc/passwd', 'sub/dir.json', 'a b.json']) {
      expect(() => parseScenarioManifest({ scenarios: [{ name: 'a', fixture, purpose: 'p', expected: 'e' }] }))
        .toThrow(/bare filename/);
    }
  });

  it('rejects duplicate scenario names', () => {
    expect(() => parseScenarioManifest({ scenarios: [ok.scenarios[0], ok.scenarios[0]] }))
      .toThrow(/Duplicate scenario name: a/);
  });
});

describe('replay-hooks — resolveScenario', () => {
  const scenarios = [
    { name: 'a', fixture: 'a.json', purpose: 'p', expected: 'e' },
    { name: 'b', fixture: 'b.json', purpose: 'p', expected: 'e' },
  ];

  it('resolves a known scenario by name', () => {
    expect(resolveScenario('b', scenarios).fixture).toBe('b.json');
  });

  it('throws listing available names for an unknown scenario', () => {
    expect(() => resolveScenario('z', scenarios)).toThrow(/Unknown scenario: z.*a, b/s);
  });
});

describe('replay-hooks — built-in catalog (CI dry-run, no server)', () => {
  it('loads the real manifest; every scenario resolves and dry-runs without malformed records', async () => {
    const scenarios = await loadScenarios();
    expect(scenarios.length).toBeGreaterThan(0);

    let totalParsed = 0;
    for (const scenario of scenarios) {
      // Round-trips through the public resolver.
      expect(resolveScenario(scenario.name, scenarios)).toBe(scenario);

      // The fixture exists and frames/JSON-parses — the "dry-run each scenario
      // in CI without a server" guarantee. Records may classify as 'unknown'
      // when the parser intentionally drops them (e.g. task-notification), but
      // none may be 'malformed'.
      const path = scenarioFixturePath(scenario);
      const content = await readFile(path, 'utf-8');
      const records = splitReplayRecords(content);
      expect(records.length, `${scenario.name} -> ${scenario.fixture}`).toBeGreaterThan(0);
      const tally = records.map(classify);
      const parsed = tally.filter((t) => t === 'parsed').length;
      expect(tally, `${scenario.name} records should all frame + parse`).not.toContain('malformed');
      // Every scenario must exercise at least one recognized hook event, except
      // task-notification, which intentionally exercises the parser's drop path.
      if (scenario.name !== 'task-notification') {
        expect(parsed, `${scenario.name} should classify at least one parsed event`).toBeGreaterThan(0);
      }
      totalParsed += parsed;
    }
    expect(totalParsed).toBeGreaterThan(0);
  });

  it('formats the catalog with the name, fixture, purpose and expected of each scenario', async () => {
    const scenarios = await loadScenarios();
    const listing = formatScenarioList(scenarios);
    for (const scenario of scenarios) {
      expect(listing).toContain(scenario.name);
      expect(listing).toContain(scenario.fixture);
    }
    // Spot-check a full entry to guard the multi-line template.
    const billing = scenarios.find((s) => s.name === 'billing-stop');
    expect(billing).toBeDefined();
    expect(listing).toContain(billing!.purpose);
    expect(listing).toContain(billing!.expected);
  });
});
