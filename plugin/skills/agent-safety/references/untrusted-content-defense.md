# Untrusted content defense

Use when: granting an agent tools or credentials, installing a skill or MCP server, storing lessons for
reuse, reviewing a CI agent workflow, or choosing between a guard model and a structural control.

## Rules

1. **Limit actions before you detect text.** Assume the model will follow an injected instruction. Give
   each task the smallest tool set and credentials it needs, no ambient secrets, no network unless needed,
   and an approval step for irreversible or outward-facing actions (send, merge, deploy, delete, publish).
   Never read untrusted text and hold broad credentials in the same step. System-level limits (Progent,
   DRIFT) kept attack success rate (ASR) under 10% on most models under an adaptive attacker, while
   filters rose under adaptation (PIGuard 0.0% to 28.0%; 2606.15057).
2. **Track where values came from.** Mark text from issues, PRs, web pages, tool output, memory notes and
   skills as untrusted. An untrusted-derived value must not fill a sensitive argument (recipient, command,
   URL, path, branch to merge) unless a trusted step confirmed it. Check per argument, not per call:
   argument-level provenance reached 100% security on the three strongest models in AgentDojo with
   38.1-46.4% utility, 8-16 points above invocation-level quarantine (CaMeL); 13 of 13 live attacks blocked
   with 0 false positives on 267 benign calls (2605.11039).
3. **Gate the effect, not the command verb.** Gating `gh pr merge` but not the REST call that merges leaves
   the route open; match the endpoint or effect. A hook is a policy layer, not a sandbox; use real
   isolation for anything dangerous.
4. **Do not rely on a guard model, classifier or robust fine-tune alone.** Static results do not carry
   over (static-to-adaptive gap averaged 15.8 points, 2606.15441), and they cost utility (defense-trained
   models failed 47-77% of benign multi-step tasks at step 1 against 3% for the base model, 2603.19423).
   Deterministic code works within its scope: output filtering leaked 0% over 15,000 attacks, but only for
   secrets it can match (2604.23887).
5. **Treat skills and MCP servers as code you are installing.** Skill-shaped injection averaged 80.7% ASR
   where naive injection scored 0.0% (2602.14211). Backdoored skills reached up to 97.2% ASR and LLM guard
   scanners (Qwen3Guard, Llama-Guard) labelled 98.2% and 99.4% of them safe (2604.06811), so one passing
   LLM scan is not enough. Layer a static filter, LLM review, then a jury or human review (F1 0.920 on 390
   skills, 2604.06550), and scope each skill's permissions. Treat tool descriptions as untrusted input too:
   tool poisoning was blocked only 42-60% of the time (2512.06556), and a cascaded filter had 59.9% recall
   on it at 6.06% false-positive rate (FPR, 2604.17125). More in
   [tool surface design](../../agent-loop-design/references/agent-tool-surface-design.md) rule 8.
6. **Treat memory as a second injection path.** Unoptimized poison reached later behavior in up to 45.70%
   of cases (2611.09721; varied widely by memory design); 91.0% of trials embedded a poisoned lesson into a
   skill at 10% attacker support (2608.05563). Keep the source on every stored lesson, require independent
   support (different sources) before a lesson becomes a reusable skill, and keep audit and rollback.
   Post-hoc audit worked only below a 0.20 (0.15 on one task) contamination ratio (2605.23723).
7. **Do not take a vote or a judge as isolation.** Majority voting fell to near zero (0.8% on one
   benchmark) once 60% of agents were corrupted (2604.17139); content-free inputs flipped LLM judges up to
   95.1% (2507.08794). Check a worker's claim with a deterministic test or a provenance check, and gate
   worker output with a verification stage: QA plus Fixer cut a saboteur's 53.7-point damage to 0.6 or
   less, though about 26% of surviving attacks were missed and 41% left unrepaired (2606.12709).
8. **Fix CI defaults.** Drop persisted credentials and unneeded tokens (`persist-credentials: false`
   removed PR-body token exfiltration without a utility loss, 2606.09935); never print an unrestricted
   environment dump into shared output. Every provider tested had a working attack by default.

## Fleets: lead and worker agents

9. **Do not hand raw untrusted text to a privileged agent.** Plan from the user task alone and pass on the
   worker's reduced result: an isolated planner took InjecAgent ASR from 72.8% to 0.0% at 0.97% FPR
   (2604.10134); a per-call trusted monitor reached under 1.7% indirect ASR at about 1.4x latency
   (2604.24118). Expect an adaptive attacker to recover some of it (another defense, AttriGuard, went from
   0% to 6.6-9.84%, 2603.10749).
10. **More agents means more attack surface.** In a 7-agent setup, permissive aggregation raised
    compromise probability from 0.24 (one agent) to 0.86; consensus gating gave 0.48 (2606.15008). One
    compromised agent infected over 95% of a simulated 128-agent system through shared retrieval
    (2605.01758; image-based attack, indicative only).
11. **Give each worker its own short-lived credential.** Heartbeat-bound sub-agent credentials cut the
    post-revocation window from 3600 s to 40 s at 0.71% overhead (2605.20704). Broker the secrets and
    constrain risky actions rather than removing them (rules 3-4 of
    [agent action containment](agent-action-containment.md)). A planted honeytool or honeytoken caught
    90.7-100% of successful attacks with no false alarm in 485 runs, single agent only (2605.11026).

## Testing a defense

- Attack it with an attacker tuned to that defense, not a fixed list: simulation missed 71.2% of real CI
  attacks (2606.09935). Read "0% ASR" as "0% against a static attacker" until shown otherwise (AttriGuard:
  0% static, 6.6-9.84% adaptive, 2603.10749).
- Report benign multi-step utility next to ASR; single-turn "under 5% false positives" hid the failures
  in 2603.19423.
- Expect residual risk: one paper argues no fixed policy can both allow all legitimate flows and block
  context-manipulation attacks (2605.17634), so plan containment and recovery.

## Gaps

- No measured ASR for standalone least-privilege scoping, memory-write gating, sub-agent sandboxing,
  approval fatigue, or adaptive attacks on named guard models.
- Fleets: no measured ASR by topology or by lead vs worker role, for structured-only handoffs, or for the
  cost of pinning tool descriptors.
