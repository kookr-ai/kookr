import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeContextFillFromTranscript, getContextLimit } from './token-tracker.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getContextLimit', () => {
  it('resolves Opus 4.6 1M variant before the default Opus entry', () => {
    expect(getContextLimit('claude-opus-4-6[1m]')).toBe(1_000_000);
    expect(getContextLimit('claude-opus-4-6')).toBe(200_000);
    expect(getContextLimit('claude-opus-4-6-20251022')).toBe(200_000);
  });

  it('resolves Sonnet and Haiku as 200K', () => {
    expect(getContextLimit('claude-sonnet-4-6')).toBe(200_000);
    expect(getContextLimit('claude-haiku-4-5')).toBe(200_000);
  });

  it('falls back to 200K for unknown models and warns once per model id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getContextLimit('claude-future-7-0')).toBe(200_000);
    expect(getContextLimit('claude-future-7-0')).toBe(200_000);
    expect(getContextLimit('')).toBe(200_000);
    expect(getContextLimit('')).toBe(200_000);
    expect(warn).toHaveBeenNthCalledWith(1, '[token-tracker] Unknown context limit for model "claude-future-7-0"; using default 200000');
    expect(warn).toHaveBeenNthCalledWith(2, '[token-tracker] Unknown context limit for model ""; using default 200000');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('computeContextFillFromTranscript', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tt-context-fill-'));
    transcriptPath = join(dir, 'transcript.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when file does not exist', async () => {
    const result = await computeContextFillFromTranscript(join(dir, 'nope.jsonl'));
    expect(result).toBeNull();
  });

  it('returns null when transcript has no assistant entries with usage', async () => {
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        JSON.stringify({ type: 'system', subtype: 'init' }),
      ].join('\n'),
    );
    const result = await computeContextFillFromTranscript(transcriptPath);
    expect(result).toBeNull();
  });

  it('reads the LAST assistant turn, not the first', async () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6[1m]',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 0,
            output_tokens: 50,
          },
        },
      }),
      JSON.stringify({ type: 'user', message: { content: 'follow up' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6[1m]',
          usage: {
            input_tokens: 6,
            cache_creation_input_tokens: 2000,
            cache_read_input_tokens: 5000,
            output_tokens: 100,
          },
        },
      }),
    ];
    await writeFile(transcriptPath, lines.join('\n'));

    const result = await computeContextFillFromTranscript(transcriptPath);
    expect(result).not.toBeNull();
    expect(result!.totalTokens).toBe(6 + 2000 + 5000); // last turn, not first
    expect(result!.model).toBe('claude-opus-4-6[1m]');
    expect(result!.modelLimit).toBe(1_000_000);
    expect(result!.ratio).toBeCloseTo(7006 / 1_000_000);
  });

  it('matches Claude Code /context numbers from POC2 (43.7k pre-compact)', async () => {
    // Real numbers captured from docs/poc/005-checkpoint-cycle-mechanics.md
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6[1m]',
          usage: {
            input_tokens: 6,
            cache_creation_input_tokens: 43_733,
            cache_read_input_tokens: 0,
            output_tokens: 1761,
          },
        },
      }),
    );
    const result = await computeContextFillFromTranscript(transcriptPath);
    expect(result!.totalTokens).toBe(43_739);
    expect(result!.modelLimit).toBe(1_000_000);
    expect(result!.ratio).toBeCloseTo(0.0437, 4);
  });

  it('matches Claude Code /context numbers from POC2 (39.6k post-compact)', async () => {
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6[1m]',
          usage: {
            input_tokens: 6,
            cache_creation_input_tokens: 21_554,
            cache_read_input_tokens: 18_027,
            output_tokens: 11,
          },
        },
      }),
    );
    const result = await computeContextFillFromTranscript(transcriptPath);
    expect(result!.totalTokens).toBe(39_587);
    expect(result!.ratio).toBeCloseTo(0.0396, 4);
  });

  it('uses default 200K limit when model is missing', async () => {
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          // model intentionally omitted
          usage: {
            input_tokens: 1000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    );
    const result = await computeContextFillFromTranscript(transcriptPath);
    expect(result!.modelLimit).toBe(200_000);
    expect(result!.ratio).toBeCloseTo(0.005);
  });

  it('skips malformed lines and continues scanning backwards', async () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
        },
      }),
      'this is garbage not json',
      '   ', // whitespace
    ];
    await writeFile(transcriptPath, lines.join('\n'));
    const result = await computeContextFillFromTranscript(transcriptPath);
    expect(result).not.toBeNull();
    expect(result!.totalTokens).toBe(150);
  });
});
