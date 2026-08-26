import { describe, it, expect } from 'vitest';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { GrokAuthPreflightError } from '../../adapters/grok-build-adapter.js';
import { CwdValidationError, PendingQueueFullError, SpawnBurstLimitError, HostLoadAdmissionError, QuotaHeadroomAdmissionError } from '../launch-service.js';
import { handleLaunchResult } from './launch-result.js';
import { aTask } from '../../core/__fixtures__/task-builders.js';

function collect(): { send: (msg: ServerMessage) => void; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return { send: (msg) => sent.push(msg), sent };
}

describe('handleLaunchResult', () => {
  it('sends a critical alert whose summary leads with the missing-cwd cause (RFC F12)', () => {
    const { send, sent } = collect();
    const err = new CwdValidationError('Working directory does not exist: /no/such/dir');

    const { duplicate } = handleLaunchResult(send, 'fix the bug', undefined, err);

    expect(duplicate).toBe(false);
    expect(sent).toHaveLength(1);
    const alert = sent[0] as Extract<ServerMessage, { type: 'alert' }>;
    expect(alert.type).toBe('alert');
    expect(alert.severity).toBe('critical');
    expect(alert.summary).toBe(
      'Error starting "fix the bug": Working directory does not exist: /no/such/dir',
    );
    // Cwd-specific recovery details lead with the actual cause instead of the
    // generic checklist that buried "verify the working directory" third.
    expect(alert.details).toMatch(/^The working directory was not found/);
    expect(alert.details).toContain('preserved as a draft');
  });

  it('keeps the generic recovery details for non-cwd launch failures', () => {
    const { send, sent } = collect();

    handleLaunchResult(send, 'fix the bug', undefined, new Error('tmux exploded'));

    const alert = sent[0] as Extract<ServerMessage, { type: 'alert' }>;
    expect(alert.summary).toBe('Error starting "fix the bug": tmux exploded');
    expect(alert.details).toMatch(/^Launch recovery:/);
  });

  it('gives Grok auth preflight failures login-specific recovery details', () => {
    const { send, sent } = collect();

    handleLaunchResult(
      send,
      'run the Grok task',
      undefined,
      new GrokAuthPreflightError('Grok authentication expired; run `grok login --device-code`'),
    );

    const alert = sent[0] as Extract<ServerMessage, { type: 'alert' }>;
    expect(alert.details).toContain('before a terminal session was created');
    expect(alert.details).toContain('grok login --device-code');
    expect(alert.summary).toContain('Grok authentication expired');
  });

  it('distinguishes a dependency-parked launch from a capacity queue', () => {
    const { send, sent } = collect();

    const { duplicate } = handleLaunchResult(send, 'use the knowledge base', {
      task: aTask({ id: 'task-parked', prompt: 'use the knowledge base' }),
      queued: true,
      parked: true,
      dependencyAdmission: {
        status: 'parked',
        reason: 'dependency_degraded',
        dependencies: [{ dependency: 'kb', state: 'degraded' }],
        parkedAt: '2026-08-25T10:00:00.000Z',
      },
    });

    expect(duplicate).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'alert',
      severity: 'warning',
      summary: 'Parked: use the knowledge base',
      details: expect.stringContaining('no worker slot was consumed'),
    });
    expect((sent[0] as Extract<ServerMessage, { type: 'alert' }>).details).toContain('kb=degraded');
  });

  it('reports a parked prompt duplicate as parked rather than already running', () => {
    const { send, sent } = collect();

    const result = handleLaunchResult(send, 'duplicate blocked work', {
      task: aTask({ id: 'task-parked-duplicate', prompt: 'duplicate blocked work', sessions: [] }),
      queued: true,
      parked: true,
      duplicate: true,
      dependencyAdmission: {
        status: 'parked',
        reason: 'dependency_degraded',
        dependencies: [{ dependency: 'kb', state: 'degraded' }],
        parkedAt: '2026-08-25T10:00:00.000Z',
      },
    });

    expect(result.duplicate).toBe(true);
    expect(sent[0]).toMatchObject({
      summary: 'Parked: duplicate blocked work',
      severity: 'warning',
    });
  });

  it('explains when a half-open recovery probe is already in flight', () => {
    const { send, sent } = collect();

    handleLaunchResult(send, 'use the knowledge base', {
      task: aTask({ id: 'task-probe-busy', prompt: 'use the knowledge base' }),
      queued: true,
      parked: true,
      dependencyAdmission: {
        status: 'parked',
        reason: 'half_open_probe_busy',
        dependencies: [{ dependency: 'kb', state: 'half_open', reason: 'A recovery probe is already in flight' }],
        parkedAt: '2026-08-25T10:00:00.000Z',
      },
    });

    expect(sent[0]).toMatchObject({
      type: 'alert',
      severity: 'warning',
      summary: 'Parked: use the knowledge base',
      details: expect.stringContaining('recovery probe is already in flight'),
    });
  });

  // --- Server-side backpressure (issue #1526 Phase C / C3) ---

  const ledger = {
    maxActiveTasks: 10,
    active: 10,
    free: 0,
    byClass: { working: 2, finishedAwaitingAck: 7, hungSuspect: 1, launching: 0 },
    effectiveWorking: 2,
    phantomActive: 8,
    pendingQueueDepth: 24,
    oldestPendingAgeMs: 120_000,
    oldestFinishedAwaitingAckAgeMs: 3_600_000,
  };

  it('renders the capacity breakdown as a warning alert for a pending-queue-full rejection (issue #1526 C3)', () => {
    const { send, sent } = collect();
    const err = new PendingQueueFullError(ledger, 24);

    handleLaunchResult(send, 'burst launch', undefined, err);

    const alert = sent[0] as Extract<ServerMessage, { type: 'alert' }>;
    expect(alert.type).toBe('alert');
    expect(alert.severity).toBe('warning');
    expect(alert.summary).toContain('Pending queue is full');
    // The "why": ledger breakdown, not just an error string.
    expect(alert.details).toContain('10/10 slots occupied');
    expect(alert.details).toContain('awaiting-ack 7');
    expect(alert.details).toContain('hung-suspect 1');
    expect(alert.details).toContain('24 task(s) (limit 24)');
    expect(alert.details).toContain('raise maxPendingTasks');
  });

  it('renders the budget line for a spawn-burst rejection (issue #1526 C3)', () => {
    const { send, sent } = collect();
    const err = new SpawnBurstLimitError(
      { allowed: false, source: 'websocket', count: 30, limit: 30, windowMs: 600_000, retryAfterMs: 42_000 },
      ledger,
    );

    handleLaunchResult(send, 'burst launch', undefined, err);

    const alert = sent[0] as Extract<ServerMessage, { type: 'alert' }>;
    expect(alert.severity).toBe('warning');
    expect(alert.summary).toContain('Spawn burst limit reached');
    expect(alert.details).toContain('30 launches per 10m for source "websocket"');
    expect(alert.details).toContain('retry in ~42s');
    expect(alert.details).toContain('10/10 slots occupied');
  });

  it('renders the host-load line as a warning alert for a CPU-saturation rejection (issue #1630)', () => {
    const { send, sent } = collect();
    const err = new HostLoadAdmissionError(ledger, 2.0, 0.9);

    handleLaunchResult(send, 'hot launch', undefined, err);

    const alert = sent[0] as Extract<ServerMessage, { type: 'alert' }>;
    // A deliberate policy refusal with a retry path — warn, don't page.
    expect(alert.severity).toBe('warning');
    expect(alert.summary).toContain('Host CPU load');
    expect(alert.details).toContain('The host is CPU-saturated');
    expect(alert.details).toContain('2.00 per core (threshold 0.90)');
    expect(alert.details).toContain('KOOKR_MAX_HOST_LOAD_PER_CPU');
    expect(alert.details).toContain('10/10 slots occupied');
  });

  it('renders the quota-headroom line as a warning alert for an exhausted-plan rejection (issue #1894)', () => {
    const { send, sent } = collect();
    const err = new QuotaHeadroomAdmissionError(ledger, 97, 90, '2026-08-02T18:00:00Z');

    handleLaunchResult(send, 'quota launch', undefined, err);

    const alert = sent[0] as Extract<ServerMessage, { type: 'alert' }>;
    expect(alert.severity).toBe('warning');
    expect(alert.summary).toContain('Anthropic plan quota is exhausted');
    expect(alert.details).toContain('Anthropic plan quota is exhausted');
    expect(alert.details).toContain('97%');
    expect(alert.details).toContain('threshold 90%');
    expect(alert.details).toContain('2026-08-02T18:00:00Z');
    expect(alert.details).toContain('10/10 slots occupied');
  });
});
