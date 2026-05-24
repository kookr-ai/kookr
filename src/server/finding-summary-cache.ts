import { createHash } from 'node:crypto';
import type { LlmClient } from '../core/llm-client.js';
import { summarizeFinding, type FindingSummaryInput } from '../core/finding-summary.js';
import { synthesize, TTSClientError } from '../adapters/tts-client.js';

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export interface FindingSpeakResult {
  text: string;
  audioBase64: string;
  mimeType: 'audio/wav';
  durationMs: number;
  usedFallback: boolean;
  llmMs: number;
  ttsMs: number;
  cached: boolean;
}

export interface FindingSpeakRequestKey {
  agentId: string;
  anomalyType: string;
  severity: string;
  explanation: string;
  /** Coerced to ISO string in the cache layer — accept Date | string | number for defensive serialization paths. */
  detectedAt: Date | string | number | null | undefined;
  taskName: string | null | undefined;
  /** Discriminator used when detectedAt is falsy. Use `agent.lastEventSeq` or similar. */
  freshness: string | number;
}

export interface FindingSummaryCacheConfig {
  llmClient: LlmClient | null;
  ttsUrl: string;
  voice: string;
  maxEntries?: number;
  maxBytes?: number;
  /** Test seam. */
  now?: () => number;
}

export interface FindingSummaryCacheStats {
  size: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
  inflight: number;
}

interface CachedEntry {
  key: string;
  bytes: number;
  result: Omit<FindingSpeakResult, 'cached'>;
}

function coerceDetectedAt(value: Date | string | number | null | undefined): string {
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) return value.toISOString();
    return '__invalid_date__';
  }
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return '__missing__';
}

/**
 * Non-printable byte used as a field separator inside the cache-key hash.
 * Must NOT be the empty string — `hash.update('')` is a no-op for SHA-1
 * and would allow distinct field tuples like {a:"ab", b:"cd"} vs
 * {a:"abc", b:"d"} to collide on the same hash.
 */
const CACHE_KEY_FIELD_SEPARATOR = String.fromCharCode(0x1f); // ASCII US

export function computeCacheKey(key: FindingSpeakRequestKey): string {
  const hash = createHash('sha1');
  hash.update(key.agentId);
  hash.update(CACHE_KEY_FIELD_SEPARATOR);
  hash.update(key.anomalyType);
  hash.update(CACHE_KEY_FIELD_SEPARATOR);
  hash.update(key.severity);
  hash.update(CACHE_KEY_FIELD_SEPARATOR);
  hash.update(key.explanation ?? '');
  hash.update(CACHE_KEY_FIELD_SEPARATOR);
  hash.update(coerceDetectedAt(key.detectedAt));
  hash.update(CACHE_KEY_FIELD_SEPARATOR);
  hash.update((key.taskName ?? '').trim());
  hash.update(CACHE_KEY_FIELD_SEPARATOR);
  hash.update(String(key.freshness));
  return hash.digest('hex');
}

/**
 * In-memory FIFO cache for finding speak results, with per-key singleflight so
 * concurrent dashboards do not stampede the LLM + TTS pipeline for the same
 * finding. Insertion-order Map iteration gives us FIFO eviction; we also cap
 * total bytes (audioBase64 is the dominant size) and evict oldest entries
 * until under both caps.
 */
export class FindingSummaryCache {
  private readonly entries = new Map<string, CachedEntry>();
  private readonly inflight = new Map<string, Promise<Omit<FindingSpeakResult, 'cached'>>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private currentBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly config: FindingSummaryCacheConfig) {
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  getStats(): FindingSummaryCacheStats {
    return {
      size: this.entries.size,
      bytes: this.currentBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      inflight: this.inflight.size,
    };
  }

  async get(
    requestKey: FindingSpeakRequestKey,
    summaryInput: FindingSummaryInput,
    signal?: AbortSignal,
  ): Promise<FindingSpeakResult> {
    const cacheKey = computeCacheKey(requestKey);
    const cached = this.entries.get(cacheKey);
    if (cached) {
      this.hits += 1;
      return { ...cached.result, cached: true, llmMs: 0, ttsMs: 0 };
    }

    const inflight = this.inflight.get(cacheKey);
    if (inflight) {
      this.hits += 1;
      const shared = await inflight;
      return { ...shared, cached: true, llmMs: 0, ttsMs: 0 };
    }

    this.misses += 1;
    const work = this.fetchFresh(cacheKey, summaryInput, signal);
    this.inflight.set(cacheKey, work);
    try {
      const result = await work;
      return { ...result, cached: false };
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  /** Reset everything. Used by `KOOKR_SPEAK=false` flips and tests. */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
    this.currentBytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  private async fetchFresh(
    cacheKey: string,
    summaryInput: FindingSummaryInput,
    signal?: AbortSignal,
  ): Promise<Omit<FindingSpeakResult, 'cached'>> {
    const llmStart = (this.config.now ?? Date.now)();
    const summary = await summarizeFinding(this.config.llmClient, summaryInput);
    const llmMs = (this.config.now ?? Date.now)() - llmStart;

    if (signal?.aborted) throw new TTSClientError('network', 'request aborted before TTS');

    const ttsStart = (this.config.now ?? Date.now)();
    const ttsResult = await synthesize({
      ttsUrl: this.config.ttsUrl,
      text: summary.text,
      voice: this.config.voice,
      signal,
    });
    const ttsMs = (this.config.now ?? Date.now)() - ttsStart;

    const result: Omit<FindingSpeakResult, 'cached'> = {
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

  private insert(cacheKey: string, result: Omit<FindingSpeakResult, 'cached'>): void {
    const bytes = Buffer.byteLength(result.audioBase64, 'utf8') + Buffer.byteLength(result.text, 'utf8');
    // A single entry that already exceeds the byte cap would, if inserted,
    // be immediately evicted by evictUntilWithinCaps — wasting an eviction
    // slot every call and leaving the next request to re-pay the LLM+TTS
    // cost. Skip insertion instead so the caller's `result` is still returned
    // but the cache remains stable.
    if (bytes > this.maxBytes) return;
    const entry: CachedEntry = { key: cacheKey, bytes, result };
    this.entries.set(cacheKey, entry);
    this.currentBytes += bytes;
    this.evictUntilWithinCaps();
  }

  private evictUntilWithinCaps(): void {
    while (
      (this.entries.size > this.maxEntries || this.currentBytes > this.maxBytes) &&
      this.entries.size > 0
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      if (!oldest) break;
      this.entries.delete(oldestKey);
      this.currentBytes -= oldest.bytes;
      this.evictions += 1;
    }
    if (this.currentBytes < 0) this.currentBytes = 0;
  }
}
