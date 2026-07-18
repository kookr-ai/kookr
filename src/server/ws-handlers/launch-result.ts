import type { ServerMessage } from '../../shared/contracts/messages.js';
import { isCwdValidationError, type LaunchResult } from '../launch-service.js';
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
    const details = isCwdValidationError(err)
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
