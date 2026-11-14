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
   skills, 2604.06550), and scope each skill's permissions.
6. **Treat memory as a second injection path.** Unoptimized poison reached later behavior in up to 45.70%
   of cases (2611.09721; varied widely by memory design); 91.0% of trials embedded a poisoned lesson into a
   skill at 10% attacker support (2608.05563). Keep the source on every stored lesson, require independent
   support (different sources) before a lesson becomes a reusable skill, and keep audit and rollback.
   Post-hoc audit worked only below a 0.20 (0.15 on one task) contamination ratio (2605.23723).
7. **Do not take a vote or a judge as isolation.** Majority voting fell to near zero (0.8% on one
   benchmark) once 60% of agents were corrupted (2604.17139); content-free inputs flipped LLM judges up to
   95.1% (2507.08794). Check a worker's claim with a deterministic test or a provenance check.
8. **Fix CI defaults.** Drop persisted credentials and unneeded tokens (`persist-credentials: false`
   removed PR-body token exfiltration without a utility loss, 2606.09935); never print an unrestricted
   environment dump into shared output. Every provider tested had a working attack by default.

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
