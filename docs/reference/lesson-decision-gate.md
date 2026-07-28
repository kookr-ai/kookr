# Lesson-decision gate + yield metric (issue #1538)

The durable lesson-write spool ([#1519](./lesson-write-spool.md)) fixed
**write durability** when the knowledge base is degraded. It did not fix the
authoring trigger: agents finished work and raised `completion-ready` without
emitting a lesson or an explicit skip. The flywheel went silent for a second
consecutive reflection window (0 lessons in 24h despite dozens of completed
tasks).

This gate makes lesson authoring a **lifecycle step**, not a voluntary act.

## Lifecycle gate

`POST /api/tasks/:id/signal` with `kind: "completion_ready"`:

1. Resolves the task's sessions → hook logs under `<kookrDir>/hooks/<tmuxSession>.jsonl`.
2. Classifies PreToolUse Bash commands with the same rules as issue #227 /
   `scripts/kb-usage-report.ts`:
   - `kb remember` → **wrote-lesson**
   - literal `No generic KB lesson:` → **explicit-skip**
   - other `kb ` traffic → **search-only**
   - neither → **no-kb-activity**
3. If the task has ≥1 session and the decision is not wrote-lesson/explicit-skip,
   responds **409** with:
   ```json
   {
     "error": "…",
     "code": "lesson_decision_required",
     "decision": "search-only" | "no-kb-activity",
     "hint": "Emit a post-task lesson decision …",
     "counts": { "lessonWrites": 0, "lessonSkips": 0, "kbSearches": 0 }
   }
   ```
4. Otherwise records the signal as before (auto-close / TTL machinery unchanged).

### Fail-open cases

| Condition | Behavior |
|-----------|----------|
| Task has 0 sessions (never launched) | Allow — unit fixtures / pre-launch |
| `kookrDir` not configured on the route | Allow — test seams without a data dir |
| `KOOKR_LESSON_DECISION_GATE=0\|false\|off\|no` | Allow — emergency kill-switch |

Human Complete (UI / REST complete without the agent signal) is **not** gated —
only the agent → user `completion_ready` path.

### CLI surface

`kookr signal completion-ready` maps the 409 into exit code 4 and prints the
server hint so the agent can fix and re-signal without re-deriving the policy.

## Lesson yield metric

**Definition:** among completed tasks in a window,

\[
\text{yield rate} = \frac{\text{wrote-lesson} + \text{explicit-skip}}{\text{completed tasks}}
\]

Target after the gate ships: **≥ 1.0** (every completed task either wrote a
lesson or declared skip). Silent no-decision is no longer a valid completion
path for managed agents.

### Surfaces

| Surface | Window | Notes |
|---------|--------|-------|
| `GET /api/diagnostics/lesson-yield?days=N` | 1–30 days (default 1) | Full snapshot, cache-first / stale-while-revalidate per window: a fresh or stale snapshot returns immediately while a single-flight refresh runs; a cold cache waits at most ~8s, then returns `503 lesson_yield_warming` (with `retryAfterMs`) while the bounded scan finishes in the background — the request path never hangs. Every completed scan warms the shared per-window cache. `503 lesson_yield_scan_timeout` only if a scan hits the 30s bound within that wait (issues #1553, #1585) |
| `GET /api/health` → `lessonYield` | last 24h | Stale-while-revalidate (issue #1553): the request path never scans hook logs — it serves the last background snapshot (60s TTL triggers a bounded background refresh; staleness visible via `generatedAt`). Absent until the first background scan completes. |
| `kookr lesson yield [--days N] [--json]` | 1–30 days | Offline operator CLI; reads `~/.kookr/tasks.json` + hooks |
| `pnpm kb:usage --days N` | existing report | Still has the per-task decision breakdown |

### Snapshot shape (`lesson-yield.v2`)

```json
{
  "schemaVersion": "lesson-yield.v2",
  "generatedAt": "2026-07-25T12:00:00.000Z",
  "windowDays": 1,
  "windowStartMs": 0,
  "tasksInWindow": 52,
  "completedInWindow": 48,
  "completedWithLogs": 47,
  "buckets": {
    "wroteLesson": 10,
    "explicitSkip": 38,
    "searchOnly": 0,
    "noKbActivity": 0
  },
  "decided": 48,
  "yieldRate": 1.0,
  "yieldRateAmongLogged": 1.0,
  "byCompletionPath": {
    "normal": {
      "completed": 40,
      "decided": 40,
      "wroteLesson": 10,
      "explicitSkip": 30,
      "searchOnly": 0,
      "noKbActivity": 0,
      "gateExempt": 0
    },
    "api_complete": {
      "completed": 8,
      "decided": 8,
      "wroteLesson": 0,
      "explicitSkip": 8,
      "searchOnly": 0,
      "noKbActivity": 0,
      "gateExempt": 0
    }
  },
  "gateExemptReasons": {},
  "explainedExceptions": 0,
  "contractRate": 1.0
}
```

**v2 additions (issue #1608):**

| Field | Meaning |
|-------|---------|
| `byCompletionPath` | Decision buckets split by how the task reached terminal-complete (`normal`, `outbox_drained`, `recovery`, `api_complete`, `ui_complete`, `other`, `unknown`) |
| `gateExemptReasons` | Counts of undecided completions keyed by `task.lessonGateExempt` |
| `explainedExceptions` | Undecided completions that carry any non-empty `lessonGateExempt` |
| `contractRate` | `(decided + explainedExceptions) / completedInWindow` — target ≥ 0.9 |

Completion path is stamped on the task at complete time. Historical tasks without a stamp land under `unknown`.

## Code map

| Path | Role |
|------|------|
| `src/core/kb-lesson-classifier.ts` | Line classification (issue #227) |
| `src/core/lesson-decision.ts` | Gate + yield aggregation (issue #1538) |
| `src/server/routes/task-routes.ts` | `POST …/signal` enforcement |
| `src/server/routes/diagnostics-routes.ts` | Health + diagnostics surfaces |
| `src/cli/kookr-lesson.ts` | `kookr lesson yield` |
| `bin/kookr-signal.js` | Agent-facing 409 → hint |

## Detection notes

- Classification is **presence of the command string** in a pre-tool shell
  invocation, not proof that `kb remember` exited 0. A command containing
  `kb remember` or `kookr lesson remember` counts as wrote-lesson.
- **Dual agent schemas (issue #1608):** Claude Code writes snake_case
  (`hook_event_name: PreToolUse`, `tool_name: Bash`, `tool_input.command`);
  Grok Build writes camelCase (`hookEventName: pre_tool_use`,
  `toolName: run_terminal_command`, `toolInput.command`). The scanner accepts
  both. Scanning only the Claude shape was the silent-bypass hole that made
  every Grok completion look like `noKbActivity` even when the agent wrote a
  lesson or printed the skip marker.
- Session names must match `^[A-Za-z0-9_-]{1,128}$`; unsafe names are treated as
  missing logs (no path traversal out of `hooksDir`).
- Only the live `<session>.jsonl` file is scanned (not rotated `.jsonl.N`
  generations). Emit the decision near the end of the task so it is still in
  the live file when signaling.
- Human Complete (UI / REST complete) is **not** hard-gated — those paths stamp
  `completionPath` + a default `lessonGateExempt` reason (`human_complete` /
  `api_complete_ungated`) so yield `contractRate` still accounts for them as
  explained exceptions rather than silent bypasses.
- The signal outbox drain (issue #1541) enforces the **same** lesson-decision
  gate as the HTTP route. A gate rejection drops the outbox entry
  (`permanent_fail`) so it cannot silently re-apply an undecided
  `completion_ready`.

## Relation to the spool

The spool ([lesson-write-spool.md](./lesson-write-spool.md)) and this gate are
complementary:

- Spool: "when the agent *does* write a lesson and KB is down, do not lose it."
- Gate: "the agent *must* write a lesson or declare skip before completion-ready."

A healthy spool with zero yield is exactly the #1538 failure mode — durability
without authoring.
