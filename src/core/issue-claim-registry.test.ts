import { describe, expect, it, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IssueClaimRegistry } from './issue-claim-registry.js';
import type { ClaimEvent, ClaimTaskPort, ClaimTaskView, IssueClaim } from './issue-claim-types.js';
import type { TaskStatus } from './task-status.js';

const KEY = { repo: 'github.com/kookr-ai/kookr', number: 779 };
const OTHER_KEY = { repo: 'github.com/kookr-ai/kookr', number: 780 };

/** In-memory ClaimTaskPort double mirroring TaskStore semantics. */
class FakePort implements ClaimTaskPort {
  tasks = new Map<string, ClaimTaskView>();

  addTask(id: string, status: TaskStatus = 'open', extra: Partial<ClaimTaskView> = {}): void {
    this.tasks.set(id, { id, status, ...extra });
  }

  setStatus(id: string, status: TaskStatus): void {
    const t = this.tasks.get(id);
    if (t) t.status = status;
  }

  activeTaskViews(): ClaimTaskView[] {
    return Array.from(this.tasks.values());
  }

  getTaskView(taskId: string): ClaimTaskView | undefined {
    return this.tasks.get(taskId);
  }

  setIssueClaim(taskId: string, claim: IssueClaim): void {
    const t = this.tasks.get(taskId);
    if (t) t.issueClaim = claim;
  }

  clearIssueClaim(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (t) delete t.issueClaim;
  }
}

describe('IssueClaimRegistry', () => {
  let port: FakePort;
  let events: ClaimEvent[];
  let registry: IssueClaimRegistry;

  beforeEach(() => {
    port = new FakePort();
    events = [];
    registry = new IssueClaimRegistry(port, (e) => events.push(e));
  });

  it('grants a free key and stamps the projection field', () => {
    port.addTask('a');
    const result = registry.claim(KEY, { taskId: 'a', sessionId: 'kookr-aaa' });
    expect(result).toMatchObject({ ok: true, reentrant: false });
    expect(port.tasks.get('a')?.issueClaim).toMatchObject({ repo: KEY.repo, number: 779, sessionId: 'kookr-aaa' });
    expect(events.map((e) => e.decision)).toEqual(['granted']);
  });

  it('two claimants in the same tick: exactly one wins, loser gets the owner block', () => {
    port.addTask('a', 'open', { name: 'batch child' });
    port.addTask('b');
    const first = registry.claim(KEY, { taskId: 'a' });
    const second = registry.claim(KEY, { taskId: 'b' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.owner.taskId).toBe('a');
      expect(second.owner.ownerName).toBe('batch child');
      expect(second.owner.number).toBe(779);
    }
    expect(events.map((e) => e.decision)).toEqual(['granted', 'denied']);
    expect(port.tasks.get('b')?.issueClaim).toBeUndefined();
  });

  it('is re-entrant for the owner', () => {
    port.addTask('a');
    registry.claim(KEY, { taskId: 'a' });
    const again = registry.claim(KEY, { taskId: 'a' });
    expect(again).toMatchObject({ ok: true, reentrant: true });
    expect(events.map((e) => e.decision)).toEqual(['granted', 'reentrant']);
  });

  it('claim() is fully synchronous — no await between check and set', () => {
    // Structural invariant (RFC R4): the CAS body must contain no `await`
    // and must not return a Promise.
    port.addTask('a');
    const result: unknown = registry.claim(KEY, { taskId: 'a' });
    expect(result).not.toBeInstanceOf(Promise);
    // Scan claim() AND the private helpers it delegates to — asynchrony in
    // grant()/releaseAllFor() would reopen the check-then-act gap without
    // 'await' appearing in claim's own body.
    for (const name of ['claim', 'releaseAllFor'] as const) {
      const fn = IssueClaimRegistry.prototype[name] as unknown as { constructor: { name: string } };
      expect(fn.constructor.name).not.toBe('AsyncFunction');
      expect(String(fn)).not.toContain('await');
      expect(String(fn)).not.toContain('.then(');
    }
  });

  it('reclaims a terminal holder inline (orphan backstop) and grants', () => {
    port.addTask('a');
    port.addTask('b');
    registry.claim(KEY, { taskId: 'a' });
    port.setStatus('a', 'completed'); // wrapper release missed (backstop path)
    const result = registry.claim(KEY, { taskId: 'b' });
    expect(result.ok).toBe(true);
    expect(events.map((e) => e.decision)).toEqual(['granted', 'orphan_reclaim', 'granted']);
    expect(port.tasks.get('a')?.issueClaim).toBeUndefined();
  });

  it('reclaims a deleted holder inline and grants', () => {
    port.addTask('a');
    port.addTask('b');
    registry.claim(KEY, { taskId: 'a' });
    port.tasks.delete('a');
    const result = registry.claim(KEY, { taskId: 'b' });
    expect(result.ok).toBe(true);
    expect(events.filter((e) => e.decision === 'orphan_reclaim')).toHaveLength(1);
  });

  it('does NOT reclaim a live-but-quiet owner (synchronous status only)', () => {
    port.addTask('a', 'inProgress');
    port.addTask('b');
    registry.claim(KEY, { taskId: 'a' });
    const result = registry.claim(KEY, { taskId: 'b' });
    expect(result.ok).toBe(false); // no liveness probe, no time-based reclaim in claim()
  });

  it('releaseAllFor is holder-checked: an old displaced owner cannot delete the new owner claim', () => {
    port.addTask('a');
    port.addTask('b');
    registry.claim(KEY, { taskId: 'a' });
    registry.claim(KEY, { taskId: 'b' }, { force: true }); // b displaces a
    const releasedForA = registry.releaseAllFor('a'); // a goes terminal later
    expect(releasedForA).toEqual([]); // a owns nothing anymore
    expect(registry.ownerRecord(KEY)?.taskId).toBe('b'); // b's claim intact
  });

  it('force displaces a live owner, records takeoverOf, clears the displaced field', () => {
    port.addTask('a', 'inProgress');
    port.addTask('b');
    registry.claim(KEY, { taskId: 'a' });
    const result = registry.claim(KEY, { taskId: 'b' }, { force: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tookOver?.taskId).toBe('a');
    expect(port.tasks.get('a')?.issueClaim).toBeUndefined();
    expect(port.tasks.get('b')?.issueClaim).toMatchObject({ takeoverOf: 'a' });
    expect(events.some((e) => e.decision === 'force' && e.priorOwnerTaskId === 'a')).toBe(true);
  });

  it('double-force in the same tick: second force sees the first forcer as owner', () => {
    port.addTask('a', 'inProgress');
    port.addTask('b');
    port.addTask('c');
    registry.claim(KEY, { taskId: 'a' });
    registry.claim(KEY, { taskId: 'b' }, { force: true });
    const second = registry.claim(KEY, { taskId: 'c' }, { force: true });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.tookOver?.taskId).toBe('b'); // not 'a' — no double-grant from stale reads
    expect(registry.ownerRecord(KEY)?.taskId).toBe('c');
  });

  it('one claim per task: claiming a new key releases the old one', () => {
    port.addTask('a');
    registry.claim(KEY, { taskId: 'a' });
    registry.claim(OTHER_KEY, { taskId: 'a' });
    expect(registry.ownerRecord(KEY)).toBeNull();
    expect(registry.ownerRecord(OTHER_KEY)?.taskId).toBe('a');
  });

  it('releaseAllFor emits the given reason and returns the freed keys', () => {
    port.addTask('a');
    registry.claim(KEY, { taskId: 'a' });
    const released = registry.releaseAllFor('a', 'dead_reclaim');
    expect(released).toEqual([{ repo: KEY.repo, number: 779 }]);
    expect(events.at(-1)).toMatchObject({ decision: 'dead_reclaim', number: 779 });
    expect(registry.ownerRecord(KEY)).toBeNull();
  });

  it('rebuildFromTasks restores owners from non-terminal fields and ignores terminal ones', () => {
    const claim: IssueClaim = { repo: KEY.repo, number: 779, claimedAt: new Date().toISOString() };
    port.addTask('live', 'inProgress', { issueClaim: claim });
    port.addTask('done', 'completed', { issueClaim: { ...claim, number: 780 } });
    const summary = registry.rebuildFromTasks();
    expect(summary).toMatchObject({ owners: 1, ignoredTerminalFields: 1 });
    expect(registry.ownerRecord(KEY)?.taskId).toBe('live');
    expect(registry.ownerRecord(OTHER_KEY)).toBeNull();
  });

  it('listRecords filters by repo and number', () => {
    port.addTask('a');
    port.addTask('b');
    registry.claim(KEY, { taskId: 'a' });
    registry.claim({ repo: 'github.com/jeanibarz/lucy', number: 12 }, { taskId: 'b' });
    expect(registry.listRecords()).toHaveLength(2);
    expect(registry.listRecords({ repo: KEY.repo })).toHaveLength(1);
    expect(registry.listRecords({ repo: KEY.repo, number: 780 })).toHaveLength(0);
  });
});

describe('issueClaim single-writer guard (RFC R3)', () => {
  it('setIssueClaim/clearIssueClaim are called only from the registry and TaskStore', () => {
    // Structural enforcement: grep the src tree for call sites. Allowed:
    // the registry (via the port) and tasks.ts (the definitions). Any other
    // caller is a drift regression — see rfc-issue-ownership-lock R3.
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = join(here, '..');
    let out = '';
    try {
      out = execFileSync(
        'grep',
        ['-rn', '--include=*.ts', '-E', '\\.(setIssueClaim|clearIssueClaim)\\(', srcRoot],
        { encoding: 'utf8' },
      );
    } catch {
      out = ''; // grep exits 1 on no matches
    }
    const offenders = out
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.includes('.test.ts'))
      // Exact allowlist (R3): the registry, the TaskStore definitions, and
      // the wiring module that implements ClaimTaskPort by delegation.
      // Deliberately NOT a prefix match — a new file merely containing
      // 'issue-claim' in its name must not be exempt.
      .filter((line) => !/\/core\/issue-claim-registry\.ts:/.test(line))
      .filter((line) => !/\/core\/tasks\.ts:/.test(line))
      .filter((line) => !/\/server\/issue-claim-wiring\.ts:/.test(line));
    expect(offenders).toEqual([]);
  });
});
