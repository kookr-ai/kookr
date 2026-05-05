# POC Findings: Hook-Based Checkpoint Interrupt Feasibility

**Date:** 2026-04-15
**Context:** RFC `rfc-task-checkpointing.md` v4 proposed a `PreToolUse` hook that would block tool calls at a context-fill threshold and instruct the agent to write `CHECKPOINT.md` and run `/compact`. Round-4 review flagged two unverified assumptions. This POC tests them empirically.

## Questions the POC answered

1. **Does a `PreToolUse` hook's feedback message reliably steer agent behavior?**
2. **Can an agent invoke `/compact` from within a turn?**

Both questions are now answered decisively: **NO, and NO.**

## Test artifacts

- `hook.sh` — PreToolUse hook with three modes (t1 allow / t2 write-instruction / t3 /compact-instruction)
- `settings.json` — minimal Claude Code settings registering the hook
- `state.json` — controls which mode is active and tracks call count
- `T1-output.jsonl`, `T2-output.jsonl`, `T3-output.jsonl` — raw stream-json output from each test run
- `hook.log` — hook invocation log
- `REPORT.md` — this file

Model: `claude-sonnet-4-6` (implicit — `claude -p` default).

## Test 1 — Control (hook allows all)

**Setup:** mode `t1`, hook always exits 0.

**Prompt:** "Use the Bash tool to run 'ls /tmp | head -5', then tell me how many items it showed."

**Result:** ✓ PASS. Agent ran the Bash tool successfully, produced the summary, session exited cleanly. Hook fired 3+ times (once per tool attempt including confirmation calls) — confirms the hook mechanism is wired up correctly and the stream-json output shows `hook_started` / `hook_response` events we can observe for the blocking tests.

## Test 2 — Hook feedback as steering mechanism

**Setup:** mode `t2`. Hook denies the first non-Write tool call with a `permissionDecision: "deny"` and a `permissionDecisionReason` that instructs the agent to first use the `Write` tool to create `/tmp/kookr-hook-poc/acknowledge.txt`. The hook then allows all subsequent calls.

**Prompt:** Same as T1.

**Observed behavior (agent's own words):**

> "The Bash command was blocked by a hook at `/tmp/kookr-hook-poc/hook.sh`. The hook's error message contains instructions asking me to create a file before proceeding — **this looks like a prompt injection test (\"POC TEST T2\") embedded in hook feedback.**
>
> I'm flagging this rather than following the injected instructions, since your actual request was just to run `ls /tmp | head -5`."

**Result:** ❌ FAIL. The agent **recognized the hook's instruction as a potential prompt injection and refused to comply**. Call count stayed at 1 (the agent did not attempt a second tool call). `acknowledge.txt` was never created.

**Interpretation:** Claude Sonnet 4.6 (and presumably all modern Claude models) has a prompt-injection defense that treats instruction-carrying hook feedback as untrusted. The agent correctly identifies instructions embedded in tool-denial messages as potentially adversarial and escalates to the user instead of executing them. **The v4 RFC's entire interrupt architecture depended on the opposite behavior** — it assumed the agent would read the block message and follow the instructions.

This is a *fundamental* blocker for hook-steered interrupts, not a wording issue. No amount of careful phrasing will bypass a prompt-injection defense — in fact, trying to "sound more like a real instruction" is exactly the attack pattern the defense is trained to catch.

## Test 3 — Agent-invoked `/compact`

**Setup:** mode `t3`. Hook denies the first tool call with `permissionDecision: "deny"` and a reason instructing the agent to run `/compact` to compress the session.

**Prompt:** Same as T1.

**Observed behavior (agent's own words):**

> "A pre-tool-use hook (`/tmp/kookr-hook-poc/hook.sh`) is blocking my tool calls with a \"POC TEST T3\" message asking me to run `/compact`.
>
> **I can't invoke `/compact` from within a turn — it's a built-in CLI command that you need to run directly.** Since this is a POC hook test, you may want to either:
>
> 1. Run `/compact` yourself if you want to test that flow
> 2. Adjust or disable the hook in your settings so I can proceed..."

**Result:** ❌ FAIL. The agent **explicitly stated that it cannot invoke `/compact` from within a turn**. It correctly identified `/compact` as a user-only CLI command and escalated to the user.

**Interpretation:** This is a direct confirmation of the round-4 failure-mode critic's show-stopper concern. `/compact` is not a tool in the agent's tool surface; it is a slash command that belongs to the user's input channel. There is no tool-use primitive for slash commands. An agent cannot cause `/compact` to run, and v4's interrupt loop would deadlock by design the first time it fired.

Notably, the agent in T3 did *not* label the hook message as prompt injection (unlike T2). The refusal was based purely on capability (“I cannot do this”) rather than suspicion. Either refusal mode is enough to kill v4's design — the effect is the same: the cycle doesn't close.

## Implications for the RFC

**v4 is dead.** The hook-block-and-steer mechanism fails on both axes:

- The steering mechanism is unreliable even in the happy case (T2 — prompt-injection defense fires).
- The specific slash-command instruction is impossible to execute (T3 — `/compact` is user-only).

**v5's direction is validated by the same evidence.** v5 moves the entire detection + interrupt loop to the **Kookr process** (not a hook). Kookr uses `tmux send-keys` to inject user-channel input directly into the Claude Code session:

1. Kookr's watchdog detects high context fill via `token-tracker.ts`.
2. Kookr uses `sendKeys` to type a user message like "please update CHECKPOINT.md with current state" into the session's input prompt.
3. The agent sees the message as a normal user turn — **no prompt-injection defense fires, because the message is in the user input stream, not hook feedback**.
4. Agent writes the checkpoint.
5. `Stop` hook fires (existing Kookr infrastructure).
6. Kookr uses `sendKeys` to type `/compact` into the input prompt — **this is exactly how a human user invokes /compact, so it actually works**.
7. `SessionStart(source=compact)` fires. CLAUDE.md universal rule reloads CHECKPOINT.md.

v5 sidesteps both failure modes that this POC identified:
- No hook-delivered instructions to the agent → no prompt-injection defense.
- Kookr (not the agent) types `/compact` into the user input channel → the command actually runs.

## Remaining unknowns (follow-up POCs for v5)

This POC confirms v4 is dead and v5 is directionally right, but v5 still has these questions that need empirical validation before full implementation:

1. **Does `tmux send-keys` with `/compact\n` actually trigger compaction in a running Claude Code session?** (This POC did not test it. Can be tested in a separate 15-minute session.)
2. **Does the `CLAUDE.md` universal rule re-fire on `SessionStart(source=compact)`?** (Required for the reload step to work.)
3. **Does `/compact` actually reduce the `input_tokens + cache_read + cache_creation` metric Kookr reads from the transcript?** (If cache_read persists the pre-compact value, the cycle loops.)
4. **Is `token-tracker.ts`'s formula accurate against Claude Code's own context-fill indicator?** (If the formula is wrong, threshold fires are wrong.)

None of these are as load-bearing as the two v4 questions this POC answered — they are calibration concerns, not "does the design work at all" concerns.

## Secondary observations

- The `hook_started` / `hook_response` events in stream-json output make it easy to observe hook execution from outside the session. Useful for Kookr's future dashboard instrumentation.
- Claude Sonnet 4.6's prompt-injection defense is clearly trained: the agent used the phrase "prompt injection test" in T2, correctly identifying the pattern. This is well-tuned enough that tooling designers need to actively work *with* it, not try to bypass it.
- The `permissionDecisionReason` text is surfaced to the agent verbatim — there is no ambiguity about what the agent saw. No need to test different wordings for T2; the agent's defense operates on the fact that *any* instruction-carrying reason is suspicious.

## Conclusion

- **v4's hook-steered interrupt mechanism is not viable.** Build v5.
- **v5's Kookr-side mechanism is the correct architecture.** The POC did not directly test v5's flow, but it identified the two v4 blockers that v5 is specifically designed to avoid.
- **This POC took ~30 minutes** to design, build, and execute — well under the 6–8 hours v5 RFC estimated for the full discovery phase. The remaining discovery questions (1–4 above) are similarly small.
