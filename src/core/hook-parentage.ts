import type { ChildSessionInfo, EventParentage } from './types.js';

/**
 * In-memory ownership view per Kookr terminal session. Mirrors what
 * gets persisted on {@link SessionInfo} — parent is set once on first
 * SessionStart and frozen; later distinct session ids are recorded as
 * children.
 *
 * See rfc-activity-log-reliability §2.
 */
export interface SessionRuntimeIdentity {
  parentSessionId?: string;
  parentTranscriptPath?: string;
  parentSeenAt?: string;
  // Usually keyed by raw child session id. If a provider reuses the parent's
  // session id for subagents, the child is keyed as `transcript:<path>`.
  childSessionIds: Map<string, ChildSessionInfo>;
}

export function createSessionRuntimeIdentity(): SessionRuntimeIdentity {
  return { childSessionIds: new Map() };
}

/**
 * Classify a hook record's parentage relative to the Kookr session's
 * known parent runtime identity. Pure — caller threads identity in.
 *
 * Foreign detection (record belongs to another active Kookr session)
 * is deferred to Phase 3 when the ingestion service holds a cross-session
 * registry. Phase 1 returns `unknown` instead of `foreign` for that case.
 */
export function classifyHookParentage(
  rawSessionId: string | undefined,
  identity: SessionRuntimeIdentity,
  transcriptPath?: string,
): EventParentage {
  if (!rawSessionId) return 'unknown';
  if (!identity.parentSessionId) return 'unknown';
  if (rawSessionId === identity.parentSessionId) {
    // Same session id as the parent: most providers reuse the parent's id for
    // subagents and only diverge by transcript path. Use the same heuristic
    // recordSessionStart uses so subagent UserPromptSubmit / PreToolUse hooks
    // that arrive without a registered SessionStart for their sidechain still
    // get classified as 'child' and gated out of parent activity. Without this,
    // AI-authored subagent prompts (Codex spawn_agent, Claude Code Task) leak
    // into the activity panel as synthetic "You" messages.
    return isChildTranscript(identity, rawSessionId, transcriptPath) ? 'child' : 'parent';
  }
  // A known child id, or a new distinct id that arrives before its own
  // SessionStart — either way classify as `child` so the event is gated out
  // of parent anomaly state. The `childSessionIds.has(...)` check is kept
  // explicit so a future caller adding telemetry on "newly observed" vs
  // "previously recorded" child ids can extend the branch.
  return 'child';
}

/**
 * Mutate {@link identity} for a `session_start` event: claim parent on
 * first sighting, otherwise record as a child. Returns the parentage
 * classification of the event itself.
 *
 * Frozen-after-first-set semantics: once `parentSessionId` is set, it
 * is never overwritten. This is the primary guarantee Phase 1 makes.
 */
export function recordSessionStart(
  identity: SessionRuntimeIdentity,
  rawSessionId: string,
  transcriptPath: string | undefined,
  observedAtIso: string,
): EventParentage {
  if (!identity.parentSessionId) {
    identity.parentSessionId = rawSessionId;
    identity.parentTranscriptPath = transcriptPath;
    identity.parentSeenAt = observedAtIso;
    return 'parent';
  }
  if (rawSessionId === identity.parentSessionId) {
    if (!isChildTranscript(identity, rawSessionId, transcriptPath)) return 'parent';
    const key = childTranscriptKey(transcriptPath);
    if (key && !identity.childSessionIds.has(key)) {
      identity.childSessionIds.set(key, {
        firstSeenAt: observedAtIso,
        transcriptPath,
        reason: 'inherited_settings',
      });
    }
    return 'child';
  }
  if (!identity.childSessionIds.has(rawSessionId)) {
    identity.childSessionIds.set(rawSessionId, {
      firstSeenAt: observedAtIso,
      transcriptPath,
      reason: 'inherited_settings',
    });
  }
  return 'child';
}

function isKnownChildTranscript(identity: SessionRuntimeIdentity, transcriptPath: string | undefined): boolean {
  if (!transcriptPath) return false;
  return identity.childSessionIds.has(childTranscriptKey(transcriptPath));
}

function isChildTranscript(
  identity: SessionRuntimeIdentity,
  rawSessionId: string,
  transcriptPath: string | undefined,
): boolean {
  if (!transcriptPath) return false;
  if (isKnownChildTranscript(identity, transcriptPath)) return true;
  return Boolean(
    identity.parentTranscriptPath
      && transcriptPath !== identity.parentTranscriptPath
      && transcriptBelongsToSession(identity.parentTranscriptPath, rawSessionId)
      && !transcriptBelongsToSession(transcriptPath, rawSessionId),
  );
}

function childTranscriptKey(transcriptPath: string | undefined): string {
  return transcriptPath ? `transcript:${transcriptPath}` : '';
}

export function childSessionStorageKey(
  identity: SessionRuntimeIdentity,
  rawSessionId: string,
  transcriptPath: string | undefined,
): string {
  if (rawSessionId === identity.parentSessionId && transcriptPath && transcriptPath !== identity.parentTranscriptPath) {
    return childTranscriptKey(transcriptPath);
  }
  return rawSessionId;
}

function transcriptBelongsToSession(transcriptPath: string | undefined, rawSessionId: string): boolean {
  return Boolean(transcriptPath && transcriptPath.includes(rawSessionId));
}
