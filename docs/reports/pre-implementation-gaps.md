# Pre-Implementation Gap Analysis

> Produced 2026-03-24. Must be resolved before or during V1 implementation.

---

## A. Blocking Gaps (resolve before implementation starts)

### ~~Gap 1: Hook configuration mechanism~~ — RESOLVED (2026-03-24)

> **Resolution:** `--settings` flag confirmed. Hooks are additive. All payloads include `session_id` and `transcript_path`. See [PoC 001](poc/001-hook-mechanism-validation.md).

<details>
<summary>Original analysis (click to expand)</summary>

#### Original: Hook configuration mechanism — Critical path blocker

**Problem:** Kookr's entire monitoring strategy depends on Claude Code hooks (`PreToolUse`, `PostToolUse`, `Stop`) writing structured JSON events to per-agent files in `~/.kookr/hooks/`. But *how Kookr injects these hooks per agent* is unresolved. This is flagged as an open question in both ADR-007 (line 236) and ADR-008 (line 258).

**Why it blocks:** The adapter cannot be implemented without knowing how to configure hooks. The session ID discovery mechanism (ADR-008) also depends on hooks — the first hook event provides the `session_id` needed to locate the transcript JSONL file.

**Tentative answer in the docs:** "Likely via `--settings` flag pointing to a Kookr-generated settings file" (architecture.md line 137).

**What needs validation (empirical PoC):**

1. **Does `--settings` exist as a Claude Code CLI flag?** Check `claude --help` or Claude Code documentation. If not, what alternatives exist? (Environment variable? `CLAUDE_SETTINGS_PATH`? Symlink override of `~/.claude/settings.json`?)

2. **Are hooks additive or replacement?** If Kookr injects hook configuration via `--settings`, does it *add to* the user's existing hooks (from `~/.claude/settings.json` and project-level settings), or does it *replace* them? This determines whether Kookr must read+merge the user's existing settings.

3. **Chicken-and-egg: hook output path vs. session ID.** The hook output path in ADR-008 is `~/.kookr/hooks/kookr-task-abc123.jsonl` (named by tmux session, which is known at launch). The session ID is discovered *from* the first hook event. So the hook output path can be determined before launch — no chicken-and-egg. But validate that hook events actually include `session_id` in their JSON payload (ADR-007 PoC said yes, but re-confirm the exact field name and structure).

4. **Can hook scripts write to arbitrary files?** Kookr needs each agent's hooks to append to a specific JSONL file. Validate that a hook script can receive JSON on stdin and append to a file path passed as an argument or embedded in the script.

**PoC steps:**

```bash
# 1. Check if --settings flag exists
claude --help 2>&1 | grep -i settings

# 2. Create a test settings file with a hook configuration
cat > /tmp/kookr-test-settings.json << 'EOF'
{
  "hooks": {
    "PostToolUse": [
      {
        "type": "command",
        "command": "cat >> /tmp/kookr-hook-test.jsonl"
      }
    ]
  }
}
EOF

# 3. Launch Claude Code in tmux with the test settings
tmux new-session -d -s kookr-test "claude --settings /tmp/kookr-test-settings.json"

# 4. After the agent runs a tool, check:
#    - Did /tmp/kookr-hook-test.jsonl get written?
#    - Does it contain session_id?
#    - Did the user's own hooks (if any) also fire?
cat /tmp/kookr-hook-test.jsonl | head -5 | python3 -m json.tool

# 5. Clean up
tmux kill-session -t kookr-test
```

If `--settings` doesn't exist or hooks aren't additive, alternative approaches:
- Generate a composite settings file (read user's settings, merge Kookr hooks, write temp file)
- Use environment variables to control hook behavior
- Use a wrapper script that the hook calls, which routes output based on an env var identifying the agent

**Resolution criteria:** Document the exact mechanism for per-agent hook injection. Update ADR-007 open questions and architecture.md adapter description.

</details>

---

### ~~Gap 2: "Waiting for input" detection signal in interactive mode~~ — RESOLVED (2026-03-24)

> **Resolution:** The `Stop` hook fires when the agent finishes its turn in interactive mode. Payload includes `last_assistant_message`. This is the reliable, structured signal — no heuristics needed. See [PoC 001](poc/001-hook-mechanism-validation.md).

<details>
<summary>Original analysis (click to expand)</summary>

#### Original: "Waiting for input" detection signal — Unspecified

**Problem:** F2.1 ("Detect needs-input state") is a V1 must-have. The design docs say it's "detectable via hooks and transcript JSONL" but never specify *which event* or *what pattern* the supervisor matches on.

**Why it blocks:** This is the most important anomaly signal in V1 — it's the primary trigger for "the loop" (developer responds, auto-advances). If the signal is wrong or unreliable, the core UX breaks.

**Background:** ADR-006 documents how `AskUserQuestion` works in *headless* mode: it produces a structured JSONL event with tool_use name `AskUserQuestion`. But Kookr uses *interactive* mode (ADR-007). In interactive mode, the agent blocks on the terminal waiting for keystrokes. The question is: what observable signal does this produce?

**Possible signals (validate empirically):**

1. **Hook event:** Does `PreToolUse` or `PostToolUse` fire for `AskUserQuestion` in interactive mode? If so, the hook JSON would contain `tool_name: "AskUserQuestion"` and `tool_input: { question: "..." }`. This would be the cleanest signal.

2. **Transcript JSONL entry:** Does the transcript JSONL record the `AskUserQuestion` tool call before the agent blocks? If so, tailing the transcript would detect it.

3. **Stop hook:** Does the `Stop` hook fire when the agent is waiting for input? (Probably not — the agent hasn't stopped, it's waiting.)

4. **Event silence heuristic:** No hook events + no transcript entries for N seconds + terminal shows a prompt. This is fragile and should be a last resort.

**PoC steps:**

```bash
# 1. Launch Claude Code in tmux with hooks that log everything
tmux new-session -d -s kookr-input-test "claude --settings /tmp/kookr-test-settings.json"

# 2. Give it a task that will trigger AskUserQuestion
#    (e.g., ask it to do something ambiguous that requires clarification)
tmux send-keys -t kookr-input-test "Create a REST API for managing users" Enter

# 3. Wait for it to ask a question, then check:
#    - What appears in the hook output JSONL?
#    - What appears in the transcript JSONL?
#    - Does capture-pane show a visible prompt?

# 4. Also test: what does "permission prompt" look like in hooks/transcript
#    when running in default permission mode (not bypassPermissions)?
#    This addresses Gap 4 (ADR-006 revisit) simultaneously.
```

**Also test non-AskUserQuestion "waiting" scenarios:**
- Agent finishes its turn and returns control to the user (normal interactive flow — the `]` prompt appears). Is this a hook event? A Stop event?
- Agent hits a permission prompt in non-bypass mode. What signal?

**Resolution criteria:** Document the exact event type, field name, and detection pattern for "agent is waiting for developer input." Update features.md F2.1 description and architecture.md supervisor section.

</details>

---

## B. Important Gaps (block specific phases)

### ~~Gap 3: Frontend framework decision~~ — RESOLVED (2026-03-24)

**Problem:** ADR-002 is "TBD" between React and Svelte 5. Referenced as "TBD" in architecture.md line 251 and system-models/03-container-view.md lines 12 and 39.

**Why it matters:** Phase 2 introduces the browser GUI. The framework choice affects build tooling, component structure, and developer experience. It does NOT block Phase 1 (CLI + backend only).

**Current analysis (from ADR-002):**
- **React + Vite:** Largest ecosystem, best AI agent familiarity (important since AI agents help build Kookr), extensive component libraries
- **Svelte 5:** Compiled (better perf), less boilerplate, runes reactivity model, smaller bundle

**Decision factors specific to Kookr:**
- Kookr's frontend is relatively simple (agent list + detail panel + input box + status bar)
- Real-time WebSocket updates are the primary interaction pattern
- AI agents (Claude Code) are very familiar with React; Svelte 5 (runes) is newer and less represented in training data
- No complex form handling or deep component trees

**Resolution:** React + Vite chosen (ADR-002 accepted). Decisive factor: AI-developability — React has the most training data, meaning AI agents make fewer mistakes when writing and maintaining the frontend. Kookr's simple UI (dashboard with ~5-10 components) doesn't benefit from Svelte's compiled performance advantage. Zustand chosen for state management. See ADR-002 for full rationale.

---

### ~~Gap 4: ADR-006 needs formal revisit~~ — RESOLVED (2026-03-24)

> **Resolution:** The `PermissionRequest` hook fires in interactive mode with `tool_name`, `tool_input`, and `permission_suggestions`. F2.4 is feasible. ADR-006 updated. See [PoC 001](poc/001-hook-mechanism-validation.md).

<details>
<summary>Original analysis (click to expand)</summary>

#### Original: ADR-006 needs formal revisit — Permission detection feasibility unclear

**Problem:** ADR-006 concluded that permission-block detection (F2.4) is infeasible in *headless* mode. ADR-007 moved to *interactive* mode. ADR-006's status says "revisit per ADR-007" but nobody has revisited. F2.4 is listed as "nice to have for V1" in features.md.

**Why it matters:** If permission prompts produce a detectable signal in interactive mode (hook event? transcript entry? terminal prompt?), then F2.4 becomes trivially implementable and should be included in V1. If they don't, F2.4 should be explicitly marked as "still deferred" with a new reason.

**How to resolve:** This can be tested as part of the Gap 2 PoC (see "also test non-AskUserQuestion waiting scenarios" above). Specifically:

1. Launch Claude Code in interactive mode with `--permission-mode default` (not `bypassPermissions`)
2. Give it a task that triggers a permission prompt (e.g., "delete /tmp/test.txt")
3. Check: does a hook event fire? Does the transcript record the permission prompt? What does `capture-pane` show?

**Resolution criteria:** Update ADR-006 with interactive-mode findings. Either:
- Mark F2.4 as feasible and define the detection signal, or
- Mark F2.4 as "deferred — no structured signal available in interactive mode either"

</details>

---

### ~~Gap 5: Roadmap phases vs. MVP scope mismatch~~ — RESOLVED (2026-03-24)

**Problem:** The roadmap defines 4 phases, but the features.md MVP scope ("must have") spans Phases 1-3:

| Feature | features.md MVP tier | Roadmap phase |
|---------|---------------------|---------------|
| F1.2 Show agent status | Must have | Phase 1-2 |
| F2.1 Detect needs-input | Must have | Phase 3 |
| F2.8 Prioritize by urgency | Must have | Phase 3 |
| F3.3 Auto-advance | Must have | Phase 3 |
| F3.6 Skip | Must have | Phase 3 |
| F3.7 Snooze | Must have | Phase 3 |
| F4.1 Launch agent from GUI | Must have | Phase 2 |
| F4.4 Task lifecycle | Must have | Phase 2 |

This means "V1 done" = Phase 3 complete, not Phase 2. But the roadmap doesn't say this explicitly, creating ambiguity about what each milestone delivers.

**Why it matters:** A developer (or AI agent) picking up "implement Phase 2" might think it's shippable — but it's missing half the MVP must-haves.

**Resolution:** Option (a) applied — roadmap now labels V1 = Phases 1+2+3, Phase 4 = V2. Phase headers updated to reflect milestone ownership.

---

## C. Minor Gaps (resolvable during implementation)

### Gap 6: Terminal dimensions

**Current state:** ADR-007 open question says "Set via tmux options at session creation; allow override in config."

**Recommendation:** Use `tmux new-session -d -s <name> -x 200 -y 50` as the default. Add a `terminalDimensions` config field. No further design needed — this is a one-liner at implementation time.

### Gap 7: Cost data source

**Current state:** F1.4 mentions "session cost (if available)" but no design specifies where cost data comes from.

**Answer:** The transcript JSONL includes cost information in assistant message metadata. aegiscore's `StuckDetector` already tracks `totalCost` from similar structured data. The adapter should extract cost from transcript JSONL entries and include it in `AgentEvent` (e.g., `{ type: 'cost', usd: number }`). This is display-only metadata — no design decision needed, just implementation.

### Gap 8: Supervisor polling interval

**Current state:** Architecture says "every few seconds per agent."

**Recommendation:** Default to 3-5 seconds per agent, configurable. aegiscore's `StuckDetector` uses timestamp-based thresholds (e.g., "no progress for 60 seconds"). The exact polling interval is a tuning parameter, not a design decision.

---

## Suggested Resolution Order

1. ~~**Gaps 1 + 2 + 4 together**~~ — **DONE (2026-03-24).** Validated via [PoC 001](poc/001-hook-mechanism-validation.md). ADRs 006, 007, 008 updated. Features.md and architecture.md updated.
2. ~~**Gap 5**~~ — **DONE (2026-03-24).** Roadmap updated: V1 = Phases 1+2+3, Phase 4 = V2.
3. ~~**Gap 3**~~ — **DONE (2026-03-24).** React + Vite chosen. ADR-002 accepted.
4. **Gaps 6-8** — Resolve inline during implementation.

---

## Reference: What Is NOT a Gap

These are intentional deferrals, not gaps:

| Item | Status | Why acceptable |
|------|--------|----------------|
| Agent discovery (F1.1) | Deferred from V1 | Near-zero value without take-over (ADR-005) |
| Codex CLI / Gemini CLI support | Deferred to Phase 4 | Focus on Claude Code first |
| LLM-powered supervisor (Tier 2) | Deferred to V2 | Rule-based detection is sufficient for V1 |
| Budget burn detection (F2.5) | Deferred to V2 | Requires cost trend analysis |
| Trajectory drift detection (F2.6) | Deferred to V2 | Requires LLM analysis |
| Plugin system | Deferred | No users, no plugins needed |
| Windows support | Deferred | Linux + macOS first |
| Session history / analytics DB | Deferred | tasks.json provides V1 foundation |

## Reference: Aegiscore Reuse — Validated

The files referenced in architecture.md's reuse map exist and are compatible:

| File | Location | Compatibility |
|------|----------|---------------|
| `stuck-detector.ts` | `~/git/aegiscore/scripts/lib/stuck-detector.ts` | Agent-agnostic via `StuckDetectorThresholds` injection. Tracks progress timestamps, error repetition, output silence, cost. Maps directly to Kookr's supervisor needs. |
| `claude-code-runner.ts` | `~/git/aegiscore/scripts/lib/claude-code-runner.ts` | Process spawning + signal handling patterns. Adapt for tmux session creation. |
| `codex-cli-driver.ts` | `~/git/aegiscore/scripts/lib/agentic-drivers/codex-cli-driver.ts` | Codex CLI patterns. Deferred to Phase 4 but available when needed. |
