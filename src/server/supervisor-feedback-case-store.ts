import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentEvent, AnomalyType } from '../core/types.js';

export const SUPERVISOR_FEEDBACK_CASE_FILE = 'supervisor-feedback-cases.jsonl';
export const SUPERVISOR_FEEDBACK_CASE_SCHEMA_VERSION = 'supervisor-feedback-case.v1';

/**
 * Lightweight snapshot of agent context captured at the moment a user flags
 * a finding. Best-effort: any field may be omitted if the source isn't
 * currently available (e.g., pane capture failed, audit record not retained).
 */
export interface SupervisorFeedbackCaseSnapshotV1 {
  /** Trailing slice of normalized pane output, capped to ~1200 chars. */
  paneExcerpt?: string;
  /** Tail of agent events (default cap: 30). */
  recentEvents?: AgentEvent[];
  /** Anomaly that was active at flag-time, if any (FP cases always carry one). */
  anomalyExplanation?: string;
  /** Optional opaque audit-record id linking to FindingEvidenceAuditor in-memory state. */
  auditRecordId?: string;
}

export type SupervisorFeedbackCaseRecordV1 =
  | {
      schemaVersion: typeof SUPERVISOR_FEEDBACK_CASE_SCHEMA_VERSION;
      kind: 'false_positive';
      agentId: string;
      timestamp: string;
      anomalyType: AnomalyType;
      supervisorExplanation: string;
      userReason?: string;
      snapshot: SupervisorFeedbackCaseSnapshotV1;
    }
  | {
      schemaVersion: typeof SUPERVISOR_FEEDBACK_CASE_SCHEMA_VERSION;
      kind: 'false_negative';
      agentId: string;
      timestamp: string;
      userReason: string;
      suspectedType?: AnomalyType;
      snapshot: SupervisorFeedbackCaseSnapshotV1;
    };

export interface SupervisorFeedbackCaseReadDiagnostic {
  lineNumber: number;
  failureKind: 'malformed_json' | 'invalid_record';
  message: string;
}

export interface SupervisorFeedbackCaseReadResult {
  records: SupervisorFeedbackCaseRecordV1[];
  diagnostics: SupervisorFeedbackCaseReadDiagnostic[];
}

export class SupervisorFeedbackCaseStore {
  private appendChain = Promise.resolve();

  constructor(private readonly path: string) {}

  static forKookrDir(kookrDir: string): SupervisorFeedbackCaseStore {
    return new SupervisorFeedbackCaseStore(join(kookrDir, SUPERVISOR_FEEDBACK_CASE_FILE));
  }

  append(record: SupervisorFeedbackCaseRecordV1): Promise<void> {
    this.appendChain = this.appendChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    });
    return this.appendChain;
  }

  async readAll(): Promise<SupervisorFeedbackCaseReadResult> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if (isNodeErrno(err, 'ENOENT')) return { records: [], diagnostics: [] };
      throw err;
    }

    const records: SupervisorFeedbackCaseRecordV1[] = [];
    const diagnostics: SupervisorFeedbackCaseReadDiagnostic[] = [];
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        diagnostics.push({
          lineNumber: index + 1,
          failureKind: 'malformed_json',
          message: 'line was not valid JSON',
        });
        continue;
      }
      if (!isSupervisorFeedbackCaseRecord(value)) {
        diagnostics.push({
          lineNumber: index + 1,
          failureKind: 'invalid_record',
          message: 'line did not match supervisor feedback case schema',
        });
        continue;
      }
      records.push(value);
    }
    return { records, diagnostics };
  }
}

function isSupervisorFeedbackCaseRecord(value: unknown): value is SupervisorFeedbackCaseRecordV1 {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== SUPERVISOR_FEEDBACK_CASE_SCHEMA_VERSION) return false;
  if (typeof value.agentId !== 'string' || value.agentId === '') return false;
  if (typeof value.timestamp !== 'string' || !isIsoDate(value.timestamp)) return false;
  if (!isRecord(value.snapshot)) return false;
  if (value.kind === 'false_positive') {
    if (typeof value.anomalyType !== 'string') return false;
    if (typeof value.supervisorExplanation !== 'string') return false;
    if (value.userReason !== undefined && typeof value.userReason !== 'string') return false;
    return true;
  }
  if (value.kind === 'false_negative') {
    if (typeof value.userReason !== 'string' || value.userReason === '') return false;
    if (value.suspectedType !== undefined && typeof value.suspectedType !== 'string') return false;
    return true;
  }
  return false;
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeErrno(err: unknown, code: string): boolean {
  return isRecord(err) && err.code === code;
}
