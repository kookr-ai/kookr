import type {
  AutoAdvanceSlice,
  AutoAdvanceSwitchCause,
  AutoAdvanceTickReason,
  KookrStore,
  StoreSet,
  StoreGet,
  FocusZone,
} from '../store-types.js';
import type { AgentState, ProjectSummary } from '../../../shared/protocol.js';
import type { ProjectSidebarPrefs } from '../project-sidebar-prefs.js';
import { isActiveFinding } from '../finding-helpers.js';
import { track } from '../../telemetry.js';

const STORAGE_KEY = 'kookr-auto-advance-mode';
export const AUTO_ADVANCE_SETTLE_MS = 2000;

interface QueueState {
  visibleProjectSummaries: ProjectSummary[];
  projectSidebarPrefs: ProjectSidebarPrefs;
  agents: AgentState[];
}

/**
 * Ordered list of projects with at least one active finding. Pinned projects
 * (in their sidebar order) come first; unpinned (in sidebar order) follow.
 * The head is the auto-advance target.
 */
export function autoAdvanceQueue(state: QueueState): string[] {
  const pinnedSet = new Set(state.projectSidebarPrefs.pinned);
  const projectsWithFinding = new Set(
    state.agents.filter(isActiveFinding).map((a) => a.projectId),
  );
  const eligible = state.visibleProjectSummaries
    .map((p) => p.project)
    .filter((projectId) => projectsWithFinding.has(projectId));
  const pinnedFirst = eligible.filter((id) => pinnedSet.has(id));
  const unpinned = eligible.filter((id) => !pinnedSet.has(id));
  return [...pinnedFirst, ...unpinned];
}

interface EngagementState {
  selectedAgentId: string | null;
  selectedAgentSource: 'manual' | 'auto-advance';
  focusZone: FocusZone;
  agents: AgentState[];
}

/**
 * True when the user is currently engaged with an agent they picked
 * themselves. Auto-advance never yanks focus while this is true.
 *
 * `selectedAgentSource` is the load-bearing distinguisher: an agent the
 * auto-advance branch left selected (it actually leaves none) would not count
 * as engagement, avoiding the cascade self-disable.
 */
export function engagedWithAgent(state: EngagementState): boolean {
  if (!state.selectedAgentId) return false;
  if (state.selectedAgentSource !== 'manual') return false;
  const agent = state.agents.find((a) => a.agentId === state.selectedAgentId);
  if (!agent) return false;
  return state.focusZone !== 'none' || isActiveFinding(agent);
}

/** Map a tick-reason enum to a sentence shown in the FollowPill popover. */
export function describeTickReason(reason: AutoAdvanceTickReason | null): string {
  switch (reason) {
    case 'engaged': return 'You have a finding selected';
    case 'already_top': return 'Already on the highest-priority project';
    case 'no_eligible_project': return 'No project has active findings';
    case 'settling': return 'Switching in ~2s…';
    case null: return 'No decisions yet';
  }
}

export function describeSwitchCause(cause: AutoAdvanceSwitchCause): string {
  switch (cause) {
    case 'activation': return 'mode activated';
    case 'queue_head_changed': return 'higher-priority finding';
  }
}

function readEnabledFromStorage(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeEnabledToStorage(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private-browsing or quota — in-memory state is still correct */
  }
}

export function createAutoAdvanceSlice(set: StoreSet, get: StoreGet): AutoAdvanceSlice {
  return {
    autoAdvanceEnabled: readEnabledFromStorage(),
    selectedAgentSource: 'manual',
    lastTickReason: null,
    lastAutoSwitch: null,
    autoAdvanceError: null,

    toggleAutoAdvance: () => {
      const next = !get().autoAdvanceEnabled;
      writeEnabledToStorage(next);
      set({ autoAdvanceEnabled: next });
      track({ type: next ? 'auto_advance_enabled' : 'auto_advance_disabled' });
      // Activation tick is wired through the subscriber (which sees the
      // autoAdvanceEnabled change) so we don't need to invoke it directly.
    },
  };
}

// ---------------------------------------------------------------------------
// Subscriber + cross-tab sync (attached by useStore.ts after store creation)
// ---------------------------------------------------------------------------

interface AutoAdvanceRuntime {
  unsubscribeStore: () => void;
  detachStorage: () => void;
  clearSettleTimer: () => void;
}

let activeRuntime: AutoAdvanceRuntime | null = null;

interface ZustandStoreLike {
  getState: () => KookrStore;
  setState: (partial: Partial<KookrStore>) => void;
  subscribe: (
    listener: (state: KookrStore, prevState: KookrStore) => void,
  ) => () => void;
}

interface AttachOptions {
  /** Override the settle delay (tests pass 0). */
  settleMs?: number;
  /** Override `Date.now` for deterministic tests. */
  now?: () => number;
}

/**
 * Wire up the auto-advance subscriber to a Zustand store. Called once at
 * module load from useStore.ts. Tests typically don't call this; they
 * exercise the pure functions and `evaluateAutoAdvance` directly.
 */
function tearDownActiveRuntime(): void {
  if (!activeRuntime) return;
  activeRuntime.clearSettleTimer();
  activeRuntime.detachStorage();
  activeRuntime.unsubscribeStore();
  activeRuntime = null;
}

export function attachAutoAdvanceSubscribers(
  store: ZustandStoreLike,
  options: AttachOptions = {},
): AutoAdvanceRuntime {
  tearDownActiveRuntime();

  const settleMs = options.settleMs ?? AUTO_ADVANCE_SETTLE_MS;
  const now = options.now ?? (() => Date.now());

  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const unsubscribe = store.subscribe((state, prevState) => {
    // Zero-cost early exit when the feature is OFF — and irrelevant updates
    // bypass tick entirely so lastTickReason doesn't flicker on every
    // unrelated store change.
    if (!state.autoAdvanceEnabled) {
      if (prevState.autoAdvanceEnabled) {
        // Just toggled off — abandon any pending switch.
        clearTimer();
      }
      return;
    }
    if (!state.agentsHydrated || !state.projectSummariesHydrated) return;
    if (
      state.agents === prevState.agents &&
      state.selectedAgentId === prevState.selectedAgentId &&
      state.selectedProject === prevState.selectedProject &&
      state.autoAdvanceEnabled === prevState.autoAdvanceEnabled &&
      state.projectSidebarPrefs === prevState.projectSidebarPrefs &&
      state.visibleProjectSummaries === prevState.visibleProjectSummaries &&
      state.focusZone === prevState.focusZone
    ) {
      return;
    }

    evaluateAutoAdvance(state, store, {
      settleMs,
      now,
      scheduleSwitch: (cause) => {
        clearTimer();
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          fireSwitch(store, cause, now);
        }, settleMs);
      },
      cancelPending: clearTimer,
    });
  });

  // Cross-tab sync. A toggle in another tab fires `storage` here.
  let storageHandler: ((event: StorageEvent) => void) | null = null;
  if (typeof window !== 'undefined') {
    storageHandler = (event: StorageEvent) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      const next = readEnabledFromStorage();
      if (next !== store.getState().autoAdvanceEnabled) {
        store.setState({ autoAdvanceEnabled: next });
      }
    };
    window.addEventListener('storage', storageHandler);
  }

  const runtime: AutoAdvanceRuntime = {
    unsubscribeStore: unsubscribe,
    detachStorage: () => {
      if (storageHandler && typeof window !== 'undefined') {
        window.removeEventListener('storage', storageHandler);
      }
    },
    clearSettleTimer: clearTimer,
  };
  activeRuntime = runtime;
  return runtime;
}

/** Test-only: tear down the singleton subscriber + listeners + timer. */
export function __resetAutoAdvanceForTests(): void {
  tearDownActiveRuntime();
}

// ---------------------------------------------------------------------------
// Tick evaluator
// ---------------------------------------------------------------------------

interface TickContext {
  settleMs: number;
  now: () => number;
  scheduleSwitch: (cause: AutoAdvanceSwitchCause) => void;
  cancelPending: () => void;
}

/**
 * Evaluate the guard chain and either schedule a switch, cancel a pending one,
 * or no-op. Records the outcome to `lastTickReason` (only on actual decisions,
 * never on early-exit guards, so the popover doesn't flicker).
 *
 * Wrapped in try/catch so a runtime error doesn't kill the subscriber.
 */
export function evaluateAutoAdvance(
  state: KookrStore,
  store: ZustandStoreLike,
  ctx: TickContext,
): void {
  try {
    const queue = autoAdvanceQueue(state);
    const head = queue[0] ?? null;

    let outcome: AutoAdvanceTickReason;

    if (head === null) {
      outcome = 'no_eligible_project';
      ctx.cancelPending();
    } else if (head === state.selectedProject) {
      outcome = 'already_top';
      ctx.cancelPending();
    } else if (engagedWithAgent(state)) {
      outcome = 'engaged';
      ctx.cancelPending();
    } else {
      outcome = 'settling';
      // Distinguish activation (no current selectedProject in the queue) from
      // a queue-head-changed event purely for telemetry; the switch fires the
      // same way either way.
      ctx.scheduleSwitch(state.selectedProject === null ? 'activation' : 'queue_head_changed');
    }

    const patch: Partial<KookrStore> = { lastTickReason: outcome };
    if (state.autoAdvanceError !== null) {
      // Tick succeeded — clear any prior error.
      patch.autoAdvanceError = null;
    }
    store.setState(patch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const prev = state.autoAdvanceError;
    // Dedup: keep `firstSeenTs` if the message hasn't changed, so the popover
    // can show "first seen Ns ago" instead of resetting on every recurring throw.
    const errorRecord = prev && prev.message === message
      ? prev
      : { message, firstSeenTs: ctx.now() };
    store.setState({ autoAdvanceError: errorRecord });
  }
}

/**
 * Re-evaluate the queue at fire time (not schedule time) so drag-during-settle,
 * cross-tab toggle-off, or stale-anomaly clearing all behave correctly. If
 * conditions still hold, perform the switch; otherwise abandon.
 */
function fireSwitch(
  store: ZustandStoreLike,
  cause: AutoAdvanceSwitchCause,
  now: () => number,
): void {
  const state = store.getState();
  if (!state.autoAdvanceEnabled) return;
  const queue = autoAdvanceQueue(state);
  const head = queue[0] ?? null;
  if (head === null) return;
  if (head === state.selectedProject) return;
  if (engagedWithAgent(state)) return;

  const from = state.selectedProject;
  state.selectProject(head, { source: 'auto-advance' });

  const record = { from, to: head, cause, ts: now() };
  store.setState({ lastAutoSwitch: record });
  track({
    type: 'auto_advance_switch',
    from,
    to: head,
    cause,
  });
}
