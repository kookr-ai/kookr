import type { ServerMessage } from '../../shared/contracts/messages.js';
import {
  isCwdValidationError,
  isPendingQueueFullError,
  isSpawnBurstLimitError,
  isHostLoadAdmissionError,
  isQuotaHeadroomAdmissionError,
  type LaunchResult,
  type PendingQueueFullError,
  type SpawnBurstLimitError,
  type HostLoadAdmissionError,
  type QuotaHeadroomAdmissionError,
} from '../launch-service.js';
import { LaunchPreflightError } from '../../core/launch-dependency-preflight.js';

const GENERIC_LAUNCH_RECOVERY_DETAILS = [
  'Launch recovery:',
  '- Run `pnpm run doctor` from the Kookr checkout and follow the suggested fixes.',
  '- Check that the selected agent binary is installed and authenticated.',
  '- Verify the working directory exists and no required Kookr port is already in use.',
].join('\n');

// RFC F12: a missing cwd is validated before any session spawns, so the
// recovery guidance leads with the actual cause instead of burying it in the
// generic checklist.
const CWD_LAUNCH_RECOVERY_DETAILS = [
  'The working directory was not found on this machine — nothing was launched.',
  '- Create the directory, or reopen the Launch dialog and pick an existing checkout.',
  '- If you typed the prompt in the Launch dialog, it is preserved as a draft and restored when the dialog reopens.',
].join('\n');

const GROK_AUTH_LAUNCH_RECOVERY_DETAILS = [
  'Grok authentication preflight failed before a terminal session was created.',
  '- Run `grok login --device-code` (or `grok login --oauth`) and retry.',
  '- Credential values are intentionally omitted from this diagnostic.',
].join('\n');

function isGrokAuthPreflightError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err &&
    (err as { code?: unknown }).code === 'grok_auth_preflight';
}

/**
 * Render the capacity-ledger snapshot carried by a backpressure rejection
 * (issue #1526 Phase C / C3) so the WS alert shows WHY the launch was
 * refused — the same breakdown the REST 429 body and `GET /api/health`
 * `capacity` carry, not just a bare error string.
 */
function describeBackpressure(
  err: PendingQueueFullError | SpawnBurstLimitError | HostLoadAdmissionError | QuotaHeadroomAdmissionError,
): string {
  const cap = err.capacity;
  const headline = isQuotaHeadroomAdmissionError(err)
    ? 'Anthropic plan quota is exhausted — nothing was launched.'
    : isHostLoadAdmissionError(err)
    ? 'The host is CPU-saturated — nothing was launched.'
    : err.code === 'pending_queue_full'
    ? 'The pending queue is full — nothing was launched.'
    : 'This caller\'s spawn burst budget is exhausted — nothing was launched.';
  const lines = [
    headline,
    `- Capacity: ${cap.active}/${cap.maxActiveTasks} slots occupied ` +
      `(working ${cap.byClass.working}, awaiting-ack ${cap.byClass.finishedAwaitingAck}, ` +
      `hung-suspect ${cap.byClass.hungSuspect}, launching ${cap.byClass.launching}).`,
    `- Pending queue: ${cap.pendingQueueDepth} task(s)` +
      (isPendingQueueFullError(err) ? ` (limit ${err.maxPendingTasks}).` : '.'),
  ];
  if (isQuotaHeadroomAdmissionError(err)) {
    lines.push(
      `- Plan utilization: ${err.maxUtilization.toFixed(0)}% ` +
      `(threshold ${err.threshold.toFixed(0)}%).` +
      (err.resetsAt
        ? ` Retry after the binding window resets (${err.resetsAt}).`
        : ' Retry once plan quota resets.'),
    );
  } else if (isHostLoadAdmissionError(err)) {
    lines.push(
      `- Host load: ${err.loadPerCpu.toFixed(2)} per core (threshold ${err.maxLoadPerCpu.toFixed(2)}). ` +
      'Retry once host load drops, or raise/disable KOOKR_MAX_HOST_LOAD_PER_CPU.',
    );
  } else if (isSpawnBurstLimitError(err)) {
    lines.push(
      `- Burst budget: ${err.limit} launches per ${Math.round(err.windowMs / 60_000)}m for source "${err.source}"; ` +
      `retry in ~${Math.max(1, Math.ceil(err.retryAfterMs / 1000))}s.`,
    );
  } else {
    lines.push('- Free a slot (complete/abort a task) or raise maxPendingTasks in Settings, then retry.');
  }
  return lines.join('\n');
}

/**
 * Emit result-aware feedback after a launch/relaunch/launchPlaybook attempt.
 *
 * Sends a targeted alert to the originator describing the outcome. The
 * snapshot broadcast that makes the new row appear for every client is
 * emitted by `ws-connection-handler.ts` unconditionally after each handled
 * client message, so this function intentionally does not broadcast — doing
 * so would double-send. Never throws — the launch itself has already
 * committed state by the time we get here.
 *
 * Returns `{ duplicate }` so the dispatching router can track whether the
 * most recent launch was deduplicated (used by achievement-watcher to skip
 * launch credit for duplicates).
 */
export function handleLaunchResult(
  send: (msg: ServerMessage) => void,
  promptExcerpt: string,
  result: LaunchResult | undefined,
  err: unknown,
): { duplicate: boolean } {
  if (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[launch] failed prompt="${promptExcerpt}" err=${message}`);
    const details = isPendingQueueFullError(err) || isSpawnBurstLimitError(err)
      || isHostLoadAdmissionError(err) || isQuotaHeadroomAdmissionError(err)
      ? describeBackpressure(err)
      : isCwdValidationError(err)
      ? CWD_LAUNCH_RECOVERY_DETAILS
      : isGrokAuthPreflightError(err)
      ? GROK_AUTH_LAUNCH_RECOVERY_DETAILS
      : err instanceof LaunchPreflightError
      ? err.findings.map((finding) =>
          [
            `Dependency: ${finding.dependency}`,
            `Failure mode: ${finding.category}`,
            finding.detail ? `Detail: ${finding.detail}` : undefined,
            `Recommended action: ${finding.recommendedAction}`,
          ].filter(Boolean).join('\n'),
        ).join('\n\n')
      : GENERIC_LAUNCH_RECOVERY_DETAILS;
    send({
      type: 'alert',
      agentId: '',
      summary: `Error starting "${promptExcerpt}": ${message}`,
      details,
      // Backpressure rejections are deliberate policy refusals with a retry
      // path, not launch failures — warn, don't page (issue #1526 Phase C, #1630, #1894).
      severity: isPendingQueueFullError(err) || isSpawnBurstLimitError(err)
        || isHostLoadAdmissionError(err) || isQuotaHeadroomAdmissionError(err)
        ? 'warning'
        : 'critical',
    });
    return { duplicate: false };
  }
  if (!result) return { duplicate: false };
  if (result.duplicate) {
    send({
      type: 'alert',
      agentId: result.task.sessions[0]?.tmuxSession ?? '',
      summary: `Already running: ${promptExcerpt}`,
      details: '',
      severity: 'info',
    });
    return { duplicate: true };
  }
  if (result.queued) {
    if (result.parked) {
      const dependencies = result.dependencyAdmission?.dependencies
        .map((dependency) => {
          const reason = dependency.reason ? ` (${dependency.reason})` : '';
          return `${dependency.dependency}=${dependency.state}${reason}`;
        })
        .join(', ');
      const admissionReason = result.dependencyAdmission?.reason;
      const admissionMessage = admissionReason === 'half_open_probe_busy'
        ? 'A dependency recovery probe is already in flight; no worker slot was consumed.'
        : 'A required launch dependency is degraded; no worker slot was consumed.';
      send({
        type: 'alert',
        agentId: '',
        summary: `Parked: ${promptExcerpt}`,
        details: [
          admissionMessage,
          dependencies ? `Dependencies: ${dependencies}.` : undefined,
          'Kookr will retry the preserved launch intent after recovery evidence.',
        ].filter(Boolean).join('\n'),
        severity: 'warning',
      });
      return { duplicate: false };
    }
    send({
      type: 'alert',
      agentId: '',
      summary: `Queued: ${promptExcerpt}`,
      details: 'Concurrency limit reached — will start when a slot opens.',
      severity: 'info',
    });
  }
  return { duplicate: false };
}
