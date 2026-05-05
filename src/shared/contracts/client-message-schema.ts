import { z } from 'zod';
import type { ClientMessage } from './messages.js';

/**
 * Runtime validators for the ClientMessage discriminated union.
 *
 * The source-of-truth type is `ClientMessage` in ./messages.ts. These schemas
 * mirror each member shape so the WS boundary can reject malformed payloads
 * before typed handlers dereference fields.
 *
 * Extra keys are stripped by default. Telemetry events carry an open
 * `[key: string]: unknown` shape and use `looseObject` so extra fields survive.
 */

const autonomyLevel = z.enum(['supervised', 'autonomous']);
const agentType = z.enum(['claude-code', 'codex-cli']);
const anomalyType = z.enum([
  'needs_input',
  'permission_blocked',
  'repeated_error',
  'merge_conflict',
  'stale_agent',
  'hook_disconnected',
  'hook_missing',
  'tmux_unresponsive',
  'api_error',
  'auto_proceed_failure',
  'budget_exceeded',
]);

const telemetryEventType = z.enum([
  'agent_clicked',
  'auto_advance_overridden',
  'tab_switched',
  'response_sent',
  'quick_action_clicked',
  'suggestion_accepted',
  'suggestion_ignored',
  'launch_dialog_opened',
  'launch_dialog_closed',
  'launch_dialog_draft_restored',
  'launch_dialog_draft_discarded',
  'launch_submitted',
  'task_completed',
  'task_cancelled',
  'task_relaunched',
  'task_renamed',
  'finding_skipped',
  'finding_snoozed',
  'shortcut_used',
  'focus_zone_changed',
  'rapid_repeat_click',
  'healthy_agent_inspected',
  'session_started',
  'websocket_reconnect',
  'suggestion_lifecycle',
]);

const telemetryEvent = z.looseObject({
  type: telemetryEventType,
  timestamp: z.string(),
  sessionId: z.string(),
  platform: z.enum(['linux', 'darwin', 'wsl2', 'unknown']),
});

const projectConfigPartial = z.object({
  project: z.string().optional(),
  tracked: z.boolean().optional(),
  dailyPrLimit: z.number().optional(),
  weeklyPrLimit: z.number().optional(),
  notes: z.string().optional(),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('respond'), agentId: z.string(), input: z.string() }),
  z.object({ type: z.literal('respondAll'), agentIds: z.array(z.string()), input: z.string() }),
  z.object({ type: z.literal('directReply'), agentId: z.string(), input: z.string() }),
  z.object({ type: z.literal('navigate'), agentId: z.string() }),
  z.object({ type: z.literal('getNext') }),
  z.object({ type: z.literal('skip'), agentId: z.string() }),
  z.object({ type: z.literal('skipAll'), agentIds: z.array(z.string()) }),
  z.object({
    type: z.literal('snooze'),
    agentId: z.string(),
    durationMs: z.number(),
    reason: z.string().optional(),
    resumeMonitoring: z.boolean().optional(),
  }),
  z.object({ type: z.literal('cancelSnooze'), agentId: z.string() }),
  z.object({
    type: z.literal('launch'),
    prompt: z.string(),
    cwd: z.string(),
    criteria: z.string().optional(),
    autonomy: autonomyLevel.optional(),
    agentType: agentType.optional(),
  }),
  z.object({ type: z.literal('completeTask'), taskId: z.string() }),
  z.object({
    type: z.literal('relaunch'),
    taskId: z.string(),
    prompt: z.string(),
    agentType: agentType.optional(),
  }),
  z.object({ type: z.literal('cancelTask'), taskId: z.string() }),
  z.object({ type: z.literal('reopenTask'), taskId: z.string() }),
  z.object({ type: z.literal('deleteTask'), taskId: z.string() }),
  z.object({ type: z.literal('renameTask'), taskId: z.string(), name: z.string() }),
  z.object({ type: z.literal('stop'), agentId: z.string() }),
  z.object({ type: z.literal('reflect') }),
  z.object({ type: z.literal('listPlaybooks'), cwd: z.string() }),
  z.object({
    type: z.literal('launchPlaybook'),
    playbookPath: z.string(),
    cwd: z.string(),
    parameterValues: z.record(z.string(), z.string()),
    autonomy: autonomyLevel.optional(),
    agentType: agentType.optional(),
  }),
  z.object({ type: z.literal('telemetry'), events: z.array(telemetryEvent) }),
  z.object({
    type: z.literal('setProjectConfig'),
    project: z.string(),
    config: projectConfigPartial,
  }),
  z.object({ type: z.literal('clearCompleted'), includeTerminated: z.boolean().optional() }),
  z.object({ type: z.literal('ackTerminatedTask'), taskId: z.string() }),
  z.object({ type: z.literal('achievement:reset') }),
  z.object({ type: z.literal('achievement:setEnabled'), enabled: z.boolean() }),
  z.object({ type: z.literal('setAutonomy'), taskId: z.string(), level: autonomyLevel }),
  z.object({ type: z.literal('cancelAutoProceed'), agentId: z.string() }),
  z.object({ type: z.literal('permissionChoice'), agentId: z.string(), keystroke: z.string() }),
  z.object({ type: z.literal('rearmCircuitBreaker'), name: z.string() }),
  z.object({
    type: z.literal('findingFeedback'),
    agentId: z.string(),
    anomalyType,
    explanation: z.string(),
    verdict: z.literal('false_positive'),
  }),
  z.object({ type: z.literal('workspace:getView'), projectId: z.string() }),
  z.object({
    type: z.literal('workspace:getCleanupDetail'),
    projectId: z.string(),
    worktreePath: z.string(),
  }),
  z.object({
    type: z.literal('workspace:cleanupCandidate'),
    projectId: z.string(),
    worktreePath: z.string(),
    branch: z.string().optional(),
    repoPath: z.string().optional(),
    deleteBranch: z.boolean().optional(),
    riskAccepted: z.boolean().optional(),
    discardDirtyState: z.boolean().optional(),
    reviewFingerprint: z.string().optional(),
  }),
  z.object({ type: z.literal('workspace:bulkSafeCleanup'), projectId: z.string() }),
  z.object({
    type: z.literal('workspace:runCleanupDiagnostic'),
    projectId: z.string(),
    worktreePath: z.string(),
    reviewFingerprint: z.string(),
  }),
  z.object({
    type: z.literal('workspace:startWork'),
    projectId: z.string(),
    cwd: z.string(),
    prompt: z.string(),
    issueRef: z.string().optional(),
    playbookId: z.string().optional(),
  }),
  z.object({ type: z.literal('workspace:sweep') }),
]);

// Compile-time drift guards. Both directions are checked because a one-way
// check would silently accept the case where someone adds a variant to
// `ClientMessage` in messages.ts but forgets to mirror it here — legitimate
// new traffic would then be rejected at runtime with no build-time warning.
type _SchemaToUnion = Exclude<z.infer<typeof ClientMessageSchema>, ClientMessage> extends never ? true : false;
type _UnionToSchema = Exclude<ClientMessage, z.infer<typeof ClientMessageSchema>> extends never ? true : false;
const _driftSchemaToUnion: _SchemaToUnion = true;
const _driftUnionToSchema: _UnionToSchema = true;
void _driftSchemaToUnion;
void _driftUnionToSchema;

/**
 * Summarize a ZodError into a short human-readable string naming the bad
 * field(s). Used as the `details` body of the malformed-payload alert so
 * the operator can see which field tripped validation.
 */
export function summarizeZodIssues(error: z.ZodError): string {
  if (error.issues.length === 0) return 'validation failed';
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
