# RFC: Fun Achievements — Catalog Expansion & Dedicated Page

## Status

**Draft (v3 — post round-2 critiques: delivery-pragmatist, failure-mode-analyst — ready for user review)**

**Date:** 2026-05-07
**Author:** Jean Ibarz (with Claude)

---

## Problem

Kookr ships a working achievement system: 9 achievements, a watcher, JSON store, modal panel, toast on unlock, WebSocket plumbing. It works, but the catalog is undersized for a tool that has gained ~25 features in the last few weeks (cron schedules, playbooks, multi-project tracking, GitHub integration, terminal attach, Codex agents, session reflection, ralph loops, workspaces, GitHub PR triage). Most of those features have no achievement attached, and the existing 9 are utilitarian (`first-agent`, `first-response`, `5-agents`) — they reward existence, not exploration or personality.

This RFC expands the catalog to **22 achievements** with a deliberate skew toward *playful* over *bureaucratic*, wires up the missing trigger surfaces, and (in a later phase, gated on density) introduces a `/achievements` route alongside the existing modal/toast.

## Why now / what success looks like

Round-1 socratic challenger asked the load-bearing question: *what problem is this actually solving?*

- **Primary purpose:** the author's own motivation while iterating on Kookr, plus screenshotability for the upcoming public OSS launch.
- **Not the purpose:** feature discoverability — that is the onboarding tour's job (existing RFC). If a user never launches a Codex agent, an achievement won't fix that; the onboarding tour will.

**Success metric:** *if after Phase 2 ships, the author personally unlocks 10+ achievements within their normal weekly Kookr usage, and at least one achievement gets posted as a screenshot in OSS-launch promotion, this RFC was worth it.* If those numbers don't land, do not build Phase 3 (the dedicated page). Author manually checks `Object.keys(unlocked).length >= 10` before opening the Phase 3 PR.

## Active-user reality check

Single-tenant local. Today: author + small handful of OSS contributors and external testers. Don't optimize for thousands. Optimize for taste.

## Design principles

1. **Celebrate behaviors we want more of, not just behaviors we can detect.** Cuts speed-over-judgment and triviality-rewarding achievements.
2. **No shame, but affectionate roast is fine.**
3. **Existing investment must be honored.** One-time retroactive back-fill on first launch unlocks any boolean-precondition discovery achievement that is currently true. Tier counters start fresh.
4. **Every achievement maps to a real, currently-emitted signal** — or to a single named instrumentation addition listed in §Implementation. No vapor signals. (Round-2: this principle is now load-bearing — see §Definitions.)
5. **Counters are tamper-resistant.** Resolution counters require non-trivial respond bodies (≥ 3 non-whitespace chars). Disabled-mode pauses counter mutation, not just toast firing.

## Definitions (round-2 critical fixes)

The detector returns *at most one anomaly per detection call* (`anomaly-detector.ts:38–100`), with shape `{agentId, type, severity, detectedAt}` — there is **no stable finding-id**. v2 was wrong about this. v3 reframes:

> **A user-resolved anomaly** is the event in which the user sends a `respond` or `directReply` whose body contains ≥ 3 non-whitespace characters, while a non-snoozed anomaly was active for that task at the moment the message was processed. The active anomaly's `type` is recorded with the resolution timestamp. Exactly one counter increments per resolution event.

Implementation primitives (round-2 delivery):

- **`AttentionQueue.getActiveAnomaly(agentId)`** — new method returning `{type, detectedAt} | null`. Filters out snoozed and `lastRemoved` entries, returning only currently-active. (One method, not a refactor of `getAnomaly`.)
- **`agentId → taskId` mapping** — already available via `taskStore.getByAgentId(agentId)`; verified.
- **`recordResolution(agentId, body)` helper in achievement-watcher** — called from the existing `respond` and `directReply` arms in `ws-connection-handler.ts`. Returns early if body fails the 3-char gate. Otherwise looks up active anomaly, increments `counters[<type>_resolutions]`, updates streak, and runs tier checks.

This replaces v2's "list of types" semantics with single-type semantics. `stuck-together` now keys off `(agentId, type)` tuples — see catalog.

## Requirements

- **R1.** Each new achievement must map to a real signal already produced by Kookr, or to a single named instrumentation addition in §Implementation.
- **R2.** Catalog changes are additive. Existing achievement IDs and unlock criteria must not change.
- **R3.** A one-time retroactive back-fill on first launch of v2 unlocks discovery achievements whose precondition is *currently true* (boolean only). Idempotency guarded by a `backfillCompleted: true` flag in the achievement file (not by `tryUnlock` alone).
- **R4.** Existing **category IDs** remain stable (`first-steps`, `feature-discovery`, `multi-agent`, `easter-egg`). Display names and ordering may change. New categories may be added. No type-level rename. (Round-2 fix.)
- **R5.** No achievement may shame the user; affectionate self-aware copy is allowed and encouraged.
- **R6.** No achievement may reward perverse incentives (speed-over-judgment, triviality, work fragmentation, body-spam).
- **R7.** The dedicated `/achievements` page is a Phase 3 deliverable, gated on the success metric.
- **R8.** Tier achievements increment integer counters server-side. Counters and streak ride in the existing snapshot. **Snapshot contract extension lands in Phase 1**, not Phase 2 (round-2 fix).
- **R9.** Achievement copy and emoji are reviewed in a single sit-down pass by the author before Phase 3 ships.
- **R10.** Achievement file uses zod schema validation. On parse failure, the file is **quarantined** to `achievements.quarantined-<ISO>.json` and a fresh state is created — never silently reset (round-2 critical fix).
- **R11.** When achievements are disabled (`achievementsEnabled: false`), the watcher does NOT mutate counters or streak. Re-enabling does not retroactively scan.

## Non-goals

- No global leaderboard, social sharing, or multi-tenant features.
- No XP / points / levels.
- No locale/translation; English-only.
- No retroactive unlock for tier counters or behavioral achievements (only boolean discovery achievements per R3).
- No removal of existing achievements.
- No achievements that require third-party network calls.
- No multi-machine sync. Per-machine divergence is by design; documented in the dedicated-page footer copy when Phase 3 ships.

## Catalog v3 — 22 achievements, 4 stable category IDs

Display labels in parentheses. Legend: ★ existing signal, no new instrumentation.

### Category ID `first-steps` (display: **"First Steps"**) — kept verbatim

| ID | Name | Emoji | Description |
|---|---|---|---|
| `first-agent` | First Contact | 👋 | Monitor your first AI agent |
| `first-anomaly-resolved` | Good Eye | 👁 | Resolve your first detected anomaly |
| `first-response` | Whisperer | 💬 | Send your first message to an agent |

### Category ID `feature-discovery` (display: **"Field Guide"**) — expanded

| ID | Name | Emoji | Description | Trigger |
|---|---|---|---|---|
| `first-shortcut` | Keyboard Warrior | ⌨ | Use a keyboard shortcut | existing |
| `smart-response-used` | AI Assist | 🤖 | Accept a smart response suggestion | existing |
| `task-launched` | Mission Control | 🚀 | Launch an agent task from the UI | existing |
| `first-cron` ★ | Crontab Curator | 🕰 | Schedule your first recurring agent | `schedule:create` client message |
| `first-codex` ★ | Polyglot | 🌐 | Launch your first Codex CLI agent | `session_start` event with `agent: 'codex'` |
| `first-multi-project` ★ | Two Worlds | 🪐 | Register a second project directory | `project:register` boundary 1→2 (current count, additive — see clarifications) |
| `first-feedback` ★ | Honest Critic | 👍 | Submit thumbs-up or thumbs-down on a task | `task:feedback` client message |
| `first-snooze` ★ | Not Now | 💤 | Snooze a finding | `finding:snooze` action |
| `first-direct-reply` ★ | Backseat Driver | 🎤 | Send a direct reply mid-stream | `directReply` action |

### Category ID `multi-agent` (display: **"Battle Honors"**) — expanded

| ID | Name | Emoji | Description | Trigger |
|---|---|---|---|---|
| `five-agents` | Squadron Leader | ✈ | Run 5 agents simultaneously | existing |
| `ten-agents` | Fleet Commander | 🚢 | Run 10 agents simultaneously | existing |
| `loop-buster-i` ★ | Loop Buster | 🔓 | Resolve 10 stuck-loop anomalies | `counters.repeated_error_resolutions ≥ 10` |
| `loop-buster-ii` ★ | Loop Crusher | 🔨 | Resolve 50 stuck-loop anomalies | `≥ 50` |
| `permission-whisperer` ★ | Permission Whisperer | 🗝 | Resolve 25 permission-block anomalies | `counters.permission_blocked_resolutions ≥ 25` |
| `iron-streak` ★ | Iron Streak | 🔥 | 7 consecutive days with at least one user-resolved anomaly | `streak.currentStreak ≥ 7` |

### Category ID `easter-egg` (display: **"Folklore"**) — expanded with affectionate roasts

| ID | Name | Emoji | Description | Trigger |
|---|---|---|---|---|
| `the-loop` | The Loop | 🔄 | Kookr supervises an agent working on Kookr itself | existing |
| `stuck-together` ★ | Stuck Together | 🤝 | Resolve the same `(agentId, type)` anomaly 3 times within 1 hour | rolling window keyed by tuple |
| `tab-hoarder` ★ | Tab Hoarder | 📑 | Have 10+ unsnoozed findings observable in a single snapshot tick | snapshot count |
| `afk` ★ | Welcome Back | 🐻 | Resolve an anomaly more than 30 minutes after it fired | `resolution_at − active_anomaly.detectedAt > 30m` |
| `forty-two` ★ | The Answer | 4️⃣2️⃣ | Reach 42 lifetime agent sessions | `counters.session_start_total ≥ 42` (round-2 crash-safe; was `==42`) |
| `self-aware` ★ | Self-Aware | 🪞 | Launch a task whose subject matches `\bkookr\b` (case-insensitive) | task subject regex with word boundary (round-2: tightened from `/kookr/i`) |

**Cut from v1/v2:** Triage Streak, Penny Pincher (perverse incentives); Shortcut Master, Playbook Explorer (unreachable for low-feature users + persisted distinct-ID set complexity); Konami, Coffee Break (generic, not Kookr-specific); Cost-Aware (too thin); time-of-day category (folded into Folklore via `afk`).

## Persistence schema (zod-validated, quarantine-on-fail)

```ts
const AchievementFileSchema = z.object({
  unlocked: z.record(z.string(), z.string().datetime()),
  counters: z.object({
    repeated_error_resolutions: z.number().int().nonnegative(),
    permission_blocked_resolutions: z.number().int().nonnegative(),
    merge_conflict_resolutions: z.number().int().nonnegative(),
    api_error_resolutions: z.number().int().nonnegative(),
    needs_input_resolutions: z.number().int().nonnegative(),
    ask_user_question_resolutions: z.number().int().nonnegative(),
    session_start_total: z.number().int().nonnegative(),
    stuck_together_runs: z.record(
      z.string(),  // key: `${agentId}:${type}`
      z.array(z.string().datetime())  // resolution timestamps within last hour
    ),
  }).default({}),
  streak: z.object({
    lastActiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    currentStreak: z.number().int().nonnegative(),
  }).default({ lastActiveDate: null, currentStreak: 0 }),
  backfillCompleted: z.boolean().default(false),
  schemaVersion: z.literal(2).default(2),
});
```

**On read failure** (parse error, schema mismatch, hand-edited corruption): rename file to `achievements.quarantined-<ISO>.json`, log warning, surface a one-time UI banner ("Achievement state was reset due to file corruption — quarantined copy at <path>"), start fresh. **Never silently reset** (R10 — round-2 critical).

**Migration from v1** (`{unlocked: {...}}` only, no `schemaVersion`): defaults populate cleanly via zod's `.default(...)`; back-fill runs as post-init pass.

## Retroactive back-fill (R3)

Runs **once**, gated by `backfillCompleted: true` flag. Wired as **post-init pass** in `index.ts` after `scheduleStore`, `taskStore`, and project registry are all loaded — NOT at watcher construction time (round-2 critical fix).

```ts
async function runBackfillOnce(deps: { watcher, scheduleStore, taskStore, projectRegistry }) {
  if (deps.watcher.state.backfillCompleted) return;
  const checks: Array<[string, () => boolean]> = [
    ['first-cron',           () => deps.scheduleStore.list().length > 0],
    ['first-multi-project',  () => deps.projectRegistry.count() >= 2],
    ['first-feedback',       () => deps.taskStore.list().some(t => t.feedback != null)],
    ['first-snooze',         () => deps.taskStore.list().some(t => t.snoozedFindings?.length > 0)],
    ['first-codex',          () => deps.taskStore.list().some(t => t.agent === 'codex')],
    ['self-aware',           () => deps.taskStore.list().some(t => /\bkookr\b/i.test(t.subject ?? ''))],
  ];
  for (const [id, predicate] of checks) {
    if (predicate()) deps.watcher.tryUnlock(id);
  }
  deps.watcher.markBackfillComplete();  // sets flag + persists
}
```

Toast queue handles spacing (existing client-side queueing — see `achievement-system-slice.ts`); back-fill emits the same `achievement:unlocked` events as runtime unlocks.

**Tier counters do not back-fill.** Loop Buster, Permission Whisperer, streak start at zero. Acknowledged tradeoff: existing power users get ~5 instant unlocks (boolean discovery) but earn tier achievements going forward.

## Trigger gap-fill (server-side wiring)

`src/server/achievement-watcher.ts` gains the following check arms:

```
client message      → check
─────────────────────────────────────────────
schedule:create     → first-cron
project:register    → first-multi-project (boundary current==2; additive)
finding:snooze      → first-snooze
task:feedback       → first-feedback
directReply         → first-direct-reply, then recordResolution(...)
respond             → recordResolution(...)
task:launch         → self-aware (when subject matches \bkookr\b/i)

agent event         → check
─────────────────────────────────────────────
session_start       → first-codex (when agent='codex')
                      counters.session_start_total++; check forty-two

snapshot watcher    → check
─────────────────────────────────────────────
unsnoozed finding count for any task ≥ 10 → tab-hoarder

derived (in recordResolution)
─────────────────────────────────────────────
- gate: body contains ≥ 3 non-whitespace chars (R6)
- gate: achievementsEnabled is true (R11)
- look up active anomaly via AttentionQueue.getActiveAnomaly(agentId)
- if null → return (no resolution credit)
- counter increment for active.type
- streak.update(today)
- check loop-buster-i/ii (if type=repeated_error)
- check permission-whisperer (if type=permission_blocked)
- check iron-streak
- update stuck_together_runs[`${agentId}:${type}`]:
    push now; drop entries older than 1 hour;
    if length ≥ 3 and 'stuck-together' not unlocked → tryUnlock
- check afk (now − active.detectedAt > 30m)
```

**Map size cap:** `stuck_together_runs` pruned on each write — entries older than 1 hour drop, and the map is hard-capped at 200 keys (oldest evicted) as a safety bound.

## Implementation phases

Phase 1 is split into 1a / 1b / 1c per round-2 delivery. Each is independently mergeable.

| Phase | Subphase | Scope | PR shape |
|---|---|---|---|
| 1 | 1a | Schema migration + zod validation + quarantine path. New category display labels in `CATEGORY_DISPLAY` map (no type rename). New catalog IDs added with no triggers wired yet. Frontend audit: grep for old category-name string literals; fix any. | One PR, no behavior change visible to user beyond display labels. |
| 1 | 1b | `AttentionQueue.getActiveAnomaly(agentId)` method + tests. `agentId→taskId` mapping confirmed via `taskStore.getByAgentId`. No achievement triggers yet. | One PR, isolated API addition. |
| 1 | 1c | `recordResolution` helper + all new triggers wired (boolean, counter, streak, tab-hoarder snapshot watcher, stuck-together rolling window). Snapshot contract extended (`counters`, `streak`) — landed here per R8. Retroactive back-fill runs as post-init pass. | One PR, lights up the catalog. |
| 2 | — | Counter / streak progress UI in modal. Tier achievements show "X / Y" inside their card. Streak shows current count with flame icon. | One PR, frontend-only beyond the existing snapshot data. |
| 3 | — | Dedicated `/achievements` route (gated on success metric). Refactor inner content to `<AchievementsContent>` shared between modal and route. Author copy/emoji review pass before merge per R9. | One PR, gated. |

Rollback: every subphase is independently revertable. v1 file format remains readable by the v1 loader if v3 is rolled back (extra keys ignored; counter/streak data is lost but unlocked map preserved — acknowledged in §Risks).

## Open questions

1. Should `tab-hoarder` re-trigger if the queue empties and refills past 10 again? **v3 proposes once-and-done** (achievements are not re-unlockable; consistent with rest of catalog).
2. Should `afk` copy be celebratory ("Welcome Back") or roasty ("Where Did You Go")? **v3 proposes celebratory** — the user *came back*, that is the reward-worthy moment.
3. Streak reset on missed day is harsh. Offer a "freeze" (one missed day forgiven per N days)? **v3: no — keep three lines.** Reconsider only if Phase 1 ships and the author observes their own frustration.
4. `forty-two` exact-match was changed to `≥ 42` for crash safety. The joke is preserved (it fires on session 42 in normal operation). Acceptable?
5. Body-validation gate is 3 non-whitespace characters. Reasonable? Higher (10) prevents "ok" / "yes" but those are real responses. Lower (1) lets "k" through. **v3 proposes 3.**

## Risks

- **Toast storm on first launch.** Back-fill emits ~5 toasts; client queue spaces them at 1.5s, max 3 visible. If user reloads mid-storm, in-flight toast queue is lost but `unlocked` map is correct. Acknowledged.
- **Streak time-skew across timezones / multi-machine.** Acceptable for fun-not-audit. Per-machine divergence is by design (R8 Non-goal).
- **`stuck_together_runs` map growth.** Bounded by the 1-hour TTL prune + 200-key hard cap.
- **Counter loss on rollback to v1.** v1 loader ignores `counters`/`streak` keys; unlocked map is preserved. Tier progress lost but not corrupted. Acknowledged.
- **`tab-hoarder` once-and-done is invisible after unlock.** A user who hits 10 findings, unlocks, and then rebuilds toward 10 will see no toast on the second occurrence. This is consistent with all other achievements; if it surprises the author, reconsider in Phase 2.
- **`forty-two` skip risk** mitigated by `≥ 42` check (round-2 fix).
- **Snapshot watcher cost.** `tab-hoarder` adds one finding-count comparison per snapshot tick. Each tick already iterates active tasks for other purposes. Negligible. Pruning of `stuck_together_runs` is bounded as above.
- **Self-aware regex over-match.** `\bkookr\b` rejects "anti-kookr" and "kookrify" matches; intentional tightening per round-2.
- **Author copy/emoji review bottleneck.** If author skips R9 review, Phase 3 doesn't ship — design, not a risk.

## Changes from v2

- **Defined "user-resolved anomaly" against single-anomaly-per-call detector reality.** v2 assumed multi-anomaly + finding-id; both wrong. Reframed against `(agentId, type)` tuples (round-2 failure-mode #1, #2).
- **Added body-validation gate (≥ 3 non-whitespace chars)** to prevent counter gaming via empty `respond` (round-2 failure-mode #1).
- **Disabled-mode now pauses counter mutation** (R11; round-2 failure-mode #13).
- **Category rename is display-only** — IDs unchanged. v2 R4 was wrong (round-2 failure-mode #15, delivery on `achievement-catalog.ts:11`).
- **zod schema validation with quarantine, not silent reset** (R10; round-2 critical data-loss path).
- **Phase 1 split into 1a/1b/1c** (round-2 delivery): schema/IDs, AttentionQueue API, helper+wiring.
- **Snapshot contract extension lands in Phase 1**, not 2 (R8; round-2 delivery).
- **Back-fill wired as explicit post-init pass** with `backfillCompleted` flag (round-2 delivery: ordering bug at index.ts:545 vs :783).
- **`forty-two` uses `≥ 42`**, not `==42`, for crash safety (round-2 failure-mode #6).
- **`self-aware` regex tightened** to `\bkookr\b` (round-2 failure-mode #11).
- **`stuck-together` redefined** against `(agentId, type)` tuples + 1h rolling window + 200-key hard cap (round-2 failure-mode #2, #10).
- **Cut `stuck_together_runs` keyed by finding-id** (vapor signal in v2).
- **Documented v1 rollback safety** explicitly (round-2 delivery).
- **Per-machine divergence acknowledged** in non-goals (round-2 failure-mode #7).
