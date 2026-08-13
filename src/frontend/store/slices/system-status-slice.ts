import type { StoreSet, SystemStatusSlice } from '../store-types.js';

export function createSystemStatusSlice(set: StoreSet): SystemStatusSlice {
  return {
    resourceStatus: null,
    resourceStatusReceivedAtMs: null,
    prodSmokeTick: null,
    resourceWatchdog: null,
    capacityResidual: null,
    pipelineStarvation: null,
    launchDependencies: null,
    pausedSchedules: null,
    lessonYield: null,

    handleResourceStatus: (status, receivedAtMs = Date.now()) => {
      set({
        resourceStatus: status,
        resourceStatusReceivedAtMs: receivedAtMs,
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
      if (Object.keys(next).length > 0) set(next);
    },
  };
}
