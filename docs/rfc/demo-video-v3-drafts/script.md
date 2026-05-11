# Demo v3 — Scene-by-Scene Script

Total target: **2:30** (hard cap 2:50). All captions ≤70 characters. Narration text is the exact value that goes into `NARRATIONS[key]` in `demo/record.ts`.

---

## Act 0 — HOOK (0:00–0:08)

**Tracker key:** `hook`

**Caption (on-screen, bottom-center, full 8s):**

> 5 AI agents working. One needs you. Which one?

(53 chars — passes 70-char limit, reads on a 360px mobile preview.)

**Narration (TTS, matilda):**

> Five AI agents working in parallel. One needs you. Which one?

**Visual:**

- Open cold on the full Kookr dashboard, 1920×1080.
- Sidebar visible on the left showing both `acme/webapp` and `acme/api-service` projects with agent counts.
- Five agent rows already populated (data pre-seeded — no launch animation).
- Each row shows the provider badge (`Claude Code` × 4, `Codex CLI` × 1). The Codex row is row #4.
- One row is already in `needs-input` state with a yellow pulsing indicator.
- Top bar shows lifetime session spend ($1.47).
- No cursor movement. Camera holds still.

**Why this act matters:**

Auto-play is silent. The first frame must answer the viewer's "is this for me?" question instantly. Five agents on screen = "this is for someone running parallel agents." The pulsing finding = "this product solves an actual problem." Caption phrasing borrows the form of the value prop (route attention to the agent that needs you most) rather than naming the product — the brand mark in the corner does that work.

---

## Act 1 — Multi-Project, Multi-Provider Landscape (0:08–0:35)

**Tracker keys:** `projects_open`, `providers_mixed`, `codex_fork`

**Captions (three, sequential):**

1. (0:08–0:17) `Two projects. One queue. Both runtimes.` (40 chars)
2. (0:17–0:25) `Claude Code + Codex CLI. Same dashboard.` (40 chars)
3. (0:25–0:35) `Codex via jeanibarz/codex#feat/claude-compat` (44 chars)

**Narration (three clips, sync to caption beats):**

1. `Two projects, side by side. Webapp on the left, API service on the right.`
2. `Claude Code and Codex CLI agents — same queue, same triage.`
3. `Codex compatibility runs on a maintained fork. Link in the description.`

**Visual:**

- Cursor moves to the project sidebar. Hover on `acme/webapp` chip — tooltip shows the per-project PR budget. Hold 1s.
- Click `acme/webapp` — queue filters to just the webapp agents (3 of 5 visible). Hold 2s.
- Click "All" (or the empty space next to chips) — queue restores.
- Hover on `acme/api-service` chip — same tooltip pattern. Click. Filter applies (2 of 5 visible, including the Codex agent). Hold 2s.
- Cursor moves to the Codex row's provider badge. Hover. The new `showProviderBadge()` overlay tooltip fades in upper-right reading:
  > **Codex CLI** via `jeanibarz/codex#feat/claude-compat`
  > Adds permission, notification, subagent, and session-end hooks.
- Hold tooltip 3s. Fade out.
- Cursor releases. Filter restored to All.

**Why this act matters:**

This is the act that closes the under-shown multi-project gap AND introduces Codex visibility in one move. The filter interaction is essential — anyone scrolling LinkedIn knows what a click + filter chip does, so the affordance is self-evident, and it proves Kookr isn't a single-project dashboard. The Codex tooltip is a deliberate "subtle but unmissable" beat: text small enough not to interrupt the rhythm, anchored at the moment of visual focus.

---

## Act 2 — Permission Block (0:35–0:55)

**Tracker keys:** `permission_block`, `permission_allow`

**Captions:**

1. (0:35–0:45) `Permission blocked. Kookr surfaces it instantly.` (49 chars)
2. (0:45–0:55) `One key. Allow. Keep moving.` (28 chars)

**Narration:**

1. `Permission blocked on the webapp agent. Kookr flags it instantly.`
2. `One key to allow. The queue rolls forward.`

**Visual:**

- Permission event injected on Agent 1 (Claude Code, webapp project).
- The agent row pulses, jumps to the top of the queue.
- Finding card expands inline showing the prompt: `Allow Bash: npm test --coverage?`
- Cursor moves to the "Allow" button.
- Click. Card collapses. Row returns to `healthy`. Queue empties.
- Brief "All clear" toast in upper-right.

**Why this act matters:**

This is the closest analogue to the existing demo's strongest beat — the moment that makes Kookr's value concrete: an agent stalls, Kookr notices, you act in one click. Keep it under 20s. Don't over-explain.

---

## Act 3 — Cross-Project Triage (0:55–1:25)

**Tracker keys:** `two_findings`, `ai_suggest`, `snooze_other`

**Captions:**

1. (0:55–1:05) `Question on Codex. Merge conflict on Claude.` (45 chars)
2. (1:05–1:15) `AI drafts a reply. Approve or edit.` (35 chars)
3. (1:15–1:25) `The other one waits. Snooze and move on.` (40 chars)

**Narration:**

1. `A question on the Codex agent, a merge conflict on Claude. Both surfaced.`
2. `AI suggests a response. Approve, edit, or write your own.`
3. `The merge conflict can wait. Snooze it and keep moving.`

**Visual:**

- Inject two findings simultaneously:
  - **Finding A:** Codex agent (api-service) asks `Should I use Redis or in-memory for rate limit storage?` — provider badge `Codex CLI` visible in finding header.
  - **Finding B:** Claude agent (webapp) hits merge conflict on `auth.ts` — provider badge `Claude Code` visible.
- Both rows pulse. Queue shows two pending items with their project chips.
- Cursor selects Finding A (Codex).
- AI suggestion panel slides in with three pre-drafted responses. Cursor hovers the first: `Use in-memory with TTL — Redis can wait until we cross 1k req/min.`
- Click Approve. Finding A clears. Codex row returns to healthy.
- Cursor now on Finding B. Click the snooze icon. Pick "1 hour."
- Finding B fades from queue (snoozed indicator briefly visible).

**Why this act matters:**

This is the load-bearing 30-second window that says: Codex agents are first-class, AI suggestions actually save typing, and snooze means you control the cadence. All three claims happen in one continuous gesture so they read as a single workflow, not three features.

---

## Act 4 — GitHub Awareness (1:25–1:50)

**Tracker keys:** `pr_opened`, `ci_failed`

**Captions:**

1. (1:25–1:37) `Agent opened a PR. Kookr is tracking it.` (40 chars)
2. (1:37–1:50) `CI failed. Same queue. Same triage.` (35 chars)

**Narration:**

1. `An agent just opened a pull request.`
2. `CI failed. Same attention queue. Same triage.`

**Visual:**

- Toast in upper-right: `Agent 2 opened PR #142 in acme/api-service`. Hold 2s.
- A few seconds pass with normal terminal streaming visible.
- Toast: `CI failed on PR #142`. The agent row jumps to needs-input.
- Cursor clicks the agent row. Detail panel switches to GitHub tab.
- Tab shows: PR title, CI run status (red), one review thread with an unresolved comment.
- Hold 4s so the viewer can read the failure name (e.g. `lint: unused-import`).

**Why this act matters:**

GitHub awareness is one of Kookr's strongest claims and the easiest to under-show. The trick is to anchor it: the same agent we already met opens a PR, gets CI feedback, and Kookr's queue treats CI failure with the same urgency as a permission prompt. The viewer leaves with the model: Kookr watches the whole agent loop, not just the terminal.

---

## Act 5 — Completion + Cost (1:50–2:10)

**Tracker key:** `agent_done`

**Caption:**

(1:50–2:10) `Done. Files changed, tests run, dollars spent.` (45 chars)

**Narration:**

> Agent finished. Files changed, tests run, dollars spent.

**Visual:**

- Toast: `Agent 3 completed: Add pagination to /users endpoint`.
- Detail panel auto-opens to the completion digest:
  - Files changed: `api/users.ts (+18 −2)`, `api/users.test.ts (+42 −0)`
  - Tests: `28 passed, 0 failed`
  - Duration: `8m 12s`
  - Cost: `$0.42 (input 28k, output 6.1k)`
- Top bar lifetime spend updates: `$1.47 → $1.89`.
- Hold 6s. Cursor lingers on the cost line.

**Why this act matters:**

The completion digest closes the loop opened in Act 0 — five agents working becomes "and here's what one of them actually shipped, for under fifty cents." Cost is load-bearing for the developer audience: it's the line that separates "cute demo" from "I could justify this to my manager."

If runtime overruns, this act is the first one to trim — it's the lowest-novelty beat.

---

## Act 6 — Closing CTA (2:10–2:30)

**Tracker keys:** `closing`, `repo_url`

**Captions:**

1. (2:10–2:20) `Local-first. Multi-agent. Multi-project.` (40 chars)
2. (2:20–2:30) `github.com/kookr-ai/kookr · Apache 2.0` (38 chars)

**Narration:**

1. `Local-first. Multi-agent. Multi-project. Claude Code and Codex CLI.`
2. `github.com slash kookr-ai slash kookr. Apache 2.0.`

**Visual:**

- Camera transitions to a full-frame closing card (overlay on a faded dashboard background):
  - Kookr wordmark + logo, centered upper third
  - Three pills: `Local-first`, `Multi-agent`, `Multi-project`
  - Repo URL: `github.com/kookr-ai/kookr`
  - Sub-line: `Codex CLI via jeanibarz/codex/tree/feat/claude-compat`
  - (Optional) QR code linking to the repo, lower-right
- Hold 8s. Fade to black at 2:30.

**Why this act matters:**

This is the only act where a passive muted viewer might actively pause to type a URL. The information density should match that: three pills, one URL, one fork reference. No more.

---

## NARRATIONS map summary

Exact key→text pairs for `demo/record.ts` line ~500:

| Key | Narration |
|---|---|
| `hook` | Five AI agents working in parallel. One needs you. Which one? |
| `projects_open` | Two projects, side by side. Webapp on the left, API service on the right. |
| `providers_mixed` | Claude Code and Codex CLI agents — same queue, same triage. |
| `codex_fork` | Codex compatibility runs on a maintained fork. Link in the description. |
| `permission_block` | Permission blocked on the webapp agent. Kookr flags it instantly. |
| `permission_allow` | One key to allow. The queue rolls forward. |
| `two_findings` | A question on the Codex agent, a merge conflict on Claude. Both surfaced. |
| `ai_suggest` | AI suggests a response. Approve, edit, or write your own. |
| `snooze_other` | The merge conflict can wait. Snooze it and keep moving. |
| `pr_opened` | An agent just opened a pull request. |
| `ci_failed` | CI failed. Same attention queue. Same triage. |
| `agent_done` | Agent finished. Files changed, tests run, dollars spent. |
| `closing` | Local-first. Multi-agent. Multi-project. Claude Code and Codex CLI. |
| `repo_url` | github.com slash kookr-ai slash kookr. Apache 2.0. |

14 keys, all sentence-length, all matilda-friendly (no hard-to-pronounce slugs except the URL which is read with "slash" expansion).
