import {
  formatGrokAuthPreflightFailure,
  inspectGrokAuthFile,
  type GrokAuthPreflightResult,
} from './grok-auth-preflight.js';
import {
  GROK_LOGIN_COMMAND,
  type GrokAuthStatusResponse,
} from '../shared/contracts/grok-auth-status.js';

export interface BuildGrokAuthStatusOptions {
  authPath: string;
  roundRobinIndex?: number;
  now?: Date;
  inspect?: (path: string, options?: { now?: Date }) => Promise<GrokAuthPreflightResult>;
}

/**
 * Project the offline Grok credential-cache verdict into the Launch-dialog DTO.
 *
 * This does not contact xAI and does not copy token fields from the cache.
 */
export async function buildGrokAuthStatusResponse(
  options: BuildGrokAuthStatusOptions,
): Promise<GrokAuthStatusResponse> {
  const inspect = options.inspect ?? inspectGrokAuthFile;
  const result = await inspect(options.authPath, options.now ? { now: options.now } : undefined);
  if (result.kind === 'ok') {
    return {
      status: 'ok',
      loginCommand: GROK_LOGIN_COMMAND,
      message: null,
      launchWouldRefuse: false,
      roundRobinIndex: options.roundRobinIndex ?? 0,
    };
  }
  return {
    status: result.kind,
    loginCommand: GROK_LOGIN_COMMAND,
    message: formatGrokAuthPreflightFailure(options.authPath, result),
    launchWouldRefuse: true,
    roundRobinIndex: options.roundRobinIndex ?? 0,
  };
}
