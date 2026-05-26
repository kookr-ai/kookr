export type PromptStatus =
  | { kind: 'unknown' }
  | { kind: 'ready'; readinessVersion: number }
  | {
      kind: 'blocked';
      reason: 'permission' | 'running' | 'terminated';
    };

export interface TerminalInputSnapshot {
  sessionId: string;
  taskId: string;
  inputStateEpoch: string;
  readinessVersion: number;
  promptReady: boolean;
}

export interface EmptyEnterIntentRequest {
  type: 'emptyEnterIntent';
  intentId: string;
  taskId: string;
  sessionId: string;
  selectionVersion: number;
  inputStateEpoch: string;
  observedReadinessVersion: number;
}

export type EmptyEnterRejectReason =
  | 'stale-epoch'
  | 'stale-readiness-version'
  | 'stale-selection'
  | 'not-ready'
  | 'blocked'
  | 'session-gone';

export type EmptyEnterDecision =
  | {
      kind: 'valid-empty-enter';
      intentId: string;
      taskId: string;
      sessionId: string;
      inputStateEpoch: string;
      decisionReadinessVersion: number;
    }
  | {
      kind: 'rejected';
      intentId: string;
      sessionId: string;
      reason: EmptyEnterRejectReason;
    };
