import type { AgentEvent, Anomaly, AnomalySeverity } from './types.js';
import {
  recordDetectionCheck,
  recordDetectionFire,
  type AnomalyDetectorConfig,
} from './detection-stats.js';

// Re-export the stats/config surface from its new home so existing import paths
// keep working while call-sites migrate. The detection module no longer owns
// these — see src/core/detection-stats.ts.
export {
  getDetectionStats,
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

/**
 * Detect the highest-priority anomaly in a window of events for an agent.
 * Returns the most severe anomaly found, or null if everything looks normal.
 *
 * Priority: permission_blocked (warning) > repeated_error (warning) > needs_input (info)
 */
export function detectAnomalies(
  events: AgentEvent[],
  agentId: string,
  config?: Partial<AnomalyDetectorConfig>,
): Anomaly | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const window = events.slice(-cfg.windowSize);

  if (window.length === 0) return null;

  // Trim trailing notification events to find the effective state.
  // Notifications are async signals (idle_prompt, auth_success, etc.) that should
  // not change the agent's primary state — they are overlays, not state transitions.
  let effectiveWindow = window;
  while (effectiveWindow.length > 0 && effectiveWindow[effectiveWindow.length - 1].type === 'notification') {
    effectiveWindow = effectiveWindow.slice(0, -1);
  }
  if (effectiveWindow.length === 0) return null;

  const last = effectiveWindow[effectiveWindow.length - 1];

  // user_prompt means the agent is actively processing — no anomaly.
  if (last.type === 'user_prompt') return null;

  // session_end means the session is over — no anomaly to report.
  if (last.type === 'session_end') return null;

  // StopFailure: API error killed the turn.
  if (last.type === 'stop_failure') {
    recordDetectionCheck('api_error');
    const apiErr = detectApiError(last, agentId);
    if (apiErr) recordDetectionFire('api_error');
    return apiErr;
  }

  // If the agent stopped (finished its turn), only check needs_input — not error/permission.
  // A stop event means the agent completed work and is waiting.
  if (last.type === 'stop') {
    recordDetectionCheck('needs_input');
    const ni = detectNeedsInput(effectiveWindow, agentId);
    if (ni) recordDetectionFire('needs_input');
    return ni;
  }

  // Check in order of severity
  recordDetectionCheck('permission_blocked');
  const permBlocked = detectPermissionBlocked(effectiveWindow, agentId);
  if (permBlocked) { recordDetectionFire('permission_blocked'); return permBlocked; }

  recordDetectionCheck('merge_conflict');
  const mergeConflict = detectMergeConflict(effectiveWindow, agentId);
  if (mergeConflict) { recordDetectionFire('merge_conflict'); return mergeConflict; }

  recordDetectionCheck('repeated_error');
  const repeatedErr = detectRepeatedError(effectiveWindow, agentId, cfg.repeatedErrorThreshold);
  if (repeatedErr) { recordDetectionFire('repeated_error'); return repeatedErr; }

  recordDetectionCheck('needs_input');
  const askUser = detectAskUserQuestion(effectiveWindow, agentId);
  if (askUser) { recordDetectionFire('needs_input'); return askUser; }

  return null;
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

  return {
    agentId,
    type: 'permission_blocked',
    severity: 'warning',
    explanation: `Agent is blocked on permission for tool: ${last.toolName}`,
    detectedAt: new Date(),
  };
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

  // Count occurrences of each error message
  const counts = new Map<string, number>();
  for (const err of errors) {
    const count = (counts.get(err.message) ?? 0) + 1;
    counts.set(err.message, count);
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

// Patterns that mention "conflict" but are NOT git merge conflicts
const CONFLICT_FALSE_POSITIVE_PATTERNS = [
  /merge.conflict/i, // config key like merge.conflictStyle
  /conflicting/i, // "conflicting arguments" etc.
];

function extractToolResponseText(toolResponse: unknown): string {
  if (typeof toolResponse === 'string') return toolResponse;
  if (toolResponse && typeof toolResponse === 'object') {
    return JSON.stringify(toolResponse);
  }
  return '';
}

function detectMergeConflict(events: AgentEvent[], agentId: string): Anomaly | null {
  // Scan tool_result events for git conflict output
  const conflictFiles: string[] = [];
  let foundConflict = false;

  for (const event of events) {
    if (event.type !== 'tool_result') continue;
    const text = extractToolResponseText(event.toolResponse);
    if (!text) continue;

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
