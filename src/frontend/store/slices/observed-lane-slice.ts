import type { StoreSet, ObservedLaneSlice } from '../store-types.js';

/**
 * Hermes observed-activity lane (jeanibarz/hermes-fleet#15, slice 2).
 *
 * Holds the latest `observed.snapshot` frame for the monitor's observed lane.
 * `null` until the first frame arrives — which, because the server only ever
 * broadcasts this frame when `KOOKR_HERMES_FLEET` is on, is the frontend's
 * proxy for "the lane is enabled". When off, no frame arrives and the lane UI
 * renders nothing. The slice is a pure sink: it never derives task state and is
 * never keyed by `taskId` (the lane is operator-global, never task-bound).
 */
export function createObservedLaneSlice(set: StoreSet): ObservedLaneSlice {
  return {
    observedActivity: null,

    handleObservedActivity: (snapshot) => {
      set({ observedActivity: snapshot });
    },

    clearObservedActivity: () => {
      set({ observedActivity: null });
    },
  };
}
