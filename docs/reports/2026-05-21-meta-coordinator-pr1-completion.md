# Meta Task Coordinator PR 1 Completion

**Date:** 2026-05-21
**Tracking issue:** #535
**Status:** Complete

## Merged Sub-Issues

| Issue | Scope | PR | Merge commit |
| --- | --- | --- | --- |
| #531 | Deterministic detectors for stale, duplicate, and done-not-cleared tasks | #553 | `f6431b2945246a89b78aceb3c8ba75c3d271d943` |
| #532 | Declared `blocks` / `blocked_by` edges with typeahead UI | #554 | `6012118b1711b5ce892148ba88e82698367d531c` |
| #533 | Coordinator task chips, chain strip, findings pane, and guarded actions | #555 | `5ef7498162c3d1d3511872faaa6dc9643bf8f3f0` |
| #534 | `kookr-spawn` pre-spawn duplicate interrupt | #556 | `98db16d02501626a9c920ca94c32f1fb432b3f42` |

## Hard Constraint Verification

| Constraint | Current evidence |
| --- | --- |
| Click-time re-verification on destructive verbs | `POST /api/coordinator/mark-prior-done` refreshes GitHub state, checks the chain concurrency token, verifies the submitted prior task set, requires a freshly verified merged PR, rejects non-passing post-merge CI, and rejects dirty worktree health before completing prior tasks. |
| No coordinator `Terminate` verb | Coordinator action types are limited to `nudge`, `compare`, `acknowledge`, and `snooze`; the findings pane opens tasks rather than offering termination. |
| Reason-coded `Snooze` with backoff | Coordinator snoozes send `reason: coordinator:<detectorId>` and the frontend widens repeated snooze durations from 30 minutes to 2 hours to 24 hours. Class-level suppression widens from 7 days to 30 days after repeated dismissals. |
| No absence-of-signal health claims | Detector output only emits negative/attention signals. Empty findings do not assert that tasks are healthy or running normally. |
| `[x wrong]` suppression affordance | Every coordinator task chip includes a dismiss button that posts a class-level suppression keyed by detector and agent type to `coordinator-suppressions.json`. Task acknowledgements use a task-scoped suppression path. |

## Empirical Checkpoints

| Checkpoint | Result |
| --- | --- |
| WebSocket snapshot tick can carry coordinator state | Snapshots embed `coordinator` state, and realtime broadcast also emits a standalone `coordinator.snapshot` message. Tests cover both server broadcast enrichment and frontend dispatch. |
| Prompt normalizer is reachable from coordinator code without circular imports | Coordinator duplicate detection imports `normalizePromptFileReferences`, `hashPrompt`, and `canonicalizeCwd`. Launch dedup uses the same effective prompt normalization before `checkSubmission`. |
| Audit tail is cheap to read per tick | `HookIngestion` maintains an in-memory coordinator audit tail capped at 1,000 rows plus latest PostToolUse rows per task. Detector tests assert 50 active tasks evaluate under the 200 ms budget. |
| Parent/child task IDs are available for chain strips | Chain strips are built from `parentTaskId`, `childTaskIds`, and declared edges; route tests exercise parent/child mark-prior-done flows. |
| GitHub PR state polling covers click-time `Mark prior done` verification | The mark-prior-done route calls `githubScanner.refreshTaskState` for every submitted prior task before reading `githubStateStore`. |
| Follow-up surface can host the coordinator chip | `FindingsPanel` renders `CoordinatorTaskChipView` on task rows and the detail panel renders `CoordinatorChainStripView`; no new top-level focus banner was added. |

## Verification Commands

- `pnpm exec vitest run src/server/coordinator/detectors.test.ts src/server/routes/task-routes.test.ts src/server/bootstrap/create-realtime-services.test.ts src/frontend/hooks/useWebSocket.snapshot-tolerance.test.ts src/cli/kookr-spawn.test.ts --testTimeout=30000`
- `pnpm build:server`
- `pnpm check:e2e`
- `pnpm test`

This report closes the PR 1 tracking umbrella after the implementation sub-issues have landed.
