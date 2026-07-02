import type { GrantId } from './ids.js';
import type { RemotePolicyCache } from './policy-cache.js';
import { isKnownGrant } from './grants.js';
import type { ShareGrant, ShareSubject } from './policy-sync.js';

export type GrantDecision =
  | { allowed: true; grantId: GrantId }
  | { allowed: false; reason: 'revoked' | 'missing' | 'expired' | 'wrong-subject' | 'wrong-action' };

function subjectMatches(grantSubject: ShareSubject, subject: ShareSubject): boolean {
  if (grantSubject.nodeId !== subject.nodeId) return false;
  if (grantSubject.kind === 'node') return true;
  if (grantSubject.kind !== subject.kind) return false;
  switch (grantSubject.kind) {
    case 'project':
      return grantSubject.projectId === (subject as Extract<ShareSubject, { kind: 'project' }>).projectId;
    case 'task':
      return grantSubject.taskId === (subject as Extract<ShareSubject, { kind: 'task' }>).taskId;
    case 'session':
      return grantSubject.sessionId === (subject as Extract<ShareSubject, { kind: 'session' }>).sessionId;
  }
}

function isExpired(expiresAt: string | undefined, nowMs: number): boolean {
  if (expiresAt === undefined) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

export function evaluateGrant(
  cache: RemotePolicyCache,
  subject: ShareSubject,
  action: ShareGrant,
  now: Date = new Date(),
): GrantDecision {
  if (!isKnownGrant(action)) return { allowed: false, reason: 'wrong-action' };
  const snapshot = cache.snapshot();
  for (const grantId of snapshot.revokedGrantIds) {
    if (snapshot.grants.some((grant) => grant.grantId === grantId)) {
      return { allowed: false, reason: 'revoked' };
    }
  }

  let sawSubject = false;
  let sawExpired = false;
  let sawWrongAction = false;
  const nowMs = now.getTime();
  for (const grant of snapshot.grants) {
    if (cache.hasTombstone(grant.grantId)) return { allowed: false, reason: 'revoked' };
    if (!subjectMatches(grant.subject, subject)) continue;
    sawSubject = true;
    if (isExpired(grant.expiresAt, nowMs)) {
      sawExpired = true;
      continue;
    }
    if (!grant.grants.some((grantAction) => grantAction === action || grantAction === 'admin')) {
      sawWrongAction = true;
      continue;
    }
    return { allowed: true, grantId: grant.grantId };
  }
  if (sawExpired) return { allowed: false, reason: 'expired' };
  if (sawWrongAction) return { allowed: false, reason: 'wrong-action' };
  return { allowed: false, reason: sawSubject ? 'wrong-action' : 'missing' };
}

export function evaluateGrantById(
  cache: RemotePolicyCache,
  grantId: GrantId,
  subject: ShareSubject,
  action: ShareGrant,
  now: Date = new Date(),
): GrantDecision {
  if (cache.hasTombstone(grantId)) return { allowed: false, reason: 'revoked' };
  if (!isKnownGrant(action)) return { allowed: false, reason: 'wrong-action' };
  const grant = cache.get(grantId);
  if (!grant) return { allowed: false, reason: 'missing' };
  if (!subjectMatches(grant.subject, subject)) return { allowed: false, reason: 'wrong-subject' };
  if (isExpired(grant.expiresAt, now.getTime())) {
    return { allowed: false, reason: 'expired' };
  }
  if (!grant.grants.some((grantAction) => grantAction === action || grantAction === 'admin')) {
    return { allowed: false, reason: 'wrong-action' };
  }
  return { allowed: true, grantId };
}
