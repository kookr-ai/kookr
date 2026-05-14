export type AnomalyType =
  | 'needs_input'
  | 'permission_blocked'
  | 'repeated_error'
  | 'merge_conflict'
  | 'stale_agent'
  | 'hook_disconnected'
  | 'hook_missing'
  | 'tmux_unresponsive'
  | 'api_error'
  | 'budget_exceeded';

export type AnomalySeverity = 'info' | 'warning' | 'critical';

export type AnomalyConfidence = 'high' | 'medium' | 'low';

export interface Anomaly {
  agentId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  explanation: string;
  detectedAt: Date;
  count?: number;
  subType?: 'stop' | 'ask_user_question';
  confidence?: AnomalyConfidence;
}

export interface PersistedAnomaly {
  agentId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  explanation: string;
  detectedAt: string;
  count?: number;
  subType?: 'stop' | 'ask_user_question';
}

export interface LegacyPersistedSnooze {
  taskId: string;
  anomaly: PersistedAnomaly;
  expiresAt: number;
  reason?: string;
}

export interface PersistedSnooze {
  taskId: string;
  agentId?: string;
  kind: 'finding' | 'task';
  anomaly?: PersistedAnomaly;
  expiresAt: number;
  createdAt: number;
  expiredPendingRestore?: boolean;
  reason?: string;
}
