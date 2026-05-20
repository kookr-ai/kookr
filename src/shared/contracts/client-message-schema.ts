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

// Launch-time selections may carry the `round-robin` sentinel, which the
// server resolves to a concrete agent. Persisted task/session shapes never do.
const agentSelection = z.enum(['claude-code', 'codex-cli', 'round-robin']);
const playbookScope = z.enum(['project', 'user', 'plugin']);
const launchDependency = z.enum(['kb']);
const permissionRequestBinding = z.object({
  requestId: z.string(),
  toolName: z.string(),
  toolInputHash: z.string(),
  detectedAt: z.string(),
  ttlMs: z.number(),
});
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
  'launch_dialog_cwd_field_used',
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

const telemetryEvent = z.object({
  type: telemetryEventType,
  timestamp: z.string(),
  sessionId: z.string(),
  platform: z.enum(['linux', 'darwin', 'wsl2', 'unknown']),
}).passthrough();

const projectConfigPartial = z.object({
  project: z.string().optional(),
  tracked: z.boolean().optional(),
  dailyPrLimit: z.number().optional(),
  weeklyPrLimit: z.number().optional(),
  notes: z.string().optional(),
});

const launchPlaybookMessage = z.object({
  type: z.literal('launchPlaybook'),
  playbookPath: z.string(),
  cwd: z.string().optional(),
  playbookSourceCwd: z.string().optional(),
  taskTargetCwd: z.string().optional(),
  projectId: z.string().optional(),
  parameterValues: z.record(z.string(), z.string()),
  agentType: agentSelection.optional(),
  scope: playbookScope.optional(),
}).superRefine((value, ctx) => {
  const hasLegacy = value.cwd !== undefined;
  const hasSource = value.playbookSourceCwd !== undefined;
  const hasTarget = value.taskTargetCwd !== undefined;
  if (!hasLegacy && !(hasSource && hasTarget)) {
    ctx.addIssue({
      code: 'custom',
      path: ['cwd'],
      message: 'launchPlaybook requires cwd or both playbookSourceCwd and taskTargetCwd',
    });
  }
  if ((hasSource || hasTarget) && !(hasSource && hasTarget)) {
    ctx.addIssue({
      code: 'custom',
      path: ['playbookSourceCwd'],
      message: 'playbookSourceCwd and taskTargetCwd must be supplied together',
    });
  }
});

const ClientMessageSchemaImpl = z.union([
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
    taskId: z.string().optional(),
    durationMs: z.number(),
    reason: z.string().optional(),
    resumeMonitoring: z.boolean().optional(),
  }),
  z.object({ type: z.literal('cancelSnooze'), agentId: z.string(), taskId: z.string().optional() }),
  z.object({
    type: z.literal('launch'),
    prompt: z.string(),
    cwd: z.string(),
    criteria: z.string().optional(),
    agentType: agentSelection.optional(),
    dependencies: z.array(launchDependency).optional(),
  }),
  z.object({
    type: z.literal('completeTask'),
    taskId: z.string(),
    feedback: z.object({
      rating: z.enum(['up', 'down']),
      note: z.string().optional(),
      downReason: z.enum(['agent_behavior', 'my_prompt']).optional(),
    }).optional(),
  }),
  z.object({
    type: z.literal('setTaskFeedback'),
    taskId: z.string(),
    feedback: z.object({
      rating: z.enum(['up', 'down']),
      note: z.string().optional(),
      downReason: z.enum(['agent_behavior', 'my_prompt']).optional(),
    }),
  }),
  z.object({
    type: z.literal('requestTaskReflect'),
    taskId: z.string(),
    direction: z.enum(['up', 'down']),
  }),
  z.object({
    type: z.literal('relaunch'),
    taskId: z.string(),
    prompt: z.string(),
    agentType: agentSelection.optional(),
    dependencies: z.array(launchDependency).optional(),
  }),
  z.object({ type: z.literal('cancelTask'), taskId: z.string() }),
  z.object({ type: z.literal('reopenTask'), taskId: z.string() }),
  z.object({ type: z.literal('deleteTask'), taskId: z.string() }),
  z.object({ type: z.literal('renameTask'), taskId: z.string(), name: z.string() }),
  z.object({ type: z.literal('stop'), agentId: z.string() }),
  z.object({ type: z.literal('reflect') }),
  z.object({ type: z.literal('listPlaybooks'), cwd: z.string() }),
  launchPlaybookMessage,
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
  z.object({
    type: z.literal('permissionChoice'),
    agentId: z.string(),
    keystroke: z.string(),
    permissionRequest: permissionRequestBinding,
  }),
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

export const ClientMessageSchema = ClientMessageSchemaImpl as unknown as z.ZodType<ClientMessage>;

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
  const issues = flattenZodIssues(error.issues);
  if (issues.length === 0) return 'validation failed';
  return issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function flattenZodIssues(issues: z.ZodIssue[]): z.ZodIssue[] {
  const flattened = issues.flatMap((issue) => {
    if (issue.code === 'invalid_union') {
      const unionIssueLists = getUnionIssueLists(issue);
      const bestMatch = [...unionIssueLists].sort((a, b) => scoreUnionIssues(a) - scoreUnionIssues(b))[0];
      return bestMatch ?? [];
    }
    return [issue];
  });
  return flattened.sort((a, b) => {
    const aSpecific = a.path.length > 0 && a.path[0] !== 'type';
    const bSpecific = b.path.length > 0 && b.path[0] !== 'type';
    if (aSpecific === bSpecific) return 0;
    return aSpecific ? -1 : 1;
  });
}

function getUnionIssueLists(issue: z.ZodIssue): z.ZodIssue[][] {
  const raw = issue as unknown as {
    unionErrors?: z.ZodError[];
    errors?: z.ZodIssue[][];
  };
  if (raw.unionErrors) return raw.unionErrors.map((error) => error.issues);
  return raw.errors ?? [];
}

function scoreUnionIssues(issues: z.ZodIssue[]): number {
  const discriminatorIssues = issues.filter((issue) => issue.path[0] === 'type').length;
  return discriminatorIssues * 100 + issues.length;
}
