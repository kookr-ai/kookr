import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TokenTracker, computeContextFillFromTranscript, estimateCost, getContextLimit, getPricing } from './token-tracker.js';

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
    });
  });

  describe('incremental scanning', () => {
    test('only reads new content on subsequent scans', async () => {
      const path = join(dir, 'transcript.jsonl');
      writeJsonl(path, [
        {
          type: 'assistant', cost_usd: 0.003,
          message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50 } },
        },
      ]);

      tracker.register(path, 'task-1');
      await tracker.scanAll();

      const usage1 = tracker.getUsage('task-1')!;
      expect(usage1.inputTokens).toBe(100);

      // Append more content
      appendJsonl(path, [
        {
          type: 'assistant', cost_usd: 0.005,
          message: { role: 'assistant', usage: { input_tokens: 200, output_tokens: 100 } },
        },
      ]);

      await tracker.scanAll();
      const usage2 = tracker.getUsage('task-1')!;
      expect(usage2.inputTokens).toBe(300);
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

      const changed = await tracker.scanTask('task-1');
      expect(changed).toBe(true);
      expect(tracker.getUsage('task-1')!.inputTokens).toBe(1000);
      // task-2 should not have been scanned
      expect(tracker.getUsage('task-2')!.inputTokens).toBe(0);
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

describe('context fill model resolution', () => {
  test('uses the 1M denominator for claude-opus-4-7 transcripts', async () => {
    const tempDir = makeTempDir();
    try {
      const path = join(tempDir, 'opus-4-7-transcript.jsonl');
      writeJsonl(path, [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-7',
            usage: {
              input_tokens: 180_000,
              cache_creation_input_tokens: 30_000,
              cache_read_input_tokens: 20_000,
              output_tokens: 2_000,
            },
          },
        },
      ]);

      const result = await computeContextFillFromTranscript(path);
      expect(result).not.toBeNull();
      expect(result!.totalTokens).toBe(230_000);
      expect(result!.modelLimit).toBe(1_000_000);
      expect(result!.ratio).toBeCloseTo(0.23, 4);
      expect(result!.ratio).toBeLessThan(0.30);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('falls back to 200K and warns once per unknown context model id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getContextLimit('claude-future-9-0')).toBe(200_000);
    expect(getContextLimit('claude-future-9-0')).toBe(200_000);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[token-tracker] Unknown context limit for model "claude-future-9-0"; using default 200000');
  });
});
