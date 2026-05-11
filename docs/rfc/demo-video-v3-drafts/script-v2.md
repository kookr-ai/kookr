# Demo v3 — Script v2 (critic-informed)

Total target: **2:33** (hard cap 2:40). Captions ≤ 60 chars (tightened from v1's 70). Narration = exact `NARRATIONS[key]` value in `demo/record.ts`.

Deltas vs v1 are summarized in [`synthesis.md`](synthesis.md).

---

## Act 0 — Cold Open + Hook (0:00–0:11)

**Tracker keys:** `cold_open`, `hook`

### Sub-beat 0a — Split-screen pain frame (0:00–0:03)

**Visual:**

- Left half: a static 2×2 fake-tmux grid (CSS, not a real tmux). Four panes:
  - Pane TL: agent prompt waiting at `Continue? [y/n]_`
  - Pane TR: red `FAILED` text + scrolling stack trace
  - Pane BL: streaming green log output mid-line
  - Pane BR: blinking cursor on a stalled `Bash$_` prompt
- Right half: dark blank canvas.

**Caption (full 3s, centered top):**

> 5 AI agents in 5 terminals. Which one needs you?

(48 chars.)

**Narration:**

> Five AI agents in five terminals. Which one needs you?

### Sub-beat 0b — Reveal (0:03–0:05)

**Visual:**

- The Kookr dashboard slides in from the right (300ms ease-out), replacing the right canvas — sidebar visible, 5 agent rows seeded, top bar with $1.47.
- Left tmux grid fades to 30% opacity (still visible — viewer sees the contrast).

**No caption during 2s transition.**

### Sub-beat 0c — Settle on Kookr (0:05–0:11)

**Visual:**

- Tmux grid fully fades out, Kookr dashboard fills the frame.
- One agent row pulses yellow (`needs-input`). Top bar lifetime spend `$1.47`.

**Caption:**

> Kookr tells you which one. Instantly.

(38 chars.)

**Narration:**

> Kookr tells you which one. Instantly.

**Why this act matters:**

The split-screen anchors the "before" pain (per productivity critic) and gives the muted viewer a visual reason to keep watching past 3 seconds. The "Which one needs you?" question is *visible* on the left and *answered* on the right — that's the value proposition compressed into one frame.

---

## Act 1 — Multi-Project, Multi-Provider Landscape (0:11–0:38)

**Tracker keys:** `projects_open`, `providers_mixed`, `codex_fork`

**Captions (three, sequential):**

1. (0:11–0:20) `Two projects. One queue. Both runtimes.` (40 chars)
2. (0:20–0:29) `Claude Code + Codex CLI. Same dashboard.` (40 chars)
3. (0:29–0:38) `Codex CLI — patched for missing hooks.` (38 chars)

**Narration:**

1. `Two projects, side by side. Webapp on the left, API service on the right.`
2. `Claude Code and Codex CLI agents — same queue, same triage.`
3. `Codex compatibility runs on a maintained fork. Link below.`

**Visual:**

- Cursor → `acme/webapp` chip. Hover. Tooltip: `3 agents · daily PR limit 5`.
- Click. Queue filters to 3 webapp agents. Hold 1.5s.
- Click "All". Queue restores.
- Cursor → `acme/api-service` chip. Click. Filter applies (2 agents including the Codex one). Hold 1.5s.
- Cursor → the Codex agent's provider badge in row #4. Hover.
- Tooltip overlay (`showProviderBadge()`) fades in upper-right:
  > **Codex CLI** via `jeanibarz/codex` · `feat/claude-compat`
  > Adds 4 missing hooks: PermissionRequest, Notification, SubagentStart/Stop, SessionEnd.
- Hold tooltip 2.5s. Fade out. Filter restored.

**Why this act matters:**

Multi-project visibility + Codex CLI presence in one continuous gesture. The fork-slug-as-caption (v1) read as a security flag; here the fork only appears inside a hover tooltip, calmer.

---

## Act 2 — Anomaly Detection in Action (0:38–0:58)

**Tracker keys:** `permission_block`, `inference_stamp`, `permission_allow`

**Captions:**

1. (0:38–0:48) `Permission blocked. Attention routed.` (37 chars)
2. (0:48–0:58) `One key. Allow. Keep moving.` (28 chars)

**Narration:**

1. `Permission blocked on the webapp agent. Kookr routes your attention there.`
2. `One key to allow. The queue rolls forward.`

**Visual:**

- Inject `PermissionRequest` event on Agent 1.
- The agent row pulses + jumps to top.
- **NEW:** a 400ms inference label overlays the row — small text near the badge: `rule F2.4: PermissionRequest → severity warning`. Fades out. Proves Kookr inferred, not just rendered a toast.
- Detail card expands inline: `Allow Bash: npm test --coverage?`
- Cursor → "Allow". Click. Card collapses. Toast: `All clear`.

**Why this act matters:**

This act has to *show* anomaly detection, not assert it. The 400ms rule-stamp is invisible to anyone not looking — and load-bearing for the developer who *is* looking. "Attention routed" plants the phrase that distinguishes Kookr from crewAI's "multi-agent orchestration."

---

## Act 3 — Cross-Project Triage (0:58–1:30)

**Tracker keys:** `two_alerts`, `ai_suggest`, `snooze_other`, `time_reclaimed`

**Captions:**

1. (0:58–1:08) `Codex question + Claude merge conflict.` (40 chars)
2. (1:08–1:18) `AI drafts a reply. Approve or edit.` (35 chars)
3. (1:18–1:30) `Snooze the other. Keep moving.` (30 chars)

**Narration:**

1. `A question on the Codex agent. A merge conflict on Claude. Both surfaced.`
2. `AI drafts a response. Approve, edit, or write your own.`
3. `The merge conflict can wait. Snooze it and keep moving.`

**Visual:**

- Inject simultaneously:
  - **Alert A:** Codex (api-service) — `Use Redis or in-memory for rate limiting?` Provider badge `Codex CLI` shown in alert header.
  - **Alert B:** Claude (webapp) — `Merge conflict in src/auth.ts`. Provider badge `Claude Code`.
- Both rows pulse. Queue counter shows `2 alerts`.
- Cursor → Alert A. Click.
- AI suggestion panel slides in. Each item starts as a 600ms shimmer placeholder, then resolves to text. **Tiny stamp under each:** `via Claude haiku-4-5`. (If default model differs at recording time, swap the stamp.)
  - Suggestion 1: `Use in-memory with TTL — Redis can wait until 1k req/min.`
- Cursor hovers Suggestion 1. Click Approve. Alert A clears, Codex row returns to healthy.
- Cursor → Alert B. Click the snooze icon. Pick "1 hour."
- Row dims. **NEW:** a small badge overlays for 1s near the dimmed row: `~14 min reclaimed today`. (Heuristic: cumulative snooze duration / number of un-watched poll attempts. Documented in `synthesis.md`.)

**Why this act matters:**

The competitive moment: no tmux pane grid + no orchestration framework can do "switch from Codex to Claude across projects + AI-drafted reply + snooze with measurable time saved" as one continuous gesture. The shimmer + model stamp deflect the "this is just hardcoded fixtures" reading. The `~14 min reclaimed` badge is the first falsifiable productivity number.

---

## Act 4 — GitHub Awareness (1:30–1:53)

**Tracker keys:** `pr_opened`, `ci_failed`

**Captions:**

1. (1:30–1:42) `Agent opened a PR. Kookr tracks it.` (35 chars)
2. (1:42–1:53) `CI failed. Same queue. Same triage.` (35 chars)

**Narration:**

1. `An agent just opened a pull request.`
2. `CI failed. Same attention queue. Same triage.`

**Visual:**

- Toast: `Agent 2 opened PR #142 in acme/api-service`. 2s.
- Brief lull (terminal streams continue).
- Toast: `CI failed on PR #142`. Agent row jumps to needs-input.
- Cursor → row. Detail panel switches to GitHub tab.
- Tab shows PR title, red CI run, one unresolved review thread (`lint: unused-import`).
- Hold 3s.

**Why this act matters:**

Same as v1 — GitHub awareness anchored to the same agent the viewer already met. Trimmed 2s vs v1 to make room for the cold open without exceeding 2:40.

---

## Act 5 — Completion + Cost + Time Saved (1:53–2:18)

**Tracker keys:** `agent_done`, `time_saved`

**Caption:**

(1:53–2:18) `Done. Files, tests, cost — and time saved.` (43 chars)

**Narration:**

> Agent finished. Files changed, tests run, cost — and the supervision time you didn't spend.

**Visual:**

- Toast: `Agent 3 completed: Add pagination to /users endpoint`.
- Completion digest opens:
  - Files: `api/users.ts (+18 −2)`, `api/users.test.ts (+42 −0)`
  - Tests: `28 passed, 0 failed`
  - Duration: `8m 12s`
  - Cost: `$0.42 (input 28k, output 6.1k)`
  - **NEW row:** `Manual supervision avoided: ~8 min (≈ 16 checks at 30s cadence)*`
  - Footnote (tiny, gray, bottom of card): `*Estimate: 30s manual-check cadence × 8m 12s task duration ≈ 16 checks ≈ 8 min of polling time. Demo overlay; not yet a product feature.`
- Top bar updates `$1.47 → $1.89`.
- Cursor lingers on the supervision-avoided row 3s.

**Why this act matters:**

Productivity critic flagged v1's mark of Act 5 as "first to cut" as upside-down — this is the productivity payoff. Adding the `~8 min` row + honest footnote turns "cute demo" into "I can justify this to my manager" without overclaiming.

---

## Act 6 — Closing CTA (2:18–2:33)

**Tracker keys:** `closing`, `install_verb`

**Captions:**

1. (2:18–2:25) `Local-first. Attention router. Multi-project.` (45 chars)
2. (2:25–2:33) `github.com/kookr-ai/kookr · Apache 2.0` (38 chars)

**Narration:**

1. `Local-first. Attention router. Multi-project. Claude Code and Codex CLI.`
2. `github.com slash kookr-ai slash kookr. Apache two-point-zero.`

**Visual:**

- Closing card overlays a faded dashboard:
  - Kookr wordmark + logo, upper third
  - Three pills: `Local-first` · `Attention router` · `Multi-project`
  - Repo URL: `github.com/kookr-ai/kookr`
  - **NEW install line:** `git clone … && pnpm install && pnpm prod:setup && pnpm prod:update`
  - Codex sub-line: `Codex CLI: jeanibarz/codex · feat/claude-compat`
  - QR code linking to repo, lower-right corner (kept from v1, optional)
- Hold 8s. Fade to black at 2:33.

**Why this act matters:**

Closing card now contains a verb (`git clone`). The middle pill switched `Multi-agent` → `Attention router` to avoid the crewAI semantic collision.

---

## NARRATIONS map summary (v2)

| Key | Narration |
|---|---|
| `cold_open` | Five AI agents in five terminals. Which one needs you? |
| `hook` | Kookr tells you which one. Instantly. |
| `projects_open` | Two projects, side by side. Webapp on the left, API service on the right. |
| `providers_mixed` | Claude Code and Codex CLI agents — same queue, same triage. |
| `codex_fork` | Codex compatibility runs on a maintained fork. Link below. |
| `permission_block` | Permission blocked on the webapp agent. Kookr routes your attention there. |
| `permission_allow` | One key to allow. The queue rolls forward. |
| `two_alerts` | A question on the Codex agent. A merge conflict on Claude. Both surfaced. |
| `ai_suggest` | AI drafts a response. Approve, edit, or write your own. |
| `snooze_other` | The merge conflict can wait. Snooze it and keep moving. |
| `pr_opened` | An agent just opened a pull request. |
| `ci_failed` | CI failed. Same attention queue. Same triage. |
| `agent_done` | Agent finished. Files changed, tests run, cost — and the supervision time you didn't spend. |
| `closing` | Local-first. Attention router. Multi-project. Claude Code and Codex CLI. |
| `repo_url` | github.com slash kookr-ai slash kookr. Apache two-point-zero. |

15 keys (was 14). All matilda-friendly. Total spoken-time estimate: ~95s (leaves ~58s for visual pauses).

## Pacing budget table

| Act | Duration | Cumulative |
|---|---|---|
| 0 cold open + hook | 11s | 11s |
| 1 multi-project | 27s | 38s |
| 2 anomaly | 20s | 58s |
| 3 cross-project triage | 32s | 1:30 |
| 4 GitHub | 23s | 1:53 |
| 5 completion + time saved | 25s | 2:18 |
| 6 closing | 15s | 2:33 |
| **Total** | **2:33** | (hard cap 2:40) |

If recording overruns: trim Act 4 by 5s (drop the lull) before touching Act 0 or Act 5.
