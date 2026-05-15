import type { GrantId } from './ids.js';
import type { RemotePolicyCache } from './policy-cache.js';
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

export function evaluateGrant(
  cache: RemotePolicyCache,
  subject: ShareSubject,
  action: ShareGrant,
  now: Date = new Date(),
): GrantDecision {
  const snapshot = cache.snapshot();
  for (const grantId of snapshot.revokedGrantIds) {
    if (snapshot.grants.some((grant) => grant.grantId === grantId)) {
      return { allowed: false, reason: 'revoked' };
    }
  }

  let sawSubject = false;
  let sawExpired = false;
  let sawWrongAction = false;
  for (const grant of snapshot.grants) {
    if (cache.hasTombstone(grant.grantId)) return { allowed: false, reason: 'revoked' };
    if (!subjectMatches(grant.subject, subject)) continue;
    sawSubject = true;
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= now.getTime()) {
      sawExpired = true;
      continue;
    }
    if (!grant.grants.includes(action)) {
      sawWrongAction = true;
      continue;
    }
    return { allowed: true, grantId: grant.grantId };
  }
  if (sawExpired) return { allowed: false, reason: 'expired' };
  if (sawWrongAction) return { allowed: false, reason: 'wrong-action' };
  return { allowed: false, reason: sawSubject ? 'wrong-action' : 'missing' };
}
