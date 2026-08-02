import { describe, expect, test } from 'vitest';
import {
  DEFAULT_LOOP_DELIVERY_NO_PROGRESS_SAMPLES,
  DEFAULT_LOOP_DELIVERY_RECOVER_SAMPLES,
  LoopDeliveryWatchdog,
  LoopDeliveryWatchdogRegistry,
  countDeliveredPullRequests,
  createLoopDeliveryWatchdogRegistry,
  hasDeliveryProgress,
  pruneLoopDeliveryWatchdog,
  readLoopDeliveryWatchdogConfigFromEnv,
  type DeliverySnapshot,
  type LoopDeliveryWatchdogConfig,
} from './loop-delivery-watchdog.js';

function snapshot(overrides: Partial<DeliverySnapshot> = {}): DeliverySnapshot {
  return { commits: 0, prsOpened: 0, prsMerged: 0, ...overrides };
}

const CONFIG: LoopDeliveryWatchdogConfig = { noProgressSamples: 3, recoverSamples: 2 };

describe('hasDeliveryProgress', () => {
  test('true when commits advance', () => {
    expect(hasDeliveryProgress(snapshot(), snapshot({ commits: 1 }))).toBe(true);
  });

  test('true when a PR is opened', () => {
    expect(hasDeliveryProgress(snapshot(), snapshot({ prsOpened: 1 }))).toBe(true);
  });

  test('true when a PR merges', () => {
    expect(hasDeliveryProgress(snapshot({ prsOpened: 1 }), snapshot({ prsOpened: 1, prsMerged: 1 })))
      .toBe(true);
  });

  test('false when nothing advances', () => {
    expect(hasDeliveryProgress(snapshot({ commits: 4 }), snapshot({ commits: 4 }))).toBe(false);
  });

  test('a counter going backwards is not progress (defensive against non-monotonic sources)', () => {
    expect(hasDeliveryProgress(snapshot({ commits: 4 }), snapshot({ commits: 3 }))).toBe(false);
  });
});

describe('LoopDeliveryWatchdog — acceptance criteria', () => {
  test('flags a loop with no delivery progress over N consecutive samples', () => {
    const wd = new LoopDeliveryWatchdog(CONFIG);
    // Baseline sample: no judgement yet.
    expect(wd.noteSample(snapshot({ commits: 2 }))).toMatchObject({ flagged: false, reason: 'baseline' });
    // Three identical (no-progress) samples. Flag engages on the 3rd.
    expect(wd.noteSample(snapshot({ commits: 2 }))).toMatchObject({ flagged: false, reason: 'no_progress' });
    expect(wd.noteSample(snapshot({ commits: 2 }))).toMatchObject({ flagged: false, reason: 'no_progress' });
    const third = wd.noteSample(snapshot({ commits: 2 }));
    expect(third).toMatchObject({ flagged: true, transitioned: true, reason: 'flagged' });
    expect(wd.isFlagged).toBe(true);
    expect(wd.consecutiveNoProgress).toBe(3);
  });

  test('does NOT flag a quiet-but-progressing loop (progress every sample)', () => {
    const wd = new LoopDeliveryWatchdog(CONFIG);
    wd.noteSample(snapshot({ commits: 1 })); // baseline
    // Each sample advances a counter by exactly one — "quiet" (no chatter is
    // ever an input here) but genuinely progressing. Never flagged.
    for (let i = 2; i <= 10; i++) {
      const r = wd.noteSample(snapshot({ commits: i }));
      expect(r.flagged).toBe(false);
      expect(r.reason).toBe('progressing');
    }
    expect(wd.isFlagged).toBe(false);
    expect(wd.consecutiveNoProgress).toBe(0);
  });

  test('a slow loop that delivers occasionally (via PR merges) is never flagged', () => {
    const wd = new LoopDeliveryWatchdog(CONFIG);
    wd.noteSample(snapshot()); // baseline
    // No-progress twice (under the threshold), then a delivery resets the streak.
    expect(wd.noteSample(snapshot()).flagged).toBe(false);
    expect(wd.noteSample(snapshot()).flagged).toBe(false);
    expect(wd.noteSample(snapshot({ prsMerged: 1 })).reason).toBe('progressing');
    // Streak was reset, so another two no-progress samples still don't flag.
    expect(wd.noteSample(snapshot({ prsMerged: 1 })).flagged).toBe(false);
    expect(wd.noteSample(snapshot({ prsMerged: 1 })).flagged).toBe(false);
    expect(wd.isFlagged).toBe(false);
  });
});

describe('LoopDeliveryWatchdog — hysteresis prevents flapping', () => {
  test('a single progress sample does not immediately clear the flag (recover > 1)', () => {
    const wd = new LoopDeliveryWatchdog(CONFIG);
    wd.noteSample(snapshot()); // baseline
    wd.noteSample(snapshot());
    wd.noteSample(snapshot());
    expect(wd.noteSample(snapshot())).toMatchObject({ flagged: true, reason: 'flagged' });

    // One delivery is not enough to clear — recoverSamples is 2.
    const first = wd.noteSample(snapshot({ commits: 1 }));
    expect(first).toMatchObject({ flagged: true, transitioned: false, reason: 'progressing' });
    // Second consecutive delivery clears.
    const second = wd.noteSample(snapshot({ commits: 2 }));
    expect(second).toMatchObject({ flagged: false, transitioned: true, reason: 'cleared' });
    expect(wd.isFlagged).toBe(false);
  });

  test('no-progress after a lone recovery sample does not clear, and flag stays engaged', () => {
    const wd = new LoopDeliveryWatchdog(CONFIG);
    wd.noteSample(snapshot()); // baseline
    wd.noteSample(snapshot());
    wd.noteSample(snapshot());
    wd.noteSample(snapshot()); // flagged
    expect(wd.isFlagged).toBe(true);

    // progress (streak 1), then no-progress resets progress streak; flag holds.
    expect(wd.noteSample(snapshot({ commits: 1 })).flagged).toBe(true);
    expect(wd.noteSample(snapshot({ commits: 1 })).flagged).toBe(true); // no-progress, still flagged
    // A fresh pair of deliveries now clears.
    expect(wd.noteSample(snapshot({ commits: 2 })).flagged).toBe(true);
    expect(wd.noteSample(snapshot({ commits: 3 })).reason).toBe('cleared');
    expect(wd.isFlagged).toBe(false);
  });

  test('transition flag is set only on the engage/clear samples, never repeated', () => {
    const wd = new LoopDeliveryWatchdog({ noProgressSamples: 2, recoverSamples: 1 });
    wd.noteSample(snapshot()); // baseline
    expect(wd.noteSample(snapshot()).transitioned).toBe(false); // streak 1
    expect(wd.noteSample(snapshot()).transitioned).toBe(true); // engage
    expect(wd.noteSample(snapshot()).transitioned).toBe(false); // still flagged, no flip
    expect(wd.noteSample(snapshot({ commits: 1 })).transitioned).toBe(true); // clear
    expect(wd.noteSample(snapshot({ commits: 2 })).transitioned).toBe(false); // still clear
  });
});

describe('LoopDeliveryWatchdog — silence and missing data never flag', () => {
  test('a disabled watchdog (0 threshold) never flags', () => {
    const wd = new LoopDeliveryWatchdog({ noProgressSamples: 0, recoverSamples: 2 });
    for (let i = 0; i < 10; i++) {
      expect(wd.noteSample(snapshot()).reason).toBe('disabled');
    }
    expect(wd.isFlagged).toBe(false);
  });

  test('a missing snapshot leaves streaks untouched (source unreadable)', () => {
    const wd = new LoopDeliveryWatchdog(CONFIG);
    wd.noteSample(snapshot()); // baseline
    wd.noteSample(snapshot()); // no-progress streak 1
    // Two null samples must NOT advance the streak toward a flag.
    expect(wd.noteSample(null).reason).toBe('no_sample');
    expect(wd.noteSample(undefined).reason).toBe('no_sample');
    expect(wd.consecutiveNoProgress).toBe(1);
    expect(wd.isFlagged).toBe(false);
    // One more real no-progress sample reaches the threshold (1 + 1 + 1 = 3).
    wd.noteSample(snapshot());
    expect(wd.noteSample(snapshot()).flagged).toBe(true);
  });
});

describe('readLoopDeliveryWatchdogConfigFromEnv', () => {
  test('defaults when env is blank', () => {
    const cfg = readLoopDeliveryWatchdogConfigFromEnv({});
    expect(cfg).toEqual({
      noProgressSamples: DEFAULT_LOOP_DELIVERY_NO_PROGRESS_SAMPLES,
      recoverSamples: DEFAULT_LOOP_DELIVERY_RECOVER_SAMPLES,
    });
  });

  test('reads valid overrides', () => {
    const cfg = readLoopDeliveryWatchdogConfigFromEnv({
      KOOKR_LOOP_DELIVERY_NO_PROGRESS_SAMPLES: '5',
      KOOKR_LOOP_DELIVERY_RECOVER_SAMPLES: '3',
    });
    expect(cfg).toEqual({ noProgressSamples: 5, recoverSamples: 3 });
  });

  test('0 disables the watchdog (no-progress sentinel)', () => {
    const cfg = readLoopDeliveryWatchdogConfigFromEnv({
      KOOKR_LOOP_DELIVERY_NO_PROGRESS_SAMPLES: '0',
    });
    expect(cfg.noProgressSamples).toBe(0);
  });

  test('invalid values fall back to defaults', () => {
    const cfg = readLoopDeliveryWatchdogConfigFromEnv({
      KOOKR_LOOP_DELIVERY_NO_PROGRESS_SAMPLES: 'abc',
      KOOKR_LOOP_DELIVERY_RECOVER_SAMPLES: '-2',
    });
    expect(cfg).toEqual({
      noProgressSamples: DEFAULT_LOOP_DELIVERY_NO_PROGRESS_SAMPLES,
      recoverSamples: DEFAULT_LOOP_DELIVERY_RECOVER_SAMPLES,
    });
  });
});

describe('LoopDeliveryWatchdogRegistry', () => {
  test('tracks watchdogs per task independently', () => {
    const reg = createLoopDeliveryWatchdogRegistry(CONFIG);
    // Task A stalls; task B progresses in lockstep.
    reg.sample('a', snapshot()); // baseline
    reg.sample('b', snapshot()); // baseline
    for (let i = 1; i <= 3; i++) {
      reg.sample('a', snapshot());
      reg.sample('b', snapshot({ commits: i }));
    }
    expect(reg.isFlagged('a')).toBe(true);
    expect(reg.isFlagged('b')).toBe(false);
    expect(reg.flaggedTaskIds()).toEqual(['a']);
  });

  test('unknown task ids report not flagged', () => {
    const reg = new LoopDeliveryWatchdogRegistry(CONFIG);
    expect(reg.isFlagged('nope')).toBe(false);
  });

  test('forget drops a single watchdog', () => {
    const reg = new LoopDeliveryWatchdogRegistry(CONFIG);
    reg.sample('a', snapshot());
    expect(reg.size).toBe(1);
    reg.forget('a');
    expect(reg.size).toBe(0);
    expect(reg.isFlagged('a')).toBe(false);
  });

  test('retain drops watchdogs for loops no longer running', () => {
    const reg = new LoopDeliveryWatchdogRegistry(CONFIG);
    reg.sample('a', snapshot());
    reg.sample('b', snapshot());
    reg.sample('c', snapshot());
    reg.retain(['a', 'c']);
    expect(reg.size).toBe(2);
    reg.retain(new Set<string>());
    expect(reg.size).toBe(0);
  });

  test('enabled reflects the configured threshold', () => {
    expect(new LoopDeliveryWatchdogRegistry(CONFIG).enabled).toBe(true);
    expect(new LoopDeliveryWatchdogRegistry({ noProgressSamples: 0, recoverSamples: 2 }).enabled)
      .toBe(false);
  });
});

describe('countDeliveredPullRequests', () => {
  test('counts opened and merged, excluding prompt-cited PRs', () => {
    const counts = countDeliveredPullRequests([
      { status: 'open', detectedFrom: 'session-1' },
      { status: 'merged', detectedFrom: 'session-1' },
      // Prompt-cited PR (even merged) is NOT the loop's own delivery.
      { status: 'merged', detectedFrom: 'prompt' },
      { status: 'closed', detectedFrom: 'session-2' },
    ]);
    expect(counts).toEqual({ prsOpened: 3, prsMerged: 1 });
  });

  test('empty list yields zero counts', () => {
    expect(countDeliveredPullRequests([])).toEqual({ prsOpened: 0, prsMerged: 0 });
  });

  test('only prompt-cited PRs yields zero counts (never the loop\'s delivery)', () => {
    const counts = countDeliveredPullRequests([
      { status: 'merged', detectedFrom: 'prompt' },
      { status: 'open', detectedFrom: 'prompt' },
    ]);
    expect(counts).toEqual({ prsOpened: 0, prsMerged: 0 });
  });
});

describe('pruneLoopDeliveryWatchdog', () => {
  function task(id: string, status?: string) {
    return status === undefined ? { id } : { id, ralphLoop: { status } };
  }

  test('retains running and paused loops, prunes terminal and loop-less tasks', () => {
    const reg = new LoopDeliveryWatchdogRegistry(CONFIG);
    for (const id of ['run', 'pause', 'done', 'fail', 'cancel', 'none']) {
      reg.sample(id, { commits: 0, prsOpened: 0, prsMerged: 0 });
    }
    pruneLoopDeliveryWatchdog(
      [
        task('run', 'running'),
        task('pause', 'paused'), // a paused loop keeps its watchdog
        task('done', 'completed'),
        task('fail', 'failed'),
        task('cancel', 'cancelled'),
        task('none'), // no ralphLoop at all
      ],
      reg,
    );
    // Only 'run' and 'pause' survive. Prove WHICH survived by pruning again
    // against a narrowed active set and watching size fall accordingly.
    expect(reg.size).toBe(2);
    pruneLoopDeliveryWatchdog([task('run', 'running')], reg);
    expect(reg.size).toBe(1); // 'pause' pruned, 'run' retained
    pruneLoopDeliveryWatchdog([task('pause', 'paused')], reg);
    expect(reg.size).toBe(0); // 'run' now absent from the active set too
  });

  test('a task dropped from the list entirely is pruned', () => {
    const reg = new LoopDeliveryWatchdogRegistry(CONFIG);
    reg.sample('gone', { commits: 0, prsOpened: 0, prsMerged: 0 });
    pruneLoopDeliveryWatchdog([], reg);
    expect(reg.size).toBe(0);
  });

  test('disabled registry is left untouched', () => {
    const reg = new LoopDeliveryWatchdogRegistry({ noProgressSamples: 0, recoverSamples: 2 });
    // Disabled registries never flag, but they can still hold lazily-created
    // entries; prune must be a no-op so it can't churn a disabled registry.
    reg.sample('x', { commits: 0, prsOpened: 0, prsMerged: 0 });
    const before = reg.size;
    pruneLoopDeliveryWatchdog([], reg);
    expect(reg.size).toBe(before);
  });
});
