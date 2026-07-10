import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CodexRolloutScanner } from './codex-rollout-scanner.js';
import { buildTaskCompletionMetadata } from '../server/completion-metadata.js';
import type { Task } from '../core/tasks.js';

/**
 * End-to-end metering check (issue #1307): parse a sample Codex rollout
 * transcript fixture through the real scanner and completion path and assert it
 * lands in the task `tokenUsage` shape — input/cacheRead/output mapping, the
 * OpenAI cost estimate, and the provider/model tag.
 */

const FIXTURE_PATH = fileURLToPath(new URL('./__fixtures__/codex-rollout-sample.jsonl', import.meta.url));
const FIXTURE_CWD = '/repo/wt-1307';
/** Session start recorded in the fixture's session_meta line. */
const ROLLOUT_STARTED_AT = '2026-07-10T12:00:00.000Z';

function stageFixtureRollout(codexHome: string): void {
  // The scanner discovers rollouts under codexHome/YYYY/MM/DD, so file the
  // fixture into the UTC-dated directory matching its session_meta timestamp.
  const d = new Date(ROLLOUT_STARTED_AT);
  const dir = join(
    codexHome,
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  );
  mkdirSync(dir, { recursive: true });
  const content = readFileSync(FIXTURE_PATH, 'utf-8');
  writeFileSync(join(dir, 'rollout-2026-07-10T12-00-00-000Z-1307-sample.jsonl'), content, 'utf-8');
}

function codexTask(): Task {
  const createdAt = new Date('2026-07-10T12:00:30.000Z');
  return {
    id: 'task-1307',
    prompt: 'Meter Codex CLI token usage',
    cwd: FIXTURE_CWD,
    agentType: 'codex-cli',
    status: 'inProgress',
    sessions: [{
      tmuxSession: 'kookr-1307',
      agentType: 'codex-cli',
      cwd: FIXTURE_CWD,
      createdAt,
    }],
    createdAt,
    updatedAt: createdAt,
  };
}

describe('Codex rollout token metering (issue #1307)', () => {
  let codexHome: string;
  beforeEach(() => {
    codexHome = join(tmpdir(), `codex-metering-test-${randomUUID()}`);
    mkdirSync(codexHome, { recursive: true });
    stageFixtureRollout(codexHome);
  });
  afterEach(() => { try { rmSync(codexHome, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('scanner extracts the final total_token_usage snapshot including reasoning', async () => {
    const scanner = new CodexRolloutScanner({ codexHome });
    const start = Date.parse('2026-07-10T00:00:00.000Z');
    const end = Date.parse('2026-07-10T23:59:59.000Z');
    const { rollouts, stats } = await scanner.scan(start, end);

    expect(stats.parseErrorCount).toBe(0);
    expect(rollouts).toHaveLength(1);
    expect(rollouts[0].model).toBe('gpt-5.3-codex');
    expect(rollouts[0].hasTerminalEvent).toBe(true);
    expect(rollouts[0].totalUsage).toEqual({
      inputTokens: 120000,
      outputTokens: 25000,
      cachedInputTokens: 90000,
      reasoningOutputTokens: 5000,
    });
  });

  test('populates task tokenUsage with mapped tokens, OpenAI cost, and provider/model tag', async () => {
    const scanner = new CodexRolloutScanner({ codexHome });
    const metadata = await buildTaskCompletionMetadata(
      codexTask(),
      [],
      {
        runCommand: async () => '',
        scanner,
        now: () => Date.parse('2026-07-10T12:10:00.000Z'),
      },
    );

    // input = 120000 gross - 90000 cached; output = 25000 visible + 5000 reasoning.
    expect(metadata.taskTokenUsage).toMatchObject({
      inputTokens: 30000,
      outputTokens: 30000,
      cacheReadTokens: 90000,
      cacheWriteTokens: 0,
      provider: 'openai',
      model: 'gpt-5.3-codex',
    });
    // gpt-5.3-codex: input 1.75/Mtok, output 14/Mtok, cacheRead 0.175/Mtok.
    // 0.03*1.75 + 0.03*14 + 0.09*0.175 = 0.48825
    expect(metadata.taskTokenUsage!.costUsd).toBeCloseTo(0.48825, 5);

    expect(metadata.digest.tokenUsage).toMatchObject({
      source: 'codex-rollout',
      quality: 'available',
      model: 'gpt-5.3-codex',
    });
  });
});
