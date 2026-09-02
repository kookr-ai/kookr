import { describe, expect, it } from 'vitest';

import type { RelayDoctorReport } from './relay-lifecycle-contracts.js';
import { relayDoctorExitPolicy } from './relay-lifecycle-exit-policy.js';

function healthyReport(): RelayDoctorReport {
  return {
    checkedAt: '2026-09-02T00:00:00.000Z',
    paths: {
      kookrDir: '/tmp/.kookr',
      pidPath: '/tmp/.kookr/relay.pid',
      logPath: '/tmp/.kookr/relay.log',
      statePath: '/tmp/.kookr/relay-state.json',
      dbPath: '/tmp/.kookr/relay-state.sqlite',
    },
    process: {
      state: 'running',
      bindHost: '127.0.0.1',
      port: 4820,
      relayUrl: 'http://127.0.0.1:4820',
      message: 'Relay is running.',
    },
    env: {
      state: 'ok',
      envFilePath: '/tmp/.env',
      envFilePresent: true,
      adminTokenConfigured: true,
      insecureDev: false,
      processAdminTokenConfigured: true,
      requiresRestart: false,
      message: 'Env is configured.',
    },
    node: {
      state: 'ok',
      message: 'Node credential works.',
    },
    storage: {
      state: 'ok',
      dbPath: '/tmp/.kookr/relay-state.sqlite',
      message: 'Relay state database path is writable.',
    },
    policy: {
      status: 'ok',
      nodeCount: 1,
      invitationCount: 0,
      maxPolicyVersion: 1,
    },
    recentLogs: [],
    nextActions: [],
  };
}

describe('relayDoctorExitPolicy', () => {
  it('exits 0 for a healthy report', () => {
    const policy = relayDoctorExitPolicy(healthyReport());
    expect(policy.exitCode).toBe(0);
    expect(policy.fatalReasons).toEqual([]);
  });

  it('exits non-zero when the relay is stopped', () => {
    const report = healthyReport();
    report.process = { ...report.process, state: 'stopped', message: 'Relay is not running.' };
    const policy = relayDoctorExitPolicy(report);
    expect(policy.exitCode).not.toBe(0);
    expect(policy.fatalReasons.join('\n')).toContain('process:stopped');
  });

  it.each(['stale-pid', 'foreign-process', 'foreign-port'] as const)(
    'exits non-zero for process state %s',
    (state) => {
      const report = healthyReport();
      report.process = { ...report.process, state };
      const policy = relayDoctorExitPolicy(report);
      expect(policy.exitCode).not.toBe(0);
      expect(policy.fatalReasons.join('\n')).toContain(`process:${state}`);
    },
  );

  it.each(['missing-env', 'missing-admin-token', 'restart-required'] as const)(
    'exits non-zero for env state %s',
    (state) => {
      const report = healthyReport();
      report.env = { ...report.env, state };
      const policy = relayDoctorExitPolicy(report);
      expect(policy.exitCode).not.toBe(0);
      expect(policy.fatalReasons.join('\n')).toContain(`env:${state}`);
    },
  );

  it('exits non-zero when the state database is not writable', () => {
    const report = healthyReport();
    report.storage = { ...report.storage, state: 'db-write-failed', message: 'not writable' };
    const policy = relayDoctorExitPolicy(report);
    expect(policy.exitCode).not.toBe(0);
    expect(policy.fatalReasons.join('\n')).toContain('storage:db-write-failed');
  });

  it('stays non-fatal when only the admin policy summary is unavailable', () => {
    const report = healthyReport();
    report.policy = { status: 'unavailable' };
    const policy = relayDoctorExitPolicy(report);
    expect(policy.exitCode).toBe(0);
    expect(policy.fatalReasons).toEqual([]);
  });

  it('stays non-fatal when policy diagnostics are unauthorized', () => {
    const report = healthyReport();
    report.policy = { status: 'unauthorized' };
    expect(relayDoctorExitPolicy(report).exitCode).toBe(0);
  });

  it.each(['token-rejected', 'unreachable', 'error'] as const)(
    'stays non-fatal when only the relay node is degraded (%s)',
    (state) => {
      const report = healthyReport();
      report.node = { state, message: 'node degraded' };
      const policy = relayDoctorExitPolicy(report);
      expect(policy.exitCode).toBe(0);
      expect(policy.fatalReasons).toEqual([]);
    },
  );

  it('reports every required failure together', () => {
    const report = healthyReport();
    report.process = { ...report.process, state: 'stopped' };
    report.env = { ...report.env, state: 'missing-env' };
    report.storage = { ...report.storage, state: 'db-write-failed' };
    const policy = relayDoctorExitPolicy(report);
    expect(policy.exitCode).not.toBe(0);
    expect(policy.fatalReasons).toHaveLength(3);
  });
});
