import type {
  AchievementsSystemSlice,
  StoreGet,
  StoreSet,
} from '../store-types.js';

export function createAchievementsSystemSlice(set: StoreSet, get: StoreGet): AchievementsSystemSlice {
  return {
    achievements: {},
    achievementToasts: [],
    achievementsEnabled: typeof localStorage !== 'undefined' ? localStorage.getItem('kookr-achievements-enabled') !== 'false' : true,
    showAchievements: false,
    quotaStatus: null,
    circuitBreakers: [],
    diagnosticReport: null,
    schedules: [],
    scheduleRevision: 0,
    scheduleStatus: null,

    handleAchievementUnlocked: (toast) => {
      const { achievementsEnabled, achievements } = get();
      set({ achievements: { ...achievements, [toast.id]: toast.unlockedAt } });

      if (achievementsEnabled) {
        set((prev) => ({
          achievementToasts: [...prev.achievementToasts, toast],
        }));
      }
    },

    dismissAchievementToast: (id) => {
      set((prev) => ({
        achievementToasts: prev.achievementToasts.filter(
          (toast) => !(toast.id === id && toast.timestamp === prev.achievementToasts.find((candidate) => candidate.id === id)?.timestamp),
        ),
      }));
    },

    setAchievementsEnabled: (enabled) => {
      set({ achievementsEnabled: enabled });
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('kookr-achievements-enabled', String(enabled));
      }
    },

    toggleAchievementsPanel: () => {
      const showing = !get().showAchievements;
      set({ showAchievements: showing });
      if (showing && typeof localStorage !== 'undefined') {
        localStorage.setItem('kookr-last-achievement-panel-open', String(Date.now()));
      }
    },

    handleQuotaStatus: (quota) => {
      set({ quotaStatus: quota });
    },

    handleCircuitBreakerStatus: (breakers) => {
      set({ circuitBreakers: breakers });
    },

    handleDiagnosticReport: (report) => {
      set({ diagnosticReport: report });
    },

    handleSchedules: (payload) => {
      const { revision, schedules, status } = payload;
      if (revision < get().scheduleRevision) return;
      set({ schedules, scheduleRevision: revision, scheduleStatus: status });
    },
  };
}
