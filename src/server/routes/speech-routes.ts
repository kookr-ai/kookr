import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { RouteDeps } from './shared.js';
import { AgentSpeakCache } from '../agent-speak-cache.js';
import { TaskSpeechSummaryCache } from '../task-speech-summary-cache.js';
import { getSnapshotAgentsRaw } from '../use-cases/get-snapshot.js';
import { buildTaskSpeechSubject } from '../use-cases/task-speech-summary-input.js';
import { TTSClientError } from '../../adapters/tts-client.js';
import { buildAgentSpeakContext } from '../../core/agent-speak-context.js';
import {
  buildSystemPrompt,
  buildFallbackText,
  resolveSpeakMode,
} from '../../core/agent-speak-summary.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import type {
  AgentSpeakContext,
  AgentSpeakResultCore,
  SpeakAgentErrorResponse,
  SpeakAgentResponse,
  SpeakAgentRequest,
  SpeakAgentFallbackReason,
  SpeakMode,
  SpeakModeRequest,
  SpeakTaskSummaryResponse,
  VerbosityScale,
} from '../../shared/contracts/speech.js';

const VERBOSITY_VALUES: readonly VerbosityScale[] = ['terse', 'brief', 'medium', 'detailed'];
const MODE_REQUEST_VALUES: readonly SpeakModeRequest[] = ['auto', 'finding', 'activity'];
const DEFAULT_VERBOSITY: VerbosityScale = 'medium';

const VERBOSITY_TTS_WARN_MS: Record<VerbosityScale, number> = {
  terse: 600,
  brief: 1000,
  medium: 1800,
  detailed: 3000,
};

export interface SpeechRouteOptions {
  /** Surgical kill-switch independent of KOOKR_TTS. */
  enabled: boolean;
  /** Bound when ttsUrl is set; null otherwise. */
  cache: AgentSpeakCache | null;
  /** Bound when ttsUrl is set; null otherwise. */
  taskCache?: TaskSpeechSummaryCache | null;
  /** Same value the server passes to other consumers. */
  ttsUrl?: string;
  /** Voice argument echoed in `/api/diagnostics`. */
  ttsVoice?: string;
  /** Read at request time; defaults to `'medium'` when settings is absent. */
  defaultVerbosity?: () => VerbosityScale;
  /** Test seam; production uses `randomUUID()`. */
  newRequestId?: () => string;
  /** KOOKR_DEBUG gate for the preview / debug endpoints. Default reads `process.env.KOOKR_DEBUG`. */
  isDebugEnabled?: () => boolean;
}

function jsonAgentError(c: Context, status: 400 | 404 | 503 | 500, body: SpeakAgentErrorResponse) {
  return c.json(body, status);
}

function isDebugDefault(): boolean {
  const raw = process.env.KOOKR_DEBUG?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function clampVerbosity(value: unknown, fallback: VerbosityScale): VerbosityScale {
  if (typeof value === 'string' && (VERBOSITY_VALUES as readonly string[]).includes(value)) {
    return value as VerbosityScale;
  }
  return fallback;
}

function parseModeRequest(value: unknown): SpeakModeRequest {
  if (typeof value === 'string' && (MODE_REQUEST_VALUES as readonly string[]).includes(value)) {
    return value as SpeakModeRequest;
  }
  return 'auto';
}

async function parseSpeakAgentBody(c: Context): Promise<SpeakAgentRequest> {
  try {
    const text = await c.req.text();
    if (!text) return {};
    const json: unknown = JSON.parse(text);
    if (!json || typeof json !== 'object') return {};
    const obj = json as Record<string, unknown>;
    const out: SpeakAgentRequest = {};
    if ('verbosity' in obj) {
      const v = obj.verbosity;
      if (typeof v === 'string' && (VERBOSITY_VALUES as readonly string[]).includes(v)) {
        out.verbosity = v as VerbosityScale;
      }
    }
    if ('mode' in obj) {
      const m = obj.mode;
      if (typeof m === 'string' && (MODE_REQUEST_VALUES as readonly string[]).includes(m)) {
        out.mode = m as SpeakModeRequest;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function findAgent(deps: RouteDeps, agentId: string): AgentState | undefined {
  return getSnapshotAgentsRaw({ monitor: deps.monitor }).find((candidate) => candidate.agentId === agentId);
}

function ttsWarnExceeded(rung: VerbosityScale, ttsMs: number): boolean {
  return ttsMs > VERBOSITY_TTS_WARN_MS[rung];
}

function logAgentSpeak(payload: {
  requestId: string;
  agentId: string;
  mode: SpeakMode;
  verbosity: VerbosityScale;
  llmMs: number;
  ttsMs: number;
  cached: boolean;
  usedFallback: boolean;
  fallbackReason: SpeakAgentFallbackReason | null;
  outputChars: number;
  outputWords: number;
  lastEventSeq: number;
  abortedAtPhase: 'request' | 'llm' | 'tts' | null;
  outcome: 'success' | 'fallback' | 'aborted' | 'tts-error' | 'feature-disabled' | 'tts-not-configured' | 'agent-not-found';
}): void {
  const warn = payload.usedFallback || ttsWarnExceeded(payload.verbosity, payload.ttsMs);
  const emit = warn ? console.warn : console.log;
  emit(`[agent-speak] ${JSON.stringify(payload)}`);
}

function buildResponse(
  cacheKey: string,
  cached: boolean,
  resolvedMode: SpeakMode,
  verbosity: VerbosityScale,
  requestId: string,
  result: AgentSpeakResultCore,
): SpeakAgentResponse {
  return {
    text: result.text,
    audioBase64: result.audioBase64,
    mimeType: 'audio/wav',
    durationMs: result.durationMs,
    usedFallback: result.usedFallback,
    fallbackReason: result.fallbackReason,
    llmMs: result.llmMs,
    ttsMs: result.ttsMs,
    cached,
    resolvedMode,
    effectiveVerbosity: verbosity,
    requestId,
    cacheKey,
  };
}

function countOutputWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function registerSpeechRoutes(app: Hono, deps: RouteDeps, options: SpeechRouteOptions): void {
  const newRequestId = options.newRequestId ?? (() => randomUUID());
  const isDebugEnabled = options.isDebugEnabled ?? isDebugDefault;
  const readDefaultVerbosity = options.defaultVerbosity ?? ((): VerbosityScale => {
    const fromSettings = deps.settings?.get?.()?.speakVerbosity;
    return clampVerbosity(fromSettings, DEFAULT_VERBOSITY);
  });

  async function handleSpeakAgent(c: Context): Promise<Response> {
    const requestId = newRequestId();
    const agentId = c.req.param('agentId') ?? '';

    if (!options.enabled) {
      logAgentSpeak({
        requestId, agentId, mode: 'activity', verbosity: DEFAULT_VERBOSITY,
        llmMs: 0, ttsMs: 0, cached: false, usedFallback: false, fallbackReason: null,
        outputChars: 0, outputWords: 0, lastEventSeq: 0, abortedAtPhase: null,
        outcome: 'feature-disabled',
      });
      return jsonAgentError(c, 503, { error: 'feature-disabled', requestId });
    }
    if (!options.cache || !options.ttsUrl) {
      logAgentSpeak({
        requestId, agentId, mode: 'activity', verbosity: DEFAULT_VERBOSITY,
        llmMs: 0, ttsMs: 0, cached: false, usedFallback: false, fallbackReason: null,
        outputChars: 0, outputWords: 0, lastEventSeq: 0, abortedAtPhase: null,
        outcome: 'tts-not-configured',
      });
      return jsonAgentError(c, 503, { error: 'tts-not-configured', requestId });
    }

    const agent = findAgent(deps, agentId);
    if (!agent) {
      logAgentSpeak({
        requestId, agentId, mode: 'activity', verbosity: DEFAULT_VERBOSITY,
        llmMs: 0, ttsMs: 0, cached: false, usedFallback: false, fallbackReason: null,
        outputChars: 0, outputWords: 0, lastEventSeq: 0, abortedAtPhase: null,
        outcome: 'agent-not-found',
      });
      return jsonAgentError(c, 404, { error: 'agent-not-found', requestId });
    }

    const body = await parseSpeakAgentBody(c);
    const verbosity = clampVerbosity(body.verbosity, readDefaultVerbosity());
    const requestedMode = body.mode ?? 'auto';
    const resolvedMode = resolveSpeakMode(agent, requestedMode);
    const lastEventSeq = agent.lastEventSeq ?? 0;

    const context = buildAgentSpeakContext(agent);
    const requestSignal = c.req.raw.signal;

    try {
      const { cacheKey, cached, result } = await options.cache.get(
        {
          agentId: agent.agentId,
          resolvedMode,
          verbosity,
          lastEventSeq,
          anomalyDetectedAt: agent.anomaly?.detectedAt ?? null,
        },
        context,
        requestSignal,
      );

      logAgentSpeak({
        requestId,
        agentId: agent.agentId,
        mode: resolvedMode,
        verbosity,
        llmMs: result.llmMs,
        ttsMs: result.ttsMs,
        cached,
        usedFallback: result.usedFallback,
        fallbackReason: result.fallbackReason,
        outputChars: result.text.length,
        outputWords: countOutputWords(result.text),
        lastEventSeq,
        abortedAtPhase: null,
        outcome: result.usedFallback ? 'fallback' : 'success',
      });

      const response = buildResponse(cacheKey, cached, resolvedMode, verbosity, requestId, result);
      return c.json(response, 200);
    } catch (err) {
      if (requestSignal.aborted) {
        logAgentSpeak({
          requestId, agentId: agent.agentId, mode: resolvedMode, verbosity,
          llmMs: 0, ttsMs: 0, cached: false, usedFallback: false, fallbackReason: null,
          outputChars: 0, outputWords: 0, lastEventSeq,
          abortedAtPhase: 'request',
          outcome: 'aborted',
        });
        return jsonAgentError(c, 503, { error: 'aborted', requestId });
      }
      const reason = err instanceof Error ? err.message : String(err);
      const kind = err instanceof TTSClientError ? err.kind : 'unknown';
      logAgentSpeak({
        requestId, agentId: agent.agentId, mode: resolvedMode, verbosity,
        llmMs: 0, ttsMs: 0, cached: false, usedFallback: true, fallbackReason: null,
        outputChars: 0, outputWords: 0, lastEventSeq,
        abortedAtPhase: null,
        outcome: 'tts-error',
      });
      console.warn(`[agent-speak] failed agent=${agent.agentId} kind=${kind} reason=${reason}`);
      return jsonAgentError(c, 500, { error: 'tts-error', reason: reason.slice(0, 200), requestId });
    }
  }

  app.post('/api/agents/:agentId/speak', handleSpeakAgent);

  app.get('/api/agents/:agentId/speak/preview', (c) => {
    if (!isDebugEnabled()) {
      return c.json({ error: 'not-found' }, 404);
    }
    const agentId = c.req.param('agentId') ?? '';
    const agent = findAgent(deps, agentId);
    if (!agent) {
      return c.json({ error: 'agent-not-found' }, 404);
    }
    const verbosity = clampVerbosity(c.req.query('verbosity'), readDefaultVerbosity());
    const modeReq = parseModeRequest(c.req.query('mode'));
    const resolvedMode = resolveSpeakMode(agent, modeReq);
    const path = c.req.query('path') === 'fallback' ? 'fallback' : 'happy';
    const cacheKey = c.req.query('cacheKey');

    if (cacheKey && options.cache) {
      const cached = options.cache.getCachedEntry(cacheKey);
      if (cached) {
        const prompt = path === 'fallback'
          ? buildFallbackText(cached.context, cached.verbosity)
          : buildSystemPrompt(cached.resolvedMode, cached.verbosity);
        return c.json({
          prompt,
          context: cached.context,
          path,
          cached: true,
          cachedAt: cached.cachedAt,
        });
      }
    }

    const context: AgentSpeakContext = buildAgentSpeakContext(agent);
    const prompt = path === 'fallback'
      ? buildFallbackText(context, verbosity)
      : buildSystemPrompt(resolvedMode, verbosity);
    return c.json({
      prompt,
      context,
      path,
      cached: false,
    });
  });

  app.get('/api/diagnostics/speak-cache', (c) => {
    if (!isDebugEnabled()) {
      return c.json({ error: 'not-found' }, 404);
    }
    if (!options.cache) {
      return c.json({ stats: null, entries: [], note: 'cache not configured' });
    }
    return c.json({
      stats: options.cache.getStats(),
      entries: options.cache.listRedactedEntries(),
      featureEnabled: options.enabled,
      ttsConfigured: Boolean(options.ttsUrl),
      voice: options.ttsVoice ?? null,
    });
  });

  app.post('/api/tasks/:taskId/speak-summary', async (c) => {
    if (!options.enabled) {
      return c.json({ error: 'feature-disabled' }, 503);
    }
    if (!options.taskCache || !options.ttsUrl) {
      return c.json({ error: 'tts-not-configured' }, 503);
    }

    const taskId = c.req.param('taskId');
    const collectStart = Date.now();
    const subject = buildTaskSpeechSubject({
      taskId,
      agents: getSnapshotAgentsRaw({ monitor: deps.monitor }),
      task: deps.taskStore.getTask(taskId),
    });
    const collectMs = Date.now() - collectStart;
    if (!subject) {
      return c.json({ error: 'task-not-found' }, 404);
    }

    const requestSignal = c.req.raw.signal;
    try {
      const startedAt = Date.now();
      const result = await options.taskCache.get(subject.input, requestSignal);
      const response: SpeakTaskSummaryResponse = result;
      console.log(
        `[task-speak] task=${taskId} agent=${subject.agentState?.agentId ?? 'none'} status=${subject.input.taskStatus ?? 'unknown'} cached=${result.cached} usedFallback=${result.usedFallback} collectMs=${collectMs} llmMs=${result.llmMs} ttsMs=${result.ttsMs} totalMs=${Date.now() - startedAt + collectMs}`,
      );
      return c.json(response, 200);
    } catch (err) {
      if (requestSignal.aborted) {
        return c.json({ error: 'aborted' }, 503);
      }
      const reason = err instanceof Error ? err.message : String(err);
      const kind = err instanceof TTSClientError ? err.kind : 'unknown';
      console.warn(`[task-speak] failed task=${taskId} kind=${kind} reason=${reason}`);
      return c.json({ error: 'tts-error', reason: reason.slice(0, 200) }, 500);
    }
  });
}
