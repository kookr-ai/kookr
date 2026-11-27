import type { StoreSet, SystemStatusSlice } from '../store-types.js';
import {
  FLEET_VITALS_HISTORY_POINTS,
  fleetVitalsHistoryPoint,
  type FleetVitalsHistoryPoint,
} from '../../../shared/protocol.js';

/** Keep the newest `FLEET_VITALS_HISTORY_POINTS` points. */
function capHistory(history: FleetVitalsHistoryPoint[]): FleetVitalsHistoryPoint[] {
  return history.length > FLEET_VITALS_HISTORY_POINTS
    ? history.slice(history.length - FLEET_VITALS_HISTORY_POINTS)
    : history;
}

export function createSystemStatusSlice(set: StoreSet): SystemStatusSlice {
  return {
    resourceStatus: null,
    resourceStatusReceivedAtMs: null,
    fleetVitals: null,
    fleetVitalsHistory: [],
    fleetVitalsReceivedAtMs: null,
    prodSmokeTick: null,
    resourceWatchdog: null,
    capacityResidual: null,
    pipelineStarvation: null,
    launchDependencies: null,
    pausedSchedules: null,
    lessonYield: null,
    timerHealth: null,
    taskNamer: null,

    handleResourceStatus: (status, receivedAtMs = Date.now()) => {
      set({
        resourceStatus: status,
        resourceStatusReceivedAtMs: receivedAtMs,
      });
    },

    handleFleetVitals: (sample, history, receivedAtMs = Date.now()) => {
      set((state) => {
        if (history) {
          // Connection burst: the server's buffer already ends with this sample.
          return {
            fleetVitals: sample,
            fleetVitalsHistory: capHistory(history),
            fleetVitalsReceivedAtMs: receivedAtMs,
          };
        }
        const previous = state.fleetVitalsHistory;
        const last = previous[previous.length - 1];
        // A sample at or before the last point is a duplicate or arrived out of
        // order (a reconnect can replay one): show its values, do not chart it twice.
        const nextHistory = last && sample.sampledAtMs <= last.t
          ? previous
          : capHistory([...previous, fleetVitalsHistoryPoint(sample)]);
        return {
          fleetVitals: sample,
          fleetVitalsHistory: nextHistory,
          fleetVitalsReceivedAtMs: receivedAtMs,
        };
      });
    },

    handleOpsHealth: (payload) => {
      const next: Partial<SystemStatusSlice> = {};
      if ('prodSmokeTick' in payload) {
        next.prodSmokeTick = payload.prodSmokeTick ?? null;
      }
      if ('resourceWatchdog' in payload) {
        next.resourceWatchdog = payload.resourceWatchdog ?? null;
      }
      if ('capacityResidual' in payload) {
        next.capacityResidual = payload.capacityResidual ?? null;
      }
      if ('pipelineStarvation' in payload) {
        next.pipelineStarvation = payload.pipelineStarvation ?? null;
      }
      if ('launchDependencies' in payload) {
        next.launchDependencies = payload.launchDependencies ?? null;
      }
      if ('pausedSchedules' in payload) {
        next.pausedSchedules = payload.pausedSchedules ?? null;
      }
      if ('lessonYield' in payload) {
        next.lessonYield = payload.lessonYield ?? null;
      }
      if ('timerHealth' in payload) {
        next.timerHealth = payload.timerHealth ?? null;
      }
      if ('taskNamer' in payload) {
        next.taskNamer = payload.taskNamer ?? null;
      }
      if (Object.keys(next).length > 0) set(next);
    },
  };
}
