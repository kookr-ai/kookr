# Untrusted content defense

Use when: granting an agent tools or credentials, installing a skill or MCP server, storing lessons for
reuse, reviewing a CI agent workflow, or choosing between a guard model and a structural control.

1. **Limit actions before you detect text.** Assume the model will follow an injected instruction. Give
   each task the smallest tool set and credentials it needs, no ambient secrets, no network unless needed,
   and an approval step for irreversible or outward-facing actions (send, merge, deploy, delete, publish).
   Never read untrusted text and hold broad credentials in the same step. System-level limits held attack
   success under 10% against adaptive attackers, while filters degraded under adaptation.
2. **Track where values came from.** Mark text from issues, PRs, web pages, tool output, memory notes and
   skills as untrusted. An untrusted-derived value must not fill a sensitive argument (recipient, command,
   URL, path, branch to merge) unless a trusted step confirmed it. Check per argument, not per call:
   argument-level provenance blocked live attacks with no false positives on benign calls, and kept 8-16
   points more utility than invocation-level quarantine (still only about 40% task utility).
3. **Gate the effect, not the command verb.** Gating `gh pr merge` but not the REST call that merges leaves
   the route open; match the endpoint or effect. A hook is a policy layer, not a sandbox; use real
   isolation for anything dangerous.
4. **Do not rely on a guard model, classifier or robust fine-tune alone.** Static results do not carry over
   to adaptive attackers (~16 points worse), and defense-trained models failed half or more of benign
   multi-step tasks. Deterministic code works within its scope: output filtering leaked nothing, but only
   for secrets it can match.
5. **Treat skills and MCP servers as code you are installing.** Skill-shaped injection succeeded where naive
   injection failed, and LLM guard scanners labelled nearly all backdoored skills safe, so one passing LLM
   scan is not enough. Layer a static filter, LLM review, then a jury or human review, and scope each
   skill's permissions. Treat tool descriptions as untrusted input too: tool poisoning was blocked only
   42-60% of the time. More in [tool surface
   design](../../agent-loop-design/references/agent-tool-surface-design.md) (rule 8).
6. **Treat memory as a second injection path.** Poison reached later behavior in up to ~46% of cases
   (varies widely by memory design), and a poisoned lesson got embedded into a skill in 91% of trials at 10%
   attacker support. Keep the source on every stored lesson, require independent support (different
   sources) before a lesson becomes a reusable skill, and keep audit and rollback. Post-hoc audit worked
   only when contamination was below about 15-20%.
7. **Do not take a vote or a judge as isolation.** Majority voting fell to near zero once 60% of agents
   were corrupted; content-free inputs flipped LLM judges up to ~95%. Check a worker's claim with a
   deterministic test or a provenance check, and gate worker output with a verification stage (QA plus
   Fixer cut a saboteur's damage sharply, though about a quarter of surviving attacks were missed).
8. **Fix CI defaults.** Drop persisted credentials and unneeded tokens (`persist-credentials: false`
   removed PR-body token exfiltration without a utility loss); never print an unrestricted environment
   dump into shared output. Every provider tested had a working attack by default.

For lead and worker fleets:

9. **Do not hand raw untrusted text to a privileged agent.** Plan from the user task alone and pass on the
   worker's reduced result: an isolated planner took attack success from ~73% to 0%; a per-call trusted
   monitor reached under 2% at about 1.4x latency. Expect an adaptive attacker to recover some of it
   (another defense went from 0% to ~7-10%).
10. **More agents means more attack surface.** Permissive aggregation across 7 agents raised compromise
    probability from 0.24 (one agent) to 0.86; consensus gating gave 0.48. One compromised agent infected
    over 95% of a simulated 128-agent system through shared retrieval (indicative only).
11. **Give each worker its own short-lived credential.** Heartbeat-bound sub-agent credentials cut the
    post-revocation window from an hour to about 40 s. Broker the secrets and constrain risky actions
    rather than removing them (rules 3-4 of [agent action containment](agent-action-containment.md)). A
    planted honeytool or honeytoken caught nearly all successful attacks (single agent only).

Testing a defense:

- Attack it with an attacker tuned to that defense, not a fixed list (simulation missed ~70% of real CI
  attacks). Read "0% attack success" as "0% against a static attacker" until shown otherwise.
- Report benign multi-step utility next to attack success; single-turn false-positive rates hid failures.
- Expect residual risk (one paper argues no fixed policy both allows all legitimate flows and blocks context
  manipulation), so plan containment and recovery.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-defending-tool-using-agents-against-injected-instructions.md, kb://agentic-capability-reports/notes/2026-11-14-injection-and-trust-across-lead-worker-agent-fleets.md
