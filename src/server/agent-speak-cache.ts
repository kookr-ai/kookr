import { createHash } from 'node:crypto';
import type { LlmClient } from '../core/llm-client.js';
import { summarizeAgent, type SummarizeAgentResult } from '../core/agent-speak-summary.js';
import { synthesize, TTSClientError } from '../adapters/tts-client.js';
import type {
  AgentSpeakContext,
  AgentSpeakResultCore,
  SpeakAgentFallbackReason,
  SpeakMode,
  VerbosityScale,
} from '../shared/contracts/speech.js';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Non-printable byte used as a field separator inside the cache-key hash.
 * Must NOT be the empty string — `hash.update('')` is a no-op for SHA-1
 * and would allow distinct field tuples like {a:"ab", b:"cd"} vs
 * {a:"abc", b:"d"} to collide on the same hash.
 */
const CACHE_KEY_FIELD_SEPARATOR = String.fromCharCode(0x1f);

const VERBOSITIES: readonly VerbosityScale[] = ['terse', 'brief', 'medium', 'detailed'];
const MODES: readonly SpeakMode[] = ['finding', 'activity'];

export interface AgentSpeakCacheKeyInput {
  agentId: string;
  /** The resolved mode, never the literal `'auto'`. */
  resolvedMode: SpeakMode;
  verbosity: VerbosityScale;
  /** `0` for synthetic / empty event windows; see {@link AgentState.lastEventSeq}. */
  lastEventSeq: number;
  /** Date | string | number — coerced to ISO string. Null/undefined collapses to `'∅'`. */
  anomalyDetectedAt: Date | string | number | null | undefined;
}

export interface AgentSpeakCacheConfig {
  llmClient: LlmClient | null;
  ttsUrl: string;
  voice: string;
  maxBytes?: number;
  /** Test seam. */
  now?: () => number;
}

export interface AgentSpeakCacheVerbosityModeStats {
  hits: number;
  misses: number;
}

export type AgentSpeakCacheVerbosityStats = Record<SpeakMode, AgentSpeakCacheVerbosityModeStats>;

export interface AgentSpeakCacheStats {
  size: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
  insertionSkipped: number;
  inflight: number;
  singleflightJoins: number;
  byVerbosityByMode: Record<VerbosityScale, AgentSpeakCacheVerbosityStats>;
}

export interface CachedAgentSpeakEntry extends AgentSpeakResultCore {
  cacheKey: string;
  cachedAt: string;
  context: AgentSpeakContext;
  resolvedMode: SpeakMode;
  verbosity: VerbosityScale;
}

interface InternalCachedEntry {
  cacheKey: string;
  bytes: number;
  cachedAt: string;
  resolvedMode: SpeakMode;
  verbosity: VerbosityScale;
  context: AgentSpeakContext;
  result: AgentSpeakResultCore;
}

function coerceAnomalyDetectedAt(value: Date | string | number | null | undefined): string {
  if (!value) return '∅';
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : '__invalid_date__';
  }
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return '∅';
}

export function computeCacheKey(input: AgentSpeakCacheKeyInput): string {
  const hash = createHash('sha1');
  hash.update(input.agentId);
  hash.update(CACHE_KEY_FIELD_SEPARATOR);
  hash.update(input.resolvedMode);
  hash.update(CACHE_KEY_FIELD_SEPARATOR);
  hash.update(input.verbosity);
  hash.update(CACHE_KEY_FIELD_SEPARATOR);
  hash.update(String(input.lastEventSeq));
  hash.update(CACHE_KEY_FIELD_SEPARATOR);
  hash.update(coerceAnomalyDetectedAt(input.anomalyDetectedAt));
  return hash.digest('hex');
}

function emptyVerbosityStats(): AgentSpeakCacheVerbosityStats {
  return { finding: { hits: 0, misses: 0 }, activity: { hits: 0, misses: 0 } };
}

function emptyByVerbosityByMode(): Record<VerbosityScale, AgentSpeakCacheVerbosityStats> {
  return {
    terse: emptyVerbosityStats(),
    brief: emptyVerbosityStats(),
    medium: emptyVerbosityStats(),
    detailed: emptyVerbosityStats(),
  };
}

/**
 * Single-flighted, byte-capped FIFO cache for agent-speak results. Replaces
 * the legacy `FindingSummaryCache`. Stores the {@link AgentSpeakContext} that
 * produced each entry so the preview endpoint can answer "what did the LLM
 * see for this cached recap?" for an already-evicted-from-memory agent.
 *
 * Eviction trigger is the 32 MB byte cap only — the count cap from the v1
 * cache is dropped (RFC §Cache key revision) because with four verbosity
 * rungs the two caps can fight each other.
 */
export class AgentSpeakCache {
  private readonly entries = new Map<string, InternalCachedEntry>();
  private readonly inflight = new Map<string, Promise<{ entry: InternalCachedEntry }>>();
  private readonly maxBytes: number;
  private currentBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private insertionSkipped = 0;
  private singleflightJoins = 0;
  private readonly byVerbosityByMode = emptyByVerbosityByMode();

  constructor(private readonly config: AgentSpeakCacheConfig) {
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  getStats(): AgentSpeakCacheStats {
    return {
      size: this.entries.size,
      bytes: this.currentBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      insertionSkipped: this.insertionSkipped,
      inflight: this.inflight.size,
      singleflightJoins: this.singleflightJoins,
      byVerbosityByMode: cloneByVerbosityByMode(this.byVerbosityByMode),
    };
  }

  /**
   * Operator-facing listing of the N most recently inserted entries with the
   * `text` field truncated to a short prefix and `audioBase64` omitted. Used
   * by `/api/diagnostics/speak-cache`; gated behind `KOOKR_DEBUG=true` at the
   * route layer.
   */
  listRedactedEntries(limit = 50): Array<{
    cacheKey: string;
    cachedAt: string;
    resolvedMode: SpeakMode;
    verbosity: VerbosityScale;
    usedFallback: boolean;
    fallbackReason: SpeakAgentFallbackReason | null;
    recapPrefix: string;
  }> {
    const out: Array<{
      cacheKey: string;
      cachedAt: string;
      resolvedMode: SpeakMode;
      verbosity: VerbosityScale;
      usedFallback: boolean;
      fallbackReason: SpeakAgentFallbackReason | null;
      recapPrefix: string;
    }> = [];
    const keys = Array.from(this.entries.keys());
    const start = Math.max(0, keys.length - limit);
    for (let i = keys.length - 1; i >= start; i -= 1) {
      const cacheKey = keys[i];
      const entry = this.entries.get(cacheKey);
      if (!entry) continue;
      out.push({
        cacheKey,
        cachedAt: entry.cachedAt,
        resolvedMode: entry.resolvedMode,
        verbosity: entry.verbosity,
        usedFallback: entry.result.usedFallback,
        fallbackReason: entry.result.fallbackReason,
        recapPrefix: entry.result.text.slice(0, 80),
      });
    }
    return out;
  }

  getCachedEntry(cacheKey: string): CachedAgentSpeakEntry | null {
    const cached = this.entries.get(cacheKey);
    if (!cached) return null;
    return {
      ...cached.result,
      cacheKey,
      cachedAt: cached.cachedAt,
      context: cached.context,
      resolvedMode: cached.resolvedMode,
      verbosity: cached.verbosity,
    };
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
    this.currentBytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.insertionSkipped = 0;
    this.singleflightJoins = 0;
    for (const v of VERBOSITIES) {
      for (const m of MODES) {
        this.byVerbosityByMode[v][m] = { hits: 0, misses: 0 };
      }
    }
  }

  async get(
    keyInput: AgentSpeakCacheKeyInput,
    context: AgentSpeakContext,
    signal?: AbortSignal,
  ): Promise<{ cacheKey: string; cachedAt: string; cached: boolean; result: AgentSpeakResultCore }> {
    const cacheKey = computeCacheKey(keyInput);
    const cached = this.entries.get(cacheKey);
    if (cached) {
      this.hits += 1;
      this.byVerbosityByMode[keyInput.verbosity][keyInput.resolvedMode].hits += 1;
      return {
        cacheKey,
        cachedAt: cached.cachedAt,
        cached: true,
        result: { ...cached.result, llmMs: 0, ttsMs: 0 },
      };
    }

    const existing = this.inflight.get(cacheKey);
    if (existing) {
      this.hits += 1;
      this.singleflightJoins += 1;
      this.byVerbosityByMode[keyInput.verbosity][keyInput.resolvedMode].hits += 1;
      const { entry } = await existing;
      return {
        cacheKey,
        cachedAt: entry.cachedAt,
        cached: true,
        result: { ...entry.result, llmMs: 0, ttsMs: 0 },
      };
    }

    this.misses += 1;
    this.byVerbosityByMode[keyInput.verbosity][keyInput.resolvedMode].misses += 1;
    const work = this.fetchFresh(cacheKey, keyInput, context, signal);
    this.inflight.set(cacheKey, work);
    try {
      const { entry } = await work;
      return {
        cacheKey,
        cachedAt: entry.cachedAt,
        cached: false,
        result: entry.result,
      };
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  private async fetchFresh(
    cacheKey: string,
    keyInput: AgentSpeakCacheKeyInput,
    context: AgentSpeakContext,
    signal?: AbortSignal,
  ): Promise<{ entry: InternalCachedEntry }> {
    const nowFn = this.config.now ?? Date.now;
    const llmStart = nowFn();
    const summary: SummarizeAgentResult = await summarizeAgent(
      this.config.llmClient,
      context,
      keyInput.verbosity,
      keyInput.resolvedMode,
      signal,
    );
    const llmMs = nowFn() - llmStart;

    if (signal?.aborted) {
      throw new TTSClientError('network', 'request aborted before TTS');
    }

    const ttsStart = nowFn();
    const ttsResult = await synthesize({
      ttsUrl: this.config.ttsUrl,
      text: summary.text,
      voice: this.config.voice,
      signal,
    });
    const ttsMs = nowFn() - ttsStart;

    const result: AgentSpeakResultCore = {
      text: summary.text,
      audioBase64: ttsResult.audioBase64,
      mimeType: 'audio/wav',
      durationMs: ttsResult.durationMs,
      usedFallback: summary.usedFallback,
      fallbackReason: summary.usedFallback ? (summary.fallbackReason as SpeakAgentFallbackReason) : null,
      llmMs,
      ttsMs,
    };
    const entry = this.insert(cacheKey, keyInput, context, result);
    return { entry };
  }

  private insert(
    cacheKey: string,
    keyInput: AgentSpeakCacheKeyInput,
    context: AgentSpeakContext,
    result: AgentSpeakResultCore,
  ): InternalCachedEntry {
    const bytes = Buffer.byteLength(result.audioBase64, 'utf8') + Buffer.byteLength(result.text, 'utf8');
    const cachedAt = new Date((this.config.now ?? Date.now)()).toISOString();
    const entry: InternalCachedEntry = {
      cacheKey,
      bytes,
      cachedAt,
      resolvedMode: keyInput.resolvedMode,
      verbosity: keyInput.verbosity,
      context,
      result,
    };
    // A single entry that already exceeds the byte cap would, if inserted,
    // be immediately evicted by evictUntilWithinCap — wasting an eviction
    // slot every call. Track via insertionSkipped so an operator sees pressure.
    if (bytes > this.maxBytes) {
      this.insertionSkipped += 1;
      return entry;
    }
    this.entries.set(cacheKey, entry);
    this.currentBytes += bytes;
    this.evictUntilWithinCap();
    return entry;
  }

  private evictUntilWithinCap(): void {
    while (this.currentBytes > this.maxBytes && this.entries.size > 0) {
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

function cloneByVerbosityByMode(
  src: Record<VerbosityScale, AgentSpeakCacheVerbosityStats>,
): Record<VerbosityScale, AgentSpeakCacheVerbosityStats> {
  const out = emptyByVerbosityByMode();
  for (const v of VERBOSITIES) {
    for (const m of MODES) {
      out[v][m] = { ...src[v][m] };
    }
  }
  return out;
}
