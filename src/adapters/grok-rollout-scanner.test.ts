import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readGrokHomeUsage, mapGrokUsageToTokenUsage } from './grok-rollout-scanner.js';

const FIXTURE_PATH = fileURLToPath(new URL('./__fixtures__/grok-session-sample.jsonl', import.meta.url));
const ENC_CWD = encodeURIComponent('/home/dev/repo');
const SESSION_ID = '019f0000-0000-0000-0000-000000000001';

/** Stage a transcript at `<grokHome>/sessions/<enc-cwd>/<sessionId>/updates.jsonl`. */
function stageTranscript(grokHome: string, encCwd: string, sessionId: string, content: string): void {
  const dir = join(grokHome, 'sessions', encCwd, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'updates.jsonl'), content, 'utf-8');
}

describe('Grok rollout token scanner (issue #1581)', () => {
  let grokHome: string;
  beforeEach(() => {
    grokHome = join(mkdtempSync(join(tmpdir(), 'grok-rollout-test-')), '.grok');
  });
  afterEach(() => {
    try { rmSync(join(grokHome, '..'), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('sums usage across every turn_completed record in a transcript', async () => {
    const dir = join(grokHome, 'sessions', ENC_CWD, SESSION_ID);
    mkdirSync(dir, { recursive: true });
    copyFileSync(FIXTURE_PATH, join(dir, 'updates.jsonl'));

    const usage = await readGrokHomeUsage(grokHome);
    expect(usage).not.toBeNull();
    // Turn 1 (110087/938/76800/273) + Turn 2 (50000/420/20000/100).
    expect(usage).toEqual({
      inputTokens: 160087,
      outputTokens: 1358,
      cachedReadTokens: 96800,
      reasoningTokens: 373,
      model: 'grok-4.5-build',
      turnCount: 2,
    });
  });

  test('maps summed usage to the shared TokenUsage contract (input = gross − cached; output already includes reasoning)', async () => {
    const dir = join(grokHome, 'sessions', ENC_CWD, SESSION_ID);
    mkdirSync(dir, { recursive: true });
    copyFileSync(FIXTURE_PATH, join(dir, 'updates.jsonl'));

    const usage = await readGrokHomeUsage(grokHome);
    const mapped = mapGrokUsageToTokenUsage(usage!);
    expect(mapped).toEqual({
      inputTokens: 63287, // 160087 gross − 96800 cached
      // Grok's outputTokens (938 + 420) already includes reasoning (273 + 100),
      // since totalTokens === input + output — reasoning must NOT be re-added.
      outputTokens: 1358,
      cacheReadTokens: 96800,
      cacheWriteTokens: 0,
      costUsd: 0,
      model: 'grok-4.5-build',
    });
  });

  test('sums across the parent and sub-agent transcripts under one GROK_HOME', async () => {
    const content = readFileSync(FIXTURE_PATH, 'utf-8');
    stageTranscript(grokHome, ENC_CWD, SESSION_ID, content);
    // A sub-agent session lives under the same ephemeral home with its own dir.
    stageTranscript(grokHome, ENC_CWD, '019f0000-0000-0000-0000-0000000000ff', content);

    const usage = await readGrokHomeUsage(grokHome);
    expect(usage!.turnCount).toBe(4);
    expect(usage!.inputTokens).toBe(320174); // doubled
    expect(usage!.outputTokens).toBe(2716);
  });

  test('tags usage with the dominant model (most total tokens) across mixed-model turns', async () => {
    const bigGrok = '{"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":100000,"outputTokens":500,"totalTokens":100500,"cachedReadTokens":0,"reasoningTokens":0,"modelUsage":{"grok-4.5-build":{"totalTokens":100500}}}}}}';
    const smallOther = '{"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","usage":{"inputTokens":10,"outputTokens":5,"totalTokens":15,"cachedReadTokens":0,"reasoningTokens":0,"modelUsage":{"grok-code-fast":{"totalTokens":15}}}}}}';
    // Order the smaller model LAST so a last-wins bug would mis-tag it.
    stageTranscript(grokHome, ENC_CWD, SESSION_ID, `${bigGrok}\n${smallOther}\n`);

    const usage = await readGrokHomeUsage(grokHome);
    expect(usage!.turnCount).toBe(2);
    expect(usage!.model).toBe('grok-4.5-build');
  });

  test('returns null when the sessions directory is absent (missing-source fallback)', async () => {
    expect(await readGrokHomeUsage(grokHome)).toBeNull();
  });

  test('returns null when transcripts carry no turn_completed usage', async () => {
    stageTranscript(
      grokHome,
      ENC_CWD,
      SESSION_ID,
      '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}\n',
    );
    expect(await readGrokHomeUsage(grokHome)).toBeNull();
  });

  test('skips malformed lines without throwing', async () => {
    const valid = readFileSync(FIXTURE_PATH, 'utf-8').trim().split('\n');
    const withGarbage = ['not json at all', '{"partial": ', ...valid, 'turn_completed but not json'].join('\n');
    stageTranscript(grokHome, ENC_CWD, SESSION_ID, withGarbage + '\n');

    const usage = await readGrokHomeUsage(grokHome);
    expect(usage!.turnCount).toBe(2);
    expect(usage!.inputTokens).toBe(160087);
  });

  test('tolerates missing numeric fields (treats them as zero)', async () => {
    stageTranscript(
      grokHome,
      ENC_CWD,
      SESSION_ID,
      '{"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","usage":{"outputTokens":42}}}}\n',
    );
    const usage = await readGrokHomeUsage(grokHome);
    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 42,
      cachedReadTokens: 0,
      reasoningTokens: 0,
      model: null,
      turnCount: 1,
    });
  });

  test('mapping omits the model key when the session has no model tag; reasoning is not re-added', () => {
    const mapped = mapGrokUsageToTokenUsage({
      inputTokens: 100,
      outputTokens: 10, // already includes the 5 reasoning tokens below
      cachedReadTokens: 40,
      reasoningTokens: 5,
      model: null,
      turnCount: 1,
    });
    expect(mapped).toEqual({
      inputTokens: 60, // 100 − 40 cached
      outputTokens: 10, // NOT 15 — reasoning is a subset of outputTokens
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
    expect('model' in mapped).toBe(false);
  });
});
