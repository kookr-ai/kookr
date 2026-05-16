import type { GrantId, PolicyVersion } from './ids.js';
import type { PolicyGrantRecord } from './policy-sync.js';

export interface PolicyCacheSnapshot {
  policyVersion: PolicyVersion;
  grants: PolicyGrantRecord[];
  revokedGrantIds: GrantId[];
}

export class RemotePolicyCache {
  private policyVersion = 0 as PolicyVersion;
  private readonly grants = new Map<GrantId, PolicyGrantRecord>();
  private readonly revokedGrantIds = new Set<GrantId>();

  snapshot(): PolicyCacheSnapshot {
    return {
      policyVersion: this.policyVersion,
      grants: [...this.grants.values()],
      revokedGrantIds: [...this.revokedGrantIds],
    };
  }

  applySync(snapshot: PolicyCacheSnapshot): void {
    this.policyVersion = snapshot.policyVersion;
    this.grants.clear();
    for (const grant of snapshot.grants) {
      if (!this.revokedGrantIds.has(grant.grantId)) {
        this.grants.set(grant.grantId, grant);
      }
    }
    for (const grantId of snapshot.revokedGrantIds) {
      this.revoke(grantId, snapshot.policyVersion);
    }
  }

  upsert(grant: PolicyGrantRecord): boolean {
    if (this.revokedGrantIds.has(grant.grantId)) return false;
    this.policyVersion = grant.policyVersion;
    this.grants.set(grant.grantId, grant);
    return true;
  }

  revoke(grantId: GrantId, policyVersion: PolicyVersion): void {
    this.policyVersion = policyVersion;
    this.grants.delete(grantId);
    this.revokedGrantIds.add(grantId);
  }

  get(grantId: GrantId): PolicyGrantRecord | undefined {
    return this.grants.get(grantId);
  }

  hasTombstone(grantId: GrantId): boolean {
    return this.revokedGrantIds.has(grantId);
  }
}
