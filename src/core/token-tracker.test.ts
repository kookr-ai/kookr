import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TokenTracker, estimateCost, getPricing } from './token-tracker.js';
import { BudgetChecker } from './budget-checker.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `token-tracker-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonl(path: string, entries: unknown[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path, content, 'utf-8');
}

function appendJsonl(path: string, entries: unknown[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(path, content, 'utf-8');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TokenTracker', () => {
  let dir: string;
  let tracker: TokenTracker;

  beforeEach(() => {
    dir = makeTempDir();
    tracker = new TokenTracker();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('returns undefined for unregistered task', () => {
    expect(tracker.getUsage('unknown-task')).toBeUndefined();
  });

  describe('real Claude Code format (message.usage)', () => {
    test('scans usage tokens from assistant messages', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        {
          type: 'assistant',
          message: {
            role: 'assistant', model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant', model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 },
          },
        },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1');
      expect(usage).toBeDefined();
      expect(usage!.inputTokens).toBe(3000);
      expect(usage!.outputTokens).toBe(500);
      expect(usage!.cacheReadTokens).toBe(1300);
      expect(usage!.cacheWriteTokens).toBe(100);
    });

    test('detects model from message.model and estimates cost', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        {
          type: 'assistant',
          message: {
            role: 'assistant', model: 'claude-opus-4-6',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 1000000, output_tokens: 100000 },
          },
        },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1');
      // Opus: $15/M input + $75/M output = $15 + $7.5 = $22.5
      expect(usage!.costUsd).toBeCloseTo(22.5, 1);
    });

    test('prices mixed-model transcripts with a separate bucket for each model', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        {
          type: 'assistant',
          message: {
            model: 'claude-opus-4-8',
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 100_000,
              cache_read_input_tokens: 100_000,
              cache_creation_input_tokens: 100_000,
            },
          },
        },
        {
          type: 'assistant',
          message: {
            model: 'claude-fable-5',
            usage: {
              input_tokens: 2_000_000,
              output_tokens: 200_000,
              cache_read_input_tokens: 100_000,
              cache_creation_input_tokens: 100_000,
            },
          },
        },
        {
          type: 'result',
          usage: {
            input_tokens: 3_000_000,
            output_tokens: 300_000,
            cache_read_input_tokens: 200_000,
            cache_creation_input_tokens: 200_000,
          },
        },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1');
      expect(usage).toMatchObject({
        inputTokens: 3_000_000,
        outputTokens: 300_000,
        cacheReadTokens: 200_000,
        cacheWriteTokens: 200_000,
        pricingQuality: 'exact',
      });
      expect(usage!.costUsd).toBeCloseTo(39.525, 6);

      const checker = new BudgetChecker(39.5);
      expect(checker.check('task-1', 'agent-1', usage!.costUsd)?.severity).toBe('warning');
    });

    test('does not invent first-model pricing for conflicting mixed-model result totals', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 100_000 } } },
        { type: 'assistant', message: { model: 'claude-fable-5', usage: { input_tokens: 2_000_000, output_tokens: 200_000 } } },
        { type: 'result', usage: { input_tokens: 4_000_000, output_tokens: 300_000 } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      expect(tracker.getUsage('task-1')).toMatchObject({
        inputTokens: 4_000_000,
        outputTokens: 300_000,
        pricingQuality: 'fallback',
      });
      expect(tracker.getUsage('task-1')!.costUsd).toBeCloseTo(16.5, 6);
    });

    test('keeps model-less usage unattributed during result reconciliation', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 100_000 } } },
        { type: 'assistant', message: { usage: { input_tokens: 1_000_000, output_tokens: 100_000 } } },
        { type: 'result', usage: { input_tokens: 2_000_000, output_tokens: 200_000 } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      expect(tracker.getUsage('task-1')).toMatchObject({
        inputTokens: 2_000_000,
        outputTokens: 200_000,
        pricingQuality: 'fallback',
      });
      expect(tracker.getUsage('task-1')!.costUsd).toBeCloseTo(12, 6);
    });

    test('marks cost estimates as fallback for an unknown model', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        {
          type: 'assistant',
          message: {
            model: 'claude-unknown-9',
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 100_000,
              cache_read_input_tokens: 100_000,
              cache_creation_input_tokens: 100_000,
            },
          },
        },
        {
          type: 'assistant',
          message: {
            model: 'claude-opus-4-8',
            usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
          },
        },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      expect(tracker.getUsage('task-1')).toMatchObject({
        inputTokens: 2_000_000,
        outputTokens: 200_000,
        cacheReadTokens: 100_000,
        cacheWriteTokens: 100_000,
        pricingQuality: 'fallback',
      });
      expect(tracker.getUsage('task-1')!.costUsd).toBeCloseTo(12.405, 6);
    });

    test('marks prefix-priced dated model IDs as exact quality (not Sonnet fallback)', async () => {
      // Dated Claude ids (e.g. claude-opus-4-8-20260701) are priced via longest-prefix
      // against the Opus row — cost is correct, so pricingQuality must not claim fallback.
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        {
          type: 'assistant',
          message: {
            model: 'claude-opus-4-8-20260701',
            usage: { input_tokens: 1_000_000, output_tokens: 0 },
          },
        },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      expect(tracker.getUsage('task-1')).toMatchObject({ costUsd: 5, pricingQuality: 'exact' });
    });

    test('handles real-world transcript with cache tokens', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'file-history-snapshot', snapshot: {} },
        { type: 'user', message: { role: 'user', content: 'fix bug' } },
        {
          type: 'assistant',
          message: {
            role: 'assistant', model: 'claude-opus-4-6',
            content: [{ type: 'text', text: 'Hello!' }],
            usage: {
              input_tokens: 3,
              output_tokens: 5,
              cache_creation_input_tokens: 19159,
              cache_read_input_tokens: 0,
            },
          },
        },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1');
      expect(usage!.inputTokens).toBe(3);
      expect(usage!.outputTokens).toBe(5);
      expect(usage!.cacheWriteTokens).toBe(19159);
      expect(usage!.cacheReadTokens).toBe(0);
      // Cost should include cache write cost
      expect(usage!.costUsd).toBeGreaterThan(0);
    });
  });

  describe('legacy format (top-level cost_usd/usage)', () => {
    test('scans assistant message cost_usd', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', cost_usd: 0.003, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'assistant', cost_usd: 0.005, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1');
      expect(usage).toBeDefined();
      expect(usage!.costUsd).toBeCloseTo(0.008, 4);
    });

    test('result entry provides authoritative total_cost_usd', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', cost_usd: 0.003 },
        { type: 'assistant', cost_usd: 0.005 },
        { type: 'result', total_cost_usd: 0.015, result: 'done' },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1');
      // total_cost_usd (0.015) overrides accumulated cost (0.008)
      expect(usage!.costUsd).toBeCloseTo(0.015, 4);
    });

    test('result entry with usage overrides accumulated tokens', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', cost_usd: 0.003, usage: { input_tokens: 1000, output_tokens: 200 } },
        { type: 'result', total_cost_usd: 0.015, usage: { input_tokens: 5000, output_tokens: 1000, cache_read_input_tokens: 3000 }, result: 'done' },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1');
      expect(usage!.inputTokens).toBe(5000);
      expect(usage!.outputTokens).toBe(1000);
      expect(usage!.cacheReadTokens).toBe(3000);
      expect(usage!.costUsd).toBeCloseTo(0.015, 4);
    });

    test('result entry preserves omitted counters and the observed model', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        {
          type: 'assistant',
          message: {
            model: 'claude-opus-4-8',
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 100_000,
              cache_read_input_tokens: 200_000,
              cache_creation_input_tokens: 300_000,
            },
          },
        },
        { type: 'result', usage: { input_tokens: 2_000_000, output_tokens: 200_000 }, result: 'done' },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      expect(tracker.getUsage('task-1')).toMatchObject({
        inputTokens: 2_000_000,
        outputTokens: 200_000,
        cacheReadTokens: 200_000,
        cacheWriteTokens: 300_000,
        pricingQuality: 'exact',
      });
      expect(tracker.getUsage('task-1')!.costUsd).toBeCloseTo(16.975, 6);
      expect(tracker.getModel('task-1')).toBe('claude-opus-4-8');
    });
  });

  describe('incremental scanning', () => {
    test('only reads new content on subsequent scans', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        {
          type: 'assistant',
          message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 } },
        },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage1 = tracker.getUsage('task-1')!;
      expect(usage1.inputTokens).toBe(100);

      // Append more content
      appendJsonl(path, [
        {
          type: 'assistant',
          message: { role: 'assistant', model: 'claude-fable-5', usage: { input_tokens: 200, output_tokens: 100 } },
        },
      ]);

      await tracker.scanAll();
      const usage2 = tracker.getUsage('task-1')!;
      expect(usage2.inputTokens).toBe(300);
      expect(usage2.outputTokens).toBe(150);
      expect(usage2.costUsd).toBeCloseTo(0.00875, 8);
      expect(usage2.pricingQuality).toBe('exact');
    });
  });

  describe('stat-first read avoidance (issue #1620)', () => {
    test('does not re-read the file when it has not grown', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 } } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      // First scan parsed the file exactly once.
      expect(tracker.readCount).toBe(1);
      const charsAfterFirst = tracker.cumulativeReadChars;
      expect(charsAfterFirst).toBeGreaterThan(0);

      // Several no-growth ticks must NOT read the file again — this is the
      // allocation-churn fix. Before the stat-first guard, every tick did a
      // full readFile of the whole (potentially multi-MB) transcript.
      await tracker.scanAll();
      await tracker.scanAll();
      await tracker.scanAll();

      expect(tracker.readCount).toBe(1);
      expect(tracker.cumulativeReadChars).toBe(charsAfterFirst);
      // Accounting is unchanged by the skipped reads.
      expect(tracker.getUsage('task-1')!.inputTokens).toBe(100);
    });

    test('reads exactly once more per append, and only the new bytes', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 } } },
      ]);
      tracker.register(path, 'task-1');
      await tracker.scanAll();
      const charsAfterFirst = tracker.cumulativeReadChars;

      // No-op tick — skipped.
      await tracker.scanAll();
      expect(tracker.readCount).toBe(1);

      const appendedEntry = { type: 'assistant', message: { model: 'claude-fable-5', usage: { input_tokens: 200, output_tokens: 100 } } };
      appendJsonl(path, [appendedEntry]);

      await tracker.scanAll();
      expect(tracker.readCount).toBe(2);
      // The incremental read decoded only the appended line, not the whole file.
      const appendedChars = tracker.cumulativeReadChars - charsAfterFirst;
      const appendedText = JSON.stringify(appendedEntry) + '\n';
      expect(appendedChars).toBe(appendedText.length);
      expect(tracker.getUsage('task-1')!.inputTokens).toBe(300);
    });

    test('incremental byte-offset reads stay correct across multi-byte UTF-8 appends', async () => {
      // The offset is tracked in bytes; a naive char-index seek would drift on
      // any non-ASCII content and split a line or a multi-byte character.
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', note: 'em — dash 🚀', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5 } } },
      ]);
      tracker.register(path, 'task-1');
      await tracker.scanAll();
      expect(tracker.getUsage('task-1')!.inputTokens).toBe(10);

      // Append two more lines, each carrying multi-byte characters, in two ticks.
      // Assert the cumulativeReadChars DELTA equals exactly the appended line's
      // length: a char-unit (rather than byte-unit) offset would seek a few
      // bytes early, re-reading part of the previous line — the unparseable
      // fragment leaves TOTALS correct (silently skipped JSON), so only the
      // read-delta catches the drift.
      const line2 = { type: 'assistant', note: 'smart "quote" ✅', message: { model: 'claude-opus-4-8', usage: { input_tokens: 20, output_tokens: 7 } } };
      const before2 = tracker.cumulativeReadChars;
      appendJsonl(path, [line2]);
      await tracker.scanAll();
      expect(tracker.getUsage('task-1')!.inputTokens).toBe(30);
      expect(tracker.cumulativeReadChars - before2).toBe((JSON.stringify(line2) + '\n').length);

      const line3 = { type: 'assistant', note: 'accents éàü and emoji 🎉🔥', message: { model: 'claude-opus-4-8', usage: { input_tokens: 33, output_tokens: 3 } } };
      const before3 = tracker.cumulativeReadChars;
      appendJsonl(path, [line3]);
      await tracker.scanAll();
      const usage = tracker.getUsage('task-1')!;
      expect(usage.inputTokens).toBe(63);
      expect(usage.outputTokens).toBe(15);
      expect(tracker.cumulativeReadChars - before3).toBe((JSON.stringify(line3) + '\n').length);
    });

    test('rotation to a smaller file re-parses from scratch without double-counting', async () => {
      // A transcript replaced in place by a shorter, different file (rotation)
      // must reconstruct totals from the NEW content only — not add the new
      // file's usage on top of the pre-rotation totals.
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 100 } } },
        { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 2000, output_tokens: 200 } } },
      ]);
      tracker.register(path, 'task-1');
      await tracker.scanAll();
      expect(tracker.getUsage('task-1')!.inputTokens).toBe(3000);

      // Replace with a shorter file (size < prior byteOffset) carrying different usage.
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5 } } },
      ]);
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1')!;
      expect(usage.inputTokens).toBe(10);
      expect(usage.outputTokens).toBe(5);
    });

    test('defers a mid-write partial line until it is newline-terminated', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 } } },
      ]);
      tracker.register(path, 'task-1');
      await tracker.scanAll();

      // A partial line with no trailing newline (writer mid-append).
      const full = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 200, output_tokens: 20 } } };
      const line = JSON.stringify(full);
      appendFileSync(path, line.slice(0, line.length - 10), 'utf-8');
      await tracker.scanAll();
      // Partial line must not be counted yet.
      expect(tracker.getUsage('task-1')!.inputTokens).toBe(100);

      // Complete the line + newline; now it lands.
      appendFileSync(path, line.slice(line.length - 10) + '\n', 'utf-8');
      await tracker.scanAll();
      expect(tracker.getUsage('task-1')!.inputTokens).toBe(300);
    });
  });

  describe('unregisterTask (terminal cleanup, issue #1620 change d)', () => {
    test('removes every transcript for a task, including subagent transcripts', async () => {
      const parentPath = join(dir, 'parent.jsonl');
      const subagentPath = join(dir, 'subagent-sidechain.jsonl');
      writeJsonl(parentPath, [
        { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 100 } } },
      ]);
      writeJsonl(subagentPath, [
        { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 2000, output_tokens: 200 } } },
      ]);

      // Both the parent session transcript and a subagent (sidechain) transcript
      // are registered under the same parent task id.
      tracker.register(parentPath, 'task-1');
      tracker.register(subagentPath, 'task-1');
      await tracker.scanAll();
      expect(tracker.getUsage('task-1')!.inputTokens).toBe(3000);

      tracker.unregisterTask('task-1');

      expect(tracker.getUsage('task-1')).toBeUndefined();
      expect(tracker.getTrackedTaskIds()).toEqual([]);
      // A follow-up scan must not resurrect or re-read the dropped transcripts.
      const readsBefore = tracker.readCount;
      await tracker.scanAll();
      expect(tracker.readCount).toBe(readsBefore);
    });

    test('is a no-op for an unknown task id', () => {
      expect(() => tracker.unregisterTask('nonexistent')).not.toThrow();
    });
  });

  describe('multi-session aggregation', () => {
    test('aggregates across multiple sessions for same task', async () => {
      const path1 = join(dir, 'session1.jsonl');
      const path2 = join(dir, 'session2.jsonl');
      writeJsonl(path1, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 5000, output_tokens: 1000 } } },
      ]);
      writeJsonl(path2, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 8000, output_tokens: 2000 } } },
      ]);

      tracker.register(path1, 'task-1');
      tracker.register(path2, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1');
      expect(usage!.inputTokens).toBe(13000);
      expect(usage!.outputTokens).toBe(3000);
    });

    test('getUsage reads only transcripts indexed to the requested task', async () => {
      const path1 = join(dir, 'task1-session1.jsonl');
      const path2 = join(dir, 'task1-session2.jsonl');
      const unrelatedPath = join(dir, 'task2-session1.jsonl');
      writeJsonl(path1, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100 } } },
      ]);
      writeJsonl(path2, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 2000, output_tokens: 200 } } },
      ]);
      writeJsonl(unrelatedPath, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 9000, output_tokens: 900 } } },
      ]);

      tracker.register(path1, 'task-1');
      tracker.register(path2, 'task-1');
      tracker.register(unrelatedPath, 'task-2');
      await tracker.scanAll();

      const internals = tracker as unknown as { transcripts: Map<string, unknown> };
      const getSpy = vi.spyOn(internals.transcripts, 'get');
      const valuesSpy = vi.spyOn(internals.transcripts, 'values');

      const usage = tracker.getUsage('task-1');

      expect(usage!.inputTokens).toBe(3000);
      expect(usage!.outputTokens).toBe(300);
      expect(getSpy).toHaveBeenCalledTimes(2);
      expect(getSpy).toHaveBeenNthCalledWith(1, path1);
      expect(getSpy).toHaveBeenNthCalledWith(2, path2);
      expect(valuesSpy).not.toHaveBeenCalled();
    });

    test('getModel reads only transcripts indexed to the requested task', async () => {
      const path1 = join(dir, 'task1-session1.jsonl');
      const path2 = join(dir, 'task1-session2.jsonl');
      const unrelatedPath = join(dir, 'task2-session1.jsonl');
      writeJsonl(path1, [
        { type: 'assistant', message: { model: 'claude-opus-4-6', usage: { input_tokens: 1000, output_tokens: 100 } } },
      ]);
      writeJsonl(path2, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 2000, output_tokens: 200 } } },
      ]);
      writeJsonl(unrelatedPath, [
        { type: 'assistant', message: { model: 'claude-haiku-4-6', usage: { input_tokens: 9000, output_tokens: 900 } } },
      ]);

      tracker.register(path1, 'task-1');
      tracker.register(path2, 'task-1');
      tracker.register(unrelatedPath, 'task-2');
      await tracker.scanAll();

      const internals = tracker as unknown as { transcripts: Map<string, unknown> };
      const getSpy = vi.spyOn(internals.transcripts, 'get');
      const valuesSpy = vi.spyOn(internals.transcripts, 'values');

      expect(tracker.getModel('task-1')).toBe('claude-opus-4-6');
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(getSpy).toHaveBeenCalledWith(path1);
      expect(valuesSpy).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    test('handles missing transcript file gracefully', async () => {
      tracker.register('/nonexistent/transcript.jsonl', 'task-1');
      await tracker.scanAll();
      const usage = tracker.getUsage('task-1');
      expect(usage).toBeDefined();
      expect(usage!.costUsd).toBe(0);
    });

    test('handles malformed JSON lines gracefully', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeFileSync(path, '{ broken json\n{"type":"assistant","cost_usd":0.003}\n', 'utf-8');

      tracker.register(path, 'task-1');
      await tracker.scanAll();
      expect(tracker.getUsage('task-1')!.costUsd).toBeCloseTo(0.003, 4);
    });

    test('handles truncated mid-line JSON (partial write)', async () => {
      const path = join(dir, 'transcript.jsonl');
      // Valid line, then a line cut off mid-JSON (simulating a crash during write)
      writeFileSync(path, '{"type":"assistant","cost_usd":0.005}\n{"type":"assistant","cost_u', 'utf-8');

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      // First valid line should be counted, truncated line skipped
      expect(tracker.getUsage('task-1')!.costUsd).toBeCloseTo(0.005, 4);
    });
  });

  test('getTrackedTaskIds returns unique task IDs', () => {
    tracker.register('/a.jsonl', 'task-1');
    tracker.register('/b.jsonl', 'task-1');
    tracker.register('/c.jsonl', 'task-2');
    expect(tracker.getTrackedTaskIds().sort()).toEqual(['task-1', 'task-2']);
  });

  describe('scanTask', () => {
    test('returns true when task transcript has new data', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 200 } } },
      ]);

      tracker.register(path, 'task-1');
      const changed = await tracker.scanTask('task-1');
      expect(changed).toBe(true);
      expect(tracker.getUsage('task-1')!.inputTokens).toBe(1000);
    });

    test('returns false when no new data', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 200 } } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanTask('task-1');
      const changed = await tracker.scanTask('task-1');
      expect(changed).toBe(false);
    });

    test('returns false for unregistered task', async () => {
      const changed = await tracker.scanTask('nonexistent');
      expect(changed).toBe(false);
    });

    test('only scans transcripts for the specified task', async () => {
      const path1 = join(dir, 'session1.jsonl');
      const path2 = join(dir, 'session2.jsonl');
      writeJsonl(path1, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 200 } } },
      ]);
      writeJsonl(path2, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 5000, output_tokens: 500 } } },
      ]);

      tracker.register(path1, 'task-1');
      tracker.register(path2, 'task-2');

      const internals = tracker as unknown as { transcripts: Map<string, unknown> };
      const getSpy = vi.spyOn(internals.transcripts, 'get');
      const valuesSpy = vi.spyOn(internals.transcripts, 'values');

      const changed = await tracker.scanTask('task-1');
      expect(changed).toBe(true);
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(getSpy).toHaveBeenCalledWith(path1);
      expect(valuesSpy).not.toHaveBeenCalled();

      expect(tracker.getUsage('task-1')!.inputTokens).toBe(1000);
      // task-2 should not have been scanned
      expect(tracker.getUsage('task-2')!.inputTokens).toBe(0);
    });
  });

  describe('scanGrowth (freshness probe)', () => {
    test('reports exact byte delta since the last scanAll', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
      tracker.register(path, 'task-1');
      await tracker.scanAll();

      // Simulate a mid-stream growth that hasn't finalized into a parsable line yet.
      const appended = '{"type":"assistant","message":{"id":"msg_b","model":"claude-sonnet-4-6"';
      appendFileSync(path, appended, 'utf-8');

      const growths = await tracker.scanGrowth();
      expect(growths).toHaveLength(1);
      expect(growths[0].taskId).toBe('task-1');
      expect(growths[0].bytesGained).toBe(Buffer.byteLength(appended, 'utf-8'));
    });

    test('reports bytes correctly when transcript contains non-ASCII UTF-8', async () => {
      // Regression guard: scanGrowth must compare bytes vs bytes. JS string
      // .length is UTF-16 code units, so any em-dash / smart quote / emoji
      // would silently make scanGrowth fire forever if the impl mixed units.
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } },
          text: 'em — dash and a smart "quote" with emoji 🚀' },
      ]);
      tracker.register(path, 'task-1');
      await tracker.scanAll();

      // No growth after scanAll consumed everything.
      expect(await tracker.scanGrowth()).toEqual([]);

      // Append a payload that has a different byte-vs-char count.
      const appended = ' — more 🚀\n';
      appendFileSync(path, appended, 'utf-8');
      const growths = await tracker.scanGrowth();
      expect(growths).toHaveLength(1);
      expect(growths[0].bytesGained).toBe(Buffer.byteLength(appended, 'utf-8'));
      expect(growths[0].bytesGained).toBeGreaterThan(appended.length);
    });

    test('does not report pre-existing bytes on the first tick after register', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
      // Register AFTER the file already has content — those bytes are
      // historical, not growth. scanGrowth must seed from the current size.
      tracker.register(path, 'task-1');

      expect(await tracker.scanGrowth()).toEqual([]);
    });

    test('returns empty when no transcripts have grown', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const growths = await tracker.scanGrowth();
      expect(growths).toEqual([]);
    });

    test('skips missing transcript files', async () => {
      tracker.register('/nonexistent/path.jsonl', 'task-ghost');
      const growths = await tracker.scanGrowth();
      expect(growths).toEqual([]);
    });

    test('skips transcripts that shrank below the previous offset (truncation), then detects post-truncation growth', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } } },
      ]);
      tracker.register(path, 'task-1');
      await tracker.scanAll();

      // File truncated — stat.size < state.byteOffset. scanGrowth must NOT
      // report this as growth (a wrap-around would re-trigger watchdog freshness).
      writeFileSync(path, '', 'utf-8');
      expect(await tracker.scanGrowth()).toEqual([]);

      // After truncation, scanAll must catch up so the next legitimate
      // append registers as growth from the new baseline.
      await tracker.scanAll();
      const appended = 'fresh content after truncation\n';
      appendFileSync(path, appended, 'utf-8');
      const growths = await tracker.scanGrowth();
      expect(growths).toHaveLength(1);
      expect(growths[0].bytesGained).toBe(Buffer.byteLength(appended, 'utf-8'));
    });
  });

  describe('usage deduplication', () => {
    test('deduplicates multiple content blocks sharing one message.id', async () => {
      const path = join(dir, 'transcript.jsonl');
      // Claude Code writes one JSONL line per content block (thinking / text /
      // tool_use) of a single API response, all sharing message.id. When usage
      // is identical across the blocks, counting naively would multiply the bill.
      writeJsonl(path, [
        {
          type: 'assistant',
          message: { id: 'msg_a', model: 'claude-sonnet-4-6', content: [{ type: 'thinking', text: '...' }],
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        },
        {
          type: 'assistant',
          message: { id: 'msg_a', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', name: 'Read' }],
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        },
        {
          type: 'assistant',
          message: { id: 'msg_a', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', name: 'Edit' }],
            usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1')!;
      expect(usage.inputTokens).toBe(1000);
      expect(usage.outputTokens).toBe(200);
    });

    test('keeps the final usage when content blocks carry progressive streaming updates', async () => {
      const path = join(dir, 'transcript.jsonl');
      // Real-world pattern (observed in 0487e345-.../msg_01KtMvGmBkbRVEyzXiNq9Ufp):
      // early content blocks carry a partial output_tokens, the final block
      // carries the full bill. Signature dedup treats partial and final as
      // two separate messages and sums them (46 + 217 = 263 instead of 217).
      writeJsonl(path, [
        { type: 'assistant', message: { id: 'msg_stream', model: 'claude-sonnet-4-6',
          content: [{ type: 'thinking' }],
          usage: { input_tokens: 3, output_tokens: 46, cache_read_input_tokens: 12250, cache_creation_input_tokens: 8835 } } },
        { type: 'assistant', message: { id: 'msg_stream', model: 'claude-sonnet-4-6',
          content: [{ type: 'text' }],
          usage: { input_tokens: 3, output_tokens: 46, cache_read_input_tokens: 12250, cache_creation_input_tokens: 8835 } } },
        { type: 'assistant', message: { id: 'msg_stream', model: 'claude-sonnet-4-6',
          content: [{ type: 'tool_use' }],
          usage: { input_tokens: 3, output_tokens: 217, cache_read_input_tokens: 12250, cache_creation_input_tokens: 8835 } } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1')!;
      expect(usage.inputTokens).toBe(3);
      expect(usage.outputTokens).toBe(217);
      expect(usage.cacheReadTokens).toBe(12250);
      expect(usage.cacheWriteTokens).toBe(8835);
    });

    test('streaming updates that straddle an incremental scan still dedup correctly', async () => {
      const path = join(dir, 'transcript.jsonl');
      // Non-zero cache counts that also change between scans so the subtract
      // arm has to do real work for every field, not just output_tokens.
      writeJsonl(path, [
        { type: 'assistant', message: { id: 'msg_stream', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 3, output_tokens: 46, cache_read_input_tokens: 12250, cache_creation_input_tokens: 8835 } } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();
      expect(tracker.getUsage('task-1')!.outputTokens).toBe(46);
      expect(tracker.getUsage('task-1')!.cacheReadTokens).toBe(12250);

      // Final block for the same msg_id with BIGGER output and cache counts.
      appendJsonl(path, [
        { type: 'assistant', message: { id: 'msg_stream', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 3, output_tokens: 217, cache_read_input_tokens: 12500, cache_creation_input_tokens: 9000 } } },
      ]);

      await tracker.scanAll();
      // Replaced, not added: totals reflect the final entry alone.
      const u = tracker.getUsage('task-1')!;
      expect(u.inputTokens).toBe(3);
      expect(u.outputTokens).toBe(217);
      expect(u.cacheReadTokens).toBe(12500);
      expect(u.cacheWriteTokens).toBe(9000);
    });

    test('entries without message.id still dedup consecutive identical usage (legacy fallback)', async () => {
      const path = join(dir, 'transcript.jsonl');
      // Older transcripts lacked message.id. Preserve the pre-v2.1 consecutive
      // signature-dedup so legacy logs do not regress to over-counting.
      writeJsonl(path, [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
        { type: 'assistant', message: { model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const u = tracker.getUsage('task-1')!;
      expect(u.inputTokens).toBe(1000);
      expect(u.outputTokens).toBe(200);
    });

    test('mixed stream: entries without message.id interleaved with msg_id entries', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { id: 'msg_a', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1, output_tokens: 46, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
        // A legacy entry with no id slips in between the partial and the final
        // — it must not interfere with the per-msg_id bookkeeping.
        { type: 'assistant', message: { model: 'claude-sonnet-4-6',
          usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
        { type: 'assistant', message: { id: 'msg_a', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1, output_tokens: 217, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const u = tracker.getUsage('task-1')!;
      // msg_a replaced 46 with 217; legacy entry adds 5/10 once.
      expect(u.inputTokens).toBe(1 + 5);
      expect(u.outputTokens).toBe(217 + 10);
    });

    test('result entry clears per-message bookkeeping (no stale subtract)', async () => {
      const path = join(dir, 'transcript.jsonl');
      // Sequence: (1) partial+final for msg_a → totals = 217 out.
      //           (2) result entry → authoritative boundary, clear perMsgUsage.
      //           (3) a later msg_a re-use (e.g. a new session in the same file)
      //               must not subtract the pre-result 217.
      writeJsonl(path, [
        { type: 'assistant', message: { id: 'msg_a', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1, output_tokens: 46 } } },
        { type: 'assistant', message: { id: 'msg_a', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1, output_tokens: 217 } } },
        { type: 'result' },
        { type: 'assistant', message: { id: 'msg_a', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1, output_tokens: 50 } } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const u = tracker.getUsage('task-1')!;
      // Pre-result totals (217) + fresh post-result accumulation (50) = 267.
      expect(u.outputTokens).toBe(267);
    });

    test('counts distinct message ids separately', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        { type: 'assistant', message: { id: 'msg_a', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
        { type: 'assistant', message: { id: 'msg_b', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 } } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1')!;
      expect(usage.inputTokens).toBe(3000);
      expect(usage.outputTokens).toBe(500);
    });

    test('identical usage on distinct message ids is not deduped', async () => {
      const path = join(dir, 'transcript.jsonl');
      // Regression guard for the previous signature-based dedup: two distinct
      // API responses that happen to share a usage signature must both count.
      writeJsonl(path, [
        { type: 'assistant', message: { id: 'msg_a', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
        { type: 'assistant', message: { id: 'msg_b', model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage = tracker.getUsage('task-1')!;
      expect(usage.inputTokens).toBe(2000);
      expect(usage.outputTokens).toBe(400);
    });
  });

  test('unregister removes transcript', async () => {
    const path = join(dir, 'transcript.jsonl');
    writeJsonl(path, [{ type: 'assistant', cost_usd: 0.010 }]);

    tracker.register(path, 'task-1');
    await tracker.scanAll();
    expect(tracker.getUsage('task-1')!.costUsd).toBeCloseTo(0.010, 4);

    tracker.unregister(path);
    expect(tracker.getUsage('task-1')).toBeUndefined();
  });

  test('unregister keeps task index in sync across multiple transcripts', async () => {
    const path1 = join(dir, 'session1.jsonl');
    const path2 = join(dir, 'session2.jsonl');
    writeJsonl(path1, [
      { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100 } } },
    ]);
    writeJsonl(path2, [
      { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 2000, output_tokens: 200 } } },
    ]);

    tracker.register(path1, 'task-1');
    tracker.register(path2, 'task-1');
    await tracker.scanAll();
    expect(tracker.getTrackedTaskIds()).toEqual(['task-1']);

    tracker.unregister(path1);
    expect(tracker.getUsage('task-1')!.inputTokens).toBe(2000);
    expect(tracker.getTrackedTaskIds()).toEqual(['task-1']);

    tracker.unregister(path2);
    expect(tracker.getUsage('task-1')).toBeUndefined();
    expect(tracker.getTrackedTaskIds()).toEqual([]);
  });
});

describe('estimateCost', () => {
  test('calculates Opus pricing correctly', () => {
    const pricing = getPricing('claude-opus-4-6');
    // 1M input @ $15 + 1M output @ $75 = $90
    const cost = estimateCost(1_000_000, 1_000_000, 0, 0, pricing);
    expect(cost).toBeCloseTo(90, 1);
  });

  test('resolves Opus 4.7 pricing from the explicit model id', () => {
    const pricing = getPricing('claude-opus-4-7');
    expect(pricing).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.5,
    });
  });

  test('includes cache costs', () => {
    const pricing = getPricing('claude-opus-4-6');
    // 1M cache write @ $18.75 + 1M cache read @ $1.875 = $20.625
    const cost = estimateCost(0, 0, 1_000_000, 1_000_000, pricing);
    expect(cost).toBeCloseTo(20.625, 2);
  });

  test('handles dated model IDs via prefix match', () => {
    const pricing = getPricing('claude-opus-4-6-20250514');
    expect(pricing.inputPerMTok).toBe(15);
  });

  test('falls back to Sonnet pricing for unknown models', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pricing = getPricing('unknown-model');
    expect(warn).toHaveBeenCalledWith('[pricing-tables] Unknown pricing model "unknown-model"; using default Sonnet pricing');
    expect(pricing.inputPerMTok).toBe(3);
  });

  test('warns once per unknown pricing model id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getPricing('unknown-model-twice')).toBe(getPricing('unknown-model-twice'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[pricing-tables] Unknown pricing model "unknown-model-twice"; using default Sonnet pricing');
  });
});
