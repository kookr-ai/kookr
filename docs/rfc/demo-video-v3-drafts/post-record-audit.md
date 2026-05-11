# Post-record audit — Kookr demo v3

Daily-rushes review of the captured 1:47 video against `script-v2.md` (target 2:33). Frame references are the 13 samples at `demo/output/frames/frame-001.png` ... `frame-013.png`, taken at 8s intervals.

## What landed as planned

- **Frame 1 (0:00).** Cold-open tmux grid is on-spec. Four panes are distinguishable: TL `Continue? [y/n]_`, TR red `FAIL ... TypeError: jwt.verify is not a function`, BL streaming `[14:22:11] streaming output... / retry 3/5`, BR `codex exec --task "add pagination"` waiting on permission prompt. Caption `5 AI agents in 5 terminals. Which one needs you?` is centered, legible, on-time.
- **Frame 2 (~0:08).** Dashboard reveal with five pre-seeded agents in HEALTHY(5), top bar shows `$1.47` and `5/5 running`, project sidebar avatars `AW` and `AA` are visible. Caption `Two projects. One queue. Both runtimes.` is correct verbatim.
- **Frame 3 (~0:16).** Codex tooltip rendered upper-right with the right two lines: `Codex CLI via jeanibarz/codex · feat/claude-compat` and `Adds 4 hooks Codex is missing: PermissionRequest, Notification, SubagentStart/Stop, SessionEnd.` Caption `Codex CLI — patched for missing hooks.` matches the script. This was a known fragile beat and it landed.
- **Frame 4 (~0:24).** Permission finding card is fully rendered with `PERMISSION` badge, `Fix JWT token refresh in auth.ts`, body `Agent is blocked on permission for tool: Bash`, and `Skip / Snooze / Flag FP` actions. Header counter `1 finding waiting / 1 ACTIVE`. Caption `Permission blocked. Attention routed.` matches.
- **Frame 5 (~0:32).** Triage view opened, three-pane layout (queue / agent transcript / Claude Code editor), `Allow` button visible bottom-left of the action area, caption `One key. Allow. Keep moving.` matches.
- **Frame 6 (~0:40).** Two `NEEDS INPUT` cards stacked: `Implement login redirect fix (#87)` (merge conflict, webapp) and `Add rate limiting to pagination endpoint` (Redis vs in-memory, api-service). `2 findings waiting / 2 ACTIVE`. Caption `Codex question + Claude merge conflict.` matches.
- **Frame 9 (~1:04).** Snooze caption `Snooze the other. Keep moving.` is on-screen against the open merge-conflict triage view. Snooze interaction implied but the reclaimed-time badge is absent (see drift).
- **Frame 10 (~1:12).** Title bar shows `Fix JWT token refresh in auth.ts` and caption `Agent opened a PR. Kookr tracks it.` correct.
- **Frame 11 (~1:20).** CI-failed toast lit in upper-right: `PR acme/api-service#142 CI check "lint" failed`. Caption suppressed during the toast but the visual lands.
- **Frame 12 (~1:28).** Completion digest is open for `Refactor auth middleware to async/await` with files-changed bullets, all 28 tests passing. Caption `Done. Files, tests, cost — and time saved.` matches.
- **Frame 13 (~1:36).** Closing card renders the Kookr wordmark, three pills `Local-first / Attention router / Multi-project`, repo URL `github.com/kookr-ai/kookr`, the new install verb line, and the Codex sub-line. Caption matches `Local-first. Attention router. Multi-project.`

## What drifted

- **Total runtime 1:47 vs target 2:33** — a 46s shortfall, most of which lives in Acts 1, 3 and 6. The `.project-chip`, `.btn-quick-action.ai-suggestion` and `.completion-digest` locators all `.catch(()=>{})` instead of failing, so missed clicks compressed the timing instead of erroring. Severity: **ship-with-caveat** (the captured beats are still coherent; viewer just gets a faster cut).

- **Frame 2 — project chips not visibly filtered.** Script promised `Cursor → acme/webapp chip. Click. Queue filters to 3 webapp agents. Hold 1.5s. ... acme/api-service ... 2 agents`. Captured frame shows the chips collapsed to two letter-avatars (`AW`, `AA`) in the sidebar with no visible click, no filter narrowing, no cursor hover. The HEALTHY(5) section is unchanged across project selections. Severity: **ship-with-caveat** — the multi-project claim survives because the cards carry visible `webapp` / `api-service` badges, but the *interactive* filter demo is missing.

- **Frame 4 — inference stamp absent.** Script: `a 400ms inference label overlays the row — small text near the badge: rule F2.4: PermissionRequest → severity warning`. Not visible in the frame at 8s cadence. Could have flashed between samples (it was specced at 400ms), so we cannot conclude it failed — but we also cannot prove it rendered. Severity: **ship anyway** (sub-frame artifact, not load-bearing for LinkedIn pass).

- **Frame 7 (~0:48) — AI suggestion panel rendered as inbound chat bubbles, not interactive buttons.** Script: `AI suggestion panel slides in. Each item starts as a 600ms shimmer placeholder ... Suggestion 1: "Use in-memory with TTL — Redis can wait until 1k req/min." ... hovers Suggestion 1. Click Approve. Alert A clears.` Captured frame shows the suggestion text appearing as two queued assistant messages in the transcript pane, with no Approve / Edit / Use-this affordance, no `via Claude haiku-4-5` model stamp, no shimmer. The composer area at the bottom has only generic `Approve & Send / Skip / Snooze` buttons that read as agent-reply controls, not as suggestion-selection. Severity: **ship-with-caveat** — the AI-drafts-a-reply claim is *weakly* readable but the "approve or edit" verb in the caption isn't visually anchored. A LinkedIn skeptic could call this "just text in a chatbox."

- **Frame 8 (~0:56) — same panel, no resolution.** Script wanted Suggestion 1 clicked and Alert A cleared. Captured frame is virtually identical to frame 7 (caption changed but the queue still shows 2 `NEEDS INPUT` cards and the same transcript). The "approve" beat didn't visibly complete. Severity: **ship-with-caveat**.

- **Frame 9 (~1:04) — reclaimed-time badge missing.** Script: `a small badge overlays for 1s near the dimmed row: ~14 min reclaimed today`. Not visible. This was the first falsifiable productivity number in the script and it didn't render. Severity: **ship-with-caveat** (the bigger `~8 min supervision avoided` line lands in Act 5, so the productivity claim isn't entirely lost — but Act 3 loses its punchline).

- **Frame 12 — supervision-avoided overlay rendered as a floating fallback, not inside the digest.** Script asked for a `Manual supervision avoided: ~8 min` row *inside* the completion digest with a gray footnote underneath. Captured frame shows the text `Manual supervision avoided ~8m (~16 manual-check cadence × 8m 12s task duration. Demo overlay; not yet a product feature.)` floating as a separate red-tinted toast/card in the upper-right corner, partially overlapping the CI-failed toast from Act 4. The digest body itself only lists files, types, tests — no supervision row, no cost line, no `$1.47 → $1.89` top-bar tick. Severity: **must consider reshoot** if we want the headline productivity number to land cleanly; it currently reads as an error toast, not a productivity payoff.

- **Frame 13 — closing card does not fully cover the dashboard.** Script: `Closing card overlays a faded dashboard`. Captured frame shows the closing card centered with the dashboard still clearly readable through the left sidebar and bottom strip (queue cards, healthy/snoozed/completed sections, even the Codex CLI tooltip from Act 1 is faintly visible top-right behind the wordmark). The dashboard is dimmed, not occluded. The QR code spec'd in the script is absent. Severity: **ship-with-caveat** — composition is busy but the call-to-action text is legible.

- **No `Claude Code + Codex CLI. Same dashboard.` caption visible in any sampled frame.** Caption #2 of Act 1 may have appeared between frames 2 and 3 (the 8s gap straddles its 0:20–0:29 window) or may have been skipped along with the chip-filter beat. Severity: **ship anyway** (the providers-mixed message lands in the tooltip and provider badges).

## Ship recommendation

**Ship-with-caveat.** The five load-bearing beats — cold-open contrast, dashboard reveal, Codex fork tooltip, permission-block triage, completion digest — all render and stay on-message. The drift is concentrated in interactive polish (chip filter, suggestion-Approve click, reclaimed-time badge) and in one composition issue (supervision-avoided overlay floats outside the digest). A LinkedIn viewer will read this as a working product moving fast, not a broken demo. Do not block on a reshoot; the cost of re-recording exceeds the marginal lift, and the failed locators are a known follow-up.

PR description should include these three sentences acknowledging the gaps so reviewers aren't surprised:

1. "Captured runtime is 1:47 vs the 2:33 script target — three optional interactions (project-chip filter, AI-suggestion Approve click, ~14 min reclaimed badge) silently no-op'd via `.catch(()=>{})` and compressed the cut; the core narrative beats all rendered."
2. "The `Manual supervision avoided` overlay currently renders as a floating toast top-right rather than inline in the completion digest — tracked as a follow-up; the number and footnote are still legible in-frame."
3. "Closing card dims rather than fully occludes the dashboard, and the QR code is omitted; repo URL, install verb, and Codex fork sub-line are all visible and legible."

Follow-up issue should harden the three locators (`.project-chip`, `.btn-quick-action.ai-suggestion`, `.completion-digest .supervision-avoided-row`) to throw rather than swallow, so the next recording either lands the beat or fails the run.
