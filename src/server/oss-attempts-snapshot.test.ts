import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OssAttemptStore } from '../core/oss-attempt-store.js';
import {
  summarizeOssAttemptsForHealth,
  toOssAttemptsSnapshot,
} from './oss-attempts-snapshot.js';

describe('summarizeOssAttemptsForHealth (issue #2332)', () => {
  let tempDir: string;
  let store: OssAttemptStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'oss-health-sum-'));
    store = new OssAttemptStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns zeros when the store is empty', async () => {
    await store.load();
    expect(summarizeOssAttemptsForHealth(store)).toEqual({
      openCount: 0,
      totalCount: 0,
      lastRefreshAt: null,
      issueCheckErrorCount: 0,
    });
  });

  test('counts open vs total and surfaces refresh + issue-check errors', async () => {
    await store.load();
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Open fix',
      source: 'posttool_hook',
      state: 'pr_open',
    });
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 2,
      prUrl: 'https://github.com/grafana/grafana/pull/2',
      prTitle: 'Merged fix',
      source: 'posttool_hook',
      state: 'merged',
    });
    store.upsertPr({
      repo: 'rust-lang/rust',
      prNumber: 3,
      prUrl: 'https://github.com/rust-lang/rust/pull/3',
      prTitle: 'Closed',
      source: 'refresh_poll',
      state: 'closed',
    });
    store.setLastRefreshAt('2026-08-12T00:00:00.000Z');
    store.setLastRefreshIssueCheckErrors([
      { repo: 'grafana/grafana', prNumber: 1, message: 'rate limited' },
      { repo: 'rust-lang/rust', prNumber: 3, message: 'not found' },
    ]);

    expect(summarizeOssAttemptsForHealth(store)).toEqual({
      openCount: 1,
      totalCount: 3,
      lastRefreshAt: '2026-08-12T00:00:00.000Z',
      issueCheckErrorCount: 2,
    });
  });

  test('does not embed the attempts array (health stays slim)', async () => {
    await store.load();
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 10,
      prUrl: 'https://github.com/grafana/grafana/pull/10',
      prTitle: 'Keep slim',
      source: 'posttool_hook',
    });
    const summary = summarizeOssAttemptsForHealth(store);
    expect(summary).not.toHaveProperty('attempts');
    expect(Object.keys(summary).sort()).toEqual([
      'issueCheckErrorCount',
      'lastRefreshAt',
      'openCount',
      'totalCount',
    ]);

    // Full snapshot still carries the array for the dedicated endpoint.
    const full = toOssAttemptsSnapshot(store);
    expect(full.attempts).toHaveLength(1);
  });
});
