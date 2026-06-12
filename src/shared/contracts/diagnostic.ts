export type DiagnosticSeverity = 'warning' | 'critical';

export interface DiagnosticFinding {
  checkId: string;
  title: string;
  description: string;
  severity: DiagnosticSeverity;
  observed: number;
  threshold: number;
  scope: string;
}

export type HelperLlmFailureCategory =
  | 'network_timeout'
  | 'auth'
  | 'server_5xx'
  | 'malformed_response'
  | 'other';

export type LlmUseCase =
  | 'agent_speech_summary'
  | 'criteria_verdict'
  | 'finding_evidence_review'
  | 'response_suggestion'
  | 'task_naming'
  | 'task_speech_summary'
  | 'unspecified';

export interface HelperLlmDiagnosticsCounters {
  requestCount: number;
  successCount: number;
  failureCount: number;
  nullResponseCount: number;
  errorCount: number;
  abortedCount: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
  failureCategories: Partial<Record<HelperLlmFailureCategory, number>>;
}

export type HelperLlmUseCaseDiagnostics = HelperLlmDiagnosticsCounters & {
  useCase: LlmUseCase;
};

export type HelperLlmProviderDiagnostics = HelperLlmDiagnosticsCounters & {
  provider: string;
  model: string;
};

export type HelperLlmUseCaseProviderDiagnostics = HelperLlmDiagnosticsCounters & {
  useCase: LlmUseCase;
  provider: string;
  model: string;
};

export interface HelperLlmDiagnosticsSnapshot {
  schemaVersion: 'helper-llm-diagnostics.v1';
  generatedAt: number;
  totals: HelperLlmDiagnosticsCounters;
  byUseCase: HelperLlmUseCaseDiagnostics[];
  byProvider: HelperLlmProviderDiagnostics[];
  byUseCaseProvider: HelperLlmUseCaseProviderDiagnostics[];
}

export interface DiagnosticReport {
  timestamp: number;
  findings: DiagnosticFinding[];
  helperLlm?: HelperLlmDiagnosticsSnapshot;
}
