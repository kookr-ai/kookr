/**
 * Smoke coverage for LocalDtach capability modules extracted in #1465.
 * Full behavior remains in local-dtach-backend.test.ts (characterization).
 */
import { describe, expect, it } from 'vitest';
import {
  buildDtachSpawn,
  DEFAULT_MAX_SESSION_ID_LEN,
  RECONNECT_CAP,
  RINGS_DIRNAME,
} from './local-dtach-shared.js';
import {
  findAgentPidSync,
  findDtachMasterPidSync,
  verifyMasterIdentity,
} from './local-dtach-process-identity.js';
import { LocalDtachStream } from './local-dtach-stream.js';
import { LocalDtachRecovery } from './local-dtach-recovery.js';

describe('local-dtach capability modules (#1465)', () => {
  it('shared exports spawn helper and policy constants', () => {
    expect(DEFAULT_MAX_SESSION_ID_LEN).toBe(40);
    expect(RECONNECT_CAP).toBe(3);
    expect(RINGS_DIRNAME).toBe('rings');
    const linux = buildDtachSpawn('linux', 'dtach', ['-n', '/tmp/x.sock']);
    expect(linux.command).toBe('setsid');
    expect(linux.args[0]).toBe('-f');
  });

  it('process-identity rejects impossible pids without throwing', () => {
    expect(verifyMasterIdentity(-1, '/tmp/missing.sock', 'dtach')).toBe(false);
    expect(verifyMasterIdentity(1, '/tmp/definitely-not-a-dtach.sock', 'dtach')).toBe(false);
    expect(findDtachMasterPidSync('/tmp/definitely-not-a-dtach.sock', 'dtach')).toBe(-1);
    expect(findAgentPidSync(-1)).toBeNull();
  });

  it('stream and recovery collaborators are constructible', () => {
    expect(typeof LocalDtachStream).toBe('function');
    expect(typeof LocalDtachRecovery).toBe('function');
  });
});
