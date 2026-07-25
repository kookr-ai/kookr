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
| `GET /api/diagnostics/lesson-yield?days=N` | 1–30 days (default 1) | Full snapshot; warms the health cache when `days=1` |
| `GET /api/health` → `lessonYield` | last 24h | Cached 60s so frequent polls stay cheap |
| `kookr lesson yield [--days N] [--json]` | 1–30 days | Offline operator CLI; reads `~/.kookr/tasks.json` + hooks |
| `pnpm kb:usage --days N` | existing report | Still has the per-task decision breakdown |

### Snapshot shape (`lesson-yield.v1`)

```json
{
  "schemaVersion": "lesson-yield.v1",
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
  "yieldRateAmongLogged": 1.0
}
```

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

- Classification is **presence of the command string** in PreToolUse Bash, not
  proof that `kb remember` exited 0. A command containing `kb remember` or
  `kookr lesson remember` counts as wrote-lesson.
- Session names must match `^[A-Za-z0-9_-]{1,128}$`; unsafe names are treated as
  missing logs (no path traversal out of `hooksDir`).
- Only the live `<session>.jsonl` file is scanned (not rotated `.jsonl.N`
  generations). Emit the decision near the end of the task so it is still in
  the live file when signaling.
- Human Complete (UI / REST complete) is **not** gated — yield among all
  completed tasks can therefore stay below 1.0 when operators complete tasks
  without the agent signal path.

## Relation to the spool

The spool ([lesson-write-spool.md](./lesson-write-spool.md)) and this gate are
complementary:

- Spool: "when the agent *does* write a lesson and KB is down, do not lose it."
- Gate: "the agent *must* write a lesson or declare skip before completion-ready."

A healthy spool with zero yield is exactly the #1538 failure mode — durability
without authoring.
