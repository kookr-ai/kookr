import { useSyncExternalStore } from 'react';

export type AudioAlertSource = 'finding' | 'task_completion' | 'completion_signal' | 'manual_test' | 'finding_speak';

/**
 * Mirror of `SpeakStatus` from useSpeakAgent. Inlined to keep this module
 * free of hook-layer imports (the hook imports from here).
 */
export type SpeakStatus = 'idle' | 'generating' | 'playing' | 'suppressed' | 'error';

export type AudioAlertOutcome =
  | 'scheduled'
  | 'suppressed_muted'
  | 'suppressed_dnd'
  | 'suppressed_debounced'
  | 'audio_context_unavailable'
  | 'audio_context_error'
  | 'audio_context_suspended';

export type AudioAlertPrimaryCause =
  | 'first_candidate'
  | 'highest_severity'
  | 'task_completion'
  | 'completion_signal'
  | 'manual_test';

export type SoundStateSource = 'localStorage' | 'default' | 'memory_fallback';

export interface AudioAlertContext {
  source: AudioAlertSource;
  reason: string;
  agentId?: string;
  taskId?: string;
  taskName?: string;
  anomalyType?: string;
  severity?: 'info' | 'warning' | 'critical';
  detectedAt?: string;
  dedupeKey?: string;
  previousStatus?: string;
  nextStatus?: string;
  selectedAgentId?: string | null;
  focused?: boolean;
  evaluationId?: string;
  candidateCount?: number;
  completionSignalId?: string;
  primaryCause?: AudioAlertPrimaryCause;
  activeFindingsCount?: number;
}

export interface LocalAudioAlertDecision extends AudioAlertContext {
  id: string;
  timestamp: string;
  outcome: AudioAlertOutcome;
  soundEnabled: boolean;
  soundStateSource: SoundStateSource;
  soundStorageAvailable: boolean;
  dndEnabled: boolean;
  dndExpiresAt?: number | null;
  pageVisibility: DocumentVisibilityState;
  documentHasFocus: boolean;
  clientSessionId: string;
  clientTabId: string;
  appBuildSha?: string;
  audioContextInitialState?: AudioContextState;
  audioContextFinalState?: AudioContextState;
  resumeAttempted?: boolean;
  resumeFailed?: boolean;
  /** Speak-hook phase at which the in-flight operation was aborted (user cancel, client timeout). */
  abortedAtPhase?: SpeakStatus;
  repeatCount?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface AudioAlertSnapshot {
  entries: LocalAudioAlertDecision[];
  lastDecision: LocalAudioAlertDecision | null;
  countsByOutcome: Partial<Record<AudioAlertOutcome, number>>;
}

export interface RedactedAudioAlertDecision {
  id: string;
  timestamp: string;
  source: AudioAlertSource;
  outcome: AudioAlertOutcome;
  reasonCode: string;
  anomalyType?: string;
  severity?: 'info' | 'warning' | 'critical';
  candidateCount?: number;
  completionSignalId?: string;
  primaryCause?: AudioAlertPrimaryCause;
  soundEnabled: boolean;
  soundStateSource: SoundStateSource;
  soundStorageAvailable: boolean;
  dndEnabled: boolean;
  dndExpiresAt?: number | null;
  pageVisibility: DocumentVisibilityState;
  documentHasFocus: boolean;
  clientSessionId: string;
  clientTabId: string;
  appBuildSha?: string;
  audioContextInitialState?: AudioContextState;
  audioContextFinalState?: AudioContextState;
  resumeAttempted?: boolean;
  resumeFailed?: boolean;
  repeatCount?: number;
}

const DEFAULT_CAPACITY = 100;
const TAB_ID_KEY = 'kookr-audio-tab-id';

let entries: LocalAudioAlertDecision[] = [];
let snapshotCache = new Map<number, AudioAlertSnapshot>();
const listeners = new Set<() => void>();
const clientSessionId = createId('session');
let fallbackClientTabId: string | null = null;

function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function safeSessionStorage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

export function getClientAudioIdentity(): { clientSessionId: string; clientTabId: string } {
  const storage = safeSessionStorage();
  if (!storage) {
    fallbackClientTabId ??= createId('tab');
    return { clientSessionId, clientTabId: fallbackClientTabId };
  }

  try {
    const existing = storage.getItem(TAB_ID_KEY);
    if (existing) return { clientSessionId, clientTabId: existing };
    const next = createId('tab');
    storage.setItem(TAB_ID_KEY, next);
    return { clientSessionId, clientTabId: next };
  } catch {
    fallbackClientTabId ??= createId('tab');
    return { clientSessionId, clientTabId: fallbackClientTabId };
  }
}

function isSuppressedOutcome(outcome: AudioAlertOutcome): boolean {
  return outcome === 'suppressed_muted' || outcome === 'suppressed_dnd' || outcome === 'suppressed_debounced';
}

function coalesceKey(decision: LocalAudioAlertDecision): string {
  return [
    decision.source,
    decision.outcome,
    decision.reason,
    decision.agentId ?? '',
    decision.taskId ?? '',
    decision.anomalyType ?? '',
    decision.severity ?? '',
    decision.dedupeKey ?? '',
    decision.completionSignalId ?? '',
    decision.soundEnabled,
    decision.dndEnabled,
    decision.dndExpiresAt ?? '',
  ].join('\u001f');
}

function notify(): void {
  snapshotCache = new Map();
  for (const listener of listeners) listener();
}

function countByOutcome(source: readonly LocalAudioAlertDecision[]): Partial<Record<AudioAlertOutcome, number>> {
  const counts: Partial<Record<AudioAlertOutcome, number>> = {};
  for (const entry of source) {
    counts[entry.outcome] = (counts[entry.outcome] ?? 0) + (entry.repeatCount ?? 1);
  }
  return counts;
}

export function recordAudioAlertDecision(decision: LocalAudioAlertDecision): boolean {
  const last = entries[0];
  if (
    last &&
    isSuppressedOutcome(last.outcome) &&
    isSuppressedOutcome(decision.outcome) &&
    coalesceKey(last) === coalesceKey(decision)
  ) {
    entries = [
      {
        ...last,
        repeatCount: (last.repeatCount ?? 1) + 1,
        firstSeenAt: last.firstSeenAt ?? last.timestamp,
        lastSeenAt: decision.timestamp,
      },
      ...entries.slice(1),
    ];
    notify();
    return false;
  }

  entries = [decision, ...entries].slice(0, DEFAULT_CAPACITY);
  notify();
  return true;
}

export function updateAudioAlertDecision(
  id: string,
  patch: Partial<LocalAudioAlertDecision>,
): LocalAudioAlertDecision | null {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  const updated = {
    ...entries[index],
    ...patch,
  };
  entries = entries.map((entry, entryIndex) => entryIndex === index ? updated : entry);
  notify();
  return updated;
}

export function getAudioAlertSnapshot(limit = DEFAULT_CAPACITY): AudioAlertSnapshot {
  const cached = snapshotCache.get(limit);
  if (cached) return cached;
  const capped = entries.slice(0, limit);
  const snapshot = {
    entries: capped,
    lastDecision: entries[0] ?? null,
    countsByOutcome: countByOutcome(capped),
  };
  snapshotCache.set(limit, snapshot);
  return snapshot;
}

export function subscribeAudioAlertLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAudioAlertLog(limit = DEFAULT_CAPACITY): AudioAlertSnapshot {
  return useSyncExternalStore(
    subscribeAudioAlertLog,
    () => getAudioAlertSnapshot(limit),
    () => getAudioAlertSnapshot(limit),
  );
}

export function redactAudioAlertDecision(decision: LocalAudioAlertDecision): RedactedAudioAlertDecision {
  const reasonCode = (() => {
    if (decision.outcome === 'audio_context_error') return decision.reason;
    if (decision.source === 'finding') return decision.anomalyType ?? 'finding';
    if (decision.source === 'finding_speak') return decision.anomalyType ?? 'finding_speak';
    if (decision.source === 'completion_signal') return 'completion_signal';
    if (decision.source === 'task_completion') return 'task_completion';
    if (decision.source === 'manual_test') return 'manual_test';
    return decision.outcome;
  })();

  return {
    id: decision.id,
    timestamp: decision.timestamp,
    source: decision.source,
    outcome: decision.outcome,
    reasonCode,
    anomalyType: decision.anomalyType,
    severity: decision.severity,
    candidateCount: decision.candidateCount,
    completionSignalId: decision.completionSignalId,
    primaryCause: decision.primaryCause,
    soundEnabled: decision.soundEnabled,
    soundStateSource: decision.soundStateSource,
    soundStorageAvailable: decision.soundStorageAvailable,
    dndEnabled: decision.dndEnabled,
    dndExpiresAt: decision.dndExpiresAt,
    pageVisibility: decision.pageVisibility,
    documentHasFocus: decision.documentHasFocus,
    clientSessionId: decision.clientSessionId,
    clientTabId: decision.clientTabId,
    appBuildSha: decision.appBuildSha,
    audioContextInitialState: decision.audioContextInitialState,
    audioContextFinalState: decision.audioContextFinalState,
    resumeAttempted: decision.resumeAttempted,
    resumeFailed: decision.resumeFailed,
    repeatCount: decision.repeatCount,
  };
}

export function __resetAudioAlertLogForTests(): void {
  entries = [];
  snapshotCache = new Map();
  fallbackClientTabId = null;
  notify();
}
