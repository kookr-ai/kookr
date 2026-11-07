import type { DelegationConfig, ValidatedWorker } from '../registry.js';
import { DELEGATION_SCHEMA_VERSION, type Delegation } from '../store.js';

/** A valid single-project, two-worker configuration for tests. Tokens are supplied separately. */
export function makeConfig(overrides: Partial<DelegationConfig> = {}): DelegationConfig {
  return {
    snapshotsRoot: '/snapshots',
    containerSnapshotsPath: '/opt/workspace',
    maxDelegations: 8,
    allowedHosts: [],
    acceptingNewDelegations: true,
    weakTokenHashes: [],
    projects: { proj: { repoDir: '/repo', githubRepo: 'owner/proj' } },
    workers: [
      worker('w1'),
      worker('w2'),
    ],
    ...overrides,
  };
}

export function worker(name: string, overrides: Partial<ValidatedWorker> = {}): ValidatedWorker {
  return {
    name,
    url: `http://127.0.0.1:1/${name}`,
    tokenFile: `/tokens/${name}`,
    projects: ['proj'],
    maxInFlight: 2,
    operatorAttestedLeaf: true,
    workspaceMode: 'ro',
    replyTimeoutSec: 300,
    ...overrides,
  };
}

export function tokenMap(entries: Record<string, string | undefined>): Map<string, string | undefined> {
  return new Map(Object.entries(entries));
}

let counter = 0;
export function rec(overrides: Partial<Delegation> = {}): Delegation {
  counter++;
  return {
    id: `d-${counter}`,
    schemaVersion: DELEGATION_SCHEMA_VERSION,
    kind: 'triage',
    projectId: 'proj',
    issueRef: 1,
    workerId: 'w1',
    baseSha: 'a'.repeat(40),
    promptVersion: 'triage-v1',
    contextId: `kookr-test-${counter}`,
    state: 'working',
    submittedAt: 1_000,
    deadlineAt: 241_000,
    ...overrides,
  };
}
