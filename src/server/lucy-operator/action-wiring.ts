/**
 * Connects Lucy's action controller to the server's own parts: the task store, the questions
 * tasks asked (`kookr ask`), the model that writes a reply from the operator's words, and the
 * three entry points the dashboard itself uses to answer a question, type a reply and complete a task.
 *
 * Nothing is re-implemented here. An answer goes through the audited `OperatorAsksPort.answer`, a
 * reply through the tracked delivery the reply box uses, and a close through the lifecycle command
 * behind `POST /api/tasks/:id/complete`. Each is attributed to `lucy-operator`.
 */

import { join } from 'node:path';
import { appendAuditRow } from '../../core/audit-log.js';
import { isActiveRalphLoop } from '../../core/completion/completion-ready-cleanup.js';
import { nowISO } from '../../core/interaction-log.js';
import type { LucyModelPort } from '../../core/lucy-operator/model-port.js';
import { listOperatorAsks } from '../../core/operator-asks.js';
import { isSharedTaskId } from '../../shared/contracts/contact-share.js';
import { LUCY_OPERATOR_ACTOR_ID } from '../../shared/contracts/lucy-launch.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import type { LucyInteractionLog } from '../lucy-interaction-log.js';
import type { RouteDeps } from '../routes/shared.js';
import { sendDirectAgentInput } from '../use-cases/agent-input.js';
import type { TaskLifecycleCommands } from '../use-cases/task-lifecycle-commands.js';
import { createLucyActionController, type LucyActionBroadcast, type LucyActionController, type LucyCloseResult } from './action-controller.js';
import { lucyWriterCall } from './launch-wiring.js';
import { projectOf } from './look-source.js';

export interface LucyActionWiring {
  /**
   * The lifecycle commands the task routes run, shared so a task she closes is completed, audited and
   * followed up exactly like one completed over `POST /api/tasks/:id/complete`. Absent: she refuses to close.
   */
  lifecycleCommands?: Pick<TaskLifecycleCommands, 'completeTask'>;
  /** A new action card is about to be held: the launch controller drops its own. */
  onHeld?: () => void;
}

/**
 * Complete a task for the operator, attributed to `lucy-operator` in the `task.complete` audit row.
 * The worktree choice is left to the operator's "clean up on complete" setting, as on the HTTP route;
 * the cleanup itself still refuses a worktree with uncommitted or unpushed work.
 */
export async function lucyCloseTask(commands: Pick<TaskLifecycleCommands, 'completeTask'>, taskId: string): Promise<LucyCloseResult> {
  const result = await commands.completeTask(taskId, { actor: { source: 'api', actorId: LUCY_OPERATOR_ACTOR_ID } });
  switch (result.outcome) {
    case 'completed':
      // A task whose last turn ended on a provider error is recorded as failed, never as completed (issue #1712).
      return result.task.status === 'completed'
        ? { ok: true }
        : { ok: false, reason: 'Kookr recorded that task as failed instead of closing it, because its last turn ended on a provider error.' };
    case 'already_terminal':
      return { ok: false, reason: 'That task was already closed.' };
    case 'partial_ralph_completion':
      return { ok: false, reason: 'That task runs as a loop, so only its current round was ended.' };
    case 'not_found':
      return { ok: false, reason: 'That task is gone, so I did nothing.' };
    default:
      return { ok: false, reason: 'Kookr refused to close that task.' };
  }
}

export function buildLucyActionController(
  deps: RouteDeps,
  model: LucyModelPort,
  log: LucyInteractionLog | undefined,
  wiring: LucyActionWiring = {},
): LucyActionController {
  const ports = deps.lucyActionPorts;
  const answerAsk = ports?.answerAsk;
  const commands = wiring.lifecycleCommands;
  return createLucyActionController({
    getTask: (taskId) => {
      // A task shared by a contact is owned by their machine: like the task routes and the dashboard socket,
      // nothing here changes one. They are kept in their own store, so this is a second lock on the same door.
      if (isSharedTaskId(taskId)) return undefined;
      const task = deps.taskStore.getTask(taskId);
      if (!task) return undefined;
      // The session a reply is typed into: the newest one that has not ended, as for her look at the terminal.
      const session = isTerminalStatus(task.status)
        ? undefined
        : [...task.sessions].reverse().find((s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted');
      const project = projectOf(task);
      return {
        id: task.id,
        ...(task.name !== undefined ? { name: task.name } : {}),
        ...(project ? { project } : {}),
        status: task.status,
        // "Finished, please review": the pending signal, or the record of it that survives the agent's
        // last tool calls and is cleared when the task is given new work (issue #3930).
        saysFinished: task.pendingSignal?.kind === 'completion_ready' || typeof task.finishedSignalAt === 'string',
        loop: isActiveRalphLoop(task),
        ...(session ? { liveSessionId: session.tmuxSession } : {}),
      };
    },
    // The same list the panel shows, so the card and the question card agree on what is waiting.
    getAsks: () => (deps.asks?.service
      ? listOperatorAsks(deps.asks.service.all(), Date.now(), (taskId) => deps.taskStore.getTask(taskId)?.name, (taskId) => deps.taskStore.getTask(taskId)?.status)
      : []),
    writeText: lucyWriterCall(model, 600),
    ...(answerAsk ? { answerAsk: (input) => answerAsk(input, { actor: LUCY_OPERATOR_ACTOR_ID }) } : {}),
    sendReply: async (sessionId, text) => {
      if (ports?.submitReply) {
        await ports.submitReply(sessionId, text);
      } else {
        await sendDirectAgentInput(
          { adapter: deps.adapter, interactionLog: deps.interactionLog, isAwaitingChoice: (id) => deps.monitor.isAwaitingChoice(id) },
          sessionId,
          text,
          LUCY_OPERATOR_ACTOR_ID,
        );
      }
      deps.requestSnapshotBroadcast?.();
    },
    ...(commands
      ? {
          closeTask: async (taskId: string) => {
            const result = await lucyCloseTask(commands, taskId);
            deps.requestSnapshotBroadcast?.();
            return result;
          },
        }
      : {}),
    // The durable trail: what she did for the operator, for which task, and how it was confirmed. Never the text.
    audit: (row) => appendAuditRow(deps.auditLogPath ?? (deps.kookrDir ? join(deps.kookrDir, 'audit.jsonl') : undefined), {
      type: 'lucy.action',
      timestamp: nowISO(),
      actor: LUCY_OPERATOR_ACTOR_ID,
      ...row,
    }),
    // Owners only: a card carries the operator's words, a task's question and the text to be sent.
    emit: (message: LucyActionBroadcast) => deps.emitToOwners?.(message),
    ...(wiring.onHeld ? { onHeld: wiring.onHeld } : {}),
    log,
  });
}
