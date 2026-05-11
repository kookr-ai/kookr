# Autonomy Feature Removal Audit — 2026-05-12

## Rationale

Per-task autonomy (supervised vs autonomous) judged useless by maintainer. The 'autonomous' mode fires auto-proceed timers on needs_input events without human input. Removing the toggle and all associated code, schemas, docs, and UI. The user-supervision workflow described in `.claude/skills/kookr-supervise-tasks/SKILL.md` is independent (a human/skill-driven replacement) and is NOT in scope for removal.

## Disposition summary

| Disposition | Count |
|-------------|-------|
| DELETE      | 4     |
| EDIT        | 60    |
| LEAVE       | 22    |

Counts include files outside the original list that were discovered during the audit (see "Additional files discovered" below).

## Files to DELETE

### `src/server/auto-proceed.ts`
Exists solely to schedule + fire auto-proceed timers (`AutoProceedService`). Entirely autonomy-feature code. Delete in full.

### `src/server/auto-proceed.test.ts`
Tests for the deleted `AutoProceedService`. Delete in full.

### `src/server/auto-proceed-integration.test.ts`
Integration tests for the deleted auto-proceed feature. Delete in full.

### `src/server/autonomy-orchestrator.ts`
`AutonomyOrchestrator` class — single owner of autonomy/auto-proceed policy. Entirely autonomy-feature code. Delete in full.

## Files to EDIT

### `src/core/tasks.ts` (734 lines)
Edits needed:
- Drop `export type AutonomyLevel = 'supervised' | 'autonomous';` (line 6).
- Drop `autonomy?: AutonomyLevel;` from `CreateTaskOptions` (line 211).
- Drop these fields from the `Task` interface (lines 279–284):
  - `autonomy: AutonomyLevel;`
  - `autoProceedDelayMs?: number;`
  - `autoProceedRetries?: number;`
- In `createTask` (line ~362), remove `autonomy` from the destructuring and from the returned `task` literal (line 379, `autonomy: autonomy ?? 'supervised',`).
- In `loadTasks` (line 682–684), drop the default-autonomy back-fill: `if (!task.autonomy) task.autonomy = 'supervised';`. Persisted tasks with legacy `autonomy` fields will still round-trip via JSON, but the field is no longer typed or read.
- Delete methods at lines 706–733: `resetAutoProceedRetries`, `incrementAutoProceedRetries`, `setAutonomy`.
- Remove the `import type { AutonomyLevel ... }` (none here, it's defined locally; just delete the export).

### `src/core/types.ts` (291 lines)
Edits needed:
- Drop `'auto_proceed_failure'` from the `AnomalyType` union (line 237). No production code path emits this anomaly type today.
- Drop the `autoProceedingAt?: string;` field from the `Anomaly` interface (line 258) and its leading JSDoc comment.
- Optionally retain the `subType?: 'stop' | 'ask_user_question';` field — it's used by other detectors and was only described as "for autonomy decisions" in its JSDoc. Edit the JSDoc to drop the autonomy framing but keep the field and values.
- Same for `PersistedAnomaly.subType` (line 271) — keep the field, JSDoc cleanup only.

### `src/core/monitor.ts` (617 lines)
Edits needed:
- Drop `autonomy?: import('./tasks.js').AutonomyLevel;` from `AgentState` (line 45).
- In `getSnapshot()`, drop the autonomy enrichment lines:
  - Line 530–534 (comment `// Enrich with token usage, task status, and autonomy from the task` and `state.autonomy = task.autonomy;`).
  - Line 563 (`autonomy: task.autonomy,`) on the pending-task synthetic entry.
  - Line 599 (`autonomy: task.autonomy,`) on the completed/cancelled synthetic entry.

### `src/core/schedule.ts` (~370 lines)
Edits needed:
- Drop `import type { AutonomyLevel } from './tasks.js';` (line 4).
- Drop `autonomy: AutonomyLevel;` field from the `Schedule` interface (line 74).
- Drop `autonomy?: AutonomyLevel;` from `CreateScheduleInput` (line 117) and `UpdateScheduleDefinitionInput` (line 128).
- In `createDefinition` (line ~239), drop the `autonomy: input.autonomy ?? 'autonomous',` literal assignment.
- In `normalizeSchedule` (line ~349), drop the `autonomy: candidate.autonomy ?? 'autonomous',` line.

### `src/core/schedule.test.ts`
Edits needed:
- Drop line 32 `expect(schedule.autonomy).toBe('autonomous');` and any neighboring autonomy fixture setup.

### `src/core/tasks.test.ts` (817 lines)
Edits needed — delete three entire describe blocks:
- `describe('resetAutoProceedRetries', ...)` at lines 692–710.
- `describe('incrementAutoProceedRetries', ...)` at lines 712–736.
- `describe('setAutonomy', ...)` at lines 738–770.
Also remove `autonomy: 'supervised'` / `autonomy: 'autonomous'` overrides from any remaining `createTask({...})` calls that pass them (search the file).

### `src/core/interaction-log.ts`
Edits needed:
- Drop `import type { AutonomyLevel } from './tasks.js';` (line 4).
- Remove the `'auto_proceed' | 'auto_proceed_cancelled' | 'auto_proceed_failed'` entries from the `method` union on `finding_resolved` (line 17). Keep `'input' | 'auto_clear' | 'skip' | 'snooze' | 'false_positive'`.
- Drop `autoProceedDetail?: { delayMs: number; deliveryConfirmed: boolean };` (line 20).
- Trim `cancelledBy` union (line 21): drop `'level_change' | 'manual_respond' | 'direct_reply' | 'rest_api'` (these are all autonomy-orchestrator cancellation reasons). Keep `'user' | 'agent_stopped' | 'restart'`.
- Drop the `autonomy_changed` union member entirely (line 34).
- Drop `'autonomy_changed'` from `SUBSTANTIVE_EVENT_TYPES` (line 157).

### `src/core/detection-stats.ts`
Edits needed:
- Drop `auto_proceed_failure: 0,` from `ZERO_COUNTS` (line 39). After AnomalyType drops the variant in `types.ts`, this will be a type error anyway.

### `src/core/achievement-catalog.ts`
Edits needed:
- The `forty-two` achievement (line 76) reads `"Reach 42 lifetime supervised sessions"`. Here "supervised" leaks from the deleted feature. Change to "Reach 42 lifetime agent sessions" (or similar). Counter remains `session_start_total`.

### `src/core/feedback-bundle.test.ts`
Edits needed:
- Drop `autonomy: 'supervised',` from the task fixture (line 19).

### `src/core/cost-comparison-aggregator.test.ts`
Edits needed:
- Drop `autonomy: overrides.autonomy ?? 'supervised',` from the task factory (line 33).

### `src/core/self-diagnostic.test.ts`
Edits needed:
- Drop `'auto_proceed_failure'` from the `ANOMALY_TYPES` array (line 13).

### `src/shared/contracts/messages.ts`
Edits needed:
- Drop `AutonomyLevel` from `import type { AutonomyLevel, TaskCompletionFeedback } from '../../core/tasks.js';` (line 10).
- Drop `autonomy?: AutonomyLevel;` from `LaunchPlaybookBaseMessage` (line 91).
- In `ClientMessage` (line 180), drop the `autonomy?: AutonomyLevel` from the `launch` message.
- Drop the two ClientMessage members at lines 199–200:
  - `| { type: 'setAutonomy'; taskId: string; level: AutonomyLevel }`
  - `| { type: 'cancelAutoProceed'; agentId: string }`

### `src/shared/contracts/client-message-schema.ts`
Edits needed:
- Drop `const autonomyLevel = z.enum(['supervised', 'autonomous']);` (line 15).
- Drop `'auto_proceed_failure'` from the `anomalyType` enum (line 29).
- Drop `autonomy: autonomyLevel.optional(),` from `launchPlaybookMessage` (line 85).
- Drop `autonomy: autonomyLevel.optional(),` from the `launch` schema (line 130).
- Remove the two union members at lines 182–183:
  - `z.object({ type: z.literal('setAutonomy'), taskId: z.string(), level: autonomyLevel })`
  - `z.object({ type: z.literal('cancelAutoProceed'), agentId: z.string() })`

### `src/shared/protocol.ts`
Edits needed:
- Drop line 23: `export type { AutonomyLevel } from '../core/tasks.js';`.

### `src/server/index.ts` (1350 lines)
Edits needed:
- Drop the two imports at lines 80–81:
  ```
  import { AutoProceedService } from './auto-proceed.js';
  import { AutonomyOrchestrator } from './autonomy-orchestrator.js';
  ```
- In `broadcastToAll` (line 553–615), drop the `if (autonomyOrchestrator)` block at lines 558–565 that enriches `agent.anomaly.autoProceedingAt`.
- Drop the section "Auto-proceed service + autonomy orchestrator" (lines 631–640) — the `new AutoProceedService(...)` + `new AutonomyOrchestrator(...)` constructions.
- Drop the `autonomyOrchestrator,` argument inside the `completeTask` deps literal (line 806).
- Drop `autonomyOrchestrator,` from `wireEventPipeline` args (line 817).
- Drop the line `autonomyOrchestrator.rearmAfterRestart();` (line 854).
- Drop `autonomyOrchestrator,` from the `createRoutes` argument list (line 925).
- Drop `autonomyOrchestrator` from `lifecycleExtras` in `wsConnectionDeps` (line 1077).
- Drop the line `autonomyOrchestrator.dispose();` from `close()` (line 1155).

### `src/server/event-pipeline.ts` (364 lines)
Edits needed:
- Drop `import type { AutonomyOrchestrator } from './autonomy-orchestrator.js';` (line 14).
- Drop `autonomyOrchestrator?: AutonomyOrchestrator;` from `EventPipelineDeps` (line 36).
- Drop the call `deps.autonomyOrchestrator?.scheduleIfNeeded(tmuxName);` (line 192) and its leading comment "Auto-proceed: delegate scheduling decision to orchestrator".

### `src/server/launch-service.ts`
Edits needed:
- Drop `AutonomyLevel` from `import type { Task, TaskStore, AutonomyLevel } from '../core/tasks.js';` (line 3).
- Drop `autonomy?: AutonomyLevel;` field from the launch opts interface (lines 58–59, plus JSDoc).
- In `launchTask` (line ~199), drop `autonomy: opts.autonomy,` from the `taskStore.createTask({...})` call (line 204).
- Note: line 161 has the comment "Claude Code's supervised path" — this is English usage about Claude Code's permission model, NOT the AutonomyLevel feature. LEAVE the comment.

### `src/server/agent-lifecycle.ts`
Edits needed:
- Drop `autonomyOrchestrator?: { onSessionCleanup(agentId: string): void };` from `LifecycleDeps` (line 168).
- Drop the call `deps.autonomyOrchestrator?.onSessionCleanup(tmuxName);` (line 201) inside `cleanupSessionResources`.

### `src/server/ws.ts`
Edits needed:
- Drop `import type { AutonomyOrchestrator } from './autonomy-orchestrator.js';` (line 18).
- Drop `autonomyOrchestrator?: AutonomyOrchestrator;` from `MessageRouterDeps` (line 60).
- In the constructor, drop `autonomyOrchestrator: this.deps.autonomyOrchestrator,` from each of the three handler constructors (lines 112, 133, 142):
  - `configHandler`, `anomalyHandler`, `lifecycleHandler`.
- In `handleMessage` (line 254):
  - Remove `case 'cancelAutoProceed':` from the anomaly group (line 267).
  - Remove `case 'setAutonomy':` from the config group (line 292).

### `src/server/ws.test.ts`
Edits needed:
- Drop the entire `describe('WebSocket MessageRouter — cancelAutoProceed', ...)` block at lines 2422–2475.
- Drop the entire `describe('WebSocket MessageRouter — setAutonomy', ...)` block at lines 2477–2566.

### `src/server/ws-connection-handler.ts`
Edits needed:
- Drop `import type { AutonomyOrchestrator } from './autonomy-orchestrator.js';` (line 23).
- Drop `autonomyOrchestrator?: AutonomyOrchestrator;` from `WsConnectionDeps.lifecycleExtras` (line 51).
- Drop `autonomyOrchestrator: lifecycleExtras.autonomyOrchestrator,` from the `MessageRouter` constructor call (line 120).

### `src/server/ws-handlers/anomaly-handler.ts`
Edits needed:
- Drop `import type { AutonomyOrchestrator } from '../autonomy-orchestrator.js';` (line 8).
- Drop `autonomyOrchestrator?: AutonomyOrchestrator;` from deps (line 29).
- Drop the early-return block (lines 73–80) that rejects `respond` when `isFiring()`:
  ```
  if (this.deps.autonomyOrchestrator?.isFiring(msg.agentId)) { ...alert... return; }
  ```
- Drop `this.deps.autonomyOrchestrator?.onUserRespond(msg.agentId);` (line 82).
- Drop `autonomyOrchestrator: this.deps.autonomyOrchestrator,` from the `sendDirectAgentInput` call (line 133) inside the `directReply` case.
- Drop `this.deps.autonomyOrchestrator?.onPermissionChoice(msg.agentId);` (line 324).
- Drop the entire `case 'cancelAutoProceed':` block at lines 360–363.
- Drop `'cancelAutoProceed'` from the `AnomalyMessage` type union (line 44).

### `src/server/ws-handlers/config-handler.ts` (103 lines)
Edits needed:
- Drop `import type { AutonomyOrchestrator } from '../autonomy-orchestrator.js';` (line 4).
- Drop `autonomyOrchestrator?: AutonomyOrchestrator;` from deps (line 21).
- Drop `'setAutonomy'` from the `ConfigMessage` type union (line 31).
- Drop the entire `case 'setAutonomy':` block at lines 47–61 (calls `taskStore.setAutonomy`, `autonomyOrchestrator.onAutonomyChanged`, and logs `autonomy_changed`).
- The `taskStore` dep remains; check after removal whether it's still used by other cases (it isn't in the visible cases — verify and remove if orphaned).

### `src/server/ws-handlers/lifecycle-handler.ts`
Edits needed:
- Drop `import type { AutonomyOrchestrator } from '../autonomy-orchestrator.js';` (line 7).
- Drop `autonomyOrchestrator?: AutonomyOrchestrator;` from deps (line 44).
- Drop `autonomy: msg.autonomy,` from the `launchTask` opts in the `launch` case (line 107).
- Drop `this.deps.autonomyOrchestrator?.onAgentStopped(msg.agentId);` from the `stop` case (line 135), plus its leading comment "Cancel auto-proceed for this agent".

### `src/server/ws-handlers/playbook-handler.ts`
Edits needed:
- Drop `autonomy: msg.autonomy,` from the `preparePlaybookLaunch` call (line 44) inside `launchPlaybook` case.

### `src/server/routes/shared.ts`
Edits needed:
- Drop `import type { AutonomyOrchestrator } from '../autonomy-orchestrator.js';` (line 24).
- Drop `autonomyOrchestrator?: AutonomyOrchestrator;` field from `RouteDeps` (line 76).

### `src/server/routes/task-routes.ts`
Edits needed:
- In `POST /api/tasks` (lines 92–149):
  - Drop `autonomy?: string;` from the body type (line 99).
  - Drop `const autonomy = body.autonomy === 'autonomous' ? 'autonomous' as const : undefined;` (line 119).
  - Drop `autonomy,` from the `launchTask({...})` call (line 128).
- In `POST /api/playbooks/ralph-loop` (lines 435–519):
  - Drop `autonomy?: string;` from the body type (line 443).
  - Drop the `autonomy` const assignment (line 475).
  - Drop `autonomyOrchestrator: deps.autonomyOrchestrator,` from the `cancelTaskLifecycle` opts (line 490).
  - Drop `autonomy,` from the `launchLoopedPlaybook` opts (line 501).
- In `POST /api/tasks/:taskId/ralph-loop/replace-with-new` (lines 529+):
  - Drop `autonomy?: string;` from the body type (line 539).
  - Drop the `autonomy` const assignment (line 571).
  - Drop `autonomyOrchestrator: deps.autonomyOrchestrator,` from `lifecycleOpts` (line 586).
  - Drop `autonomy,` from the `replaceLoopedPlaybook` opts (line 638).
- In `POST /api/agents/:id/message`:
  - Drop `autonomyOrchestrator: deps.autonomyOrchestrator,` from `sendDirectAgentInput` (line 755).

### `src/server/routes/schedule-routes.ts`
Edits needed:
- Drop the autonomy patch line in PATCH handler (line 57): `if (body.autonomy === "supervised" || body.autonomy === "autonomous") patch.autonomy = body.autonomy;`.

### `src/server/schedule-runner.ts`
Edits needed:
- Drop `autonomy: schedule.autonomy,` from the launcher options object (line 172).

### `src/server/use-cases/agent-input.ts`
Edits needed:
- Drop `import type { AutonomyOrchestrator } from '../autonomy-orchestrator.js';` (line 4).
- Drop `autonomyOrchestrator?: Pick<AutonomyOrchestrator, 'onDirectReply' | 'onRestInput'>;` from `BaseInputDeps` (line 9).
- Drop the conditional `if (source === 'direct_reply') { deps.autonomyOrchestrator?.onDirectReply(...) } else { deps.autonomyOrchestrator?.onRestInput(...) }` block (lines 22–26).

### `src/server/use-cases/agent-input.test.ts`
Edits needed:
- Drop the `autonomyOrchestrator` mock setup and the two `expect(autonomyOrchestrator.*)` assertions in each of the two test cases (lines 8–11, 20–21, 33–36, 45–46). Tests should still verify `sendInput` + log append.

### `src/server/use-cases/playbook-launch.ts`
Edits needed:
- Drop `import type { AutonomyLevel } from '../../core/tasks.js';` (line 9).
- Drop `autonomy?: AutonomyLevel;` from `PreparePlaybookLaunchInput` (line 33).
- Drop `autonomy: input.autonomy,` from the returned `launchOpts` (line 126).

### `src/server/use-cases/playbook-launch.test.ts`
Edits needed:
- Drop `autonomy: 'autonomous',` from the test input (line 31).
- Drop `autonomy: 'autonomous',` from the `expect.objectContaining(...)` (line 39).

### `src/server/use-cases/request-task-reflect.ts`
Edits needed:
- Drop `autonomy: 'autonomous',` from the `deps.launchTask({...})` call (line 147). After removal the reflect task launches with whatever the default behavior is (no autonomy field).

### `src/server/use-cases/load-historical-tasks.test.ts`
Edits needed:
- Drop `autonomy: overrides.autonomy ?? 'supervised',` from `makeTask` (line 16).

### `src/server/completion-metadata.test.ts`
Edits needed:
- Drop `autonomy: 'supervised',` from the task fixture (line 23).

### `src/server/lifecycle-timers.test.ts`
Edits needed:
- Drop `autonomy: 'supervised',` from the task fixture (line 26).

### `src/server/approved-snapshot-callers.test.ts`
Edits needed:
- Drop the line `'src/server/autonomy-orchestrator.ts',` from `APPROVED_DIRECT_CALLERS` (line 28) and its leading comment.
- Drop the line `'src/server/auto-proceed.ts',` (line 30) and its leading comment.

### `src/server/diagnostic-runner.test.ts`
Edits needed:
- Drop `'auto_proceed_failure'` from the anomaly types array (line 10).

### `src/server/index.test.ts`
Not in the worktree at scan time (grep returned no matches). Verify: if file exists, search for `AutoProceedService`, `AutonomyOrchestrator`, `autonomy` references and apply the same patterns. Otherwise no edit needed.

### `src/frontend/components/LaunchTaskDialog.tsx`
Edits needed:
- Drop `AutonomyLevel` from `import { AVAILABLE_AGENT_TYPES, type ClientMessage, type AutonomyLevel, type AgentType } ...` (line 2).
- Drop the `useState<AutonomyLevel>(...)` for autonomy at lines 82–84.
- Drop `localStorage.setItem('kookr:defaultAutonomy', autonomy);` from `handleSubmit` (line 145).
- Drop `autonomy,` from the `send({ type: 'launch', ... })` payload (line 153).
- Drop the entire `<label className="autonomy-toggle">` block at lines 393–418 (the Supervised/Autonomous toggle + hint).

### `src/frontend/components/AgentExecutionConfig.tsx` (49 lines)
This component currently wraps `<AgentTypeSelector>` + autonomy toggle. Two execution options:
1. **Delete** the file and update both callers (`SchedulesDialog.tsx`, line 8/331) to use `<AgentTypeSelector>` directly.
2. **Edit** the file: remove `autonomy`, `onAutonomyChange` props and the entire `<label className="autonomy-toggle">` JSX; leave only the `<AgentTypeSelector>` pass-through. Then either inline at the callsite or keep as a paper-thin wrapper.

Recommended: option 1 (delete file, inline `<AgentTypeSelector>` at the SchedulesDialog callsite). The component name no longer matches its single remaining responsibility.

### `src/frontend/components/SchedulesDialog.tsx`
Edits needed:
- Drop `AutonomyLevel` from the import on line 2.
- Drop the `useState<AutonomyLevel>` for autonomy at lines 88–90.
- Drop `autonomy,` from the POST body at line 190.
- In the `<AgentExecutionConfig autonomy=... onAutonomyChange=... />` render (line 331–337), drop `autonomy` + `onAutonomyChange` props. If `AgentExecutionConfig` is deleted entirely (option 1 above), replace with `<AgentTypeSelector value={agentType} onChange={setAgentType} options={agentOptions as AvailableAgentType[]} />`.

### `src/frontend/components/SettingsDialog.tsx`
Edits needed:
- Drop `import type { AutonomyLevel } from '../../shared/protocol.js';` (line 2).
- Drop the `useState<AutonomyLevel>` at lines 31–33.
- Drop the `handleAutonomyChange` function at lines 98–101.
- Drop the entire `<div className="settings-row">` block for "Default autonomy" at lines 274–299 (settings-label, settings-desc, and the supervised/autonomous buttons).

### `src/frontend/components/PlaybookBrowser.tsx`
Edits needed:
- Drop `AutonomyLevel` from the import (line 2).
- Drop the `useState<AutonomyLevel>` at lines 276–278.
- Drop `localStorage.setItem('kookr:defaultAutonomy', autonomy);` at line 460.
- Drop `autonomy,` from the launch payload at line 610.
- Drop the entire `<label className="autonomy-toggle">` block at lines 818–841 (toggle + hint).

### `src/frontend/components/DetailPanel.tsx`
Edits needed:
- Drop `AutonomyLevel` from the import (line 3).
- Update the "all clear" copy at line 339 — currently `"All clear — agents working autonomously."`. The phrasing reads as generic English (no reliance on the AutonomyLevel field). Recommend keeping but optionally rephrasing to "All clear — no agents need attention." to avoid implying any autonomy mode.
- Drop the conditional render at lines 556–573 (the `<div className="detail-autonomy-toggle">` block with two `setAutonomy` buttons).

### `src/frontend/components/FindingsPanel.tsx`
Edits needed:
- Drop `AutonomyLevel` from the import (line 3).
- Delete the entire `function AutonomyBadge({ agent, send }: ...)` at lines 182–205.
- Delete `function formatAutoProceedCountdown(...)` at lines 235–243.
- In `FindingCard`, drop the `const autoProceedingAt = agent.anomaly?.autoProceedingAt;` (line 255).
- Drop the `useEffect` that ticks countdown when `autoProceedingAt` set (lines 269–274).
- In the finding-header JSX (lines 343–362), drop the entire `{autoProceedingAt ? <span ... auto-proceed-badge ... /> : ...}` ternary; keep the inner `{agent.anomaly?.detectedAt && ...waiting...}` branch unconditionally.
- Drop the conditional separator + `<AutonomyBadge />` at lines 396–397.

### `src/frontend/components/DetailPanel.agent-provider.test.ts`
Edits needed:
- Drop `autonomy: 'supervised',` from the fixture (line 35).

### `src/frontend/components/DetailPanel.density.test.ts`
Edits needed:
- Drop `autonomy: 'supervised',` from the fixture (line 40).

### `src/frontend/components/FindingsPanel.agent-provider.test.ts`
Edits needed:
- Drop `autonomy: 'supervised',` from the fixture (line 28).

### `src/frontend/components/FindingsPanel.collapsed.test.ts`
Edits needed:
- Drop `autonomy: 'supervised',` from the fixture (line 34).

### `src/frontend/components/FindingsPanel.ralph.test.ts`
Edits needed:
- Drop `autonomy: 'supervised',` from both fixtures (lines 65, 90).

### `src/frontend/components/ScheduleSection.test.ts`
Edits needed:
- Drop `autonomy: 'supervised',` from the schedule fixture (line 18).

### `src/frontend/styles.css`
Edits needed — delete the autonomy-related CSS blocks:
- `.finding-context .autonomy-badge-inline` rule (line 546).
- `.age-badge.auto-proceed-badge` and `.age-badge.auto-proceed-badge:hover` rules (lines 612–620).
- The "Autonomy toggle" section: `.autonomy-toggle`, `.autonomy-toggle-label`, `.autonomy-badge`, `.autonomy-options`, `.autonomy-option`, `.autonomy-option:not(:last-child)`, `.autonomy-option.active`, `.autonomy-option:hover:not(.active)`, `.autonomy-hint` (lines 2328–2380).
- The "Autonomy badge on task cards" section: `.autonomy-badge-inline`, `.autonomy-badge-inline:hover`, `.autonomy-badge-inline.auto`, `.autonomy-badge-inline.supervised` (lines 2381–2402).
- The "Autonomy toggle in detail panel header" section: `.detail-autonomy-toggle`, `.autonomy-option-sm`, `.autonomy-option-sm:not(:last-child)`, `.autonomy-option-sm.active`, `.autonomy-option-sm:hover:not(.active)` (lines 2403–2432).

### `src/integrations/telegram/index.ts`
Edits needed:
- Drop `autonomy: 'supervised',` from the `deps.launchTask({...})` call (line 822). The explicit R8 enforcement in `docs/rfc/rfc-remote-chat-trigger.md` becomes dead-letter, but defense-in-depth still applies via the launch route stripping the field.

### `src/integrations/telegram/index.test.ts`
Edits needed:
- Drop the assertion `expect(launchOpts.autonomy).toBe('supervised');` at line 323.

### `src/integrations/telegram/rephrase.test.ts`
The test at lines 99–110 uses `autonomy: 'autonomous'` as a sample unknown field to verify the `TaskSpecSchema` rejects unknown fields (Zod strict). Once `autonomy` is no longer a known field of LaunchOpts the value isn't special; the test's intent — strict-schema unknown-field rejection — is still valid.

Recommended edits (EDIT, not LEAVE — confusing as-is):
- Rename the test from `'rejects unknown autonomy field at schema level (Zod strict)'` to `'rejects unknown fields at schema level (Zod strict)'`.
- Change `autonomy: 'autonomous',` in the LLM payload to a clearly non-existent field, e.g. `foo: 'bar',`.

### `e2e/ralph-compact-controls.spec.ts`
Edits needed:
- Drop `autonomy: 'supervised',` from the POST body (line 14). Without the field, server defaults will apply (no autonomy).

### `docs/features.md`
Edits needed:
- Remove the entire **F9: Agent Autonomy & Auto-Proceed** section (lines 190–199, including the table). Per instructions, do NOT renumber F10–F15.
- Update line 347 `- F9 Agent autonomy / auto-proceed / findings feedback` in the MVP scope list — drop the autonomy/auto-proceed part. The F9.4 "findings feedback loop" item survives (it's the `findingFeedback` WS message, unrelated to autonomy). If F9 is collapsed to a single feature, consider replacing the F9 entry with "Findings feedback (false positives)" or merging into F5.
- Line 83 `"All clear" state` — body text reads `'all agents working autonomously'`. Generic English usage; safe to leave or rephrase to "all agents working" to remove autonomy-leak. LEAVE for now.
- Line 137 — same generic-English usage. LEAVE.
- Line 160 — "When supervised agents create PRs..." — generic English. LEAVE.

### `docs/requirements.md`
Edits needed:
- Line 234 reads `The system SHOULD display a clear "all agents working autonomously" state when no agents need attention.` — Generic phrasing. LEAVE or rephrase parallel to features.md.
- Line 612 mentions autonomy in a list of selected-task header fields. Drop the word `autonomy,` from that comma-list.

### `docs/architecture.md`
Edits needed:
- Line 123 anomaly list: remove `auto_proceed_failure,` (consistent with `types.ts` edit).
- Line 227: drop `setAutonomy, cancelAutoProceed,` from the WS message list.
- Line 282 rewrite-history blurb: drop "autonomy / auto-proceed" from the list of major subsystems. Optional — historical commentary.
- Lines 342–343: remove the two file-tree entries:
  - `│   │   ├── auto-proceed.ts                # Autonomy auto-proceed scheduler`
  - `│   │   ├── autonomy-orchestrator.ts       # Autonomy level enforcement`

### `docs/system-models/subsystems/supervisor-agent/00-subsystem-summary.md`
Edits needed:
- Line 17: drop `auto_proceed_failure` from the anomaly list.

### `docs/roadmap.md`
Edits needed:
- Line 23: text mentions `prompt + cwd + autonomy + agent type`. Drop `+ autonomy`.

### `docs/reference/cli.md`
Edits needed:
- Line 29: example `cat prompt.md | kookr-spawn --autonomous` — remove `--autonomous` (or replace with a different example flag) consistent with deleting the `--autonomous` CLI flag in `bin/kookr-spawn.js`.

### `docs/rfc/rfc-playbook-target-routing.md`
Edits needed:
- Lines 86, 101: the RFC code snippet references `autonomy?: AutonomyLevel;` — drop those lines from the snippet so the doc tracks the post-removal shape.

### `docs/rfc/rfc-launch-dialog-ux.md`
Edits needed:
- Line 9 mentions `autonomy toggle` as one of the dialog's features. Optional doc cleanup — the RFC is historical context but mentioning a removed feature is misleading. Recommend dropping the bullet.

### `docs/rfc/rfc-fun-achievements.md`
Edits needed:
- Line 122 row for the `forty-two` achievement says "Reach 42 lifetime supervised sessions". Update mirror change to `achievement-catalog.ts` — rephrase to "Reach 42 lifetime agent sessions".

### Files outside the original list — `bin/kookr-spawn.d.ts` and `bin/kookr-spawn.js`
These were not in the audit list but contain autonomy-related code that must be removed in tandem.

`bin/kookr-spawn.d.ts` edits:
- Drop `autonomous: boolean;` from `ParsedArgs` (line 20).
- Drop `autonomous: boolean;` from `PostTaskArgs` (line 54).

`bin/kookr-spawn.js` edits:
- Line 44: drop the `--autonomous` line from the HELP_TEXT.
- Line 76: drop `autonomous: false,` default in `parseArgs`.
- Lines 96–97: drop the `--autonomous` flag handler.
- Line 295: drop `autonomous` from the `postTask({...})` destructuring.
- Line 298: drop `if (autonomous) body.autonomy = 'autonomous';`.
- Line 445: drop `autonomous: args.autonomous,` from the `postTask` call.

### `.kookr/playbooks/parallel-issue-batch.md`
Edits needed:
- Line 370: drop `--autonomous` from the example `kookr-spawn` invocation. (`AGENT_FLAG` then becomes the only optional flag.)

### `plugin/skills/self-reflect/scripts/session-analyzer.ts`
Edits needed:
- Line 1172: drop the suggestion line `console.log(\`  → Consider agent autonomy levels (auto-proceed after delay).\`);`. The suggestion would point users to a removed feature. Either delete the whole `if (byIntent["approval"]) { ... }` branch (lines 1170–1174) or replace the suggestion with generic advice ("Consider adding a CLAUDE.md rule that pre-authorises this approval pattern.").

## Files to LEAVE

### `src/server/index.test.ts`
Not present in the worktree at audit time (grep returned no matches). LEAVE — but verify before merging.

### `docs/getting-started.md`
Line 95: `"Permission bypass for supervised agents"` — generic English usage about agents you supervise yourself; not the AutonomyLevel feature.

### `docs/hooks-setup.md`
Line 8: `"the full 'I want the same guardrails when running autonomous agents' path"` — generic English about agents running unattended, not the AutonomyLevel feature.

### `docs/adr/006-permission-mode-feasibility.md`
Line 21: `"Yes — full autonomy"` describing the `bypassPermissions` mode. English usage about Claude Code permission modes, not the per-task AutonomyLevel.

### `docs/adr/010-session-reflection-workflow.md`
Line 360: `"visible when at least one agent has been supervised"` — refers to past human-supervised agents, not the AutonomyLevel.

### `docs/adr/012-github-pr-awareness.md`
Line 15: `"When a supervised agent creates a PR..."` — generic English usage.

### `docs/adr/013-stuck-detection-promotion-criteria.md`
Line 9: `"the most common supervised-agent failure mode"` — generic English.

### `docs/poc/003-codex-compatibility-gaps.md`
Line 191: `"skip the prompt for supervised launches"` — Codex flag proposal; generic English usage.

### `docs/poc/006-bypass-permissions-ask-rule-override.md`
Lines 22, 95: `"the autonomous Ralph playbook"`, `"the autonomous Ralph use case"` — refer to the Ralph playbook running unattended, NOT the AutonomyLevel feature.

### `docs/poc/007-bypass-keeps-file-based-agents.md`
Line 224: `"Kookr's autonomous flows would re-stall"` — generic English about agents running unattended.

### `docs/rfc/rfc-demo-video-strategy.md`
Lines 9, 107: mention F9 / autonomy as part of the surface-area survey. The references describe the audit state at the time the RFC was written; rewriting to reflect post-removal state would be revisionist. LEAVE as historical record; the RFC text itself is not load-bearing for the demo pipeline post-removal.

### `docs/rfc/rfc-supervision-next-actions.md`
Line 11: `"Kookr is becoming more autonomous"` — generic English describing the project trajectory. Other lines (e.g. line 15 "supervision sessions") use "supervision" in the human-supervises-Kookr sense, not the AutonomyLevel.

### `docs/rfc/rfc-remote-chat-trigger.md`
Many references to `autonomy: 'supervised'` in code snippets and the R8 invariant. The RFC is historical; the R8 enforcement becomes vacuous once the field is gone. LEAVE the RFC text — it documents a real design decision that shipped. If you want the doc to track the new reality, mark the R8 section with a postscript "Vacuous post 2026-05-12 autonomy removal (autonomy field deleted)".

### `docs/rfc/rfc-task-chime-browser.md`
Line 323: `"autonomous completed transition"` — generic English about agents finishing without user intervention.

### `docs/spikes/gui-proposals/29-triage-sidebar-synthesis.html`
Line 321: `"All agents working autonomously."` — UI mockup copy mirroring the same generic English usage as `DetailPanel.tsx`.

### `src/frontend/hooks/useTaskCompletionChime.test.ts`
Line 377: `"The chime hook does not distinguish autonomous vs user-initiated transitions."` — generic English about what triggered the completion.

### `.claude/skills/kookr-supervise-tasks/SKILL.md`
Entire skill is about human-driven supervision of running tasks (sending keystrokes, advancing prompts manually). The skill description uses "Autonomously monitor", "supervised task", etc. in the human-as-supervisor sense. This is the replacement workflow for the deleted auto-proceed feature and explicitly NOT in scope.

### `.claude/skills/kookr-session-reflect/SKILL.md`
Line 46: `"Agent needs autonomy guidance"` — refers to writing better CLAUDE.md rules for the agent, not the AutonomyLevel field.

### `.claude/skills/kookr-oss-issue-scout/SKILL.md`
Line 60: `"autonomous playbooks should stop"` — generic English about unattended playbooks.

### `.claude/playbooks/oss-contribute.md`
Lines 7, 42: `"Fully autonomous end-to-end OSS contribution"`, `"Autonomous playbooks block by default"` — generic English about playbooks designed to run unattended.

### `hooks/oss-stale-scout-gate.sh`
Line 8: comment `"autonomous OSS contributions"` — generic English usage.

### `plugin/skills/claude-code-metrics-analysis/SKILL.md`
Line 157: `"high counts may mean agent isn't autonomous enough"` — generic English, no AutonomyLevel reliance.

### `plugin/skills/claude-code-permissions/SKILL.md`
Line 16: `"safe-by-default permission configs for autonomous agents"` — generic English.

### `plugin/skills/git-commit-discipline/SKILL.md`
Line 204: `"Autonomous agents MUST commit incrementally..."` — generic English about long-running agents.

### `plugin/skills/testing-patterns/SKILL.md`
Line 38: `"Worker/autonomy mode | Set intentionally, not inherited stale state"` — Worker autonomy is a test isolation pattern, unrelated to the Kookr per-task AutonomyLevel field.

## Env vars / settings flags to remove

- No `KOOKR_AUTO_PROCEED_*` or `KOOKR_AUTONOMY_*` env vars found in the codebase (verified via `grep -rE "KOOKR_AUTO_PROCEED|KOOKR_AUTONOMY"`).
- `localStorage` key `kookr:defaultAutonomy` — used by LaunchTaskDialog, SettingsDialog, SchedulesDialog, PlaybookBrowser. Stop reading and writing this key (covered in per-file edits). Stale values left in users' browsers are harmless.

## Frontend UI surfaces to remove

- **LaunchTaskDialog** autonomy toggle and submit-payload field (`LaunchTaskDialog.tsx` lines 82–84, 145, 153, 393–418).
- **PlaybookBrowser** autonomy toggle (`PlaybookBrowser.tsx` lines 276–278, 460, 610, 818–841).
- **SchedulesDialog** autonomy state + form payload (`SchedulesDialog.tsx` lines 88–90, 190; the `<AgentExecutionConfig>` call at line 331).
- **SettingsDialog** "Default autonomy" row (`SettingsDialog.tsx` lines 31–33, 98–101, 274–299).
- **DetailPanel** inline autonomy toggle in the header (`DetailPanel.tsx` lines 556–573).
- **FindingsPanel** `<AutonomyBadge>` and auto-proceed countdown badge/`cancelAutoProceed` click target (`FindingsPanel.tsx` lines 182–205, 235–243, 255, 269–274, 344–354, 396–397).
- **AgentExecutionConfig** the autonomy toggle inside the shared composite (`AgentExecutionConfig.tsx` lines 27–45; component recommended for deletion).
- **CSS**: all `.autonomy-*`, `.auto-proceed-badge`, `.detail-autonomy-toggle` rules (`styles.css` lines 546, 612–620, 2328–2432).

## API/WS message fields to remove

- **HTTP** `POST /api/tasks` request body field `autonomy`.
- **HTTP** `POST /api/playbooks/ralph-loop` request body field `autonomy`.
- **HTTP** `POST /api/tasks/:taskId/ralph-loop/replace-with-new` request body field `autonomy`.
- **HTTP** `PATCH /api/schedules/:id` request body field `autonomy`.
- **HTTP** `POST /api/schedules` create body field `autonomy` (via `CreateScheduleInput`).
- **WS** client → server messages to delete entirely:
  - `setAutonomy { taskId, level }`
  - `cancelAutoProceed { agentId }`
- **WS** message field deletions on existing messages:
  - `launch` → `autonomy?`
  - `launchPlaybook` → `autonomy?`
- **WS** server → client: `Anomaly.autoProceedingAt` is no longer emitted (drop from `core/types.ts`).
- **Interaction log** event types to remove:
  - `autonomy_changed` (entire event)
  - `finding_resolved.method` variants `auto_proceed | auto_proceed_cancelled | auto_proceed_failed`
  - `finding_resolved.cancelledBy` variants `level_change | manual_respond | direct_reply | rest_api`
- **Anomaly types** to remove: `auto_proceed_failure` (from `AnomalyType`, the Zod enum, `DetectionStats.ZERO_COUNTS`, and the diagnostic-runner / self-diagnostic test arrays).

## Tests to delete entirely

- `src/server/auto-proceed.test.ts`
- `src/server/auto-proceed-integration.test.ts`

## Tests to edit (remove autonomy expectations only)

- `src/core/tasks.test.ts` — drop three describe blocks (lines 692–770); remove autonomy fixture args from any other `createTask` calls.
- `src/core/schedule.test.ts` — drop the autonomy default assertion (line 32).
- `src/core/feedback-bundle.test.ts` — drop `autonomy: 'supervised'` fixture field (line 19).
- `src/core/cost-comparison-aggregator.test.ts` — drop fixture autonomy field (line 33).
- `src/core/self-diagnostic.test.ts` — drop `auto_proceed_failure` from `ANOMALY_TYPES`.
- `src/server/ws.test.ts` — drop `cancelAutoProceed` describe (lines 2422–2475) and `setAutonomy` describe (lines 2477–2566).
- `src/server/use-cases/agent-input.test.ts` — drop autonomyOrchestrator mocks and assertions.
- `src/server/use-cases/playbook-launch.test.ts` — drop autonomy from input and expectation (lines 31, 39).
- `src/server/use-cases/load-historical-tasks.test.ts` — drop autonomy fixture override (line 16).
- `src/server/completion-metadata.test.ts` — drop `autonomy: 'supervised'` fixture field (line 23).
- `src/server/lifecycle-timers.test.ts` — drop fixture field (line 26).
- `src/server/approved-snapshot-callers.test.ts` — drop the two file paths.
- `src/server/diagnostic-runner.test.ts` — drop `auto_proceed_failure` from anomaly types array.
- `src/frontend/components/ScheduleSection.test.ts` — drop fixture field (line 18).
- `src/frontend/components/DetailPanel.agent-provider.test.ts` — drop fixture field (line 35).
- `src/frontend/components/DetailPanel.density.test.ts` — drop fixture field (line 40).
- `src/frontend/components/FindingsPanel.agent-provider.test.ts` — drop fixture field (line 28).
- `src/frontend/components/FindingsPanel.collapsed.test.ts` — drop fixture field (line 34).
- `src/frontend/components/FindingsPanel.ralph.test.ts` — drop fixture field (lines 65, 90).
- `src/integrations/telegram/index.test.ts` — drop `expect(launchOpts.autonomy).toBe('supervised');` (line 323).
- `src/integrations/telegram/rephrase.test.ts` — rename test and replace `autonomy: 'autonomous'` sample with a different unknown field (lines 99–110).
- `e2e/ralph-compact-controls.spec.ts` — drop `autonomy: 'supervised'` from POST body (line 14).

## Documentation edits

- `docs/features.md`: remove the F9 section entirely (lines 190–199) without renumbering F10–F15; trim the MVP-scope F9 bullet on line 347.
- `docs/requirements.md`: drop `autonomy,` from the header-fields list on line 612.
- `docs/architecture.md`: remove `auto_proceed_failure` from the anomaly enumeration (line 123), drop `setAutonomy, cancelAutoProceed,` from the WS message list (line 227), and remove the two file-tree entries (lines 342–343).
- `docs/system-models/subsystems/supervisor-agent/00-subsystem-summary.md`: drop `auto_proceed_failure` (line 17).
- `docs/roadmap.md`: drop `+ autonomy` from the dialog-features description (line 23).
- `docs/reference/cli.md`: remove `--autonomous` from the example invocation (line 29).
- `docs/rfc/rfc-playbook-target-routing.md`: drop the `autonomy?: AutonomyLevel;` lines from the code snippets (lines 86, 101).
- `docs/rfc/rfc-fun-achievements.md`: rephrase the `forty-two` achievement row (line 122).
- `docs/rfc/rfc-launch-dialog-ux.md`: drop the `autonomy toggle` bullet from the dialog's behavior list (line 9).
- Optional: append a deprecation postscript to `docs/rfc/rfc-remote-chat-trigger.md` § R8 noting that the R8 enforcement is vacuous post-removal.

## Adjacent issues observed (NOT in scope — follow-ups)

- The `Anomaly.subType` field (`stop` | `ask_user_question`) was originally introduced for autonomy decisions but it's also useful for other anomaly handling. Keep the field, only update the JSDoc.
- The `forty-two` easter-egg achievement tier counter (`session_start_total`) is independent of autonomy; only the description string changes.
- `docs/poc/002-hook-state-detection.md` line 202 mentions `auto-proceed if configured` in the analysis of the `Notification(idle_prompt)` hook — historical PoC text, not load-bearing. LEAVE.
- `docs/rfc/rfc-remote-chat-trigger.md` R8 requirement becomes vacuous (defense-in-depth removed). Worth a follow-up note in the RFC but not a blocker.

## Open blockers / human-judgement-needed

None. The autonomy feature is well-isolated: a typed field on `Task`, a single orchestrator + scheduler in `src/server`, and UI surfaces. No persisted side-effects beyond the legacy `autonomy` field in `~/.kookr/tasks.json`, which will be silently dropped on next load when `loadTasks` no longer reads/back-fills it.

Two judgement calls flagged for the executor:

1. **`AgentExecutionConfig.tsx`** — recommend deletion (option 1) over keeping a paper-thin wrapper. The component name no longer matches its remaining responsibility.
2. **CLI `--autonomous` flag in `bin/kookr-spawn.js`** — the file isn't in the original audit list but contains the public CLI flag. Removing it is a (small) public-CLI break; if you want a deprecation cycle, leave the flag parsing in but make it a no-op + warn-on-use. Otherwise delete cleanly.
