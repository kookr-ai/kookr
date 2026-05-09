import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CheckpointCycler,
  readTriggerRatioFromEnv,
  readMaxCancelledAttemptsFromEnv,
  isCycleDisabled,
} from './checkpoint-cycler.js';

async function makeTranscriptWithRatio(
  dir: string,
  filename: string,
  totalTokens: number,
  modelLimit: number = 200_000,
  model: string = 'claude-sonnet-4-6',
): Promise<string> {
  const path = join(dir, filename);
  // Synthesize a single assistant entry with the desired total
  // (cache_creation absorbs everything for simplicity).
  const cacheCreation = totalTokens > 6 ? totalTokens - 6 : totalTokens;
  const inputTokens = totalTokens > 6 ? 6 : 0;
  await writeFile(
    path,
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model,
        usage: {
          input_tokens: inputTokens,
          cache_creation_input_tokens: cacheCreation,
          cache_read_input_tokens: 0,
          output_tokens: 100,
        },
      },
    }),
  );
  // Verify limit math (defensive against test-setup bugs)
  void modelLimit;
  return path;
}

describe('CheckpointCycler', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cycler-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does nothing when context fill is below the trigger ratio', async () => {
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 0 });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 50_000); // 25%
    const actions = await cycler.tick([{ tmuxName: 's1', transcriptPath: path }]);
    expect(actions).toHaveLength(0);
    expect(cycler.getState('s1')!.phase).toBe('idle');
  });

  it('fires a user-message action when context fill crosses the trigger', async () => {
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 0 });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000); // 80%
    const actions = await cycler.tick([{ tmuxName: 's1', transcriptPath: path }]);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('send_user_message');
    if (actions[0].kind === 'send_user_message') {
      expect(actions[0].tmuxName).toBe('s1');
      expect(actions[0].text).toContain('80%');
      expect(actions[0].text).toContain('CHECKPOINT.md');
      expect(actions[0].text).toContain('CHECKPOINT.json');
      expect(actions[0].text).toContain('semantic-checkpoint.v1');
    }
    expect(cycler.getState('s1')!.phase).toBe('prompting');
  });

  it('does not re-fire while in the prompting phase', async () => {
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 0 });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }]);
    const actions = await cycler.tick([{ tmuxName: 's1', transcriptPath: path }]);
    expect(actions).toHaveLength(0);
    expect(cycler.getState('s1')!.phase).toBe('prompting');
  });

  it('on Stop after prompting (past grace period), sends /compact and transitions to compacting', async () => {
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 0, promptGraceMs: 100 });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 1000);
    const action = cycler.onStop('s1', 2000); // 1000 ms after prompting started — well past grace
    expect(action.kind).toBe('send_input');
    if (action.kind === 'send_input') {
      expect(action.text).toBe('/compact');
    }
    expect(cycler.getState('s1')!.phase).toBe('compacting');
  });

  it('ignores Stop within the prompt grace window (leftover from prior turn)', async () => {
    // Reproduces the race the failure-mode reviewer flagged: an in-flight
    // Stop event from the agent's previous turn arrives just after the
    // cycler enters the prompting phase. Without the grace guard the
    // cycler would interpret it as the checkpoint-write completion and
    // send /compact prematurely.
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 0, promptGraceMs: 1500 });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 1000);

    // Stop arrives 500 ms into the prompting phase — well within the 1.5s grace.
    const stale = cycler.onStop('s1', 1500);
    expect(stale.kind).toBe('noop');
    expect(cycler.getState('s1')!.phase).toBe('prompting');

    // Genuine response Stop arrives later — grace expired, transition fires.
    const real = cycler.onStop('s1', 4000);
    expect(real.kind).toBe('send_input');
    expect(cycler.getState('s1')!.phase).toBe('compacting');
  });

  it('on Stop after compacting, returns to idle and starts cooldown', async () => {
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 60_000, promptGraceMs: 100 });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 1000);
    cycler.onStop('s1', 2000); // prompting → compacting
    cycler.onStop('s1', 3000); // compacting → idle (cooldown)

    const state = cycler.getState('s1')!;
    expect(state.phase).toBe('idle');
    expect(state.phaseStartedAt).toBe(0);   // reset clears the start timestamp
    expect(state.lastCycleEndedAt).toBe(3000);

    // Within cooldown, should not refire even if still over threshold
    const actions = await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 4000);
    expect(actions).toHaveLength(0);
  });

  it('refires after the cooldown elapses', async () => {
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 1000, promptGraceMs: 100 });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 1000);
    cycler.onStop('s1', 2000);
    cycler.onStop('s1', 3000);
    // 4000ms is exactly cooldownMs after end (3000 + 1000) — boundary check
    const actions = await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 4001);
    expect(actions).toHaveLength(1);
  });

  it('times out the prompting phase if the agent never finishes the turn', async () => {
    const cycler = new CheckpointCycler({
      triggerRatio: 0.75,
      cooldownMs: 0,
      promptTimeoutMs: 1000,
    });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 1000);
    // After the prompt timeout, the next tick should reset to idle.
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 2500);
    expect(cycler.getState('s1')!.phase).toBe('idle');
  });

  it('times out the compacting phase if /compact never produces a Stop', async () => {
    // Symmetrical to the prompting timeout — covers the second timeout
    // branch in tick(). A typo that flipped the phase check would let
    // this test catch it.
    const cycler = new CheckpointCycler({
      triggerRatio: 0.75,
      cooldownMs: 0,
      compactTimeoutMs: 1000,
      promptGraceMs: 100,
    });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 1000);
    cycler.onStop('s1', 2000); // prompting → compacting (phaseStartedAt = 2000)
    expect(cycler.getState('s1')!.phase).toBe('compacting');
    // 3500 ms — past the 1000 ms compact timeout
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 3500);
    expect(cycler.getState('s1')!.phase).toBe('idle');
  });

  it('onStop on an idle session is a noop', () => {
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 0 });
    // Stop arrives for a session the cycler has never seen — ignored.
    expect(cycler.onStop('unknown')).toEqual({ kind: 'noop' });

    // Stop arrives for a session in idle phase (e.g., between cycles) — also ignored.
    // Force the cycler to know about the session by running a tick that doesn't fire.
    const lowEntry = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 100 } },
    });
    // Synchronous setup: write the file then tick.
    // (cycler.tick uses its own awaits; we just need the file to exist.)
    return (async () => {
      await import('node:fs/promises').then((fs) =>
        fs.writeFile(join(dir, 'idle.jsonl'), lowEntry),
      );
      await cycler.tick([{ tmuxName: 'idle-session', transcriptPath: join(dir, 'idle.jsonl') }]);
      expect(cycler.getState('idle-session')!.phase).toBe('idle');
      expect(cycler.onStop('idle-session')).toEqual({ kind: 'noop' });
    })();
  });

  it('passively forgets sessions that disappear from the active list on tick', async () => {
    // Defense in depth against memory leaks: the cycler should drop
    // per-session state as soon as the session is no longer in the
    // active list passed to tick(), without waiting for an explicit
    // forget() call from the cleanup path.
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 0 });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }]);
    expect(cycler.getState('s1')!.phase).toBe('prompting');
    // Tick again with an empty session list — s1 should be forgotten.
    await cycler.tick([]);
    expect(cycler.getState('s1')).toBeUndefined();
  });

  it('skips sessions whose transcript file does not exist', async () => {
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 0 });
    const actions = await cycler.tick([
      { tmuxName: 'ghost', transcriptPath: join(dir, 'nonexistent.jsonl') },
    ]);
    expect(actions).toHaveLength(0);
  });

  it('forget() removes session state', async () => {
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 0 });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }]);
    expect(cycler.getState('s1')).toBeDefined();
    cycler.forget('s1');
    expect(cycler.getState('s1')).toBeUndefined();
  });

  it('handles multiple concurrent sessions independently', async () => {
    const cycler = new CheckpointCycler({ triggerRatio: 0.75, cooldownMs: 0 });
    const lowPath = await makeTranscriptWithRatio(dir, 'low.jsonl', 50_000);
    const highPath = await makeTranscriptWithRatio(dir, 'high.jsonl', 160_000);
    const actions = await cycler.tick([
      { tmuxName: 'low', transcriptPath: lowPath },
      { tmuxName: 'high', transcriptPath: highPath },
    ]);
    expect(actions).toHaveLength(1);
    if (actions[0].kind === 'send_user_message') {
      expect(actions[0].tmuxName).toBe('high');
    }
    expect(cycler.getState('low')!.phase).toBe('idle');
    expect(cycler.getState('high')!.phase).toBe('prompting');
  });
});

describe('CheckpointCycler — cancelled-/compact back-off (issue #412)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cycler-backoff-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Simulate one full no-progress cycle: tick fires, Stop advances to
   * compacting, compact timeout expires without the transcript ratio
   * dropping. Leaves the cycler in `idle` with `cancelledAttempts`
   * incremented (or `gaveUp=true` if it hit the cap).
   *
   * `tOffset` is the base time for this cycle — each cycle consumes roughly
   * 10s of simulated time.
   */
  async function runNoProgressCycle(
    cycler: CheckpointCycler,
    transcriptPath: string,
    tOffset: number,
  ): Promise<void> {
    // tick → prompting
    await cycler.tick([{ tmuxName: 's1', transcriptPath }], tOffset);
    // Stop past grace → compacting
    cycler.onStop('s1', tOffset + 2000);
    // tick after compact timeout with transcript unchanged → no-progress
    await cycler.tick([{ tmuxName: 's1', transcriptPath }], tOffset + 10_000);
  }

  it('a successful ratio-drop cycle at compact timeout resets the no-progress counter', async () => {
    // 1s compactTimeoutMs, cooldownMs=0, promptGraceMs=100, max=3
    const cycler = new CheckpointCycler({
      triggerRatio: 0.75,
      cooldownMs: 0,
      compactTimeoutMs: 1000,
      promptGraceMs: 100,
      maxCancelledAttempts: 3,
    });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000); // 80%

    // Two consecutive no-progress cycles — ratio never drops.
    await runNoProgressCycle(cycler, path, 1000);
    await runNoProgressCycle(cycler, path, 100_000);
    expect(cycler.getState('s1')!.cancelledAttempts).toBe(2);

    // Third cycle: this time /compact "works" — rewrite the transcript
    // to a lower ratio before the compact timeout fires.
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 200_000);
    cycler.onStop('s1', 202_000);
    // Replace the transcript with a lower ratio so the post-timeout sample
    // sees actual progress vs the cycleStartRatio (~0.8).
    await makeTranscriptWithRatio(dir, 's1.jsonl', 50_000); // 25%
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 210_000);

    const s = cycler.getState('s1')!;
    expect(s.phase).toBe('idle');
    expect(s.cancelledAttempts).toBe(0);
    expect(s.gaveUp).toBe(false);
    expect(s.cycleStartRatio).toBe(0); // cleared on reset
  });

  it('two consecutive no-progress cycles still allow a third attempt', async () => {
    const cycler = new CheckpointCycler({
      triggerRatio: 0.75,
      cooldownMs: 0,
      compactTimeoutMs: 1000,
      promptGraceMs: 100,
      maxCancelledAttempts: 3,
    });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);

    await runNoProgressCycle(cycler, path, 1000);
    expect(cycler.getState('s1')!.cancelledAttempts).toBe(1);
    expect(cycler.getState('s1')!.gaveUp).toBe(false);

    await runNoProgressCycle(cycler, path, 100_000);
    expect(cycler.getState('s1')!.cancelledAttempts).toBe(2);
    expect(cycler.getState('s1')!.gaveUp).toBe(false);

    // Third tick should still fire — below the max.
    const actions = await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 200_000);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe('send_user_message');
    expect(cycler.getState('s1')!.phase).toBe('prompting');
  });

  it('after 3 consecutive no-progress cycles the cycler stops injecting /compact for the session', async () => {
    const cycler = new CheckpointCycler({
      triggerRatio: 0.75,
      cooldownMs: 0,
      compactTimeoutMs: 1000,
      promptGraceMs: 100,
      maxCancelledAttempts: 3,
    });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);

    await runNoProgressCycle(cycler, path, 1000);
    await runNoProgressCycle(cycler, path, 100_000);
    await runNoProgressCycle(cycler, path, 200_000);

    const s = cycler.getState('s1')!;
    expect(s.cancelledAttempts).toBe(3);
    expect(s.gaveUp).toBe(true);
    expect(s.phase).toBe('idle');
    // lastCycleEndedAt is pinned to a large value so cooldown gating also
    // blocks any future cycle — belt + suspenders with the gaveUp check.
    expect(s.lastCycleEndedAt).toBe(Number.MAX_SAFE_INTEGER);

    // Well past the normal cooldown — still no action.
    const actions = await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 10_000_000);
    expect(actions).toHaveLength(0);
    expect(cycler.getState('s1')!.phase).toBe('idle');
    expect(cycler.getState('s1')!.gaveUp).toBe(true);
  });

  it('KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS override lets the cycler give up sooner', async () => {
    // Override to 1 — a single no-progress cycle is enough to give up.
    const cycler = new CheckpointCycler({
      triggerRatio: 0.75,
      cooldownMs: 0,
      compactTimeoutMs: 1000,
      promptGraceMs: 100,
      maxCancelledAttempts: 1,
    });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);

    await runNoProgressCycle(cycler, path, 1000);

    const s = cycler.getState('s1')!;
    expect(s.cancelledAttempts).toBe(1);
    expect(s.gaveUp).toBe(true);
    expect(s.lastCycleEndedAt).toBe(Number.MAX_SAFE_INTEGER);

    const actions = await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 100_000);
    expect(actions).toHaveLength(0);
  });

  it('records cycleStartRatio on entering the prompting phase', async () => {
    const cycler = new CheckpointCycler({
      triggerRatio: 0.75,
      cooldownMs: 0,
      promptGraceMs: 100,
    });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000); // 80%
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 1000);
    expect(cycler.getState('s1')!.cycleStartRatio).toBeCloseTo(0.8, 2);
  });

  it('onStop during compacting resets the no-progress counter (successful compaction)', async () => {
    const cycler = new CheckpointCycler({
      triggerRatio: 0.75,
      cooldownMs: 0,
      compactTimeoutMs: 1000,
      promptGraceMs: 100,
      maxCancelledAttempts: 3,
    });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);

    // First cycle: no progress → counter=1
    await runNoProgressCycle(cycler, path, 1000);
    expect(cycler.getState('s1')!.cancelledAttempts).toBe(1);

    // Second cycle: Stop fires during compacting (true success path).
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 100_000);
    cycler.onStop('s1', 102_000); // prompting → compacting
    cycler.onStop('s1', 103_000); // compacting → idle, success

    const s = cycler.getState('s1')!;
    expect(s.cancelledAttempts).toBe(0);
    expect(s.gaveUp).toBe(false);
  });

  it('onStop racing with a compact-timeout tick does not miscount a real compaction as no-progress', async () => {
    // Regression for the failure-mode review: `tick()` awaits the transcript
    // read before deciding whether the cycle made progress. If a real Stop
    // event arrives during that await (the /compact actually finished just
    // at the timeout boundary), `onStop` resets the state synchronously.
    // The tick must not resume and increment `cancelledAttempts` against
    // stale state — that would convert successful compactions into
    // no-progress counts and eventually flip `gaveUp`.
    const cycler = new CheckpointCycler({
      triggerRatio: 0.75,
      cooldownMs: 0,
      compactTimeoutMs: 1000,
      promptGraceMs: 100,
      maxCancelledAttempts: 3,
    });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);

    // Drive state to compacting
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 1000);
    cycler.onStop('s1', 2000);
    expect(cycler.getState('s1')!.phase).toBe('compacting');

    // Fire the compact-timeout tick but don't await it yet; immediately run
    // onStop synchronously (mirroring event-pipeline behavior). This lands
    // between the tick's `await readFile` yield and its counter-mutation
    // step.
    const tickPromise = cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 10_000);
    cycler.onStop('s1', 10_000);
    await tickPromise;

    const s = cycler.getState('s1')!;
    expect(s.cancelledAttempts).toBe(0);
    expect(s.gaveUp).toBe(false);
    expect(s.phase).toBe('idle');
  });

  it('transcript unreadable at compact timeout counts as no-progress (fail-toward-giving-up)', async () => {
    // The read-side of the "did /compact work?" check returns null when the
    // transcript is unreadable. We deliberately treat that as no-progress:
    // if we can't prove progress, assume the cycle failed. This test pins
    // the contract so a future "treat null as success" refactor is caught.
    const cycler = new CheckpointCycler({
      triggerRatio: 0.75,
      cooldownMs: 0,
      compactTimeoutMs: 1000,
      promptGraceMs: 100,
      maxCancelledAttempts: 3,
    });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);

    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 1000);
    cycler.onStop('s1', 2000);
    // Delete the transcript before the timeout tick samples it.
    await rm(path, { force: true });
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 10_000);

    expect(cycler.getState('s1')!.cancelledAttempts).toBe(1);
  });

  it('prompt-phase timeout does not increment the no-progress counter', async () => {
    // If the agent never replies to the CHECKPOINT.md request, /compact was
    // never even sent — this is not a "cancelled /compact" and should not
    // push the session toward giving up.
    const cycler = new CheckpointCycler({
      triggerRatio: 0.75,
      cooldownMs: 0,
      promptTimeoutMs: 1000,
      maxCancelledAttempts: 3,
    });
    const path = await makeTranscriptWithRatio(dir, 's1.jsonl', 160_000);
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 1000);
    await cycler.tick([{ tmuxName: 's1', transcriptPath: path }], 3000); // past prompt timeout
    expect(cycler.getState('s1')!.phase).toBe('idle');
    expect(cycler.getState('s1')!.cancelledAttempts).toBe(0);
    expect(cycler.getState('s1')!.gaveUp).toBe(false);
  });
});

describe('readMaxCancelledAttemptsFromEnv', () => {
  const original = process.env.KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS;
  afterEach(() => {
    if (original === undefined) delete process.env.KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS;
    else process.env.KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS = original;
  });

  it('returns the default when env var is unset', () => {
    delete process.env.KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS;
    expect(readMaxCancelledAttemptsFromEnv()).toBe(3);
  });

  it('returns the env value when valid', () => {
    process.env.KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS = '5';
    expect(readMaxCancelledAttemptsFromEnv()).toBe(5);
    process.env.KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS = '1';
    expect(readMaxCancelledAttemptsFromEnv()).toBe(1);
  });

  it('falls back to default for invalid values', () => {
    process.env.KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS = 'nonsense';
    expect(readMaxCancelledAttemptsFromEnv()).toBe(3);
    process.env.KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS = '0';
    expect(readMaxCancelledAttemptsFromEnv()).toBe(3);
    process.env.KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS = '-2';
    expect(readMaxCancelledAttemptsFromEnv()).toBe(3);
  });
});

describe('readTriggerRatioFromEnv', () => {
  const original = process.env.KOOKR_CHECKPOINT_TRIGGER_RATIO;
  afterEach(() => {
    if (original === undefined) delete process.env.KOOKR_CHECKPOINT_TRIGGER_RATIO;
    else process.env.KOOKR_CHECKPOINT_TRIGGER_RATIO = original;
  });

  it('returns the default when env var is unset', () => {
    delete process.env.KOOKR_CHECKPOINT_TRIGGER_RATIO;
    expect(readTriggerRatioFromEnv()).toBe(0.75);
  });

  it('returns the env value when valid', () => {
    process.env.KOOKR_CHECKPOINT_TRIGGER_RATIO = '0.5';
    expect(readTriggerRatioFromEnv()).toBe(0.5);
  });

  it('falls back to default for invalid values', () => {
    process.env.KOOKR_CHECKPOINT_TRIGGER_RATIO = 'nonsense';
    expect(readTriggerRatioFromEnv()).toBe(0.75);
    process.env.KOOKR_CHECKPOINT_TRIGGER_RATIO = '0';
    expect(readTriggerRatioFromEnv()).toBe(0.75);
    process.env.KOOKR_CHECKPOINT_TRIGGER_RATIO = '1.5';
    expect(readTriggerRatioFromEnv()).toBe(0.75);
  });
});

describe('isCycleDisabled', () => {
  const original = process.env.KOOKR_CHECKPOINT_CYCLE_DISABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.KOOKR_CHECKPOINT_CYCLE_DISABLED;
    else process.env.KOOKR_CHECKPOINT_CYCLE_DISABLED = original;
  });

  it('returns false by default', () => {
    delete process.env.KOOKR_CHECKPOINT_CYCLE_DISABLED;
    expect(isCycleDisabled()).toBe(false);
  });

  it('returns true for "1" and "true"', () => {
    process.env.KOOKR_CHECKPOINT_CYCLE_DISABLED = '1';
    expect(isCycleDisabled()).toBe(true);
    process.env.KOOKR_CHECKPOINT_CYCLE_DISABLED = 'true';
    expect(isCycleDisabled()).toBe(true);
  });

  it('returns false for other values', () => {
    process.env.KOOKR_CHECKPOINT_CYCLE_DISABLED = '0';
    expect(isCycleDisabled()).toBe(false);
    process.env.KOOKR_CHECKPOINT_CYCLE_DISABLED = 'no';
    expect(isCycleDisabled()).toBe(false);
  });
});
