/**
 * Notices when the operator comes back to the dashboard after being away, so Lucy can tell them
 * what changed (`useLucyBriefing.ts`).
 *
 * "Away" is measured from the last time they did something in a visible page: moved the pointer,
 * pressed a key, scrolled or touched. "Back" is the next such action, or the tab becoming visible
 * again, whichever comes first. If {@link OPERATOR_AWAY_MS} or more passed in between, the callback
 * is called once, with how long they were away.
 *
 * Hiding the tab is deliberately not counted as a sign of presence: a screen that locks by itself
 * hides the tab too, long after the operator left. The cost is that someone who read without
 * touching anything for nine minutes and then switched tabs for two is taken to have been away;
 * the briefing is only written when what waits on them changed, so that costs nothing.
 *
 * No timer runs: the check is made when something happens. The clock and the events are passed in,
 * so the rule can be tested without a browser.
 */

/** Being away this long makes the next sign of presence a "return". */
export const OPERATOR_AWAY_MS = 10 * 60_000;

export interface PresenceSources {
  now(): number;
  /** True while the tab is hidden (another tab in front, window minimised, screen locked). */
  isHidden(): boolean;
  /** Calls `listener` when the tab is shown or hidden. Returns the function that stops it. */
  onVisibilityChange(listener: () => void): () => void;
  /** Calls `listener` on pointer, keyboard, wheel or touch activity in the page. Returns the function that stops it. */
  onActivity(listener: () => void): () => void;
}

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** The real page: `document.visibilityState` and the window's input events. */
export function browserPresenceSources(): PresenceSources {
  return {
    now: () => Date.now(),
    isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    onVisibilityChange(listener) {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    onActivity(listener) {
      // Capture phase, so a component that stops an event from bubbling does not hide the operator.
      for (const name of ACTIVITY_EVENTS) window.addEventListener(name, listener, { capture: true, passive: true });
      return () => {
        for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, listener, { capture: true });
      };
    },
  };
}

export interface WatchOperatorReturnOptions {
  awayMs?: number;
  sources?: PresenceSources;
}

/**
 * Call `onReturn(awayForMs)` each time the operator comes back after `awayMs` or more.
 * Returns the function that stops watching.
 */
export function watchOperatorReturn(onReturn: (awayForMs: number) => void, options: WatchOperatorReturnOptions = {}): () => void {
  const sources = options.sources ?? browserPresenceSources();
  const awayMs = options.awayMs ?? OPERATOR_AWAY_MS;
  // Watching starts with the operator present: they just loaded the page or switched the panel on.
  let lastSeenAt = sources.now();

  const seen = (): void => {
    const now = sources.now();
    const awayFor = now - lastSeenAt;
    lastSeenAt = now;
    if (awayFor >= awayMs) onReturn(awayFor);
  };
  const stopVisibility = sources.onVisibilityChange(() => {
    if (!sources.isHidden()) seen();
  });
  // Input that reaches a hidden page (a key still held while the tab changes) is not presence.
  const stopActivity = sources.onActivity(() => {
    if (!sources.isHidden()) seen();
  });
  return () => {
    stopVisibility();
    stopActivity();
  };
}
