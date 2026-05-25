export type SpeechCapabilityKind = 'stt' | 'tts' | 'mic-capture' | 'playback' | 'notification' | 'chime';
export type SpeechCapabilityLocality = 'browser' | 'node-local';
export type SpeechCapabilityScope = 'same-device' | 'local-node-ui-only' | 'remote-routable';
export type SpeechCapabilityReadiness = 'ready' | 'starting' | 'unavailable';
export type SpeechCapabilityPrivacy = 'local-only' | 'consent-required';
export type SpeechCapabilityProtocol = 'web-speech' | 'kookr-stt-ws';

export interface SpeechCapabilityBase {
  kind: SpeechCapabilityKind;
  deviceId: string;
  deviceSessionId: string;
  capabilityId: string;
  displayName: string;
  nodeId?: string;
  advertisedAt: string;
  expiresAt: string;
}

export interface STTCapability extends SpeechCapabilityBase {
  kind: 'stt';
  locality: SpeechCapabilityLocality;
  scope: SpeechCapabilityScope;
  protocol?: SpeechCapabilityProtocol;
  /**
   * Additive Phase 6 endpoint for the existing local Kookr STT WebSocket.
   * Legacy snapshots still emit sttUrl; this lets the Phase 6 frontend keep
   * working in tests that deliberately strip the legacy fields.
   */
  endpointUrl?: string;
  maxSeconds?: number;
  maxBytes?: number;
  readiness: SpeechCapabilityReadiness;
  privacy: SpeechCapabilityPrivacy;
}

export interface TTSCapability extends SpeechCapabilityBase {
  kind: 'tts';
  locality: SpeechCapabilityLocality;
  scope: SpeechCapabilityScope;
  endpointUrl?: string;
  voices?: string[];
  readiness: SpeechCapabilityReadiness;
  privacy: SpeechCapabilityPrivacy;
}

export interface SimpleSpeechCapability extends SpeechCapabilityBase {
  kind: 'mic-capture' | 'playback' | 'notification' | 'chime';
  readiness: 'ready' | 'unavailable';
}

export type SpeechCapability = STTCapability | TTSCapability | SimpleSpeechCapability;

export interface CollaborationCapabilities {
  capabilitiesByDevice: Record<string, SpeechCapability[]>;
  capabilitiesByNode?: Record<string, SpeechCapability[]>;
}

export interface SpeakAudioResponse {
  /** The text that was spoken (may be the LLM recap, or — when usedFallback is true — the raw explanation). */
  text: string;
  /** Base64 WAV bytes synthesized by the local TTS service. */
  audioBase64: string;
  /** Always 'audio/wav' for Pocket TTS. Kept in the contract so future codecs can change it. */
  mimeType: 'audio/wav';
  durationMs: number;
  /** True iff the LLM failed, was unavailable, or hit a guardrail and the raw explanation was used. */
  usedFallback: boolean;
  /** 0 when the cache hit (no fresh LLM call). */
  llmMs: number;
  /** TTS synthesis time. 0 when the cache hit. */
  ttsMs: number;
  cached: boolean;
}

/**
 * Wire response for POST /api/findings/:agentId/speak. See
 * docs/rfc/rfc-speak-finding-summary.md.
 */
export interface SpeakFindingResponse extends SpeakAudioResponse {}

/**
 * Wire response for POST /api/tasks/:taskId/speak-summary. See
 * docs/rfc/rfc-smart-task-speech-summary.md.
 */
export interface SpeakTaskSummaryResponse extends SpeakAudioResponse {}

export type SpeakFindingErrorReason =
  | 'feature-disabled'
  | 'tts-not-configured'
  | 'agent-not-found'
  | 'task-not-found'
  | 'no-finding'
  | 'tts-error'
  | 'aborted'
  | 'http-error';

export interface SpeakFindingErrorResponse {
  error: SpeakFindingErrorReason;
  /** Optional operator-facing detail (e.g. upstream TTS message). Never displayed to end users. */
  reason?: string;
}

export function firstReadyKookrSTTEndpoint(capabilities?: CollaborationCapabilities): string | undefined {
  if (!capabilities) return undefined;
  for (const deviceCapabilities of Object.values(capabilities.capabilitiesByDevice)) {
    const candidate = deviceCapabilities.find((capability): capability is STTCapability => (
      capability.kind === 'stt'
      && capability.readiness === 'ready'
      && capability.protocol === 'kookr-stt-ws'
      && typeof capability.endpointUrl === 'string'
      && capability.endpointUrl.length > 0
    ));
    if (candidate) return candidate.endpointUrl;
  }
  return undefined;
}
