import type { AgentEvent, Anomaly, AnomalySeverity, AnomalyType } from './types.js';
import type { AnomalyDetectorConfig } from './detection-stats.js';
import type {
  AnomalyReconciliation,
  PublishMergeReconciliationEvidence,
  PublishMergeReconciliationReasonCode,
  ReconciliationClassification,
} from './anomaly-types.js';

// Re-export the stats/config surface from its new home so existing import paths
// keep working while call-sites migrate. The detection module no longer owns
// these — see src/core/detection-stats.ts.
export {
  getDetectionStats,
  recordFalseNegative,
  recordFalsePositive,
  recordSuppression,
  recordSubagentOrphans,
  recordSubagentTtlEviction,
  resetDetectionStats,
} from './detection-stats.js';
export type { AnomalyDetectorConfig, DetectionStats } from './detection-stats.js';

const DEFAULT_CONFIG: AnomalyDetectorConfig = {
  repeatedErrorThreshold: 3,
  windowSize: 50,
};

const SEVERITY_ORDER: Record<AnomalySeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function isTrailingStateOverlay(event: AgentEvent): boolean {
  return event.type === 'notification' || event.type === 'subagent_stop';
}

export interface AnomalyDetectionEvaluation {
  anomaly: Anomaly | null;
  checkedTypes: AnomalyType[];
}

/**
 * Detect the highest-priority anomaly in a window of events for an agent.
 * Returns the most severe anomaly found, or null if everything looks normal.
 *
 * Priority: critical > warning > info.
 */
export function detectAnomalies(
  events: AgentEvent[],
  agentId: string,
  config?: Partial<AnomalyDetectorConfig>,
  reconciliation?: PublishMergeReconciliationEvidence,
): Anomaly | null {
  return evaluateAnomalies(events, agentId, config, reconciliation).anomaly;
}

/**
 * Pure detector evaluation with telemetry metadata.
 *
 * Counter mutation belongs at the write boundary (`Monitor.processEvents`), not
 * here, because snapshots and diagnostics also evaluate current state.
 *
 * `reconciliation` (#1148) is optional publish/merge evidence — local
 * git/gh credential reach, tracked PR mergeability/checks, and task merge
 * authorization — gathered by a caller with live git/gh/GitHub I/O access
 * (this detector stays pure and I/O-free). When supplied, a would-be
 * publish/merge `needs_input` blocker is reconciled via
 * `classifyPublishMergeReconciliation` before it is returned. Omitting it
 * keeps today's behavior unchanged.
 */
export function evaluateAnomalies(
  events: AgentEvent[],
  agentId: string,
  config?: Partial<AnomalyDetectorConfig>,
  reconciliation?: PublishMergeReconciliationEvidence,
): AnomalyDetectionEvaluation {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const window = events.slice(-cfg.windowSize);
  const checkedTypes: AnomalyType[] = [];

  if (window.length === 0) return { anomaly: null, checkedTypes };

  // Trim trailing overlay/bookkeeping events to find the effective state.
  // Notifications are async signals (idle_prompt, auth_success, etc.).
  // SubagentStop can arrive after the parent's Stop hook as cleanup metadata.
  // Neither should replace the parent agent's primary state; real user input,
  // tool activity, and session_end remain state transitions and are not trimmed.
  let effectiveWindow = window;
  while (
    effectiveWindow.length > 0
    && isTrailingStateOverlay(effectiveWindow[effectiveWindow.length - 1])
  ) {
    effectiveWindow = effectiveWindow.slice(0, -1);
  }
  if (effectiveWindow.length === 0) return { anomaly: null, checkedTypes };

  const last = effectiveWindow[effectiveWindow.length - 1];

  // user_prompt means the agent is actively processing — no anomaly.
  if (last.type === 'user_prompt') return { anomaly: null, checkedTypes };

  // session_end means the session is over — no anomaly to report.
  if (last.type === 'session_end') return { anomaly: null, checkedTypes };

  // StopFailure: API error killed the turn.
  if (last.type === 'stop_failure') {
    checkedTypes.push('api_error');
    return { anomaly: detectApiError(last, agentId), checkedTypes };
  }

  // If the agent stopped (finished its turn), only check needs_input — not error/permission.
  // A stop event means the agent completed work and is waiting.
  if (last.type === 'stop') {
    checkedTypes.push('needs_input');
    const candidate = detectNeedsInput(effectiveWindow, agentId);
    const reconciled = reconcilePublishMergeBlocker(
      effectiveWindow,
      agentId,
      last.lastMessage,
      candidate,
      reconciliation,
    );
    return { anomaly: reconciled, checkedTypes };
  }

  // Check in order of severity
  checkedTypes.push('permission_blocked');
  const permBlocked = detectPermissionBlocked(effectiveWindow, agentId);
  if (permBlocked) return { anomaly: permBlocked, checkedTypes };

  checkedTypes.push('merge_conflict');
  const mergeConflict = detectMergeConflict(effectiveWindow, agentId);
  if (mergeConflict) return { anomaly: mergeConflict, checkedTypes };

  checkedTypes.push('repeated_error');
  const repeatedErr = detectRepeatedError(effectiveWindow, agentId, cfg.repeatedErrorThreshold);
  if (repeatedErr) return { anomaly: repeatedErr, checkedTypes };

  checkedTypes.push('needs_input');
  const askUser = detectAskUserQuestion(effectiveWindow, agentId);
  if (askUser) {
    const questionText = extractAskUserQuestionText(effectiveWindow);
    const reconciled = reconcilePublishMergeBlocker(
      effectiveWindow,
      agentId,
      questionText,
      askUser,
      reconciliation,
    );
    return { anomaly: reconciled, checkedTypes };
  }

  return { anomaly: null, checkedTypes };
}

/** Errors that require developer action (not transient). */
const CRITICAL_API_ERRORS = new Set(['billing_error', 'authentication_failed']);

function detectApiError(
  event: Extract<AgentEvent, { type: 'stop_failure' }>,
  agentId: string,
): Anomaly | null {
  const severity = CRITICAL_API_ERRORS.has(event.error) ? 'critical' : 'warning';
  return {
    agentId,
    type: 'api_error',
    severity,
    explanation: `API error: ${event.error}. Last message: "${event.lastMessage.slice(0, 100)}"`,
    detectedAt: new Date(),
  };
}

function detectAskUserQuestion(events: AgentEvent[], agentId: string): Anomaly | null {
  if (events.length === 0) return null;

  // Check if the most recent tool_use is AskUserQuestion (without a subsequent tool_result resolving it)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'tool_result' || e.type === 'input_received') break; // Question was answered
    if (e.type === 'tool_use' && e.toolName === 'AskUserQuestion') {
      return {
        agentId,
        type: 'needs_input',
        subType: 'ask_user_question' as const,
        severity: 'warning',
        explanation: `Agent is asking a question via AskUserQuestion tool`,
        detectedAt: new Date(),
      };
    }
  }

  return null;
}

/** Extract free-text from the most recent unresolved AskUserQuestion tool_use, for reconciliation pattern matching. */
function extractAskUserQuestionText(events: AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'tool_result' || e.type === 'input_received') break;
    if (e.type === 'tool_use' && e.toolName === 'AskUserQuestion') {
      return extractToolResponseText(e.toolInput);
    }
  }
  return '';
}

// --- Publish/merge state reconciliation (#1148) -----------------------------
//
// A connector/integration failure (e.g. a GitHub MCP `create_branch` call, or
// a Git Data API error) is not the same thing as a real repository blocker —
// normal local `git`/`gh` credentials can often still publish. Likewise, once
// GitHub reports a PR green and mergeable, an agent asking the operator "should
// I merge?" is redundant lifecycle state, not a real question. Reconcile both
// before a publish/merge `needs_input` blocker reaches the operator.

/** Text that indicates a preceding tool_result was a connector/integration failure trying to publish, not a real repo blocker. */
const CONNECTOR_PUBLISH_FAILURE_PATTERNS = [
  /create[_ -]?branch/i,
  /git data api/i,
  /reference already exists/i,
  /\b(?:github )?connector (?:error|failure|failed|unavailable)\b/i,
  /mcp__github/i,
  /502 bad gateway/i,
];

/**
 * Text that indicates the agent's own stop/ask is about merging or
 * publishing — either asking the operator to merge, or reporting that a
 * publish attempt failed — rather than an unrelated question or defect.
 * This is the gate for reconciliation (see `reconcilePublishMergeBlocker`):
 * ambient evidence (a connector failure seen elsewhere in the window, or the
 * tracked PR being green) is never enough on its own to reclassify a
 * candidate whose own text doesn't match one of these.
 */
const OPERATOR_MERGE_ASK_PATTERNS = [
  /\bis mergeable\b/i,
  /all required (?:status )?checks? (?:are|is) green/i,
  /\bready to merge\b/i,
  /should i merge/i,
  /(?:please )?merge (?:this |the )?(?:pr|pull request)\b/i,
  /\bpublish (?:the |this )?(?:branch|pr|pull request|changes?)\b/i,
  /\bcould not publish\b/i,
];

/**
 * Scan tool_result events for a connector/integration publish failure,
 * stopping at the nearest tool_result/input_received boundary — mirroring
 * `extractAskUserQuestionText`'s recency scoping. Only the tool_result
 * immediately preceding the current point (if any) is inspected; an older
 * connector failure separated from the current candidate by a later,
 * unrelated tool_result or a new user turn (`input_received`) is out of
 * scope and must not be found. Returns the matching evidence text, or null.
 */
function findRecentConnectorFailure(events: AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'input_received') return null;
    if (event.type !== 'tool_result') continue;
    const text = extractToolResponseText(event.toolResponse);
    if (text && CONNECTOR_PUBLISH_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) return text;
    return null; // nearest tool_result didn't match — an earlier one is out of scope
  }
  return null;
}

function isPublishMergeAskText(text: string): boolean {
  return OPERATOR_MERGE_ASK_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Classify reconciliation evidence into the publish/merge verdict.
 *
 * Table (see `anomaly-detector.test.ts` for the full matrix):
 * - PR green/mergeable + merge-after-implementation authorized → `pr-green-mergeable`.
 * - Connector failure observed + local git/gh credentials can publish → `connector-failure-but-publishable`.
 * - Anything else → `real-blocker` (connector failure alone, with no working
 *   local fallback, is still a real blocker — just one the message should not
 *   blame on the repository).
 */
export function classifyPublishMergeReconciliation(
  evidence: PublishMergeReconciliationEvidence,
): { classification: ReconciliationClassification; reasonCode: PublishMergeReconciliationReasonCode } {
  if (evidence.prGreenAndMergeable && evidence.mergeAfterImplementation) {
    return { classification: 'pr-green-mergeable', reasonCode: 'pr_green_mergeable_auto_merge_authorized' };
  }
  if (evidence.connectorFailureDetected && evidence.localCredentialsCanPublish) {
    return { classification: 'connector-failure-but-publishable', reasonCode: 'connector_failed_local_credentials_ok' };
  }
  if (evidence.connectorFailureDetected) {
    return { classification: 'real-blocker', reasonCode: 'connector_failed_local_credentials_unavailable' };
  }
  return { classification: 'real-blocker', reasonCode: 'no_reconciling_evidence' };
}

/**
 * Reconcile a would-be publish/merge `needs_input` blocker before it is
 * returned to the caller. `candidate` is the anomaly the ordinary detector
 * (`detectNeedsInput` / `detectAskUserQuestion`) already computed; this
 * function only overrides it when both (a) evidence was supplied by the
 * caller and (b) the candidate's OWN text looks publish/merge shaped
 * (`isPublishMergeAskText`). Ambient evidence — a connector failure seen
 * elsewhere in the window, or the tracked PR being green — describes state
 * unrelated to why the agent stopped *now* and must never by itself
 * reclassify a candidate whose own text is about something else (e.g. an
 * unrelated design question on an otherwise green, auto-mergeable task).
 * Otherwise `candidate` passes through unchanged — existing callers that
 * never pass `evidence` see no behavior change (#1148 AC1-AC4).
 */
function reconcilePublishMergeBlocker(
  events: AgentEvent[],
  agentId: string,
  candidateText: string,
  candidate: Anomaly | null,
  evidence: PublishMergeReconciliationEvidence | undefined,
): Anomaly | null {
  if (!evidence || !candidate) return candidate;
  if (!isPublishMergeAskText(candidateText)) return candidate;

  const connectorFailureText = findRecentConnectorFailure(events);
  const mergedEvidence: PublishMergeReconciliationEvidence = {
    ...evidence,
    connectorFailureDetected: evidence.connectorFailureDetected || connectorFailureText !== null,
    connectorFailureText: evidence.connectorFailureText ?? connectorFailureText ?? undefined,
  };
  const { classification, reasonCode } = classifyPublishMergeReconciliation(mergedEvidence);
  const reconciliationContext: AnomalyReconciliation = { classification, reasonCode, evidence: mergedEvidence };

  if (classification === 'connector-failure-but-publishable') {
    // AC2: don't emit operator text for a mere connector/integration failure
    // when normal git/gh credentials can still publish. Logged (not counted
    // in detection-stats, which is outside this layer's scope) so the
    // dashboard/log surfaces can still explain the suppression (AC4).
    console.info('[anomaly-detector] reconciled publish/merge blocker: suppressed (connector failure, local credentials can publish)', {
      agentId,
      reasonCode,
      evidence: mergedEvidence,
    });
    return null;
  }

  if (classification === 'pr-green-mergeable') {
    // AC3: surface a structured merge-ready signal instead of an operator question.
    return {
      agentId,
      type: 'needs_input',
      severity: 'info',
      explanation: 'PR is green and mergeable, and merge-after-implementation is authorized. '
        + 'Merge-ready signal — no operator input needed.',
      detectedAt: new Date(),
      reconciliation: reconciliationContext,
    };
  }

  // real-blocker: keep the candidate, but attach reconciliation evidence and
  // (when a connector failure was involved) clarify the message so operators
  // don't mistake a real repo blocker for a transient connector outage (AC2).
  const explanation = mergedEvidence.connectorFailureDetected
    ? `${candidate.explanation} (Reconciled: a GitHub connector/integration failure was observed, but local `
      + 'git/gh credentials could not publish either — this is a real repository blocker, not a connector outage.)'
    : candidate.explanation;

  return { ...candidate, explanation, reconciliation: reconciliationContext };
}

function detectNeedsInput(events: AgentEvent[], agentId: string): Anomaly | null {
  if (events.length === 0) return null;

  const last = events[events.length - 1];
  if (last.type !== 'stop') return null;

  return {
    agentId,
    type: 'needs_input',
    subType: 'stop' as const,
    severity: 'info',
    explanation: `Agent is waiting for input. Last message: "${last.lastMessage.slice(0, 100)}"`,
    detectedAt: new Date(),
  };
}

function detectPermissionBlocked(events: AgentEvent[], agentId: string): Anomaly | null {
  if (events.length === 0) return null;

  const last = events[events.length - 1];
  if (last.type !== 'permission_request') return null;
  // A PermissionRequest for AskUserQuestion is the question's own approval
  // prompt, not a tool-permission block. Returning null lets evaluateAnomalies
  // fall through to detectAskUserQuestion, which classifies the unresolved
  // question as `needs_input / ask_user_question`. See deriveTurnState's
  // matching permission_request branch in turn-state.ts.
  if (last.toolName === 'AskUserQuestion') return null;

  return {
    agentId,
    type: 'permission_blocked',
    severity: 'warning',
    explanation: `Agent is blocked on permission for tool: ${last.toolName}`,
    detectedAt: new Date(),
  };
}

function repeatedErrorFingerprint(message: string): string {
  // Strip volatile tokens from recurring tool/API failures while keeping the
  // semantic error text intact: timestamps, request IDs, paths, and counters.
  return message
    .normalize('NFKC')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-][0-2]\d:?[0-5]\d)?\b/g, '<timestamp>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\b[A-Za-z]:\\(?:[^\s"'<>|]+\\)+[^\s"'<>|]+/g, '<path>')
    .replace(/(?:^|[\s([{"'=])\/(?:[^\s"'<>:),\]}]+\/)+[^\s"'<>:),\]}]+/g, (match) => {
      const prefix = match[0] === '/' ? '' : match[0];
      return `${prefix}<path>`;
    })
    .replace(/\b\d+\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function detectRepeatedError(
  events: AgentEvent[],
  agentId: string,
  threshold: number,
): Anomaly | null {
  const errors = events.filter((e) => e.type === 'error') as Array<
    Extract<AgentEvent, { type: 'error' }>
  >;
  if (errors.length < threshold) return null;

  // Count on a stable key so request IDs, paths, and timestamps do not hide loops.
  const counts = new Map<string, number>();
  for (const err of errors) {
    const fingerprint = repeatedErrorFingerprint(err.message);
    const count = (counts.get(fingerprint) ?? 0) + 1;
    counts.set(fingerprint, count);
    if (count >= threshold) {
      return {
        agentId,
        type: 'repeated_error',
        severity: 'warning',
        explanation: `Same error repeated ${count} times: "${err.message.slice(0, 100)}"`,
        detectedAt: new Date(),
        count,
      };
    }
  }

  return null;
}

// Patterns that indicate a git merge/rebase/pull conflict.
// These appear in Bash tool_result output when git encounters conflicts.
const MERGE_CONFLICT_PATTERNS = [
  /CONFLICT \(content\): Merge conflict in (.+)/,
  /CONFLICT \(modify\/delete\): (.+)/,
  /CONFLICT \(rename\/delete\): (.+)/,
  /CONFLICT \(add\/add\): Merge conflict in (.+)/,
  /Automatic merge failed; fix conflicts and then commit/,
  /Failed to merge in the changes/,
  /You need to resolve your current index first/,
  /fix conflicts and then commit the result/,
  /Unmerged paths:/,
];

function extractToolResponseText(toolResponse: unknown): string {
  if (typeof toolResponse === 'string') return toolResponse;
  if (toolResponse && typeof toolResponse === 'object') {
    return JSON.stringify(toolResponse);
  }
  return '';
}

function extractCommand(toolInput: unknown): string | null {
  if (typeof toolInput === 'string') return toolInput;
  if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    const command = (toolInput as Record<string, unknown>).command;
    return typeof command === 'string' ? command : null;
  }
  return null;
}

function findCommandForResult(
  events: AgentEvent[],
  result: Extract<AgentEvent, { type: 'tool_result' }>,
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== 'tool_use') continue;
    if (event.toolName !== result.toolName) continue;
    if (result.toolUseId && event.toolUseId !== result.toolUseId) continue;
    return extractCommand(event.toolInput);
  }
  return null;
}

function isGitConflictCommand(command: string | null): boolean {
  if (!command) return false;
  return /\bgh\s+pr\s+checkout\b/i.test(command)
    || /\bgit\b[^\n;&|]*\b(?:merge|rebase|pull|cherry-pick|status|diff|checkout|switch|apply|am)\b/i.test(command)
    || /\bgit\b[^\n;&|]*\bstash\s+(?:pop|apply)\b/i.test(command);
}

function detectMergeConflict(events: AgentEvent[], agentId: string): Anomaly | null {
  const last = events[events.length - 1];
  if (last?.type !== 'tool_result') return null;
  if (last.toolName !== 'Bash') return null;

  const command = findCommandForResult(events, last);
  if (!isGitConflictCommand(command)) return null;

  // Scan the current git-related Bash result for conflict output.
  const conflictFiles: string[] = [];
  let foundConflict = false;

  const text = extractToolResponseText(last.toolResponse);
  if (!text) return null;

  // Check each line against conflict patterns to catch multiple CONFLICT lines
  const lines = text.split('\n');
  for (const line of lines) {
    for (const pattern of MERGE_CONFLICT_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        foundConflict = true;
        if (match[1]) {
          const file = match[1].trim();
          if (!conflictFiles.includes(file)) {
            conflictFiles.push(file);
          }
        }
      }
    }
  }

  if (!foundConflict) return null;

  const fileList = conflictFiles.length > 0
    ? ` Files: ${conflictFiles.join(', ')}`
    : '';

  return {
    agentId,
    type: 'merge_conflict',
    severity: 'warning',
    explanation: `Agent hit a git merge conflict.${fileList}`,
    detectedAt: new Date(),
  };
}

/**
 * Sort anomalies by severity: critical > warning > info.
 */
export function prioritizeAnomalies(anomalies: Anomaly[]): Anomaly[] {
  return [...anomalies].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}
