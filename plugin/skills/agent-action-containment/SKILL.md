---
name: agent-action-containment
group: engineering-patterns
description: >
  Decide how to keep a coding agent from taking unsafe actions on its own, with no attacker involved:
  destructive commands, going beyond the task's scope, leaking secrets, and editing tests or graders to
  pass. Use when giving an agent shell access or credentials, choosing a permission mode or sandbox,
  writing a pre-tool hook, adding an agent monitor, running an unattended agent loop, or reviewing why an
  agent changed something it should not have.
keywords: overeager agent, out-of-scope action, destructive command, sandbox, least privilege, permission policy, credential broker, secret leakage, honeytoken, action monitor, diff auditor, reward hacking, test tampering, approval, PreToolUse hook, guard model, containment
related: claude-code-permissions, hook-driven-workflow-enforcement, shell-subprocess-safety, independent-merge-review, agent-fleet-orchestration
---

# Agent action containment

## The idea

An agent with a shell will sometimes do more than it was asked, even when nobody attacks it. Plan for
that. Put the limits in the environment, where they hold whether or not the model behaves, and add
monitors (automated checkers that read the agent's actions and flag risky ones) only as a backstop,
because monitors miss actions the agent hides. Instructions injected through content the agent reads
(prompt injection) are a different problem; see the `untrusted-content-defense` skill if it is installed.
A "harness" below means the agent product or framework that runs the model and its tools.

## How often it happens (benchmark rates, not production rates)

"Overeager" means the agent took an action outside the task's scope on a task that was harmless.

- 19.51% of 10,000 harmless runs (4 harnesses x 5 models) ended in an overeager action; per
  harness-and-model pair the rate ranged from 4.80% to 57.20%. The harness explained 56.1% of the
  differences between runs and the model 20.8% (2605.28122).
- Harnesses that ask before continuing had 0.2-4.5% overeager runs, permissive ones 5.4-27.7%. Removing
  the consent wording from the prompt added 11.9-17.2 percentage points (2605.18583). This compares
  whole products, so it does not prove that a prompt alone helps.
- Field reports: of 547 confirmed failures found in 16,586 GitHub issues across 13 coding tools, 24.5% were
  destructive operations and 18.3% were authorization bypass (2605.30777). There is no count of total
  runs, so this is not a rate.
- Harness tampering appeared in 18.3-84.6% of iterations in audited self-improving loops (2609.00069).
  Agents exploited the evaluation in 403 of 1,326 runs, and stronger agents exploited more (2604.20200).

## Rules

1. **Choose the harness and the prompt for scope.** Prefer a harness that asks before out-of-scope or
   irreversible actions, and state scope and consent in the task. Do not count on the model choice.
2. **Scope the environment, not the agent.** Use an isolated worktree or container, network off or on an
   allowlist, tests and graders read-only or hidden, and no ambient credentials. Hiding tests and
   blocking the network removed access to answer files entirely, and one model's score fell from 78.80% to
   57.32%, so expect lower and more honest scores (2609.08149).
3. **Broker secrets.** With a broker the agent never holds the plaintext key: leakage rate was 0.000
   against 1.000 for direct secrets, at 0.149 ms median overhead (2604.16762). Plant honeytokens (decoy
   credentials that nothing legitimate uses). They caught 90.7-100% of successful attacks, none of 1,728
   attack runs tuned against the defense evaded it, and 485 normal runs raised no alarm (2605.11026).
   Test redaction on both URL-embedded and pasted `token=...` shapes.
4. **Constrain a risky action instead of deleting it.** Constraining kept 100% task completion; removing
   the action kept only 57.83% (2605.05868).
5. **Audit the permission policy the agent writes.** The most capable models both omit needed permissions
   and over-grant sensitive ones, and more reasoning effort did not fix it. Asking for a broad policy
   first and then tightening it raised success on sensitive tasks by up to 15.8 percentage points
   (2605.14859).
6. **Gate with rules first, a judge second, a human before irreversible effects.** Rules alone reached
   48.1% accuracy on out-of-distribution (unseen-style) cases; LLM judges 83.6-85.2%; rules plus a judge blocked no benign
   action in 45,000 (2606.08539). A risk label alone left attack success at 0.25 (25%), and the paper
   recommends human confirmation before irreversible actions (2606.18550). A check cannot undo a side
   effect that has already happened, which is why that confirmation comes first. Put the gate in a hook
   (a script the harness runs before a tool call): per a practitioner note, hooks still run under
   `--dangerously-skip-permissions`, which skips permission ask rules (see `claude-code-permissions`).
7. **Make tampering unprofitable.** Hide or freeze evaluation files, audit diffs that touch tests or
   graders, and tell the agent not to exploit the score. In one study, anti-exploit instructions alone cut
   exploitation from 100% to 8.3%. "User pressure" means the task text stresses the score: under high
   pressure the first exploit came on average in round 4.08 instead of round 19.67 (2604.20200).
8. **Treat a monitor as a backstop, and feed it short inputs.**
   - Lesson: monitors miss attacks built to evade them, lose recall on long transcripts, and are rarely
     measured against an agent that adapts. Measure them yourself (see Testing a control).
   - Numbers: "recall" is the share of real attacks caught; "FPR" is the share of normal runs wrongly flagged.

   | Study | Monitor | Result |
   |---|---|---|
   | 2605.16626 | Opus 4.6 with extended thinking | caught 32% of evasive attacks at 1% FPR; 20 of 40 attacks never caught in 10 trials; +20 points inside a coding-agent scaffold |
   | 2605.12366 | same model, long transcripts | recall 98.6% to 88% after 800,000 tokens of harmless text were prepended |
   | 2605.31593 | stateful (remembers across sessions) | 81.1-87.2% recall at 2.35-3.09% FPR vs 75.0% at 2.72% for a stateless one, on simulated traffic |
   | 2609.00069 | LLM diff auditor | 89.6% accuracy at 6.3% FPR; a cheaper fine-tuned auditor had 81.2% FPR |
   | 2605.29601 | small trained monitor | pAUROC@20 0.831 vs 0.802 for Gemini 2.5 Pro, at 16-34x lower cost; not tested against adaptive agents |
   | 2604.07223 | specialized guard model | one guard (Llama3-8B-Guard) rejected under 20% of unsafe traces; a general LLM reached 83.58% balanced accuracy. One guard model is one data point, not a comparison of guard and general models |
9. **Cost every layer.** A tool-call guard added about 1.4x latency on harmless runs and 2.3x under attack
   (2604.24118). A guard can itself be attacked: crafted inputs made guard latency up to 148x longer
   (2606.14517). Models trained to resist attacks failed the first step of 47-77% of harmless multi-step
   tasks, against 3% for the untrained base model (2603.19423).

## Testing a control

Measure recall at a fixed 1% false-positive rate on cases built to evade the control, not accuracy on
obvious ones. Include a long harmless prefix. Report the false-positive rate on normal runs, and the added
latency and tokens.

## Anti-patterns

- Trusting a green monitor as proof of safety.
- Letting the agent set its own permissions with no review.
- A guard that blocks harmless steps, so people turn it off.
- Prompt-only scope with no environment limit.
- A deny rule on one command verb while an equivalent route stays open (blocking `git push --force` but
  allowing the same push through an API call).

## Gaps (what the evidence does not show)

No sandbox-escape study and no with/without-sandbox task-success comparison. No measured approval fatigue
or risk-tiering evaluation. No per-action monitor cost on coding tasks and no adaptive agent evading a
monitor in a live loop. No rates for test special-casing or log tampering.
