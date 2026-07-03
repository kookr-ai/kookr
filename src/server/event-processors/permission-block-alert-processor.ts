import { CircuitBreaker } from '../../core/circuit-breaker.js';
import type { Task } from '../../core/tasks.js';
import { isPermissionRequestEvent } from '../../core/types.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import { createPermissionAlertBreaker } from '../permission-alert-breaker.js';

type PermissionAlertTask = Pick<Task, 'id'>;

interface PermissionAlertTaskLookup {
  findTaskBySession(tmuxName: string): PermissionAlertTask | null | undefined;
}

export interface PermissionBlockAlertProcessorDeps {
  taskLookup: PermissionAlertTaskLookup;
  onPermissionBlocked?: (taskId: string, promptText: string) => void;
  permissionAlertBreaker?: CircuitBreaker;
}

export interface PermissionBlockAlertInput {
  tmuxName: string;
  preState: AgentState | undefined;
  postState: AgentState | undefined;
}

/**
 * Compact tool-input renderer for the R16 block-alert message body. Aims for
 * ~60 chars max and never includes anything that could itself be a credential
 * (the integration's send path also redacts; this is just for log-friendly
 * shape).
 */
export function formatToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 60);
  if (typeof input === 'object') {
    // Common Claude Code shapes: {command: "..."}, {file_path: "..."}, {url: "..."}.
    const obj = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'url']) {
      const v = obj[key];
      if (typeof v === 'string') return v.slice(0, 60);
    }
  }
  return '';
}

export interface PermissionBlockAlertProcessor {
  process(input: PermissionBlockAlertInput): void;
}

export function createPermissionBlockAlertProcessor({
  taskLookup,
  onPermissionBlocked,
  permissionAlertBreaker = createPermissionAlertBreaker(),
}: PermissionBlockAlertProcessorDeps): PermissionBlockAlertProcessor {
  return {
    process({ tmuxName, preState, postState }) {
      // R16 block-alert (rfc-remote-chat-trigger §7): fire onPermissionBlocked
      // exactly once per entry into permission_blocked state. The integration
      // routes the alert to the originating chat if the task is remote-spawned.
      // Non-remote tasks: integration's lookup misses → no-op.
      const isPermissionBlocked = postState?.anomaly?.type === 'permission_blocked';
      const wasPermissionBlocked = preState?.anomaly?.type === 'permission_blocked';
      if (wasPermissionBlocked || !isPermissionBlocked || !onPermissionBlocked) return;

      const ownerTaskForAlert = taskLookup.findTaskBySession(tmuxName);
      if (!ownerTaskForAlert) return;

      const permEvent = [...(postState.events)].reverse().find(isPermissionRequestEvent);
      const promptText = permEvent
        ? `${permEvent.toolName}(${formatToolInput(permEvent.toolInput)})`
        : 'permission required';
      if (permissionAlertBreaker.getState() === 'open') {
        permissionAlertBreaker.recordRejectedCall();
        console.warn('[permission-block-alert-processor] permission-alert breaker open; skipped onPermissionBlocked');
        return;
      }

      try {
        onPermissionBlocked(ownerTaskForAlert.id, promptText);
        permissionAlertBreaker.recordSuccess();
      } catch (err) {
        permissionAlertBreaker.recordFailure();
        // Never let a faulty integration callback escape the pipeline.
        console.warn('[permission-block-alert-processor] onPermissionBlocked threw:', err);
      }
    },
  };
}
