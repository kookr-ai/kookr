import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { IssueClaimsAuditLog, bindAuditSink } from './issue-claims-audit-log.js';
import type { ClaimEvent } from '../core/issue-claim-types.js';

describe('IssueClaimsAuditLog', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'issue-claims-audit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('append writes one parseable JSONL row with ts + fields, omitting undefined fields', async () => {
    const log = new IssueClaimsAuditLog({ kookrDir: dir, now: () => new Date('2026-07-02T00:00:00.000Z') });
    const event: ClaimEvent = {
      decision: 'granted',
      repo: 'github.com/acme/widgets',
      number: 42,
      requestingTaskId: 'task-1',
    };

    const ok = await log.append(event);

    expect(ok).toBe(true);
    const filePath = join(dir, 'issue-claims-audit.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!);
    expect(row).toEqual({
      ts: '2026-07-02T00:00:00.000Z',
      decision: 'granted',
      repo: 'github.com/acme/widgets',
      number: 42,
      requestingTaskId: 'task-1',
    });
    expect('requestingSessionId' in row).toBe(false);
    expect('priorOwnerTaskId' in row).toBe(false);
    expect('reason' in row).toBe(false);
  });

  test('multiple appends accumulate lines', async () => {
    const log = new IssueClaimsAuditLog({ kookrDir: dir });
    await log.append({ decision: 'granted', repo: 'github.com/acme/widgets', number: 1 });
    await log.append({ decision: 'released', repo: 'github.com/acme/widgets', number: 1 });
    await log.append({ decision: 'denied', repo: 'github.com/acme/widgets', number: 2, reason: 'owned by another task' });

    const filePath = join(dir, 'issue-claims-audit.jsonl');
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).decision).toBe('granted');
    expect(JSON.parse(lines[1]!).decision).toBe('released');
    expect(JSON.parse(lines[2]!).reason).toBe('owned by another task');
  });

  test('disabled (filePath null) returns true and writes no file', async () => {
    const log = new IssueClaimsAuditLog({ filePath: null });

    const ok = await log.append({ decision: 'granted', repo: 'github.com/acme/widgets', number: 1 });

    expect(ok).toBe(true);
    expect(existsSync(join(dir, 'issue-claims-audit.jsonl'))).toBe(false);
    expect(log.status()).toEqual({ configured: false, writable: true });
  });

  test('write failure returns false, marks status().writable false, and does not throw', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = new IssueClaimsAuditLog({ filePath: '/nonexistent-root-dir/x.jsonl' });

    const ok = await log.append({ decision: 'granted', repo: 'github.com/acme/widgets', number: 1 });

    expect(ok).toBe(false);
    const status = log.status();
    expect(status.configured).toBe(true);
    expect(status.writable).toBe(false);
    expect(status.lastFailure?.message).toBeTruthy();
    expect(status.lastFailure?.ts).toBeTruthy();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[issue-claims-audit] append failed:'));

    consoleErrorSpy.mockRestore();
  });

  test('a subsequent successful append clears lastFailure', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Parent path is a FILE, so mkdir/append fail; after replacing it with a
    // real directory, the same instance must recover and clear lastFailure.
    const obstruction = join(dir, 'blocked');
    writeFileSync(obstruction, 'not a directory');
    const log = new IssueClaimsAuditLog({ filePath: join(obstruction, 'x.jsonl') });
    await log.append({ decision: 'granted', repo: 'github.com/acme/widgets', number: 1 });
    expect(log.status().writable).toBe(false);
    expect(log.status().lastFailure).toBeDefined();

    rmSync(obstruction);
    mkdirSync(obstruction);
    const ok = await log.append({ decision: 'granted', repo: 'github.com/acme/widgets', number: 2 });
    expect(ok).toBe(true);
    expect(log.status().writable).toBe(true);
    expect(log.status().lastFailure).toBeUndefined();
    consoleErrorSpy.mockRestore();
  });
});

describe('bindAuditSink', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'issue-claims-audit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('emit does not throw on failure and fires the append', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = new IssueClaimsAuditLog({ filePath: '/nonexistent-root-dir/x.jsonl' });
    const emit = bindAuditSink(log);

    expect(() => emit({ decision: 'granted', repo: 'github.com/acme/widgets', number: 1 })).not.toThrow();

    // The emit is fire-and-forget; under a loaded suite one macrotask tick is
    // not always enough for the failed append to settle — poll instead.
    await vi.waitFor(() => {
      expect(log.status().writable).toBe(false);
    });

    consoleErrorSpy.mockRestore();
  });

  test('emit appends successfully when the sink is configured', async () => {
    const log = new IssueClaimsAuditLog({ kookrDir: dir });
    const emit = bindAuditSink(log);

    emit({ decision: 'granted', repo: 'github.com/acme/widgets', number: 7, requestingTaskId: 'task-9' });

    // Fire-and-forget append; poll until the write lands (one macrotask tick
    // is not always enough under a loaded suite).
    const filePath = join(dir, 'issue-claims-audit.jsonl');
    await vi.waitFor(() => {
      expect(existsSync(filePath)).toBe(true);
    });
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).requestingTaskId).toBe('task-9');
  });
});
