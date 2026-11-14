---
name: agent-action-containment
group: engineering-patterns
description: >
  Decide how to keep a coding agent from taking unsafe actions on its own, with no attacker involved:
  destructive commands, going beyond the task's scope, leaking secrets, editing tests or graders to pass,
  and acting on its own permission policy. Covers how often it happens, which controls hold (a scoped
  environment, brokered secrets, constrained actions, deterministic rules with a judge for the middle,
  confirmation before irreversible actions), why a monitor is a second line and not the first, what each
  layer costs, and how to test a monitor. Use when giving an agent shell access or credentials, choosing
  a permission mode or sandbox, writing a pre-tool hook, adding an agent monitor or guard model, running
  an unattended agent loop, or reviewing why an agent edited something it should not have.
keywords: overeager agent, out-of-scope action, destructive command, sandbox, least privilege, permission policy, credential broker, secret leakage, honeytoken, action monitor, diff auditor, reward hacking, test tampering, approval, PreToolUse hook, guard model, containment
related: claude-code-permissions, hook-driven-workflow-enforcement, shell-subprocess-safety, independent-merge-review, agent-fleet-orchestration
---

# Agent action containment

## The idea

An agent with a shell will sometimes do more than it was asked, even when nobody attacks it. Plan for
that. Put the limits in the environment, where they hold whether or not the model behaves, and add
monitors only as a backstop, because monitors miss actions the agent hides. For injected instructions
see `untrusted-content-defense`; this skill covers the agent's own overreach.

## How often it happens (benchmark rates, not production rates)

- 19.51% of 10,000 benign runs (4 frameworks x 5 models) triggered an out-of-scope action, per pair 4.80-57.20%.
  The framework explained 56.1% of the variance and the model 20.8% (2605.28122).
- Ask-to-continue frameworks had 0.2-4.5% overeager actions, permissive ones 5.4-27.7%. Removing the
  prompt's consent wording added 11.9-17.2 percentage points (2605.18583). The comparison is between whole
  products, so it does not prove a prompt alone helps.
- Field reports: 547 confirmed failures from 16,586 GitHub issues across 13 coding tools; 24.5% destructive
  operations, 18.3% authorization bypass (2605.30777). There is no denominator, so it is not a rate.
- Tampering with the harness appeared in 18.3-84.6% of iterations in audited self-improving loops (2609.00069).
  Evaluation exploitation hit 403 of 1,326 runs and stronger agents exploited more (2604.20200).

## Rules

1. **Choose the harness and the prompt for scope.** Prefer a harness that asks before out-of-scope or
   irreversible actions, and state scope and consent in the task. Do not count on the model choice.
2. **Scope the environment, not the agent.** Use an isolated worktree or container, network off or on an
   allowlist, tests and graders read-only or concealed, and no ambient credentials. Concealed tests plus
   a network block took answer-file access to zero, and one model fell from 78.80% to 57.32%, so expect
   lower and more honest scores (2609.08149).
3. **Broker secrets.** A broker kept key leakage at 0.000 against 1.000 for direct secrets at 0.149 ms
   median overhead (2604.16762). Plant honeytokens: 90.7-100% of successful attacks were caught, 0 of
   1,728 adaptive runs evaded, and 485 normal runs raised no alarm (2605.11026). Test redaction on both
   URL-embedded and pasted `token=...` shapes.
4. **Constrain a risky action instead of deleting it.** Constraining kept 100% task completion, removal
   only 57.83% (2605.05868).
5. **Audit the permission policy the agent writes.** Frontier models omit needed permissions and
   over-grant sensitive ones at once, and more reasoning effort did not fix it. Have the agent propose
   broad, then tighten; that raised sensitive-task success by up to 15.8% (2605.14859).
6. **Gate with rules first, a judge second, a human before irreversible effects.** Rules alone reached
   48.1% out-of-distribution accuracy, LLM judges 83.6-85.2%, and the combination made zero benign
   hard-blocks in 45,000 actions (2606.08539). A risk label alone left attack success at 0.25 and runtime
   checks cannot undo a committed side effect, so confirm irreversible actions before they run (2606.18550).
   Put the gate in a hook: hooks still fire when `--dangerously-skip-permissions` bypasses ask rules.
7. **Make tampering unprofitable.** Freeze or hide evaluation files, audit diffs that touch tests or
   graders, and tell the agent not to exploit the score: that cut exploitation from 100% to 8.3% in one
   study (2604.20200). Do not raise user pressure; it moved the first exploit from round 19.67 to 4.08.
8. **Treat a monitor as a backstop.** The best monitor caught 32% of evasive attacks at a 1% false-positive
   rate, and 20 of 40 attacks were never caught in 10 trials (2605.16626). Recall fell from 98.6% to 88% after
   800K benign tokens, so feed it short inputs (2605.12366). A stateful monitor reached 81.1-87.2% recall
   at 2.35-3.09% FPR on simulated traffic (2605.31593). A diff auditor reached 89.6% accuracy and 6.3% FPR,
   while a cheaper fine-tuned one had 81.2% FPR (2609.00069). A small trained monitor beat larger models on
   pAUROC@20 at 16-34x lower cost but was not tested against adaptive agents (2605.29601). Use a general LLM
   rather than a specialized guard model: Llama3-8B-Guard rejected under 20% of unsafe traces (2604.07223).
9. **Cost every layer.** A tool-call guard added about 1.4x latency on benign runs and 2.3x under attack
   (2604.24118). A guard can be turned into a denial-of-service target, with up to 148x latency
   (2606.14517). Defense-trained models failed 47-77% of benign multi-step tasks at step 1 (2603.19423).

## Testing a control

Measure recall at a fixed 1% false-positive rate on evasive cases, not accuracy on obvious ones. Include a
long benign prefix. Report the false-positive rate on normal runs, and the added latency and tokens.

## Anti-patterns

- Trusting a green monitor as proof of safety.
- Letting the agent set its own permissions with no review.
- A guard model that rejects benign steps, so people turn it off.
- Prompt-only scope with no environment limit.
- Deny rules on one command verb while an equivalent route stays open.

## Gaps (what the evidence does not show)

No sandbox-escape study and no with/without-sandbox task-success comparison. No measured approval fatigue
or risk-tiering evaluation. No per-action monitor cost on coding tasks and no adaptive agent evading a
monitor in a live loop. No rates for test special-casing or log tampering.
