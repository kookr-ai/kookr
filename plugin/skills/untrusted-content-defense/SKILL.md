---
name: untrusted-content-defense
group: engineering-patterns
description: >
  Decide how to defend a tool-using agent against instructions injected through content it reads: issues,
  PR text, web pages, tool and MCP output, stored memory, and third-party skills. Covers which defense
  layers survive an adaptive attacker (action limits and provenance tracking) and which do not (filters,
  classifiers, robust fine-tunes, LLM-judge scanners), the extra risk from skills and memory, why voting and
  judge-only checks are not isolation, and how to test a defense honestly. Use when giving an agent new
  tools or credentials, installing a skill or MCP server, letting an agent store lessons for later reuse,
  reviewing a CI agent workflow, or choosing between a guard model and a structural control.
keywords: prompt injection, indirect injection, untrusted content, tool output, MCP, skill poisoning, malicious skill, memory poisoning, least privilege, provenance, taint, tool-call gating, deny gate, hook, sandbox, adaptive attack, classifier, guard model, CI agent, credentials, LLM judge manipulation
related: agent-fleet-orchestration, hook-driven-workflow-enforcement, claude-code-permissions, shell-subprocess-safety, task-feedback-reflect
---

# Untrusted content defense

## The idea

An agent that reads text can be told what to do by that text. Models cannot reliably tell the user's
instruction from a sentence inside an issue, a web page or a tool result. So design for the case where
the model follows an injected instruction: limit what a tainted action can do. Filters that try to spot
the injection help against fixed attacks and weaken once the attacker adapts.

## Rules

1. **Limit actions before you detect text.** Give each task the smallest tool set and credentials it
   needs, no ambient secrets, no network unless needed, and an approval step for irreversible or
   outward-facing actions (send, merge, deploy, delete, publish).
   Evidence: system-level limits (Progent, DRIFT) kept attack success rate (ASR) under 10% on most
   models even under an adaptive attacker, while filters rose from 0-12.6% to 28-33% ASR (2606.15057).
2. **Track where values came from.** Mark text from issues, PRs, web pages, tool output, memory notes
   and skills as untrusted. Do not let an untrusted-derived value fill a sensitive argument (recipient,
   command, URL, path, branch to merge) unless a trusted step confirmed it. Check per argument, not per
   call. Evidence: argument-level provenance reached 100% security on the three strongest models in
   AgentDojo with 38.1-46.4% utility, 8-16 points above whole-call quarantine; 13 of 13 live attacks
   blocked with 0 false positives on 267 benign calls (2605.11039).
3. **Gate the effect, not the command verb.** A deny rule on one verb leaves an equivalent route open
   (for example a REST call that merges). Match the endpoint or effect. A hook is a policy layer, not a
   sandbox; use real isolation for anything dangerous.
4. **Do not rely on a guard model or a robust fine-tune alone.**
   - Static results do not carry over: the static-to-adaptive gap averaged 15.8 points (2606.15441);
     input sanitization fell at attack round 39 and a sandwich prompt at round 277 (2604.23887).
   - They cost utility: defense-trained models failed 47-77% of benign multi-step tasks at step 1
     against 3% for the base model (2603.19423).
   - Deterministic code works within its scope: output filtering leaked 0% over 15,000 attacks, but only
     for secrets it can match (2604.23887).
5. **Treat skills and MCP servers as code you are installing.** Skill-shaped injection averaged 80.7%
   ASR where naive injection scored 0.0% (2602.14211). Backdoored skills reached 97.2% ASR and LLM
   scanners labelled 98.2% and 99.4% of them safe (2604.06811). Use layers: a static filter, LLM review,
   then a jury or human review (F1 0.920 on 390 skills, 2604.06550), and scope each skill's permissions.
6. **Treat memory as a second injection path.** Poison persisted up to 45.70% in memory systems
   (2611.09721); 91.0% of trials embedded a poisoned lesson into a skill at 10% attacker support
   (2608.05563). Keep the source on every stored lesson, require independent support (different
   sources) before a lesson becomes a reusable skill, and keep an audit and rollback path. Post-hoc
   audit worked only below a 0.20 contamination ratio (2605.23723).
7. **Do not take a vote or a judge as isolation.** Majority voting fell to 0.8% accuracy once 60% of
   agents were corrupted (2604.17139). Content-free inputs flipped LLM judges up to 95.1% (2507.08794).
   Check a worker's claim with a deterministic test or a provenance check.
8. **Fix CI defaults.** In CI agent workflows, drop persisted credentials and any token the agent
   does not need (`persist-credentials: false` removed PR-body token exfiltration without a utility
   loss, 2606.09935). Every provider tested had a working attack in its default configuration.

## Testing a defense

- Attack it with an attacker tuned to that defense, not a fixed list. Simulation missed 71.2% of real CI
  attacks (2606.09935).
- Report utility on benign multi-step tasks next to ASR. Single-turn "under 5% false positives" hid the
  failures in 2603.19423.
- Read "0% ASR" as "0% against a static attacker" until shown otherwise (AttriGuard: 0% static, 6.6-9.84%
  adaptive, 2603.10749).
- Expect residual risk. One paper argues that no fixed policy can both allow all legitimate flows and
  block context-manipulation attacks (2605.17634), so plan containment and recovery.

## Anti-patterns

- Adding a classifier and calling the agent safe.
- Letting the agent read untrusted text and hold broad credentials in the same step.
- Gating `gh pr merge` but not the API call that does the same thing.
- Printing an unrestricted environment dump into shared output.
- Installing a skill because one LLM scan passed it.
- Writing lessons to memory without recording where they came from.

## Gaps

No measured ASR for standalone least-privilege scoping, memory-write gating, sub-agent sandboxing,
approval fatigue, or adaptive attacks on named guard models. Report: `defending-tool-using-agents-against-injected-instructions`
in the `agentic-capability-reports` KB.
