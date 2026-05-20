import type { ServerMessage } from '../../shared/contracts/messages.js';
import type { LaunchResult } from '../launch-service.js';
import { LaunchPreflightError } from '../../core/launch-dependency-preflight.js';

const GENERIC_LAUNCH_RECOVERY_DETAILS = [
  'Launch recovery:',
  '- Run `pnpm run doctor` from the Kookr checkout and follow the suggested fixes.',
  '- Check that the selected agent binary is installed and authenticated.',
  '- Verify the working directory exists and no required Kookr port is already in use.',
].join('\n');

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
    const details = err instanceof LaunchPreflightError
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
      severity: 'critical',
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
