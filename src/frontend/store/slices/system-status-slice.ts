import type { StoreSet, SystemStatusSlice } from '../store-types.js';

export function createSystemStatusSlice(set: StoreSet): SystemStatusSlice {
  return {
    resourceStatus: null,
    resourceStatusReceivedAtMs: null,

    handleResourceStatus: (status, receivedAtMs = Date.now()) => {
      set({
        resourceStatus: status,
        resourceStatusReceivedAtMs: receivedAtMs,
      });
    },
  };
}
