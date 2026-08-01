/**
 * The completion-ready lifecycle owner (issue #1827).
 *
 * Before this barrel, the "what happens once a task becomes completion-ready"
 * flow — auto-close eligibility, the delivered-PR self-completion decision, the
 * stale-drain selection shared by the background sweep and the supervisor
 * bulk-ack — was scattered across `core/` with no single home, so changing the
 * behavior meant shotgun surgery across the timer, the use-cases, and the route
 * layer (each re-deriving the same eligibility filter).
 *
 * This module is that home: the single import surface for the post-signal
 * completion-ready decision layer. The server tiers (lifecycle-timers, the
 * ack-all use-case, the task routes) invoke `selectAutoClosableCompletionReadyTasks`
 * and the classifiers here rather than re-deriving them.
 *
 * Scope boundary: this owns the *pure decisions*. The *effectful transitions*
 * (`completeTask`, dirty-worktree findings, the delivered sweep) stay in the
 * server tier — they depend on server-only infrastructure and would invert the
 * core→server layering if pulled in here. The Stop-hook *pre-signal* decision
 * (`core/completion-signal.ts` `evaluateCompletionSignal`) is already cleanly
 * owned and intentionally left in place.
 */

export * from './completion-ready-cleanup.js';
export * from './delivered-task-completion.js';
