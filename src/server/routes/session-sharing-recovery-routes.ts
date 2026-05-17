import type { Context, Hono } from 'hono';

import type {
  SessionSharingRecoveryAction,
  SessionSharingRecoveryActionResponse,
  SessionSharingRecoveryStatusResponse,
} from '../../shared/contracts/session-sharing-recovery.js';
import {
  disableTerminalSharing,
  openRelayLogs,
  recoveryAuditPath,
  repairRelayPairing,
  resetRelayState,
  revokeAllShares,
  rotateNodeCredential,
  SESSION_SHARING_RECOVERY_ACTIONS,
  validateRecoveryConfirmation,
  type SessionSharingRecoveryDeps,
} from '../session-sharing-recovery.js';
import type { RouteDeps } from './shared.js';
import { evaluateShareMutationGuard, SHARE_CSRF_HEADER } from './share-routes.js';

function guardRecoveryMutation(c: Context, deps: RouteDeps) {
  const remoteShare = deps.remoteShare;
  if (!remoteShare) return { ok: false as const, status: 500 as const, error: 'share-csrf-not-configured' };
  return evaluateShareMutationGuard({
    requestUrl: c.req.url,
    origin: c.req.header('Origin'),
    csrfHeader: c.req.header(SHARE_CSRF_HEADER),
    expectedCsrfToken: remoteShare.csrfToken,
  });
}

function recoveryDeps(deps: RouteDeps): SessionSharingRecoveryDeps {
  return {
    kookrDir: deps.kookrDir,
    serverCwd: deps.serverCwd,
    remoteShare: deps.remoteShare,
    relayConnection: deps.relayConnection,
  };
}

function isRecoveryAction(value: string): value is SessionSharingRecoveryAction {
  return SESSION_SHARING_RECOVERY_ACTIONS.some((action) => action.id === value);
}

export function registerSessionSharingRecoveryRoutes(app: Hono, deps: RouteDeps): void {
  app.get('/api/session-sharing/recovery', (c) => {
    const response: SessionSharingRecoveryStatusResponse = {
      actions: [...SESSION_SHARING_RECOVERY_ACTIONS],
      auditPath: recoveryAuditPath(deps.kookrDir),
    };
    return c.json(response);
  });

  app.post('/api/session-sharing/recovery/:action', async (c) => {
    const actionParam = c.req.param('action');
    if (!isRecoveryAction(actionParam)) return c.json({ error: 'unknown-recovery-action' }, 404);

    const guard = guardRecoveryMutation(c, deps);
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid-json-body' }, 400);
    }

    const confirmationError = validateRecoveryConfirmation(actionParam, body.confirmation);
    if (confirmationError) return c.json({ error: confirmationError }, 400);

    const scopedDeps = recoveryDeps(deps);
    try {
      const result = await (async () => {
        switch (actionParam) {
          case 'revokeAllShares':
            return revokeAllShares(scopedDeps);
          case 'disableTerminalSharing':
            return disableTerminalSharing(scopedDeps);
          case 'rotateNodeCredential':
            return rotateNodeCredential(scopedDeps, body);
          case 'repairRelayPairing':
            return repairRelayPairing(scopedDeps, body);
          case 'openRelayLogs':
            return openRelayLogs(scopedDeps);
          case 'resetRelayState':
            return resetRelayState(scopedDeps);
        }
      })();
      const response: SessionSharingRecoveryActionResponse = { result };
      return c.json(response);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'session-sharing-recovery-failed' }, 502);
    }
  });
}
