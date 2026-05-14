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

export interface DiagnosticReport {
  timestamp: number;
  findings: DiagnosticFinding[];
}
