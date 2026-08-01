import { createHash } from 'node:crypto';
import type { LlmClient } from '../core/llm-client.js';
import type { CircuitBreaker } from '../core/circuit-breaker.js';
import {
  normalizedTaskSpeechSummaryHashInput,
  summarizeTaskForSpeech,
  type TaskSpeechSummaryInput,
} from '../core/task-speech-summary.js';
import { TTSClientError } from '../adapters/tts-client.js';
import { synthesizeWithCircuitBreaker } from '../adapters/circuit-breaker-tts-client.js';

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export interface TaskSpeakResult {
  text: string;
  audioBase64: string;
  mimeType: 'audio/wav';
  durationMs: number;
  usedFallback: boolean;
  llmMs: number;
  ttsMs: number;
  cached: boolean;
}

export interface TaskSpeechSummaryCacheConfig {
  llmClient: LlmClient | null;
  ttsUrl: string;
  voice: string;
  maxEntries?: number;
  maxBytes?: number;
  /**
   * Optional TTS circuit breaker (issue #1772). When open, fresh synthesis is
   * skipped immediately; cache hits still serve previously synthesized audio.
   */
  ttsBreaker?: CircuitBreaker;
  now?: () => number;
}

interface CachedEntry {
  bytes: number;
  result: Omit<TaskSpeakResult, 'cached'>;
}

function computeTaskSpeechCacheKey(input: TaskSpeechSummaryInput, voice: string): string {
  return createHash('sha1')
    .update(voice)
    .update('\x1f')
    .update(JSON.stringify(normalizedTaskSpeechSummaryHashInput(input)))
    .digest('hex');
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new TTSClientError('network', 'request aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new TTSClientError('network', 'request aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export class TaskSpeechSummaryCache {
  private readonly entries = new Map<string, CachedEntry>();
  private readonly inflight = new Map<string, Promise<Omit<TaskSpeakResult, 'cached'>>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private currentBytes = 0;

  constructor(private readonly config: TaskSpeechSummaryCacheConfig) {
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async get(input: TaskSpeechSummaryInput, signal?: AbortSignal): Promise<TaskSpeakResult> {
    const cacheKey = computeTaskSpeechCacheKey(input, this.config.voice);
    const cached = this.entries.get(cacheKey);
    if (cached) return { ...cached.result, cached: true, llmMs: 0, ttsMs: 0 };

    const inflight = this.inflight.get(cacheKey);
    if (inflight) {
      const shared = signal ? await abortable(inflight, signal) : await inflight;
      return { ...shared, cached: true, llmMs: 0, ttsMs: 0 };
    }

    const work = this.fetchFresh(cacheKey, input);
    this.inflight.set(cacheKey, work);
    work.finally(() => {
      if (this.inflight.get(cacheKey) === work) {
        this.inflight.delete(cacheKey);
      }
    });
    const result = signal ? await abortable(work, signal) : await work;
    return { ...result, cached: false };
  }

  private async fetchFresh(
    cacheKey: string,
    input: TaskSpeechSummaryInput,
  ): Promise<Omit<TaskSpeakResult, 'cached'>> {
    const now = this.config.now ?? Date.now;
    const llmStart = now();
    const summary = await summarizeTaskForSpeech(this.config.llmClient, input);
    const llmMs = now() - llmStart;

    const ttsStart = now();
    const ttsResult = await synthesizeWithCircuitBreaker(this.config.ttsBreaker, {
      ttsUrl: this.config.ttsUrl,
      text: summary.text,
      voice: this.config.voice,
    });
    const ttsMs = now() - ttsStart;

    const result: Omit<TaskSpeakResult, 'cached'> = {
      text: summary.text,
      audioBase64: ttsResult.audioBase64,
      mimeType: 'audio/wav',
      durationMs: ttsResult.durationMs,
      usedFallback: summary.usedFallback,
      llmMs,
      ttsMs,
    };
    this.insert(cacheKey, result);
    return result;
  }

  private insert(cacheKey: string, result: Omit<TaskSpeakResult, 'cached'>): void {
    const bytes = Buffer.byteLength(result.audioBase64, 'utf8') + Buffer.byteLength(result.text, 'utf8');
    if (bytes > this.maxBytes) return;
    this.entries.set(cacheKey, { bytes, result });
    this.currentBytes += bytes;
    while ((this.entries.size > this.maxEntries || this.currentBytes > this.maxBytes) && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      if (!oldest) break;
      this.entries.delete(oldestKey);
      this.currentBytes -= oldest.bytes;
    }
    if (this.currentBytes < 0) this.currentBytes = 0;
  }
}
