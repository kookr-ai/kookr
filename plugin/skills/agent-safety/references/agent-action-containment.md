# Agent action containment

Use when: giving an agent shell access or credentials, choosing a permission mode or sandbox, writing a
pre-tool hook, adding an agent monitor, or running an unattended loop, with no attacker involved.

Plan for an agent doing more than asked. For injected instructions see
[untrusted-content defense](untrusted-content-defense.md).

## How often it happens (benchmark rates, not production rates)

- "Overeager" (an out-of-scope action on a harmless task) in 19.51% of 10,000 harmless runs (4 harnesses x
  5 models), 4.80% to 57.20% per pair. The harness explained 56.1% of the differences between runs and the
  model 20.8% (2605.28122).
- Harnesses that ask before continuing had 0.2-4.5% overeager runs, permissive ones 5.4-27.7%; removing
  the consent wording from the prompt added 11.9-17.2 points (2605.18583). This compares whole products,
  so it does not prove that a prompt alone helps.
- Field reports: of 547 confirmed failures in 16,586 GitHub issues across 13 coding tools, 24.5% were
  destructive operations and 18.3% authorization bypass (2605.30777). No total-run count, so not a rate.
- Harness tampering appeared in 18.3-84.6% of iterations in audited self-improving loops (2609.00069).
  Agents exploited the evaluation in 403 of 1,326 runs, and stronger agents exploited more (2604.20200).

## Rules

1. **Choose the harness and the prompt for scope.** Prefer a harness that asks before out-of-scope or
   irreversible actions, and state scope and consent in the task. Do not count on the model choice.
2. **Scope the environment, not the agent.** Isolated worktree or container, network off or allowlisted,
   tests and graders read-only or hidden, no ambient credentials. Hiding tests and blocking the network
   removed access to answer files entirely; one model's score fell from 78.80% to 57.32%, so expect lower
   and more honest scores (2609.08149).
3. **Broker secrets.** With a broker the agent never holds the plaintext key: leakage 0.000 against 1.000
   for direct secrets, at 0.149 ms median overhead (2604.16762). Plant honeytokens (decoy credentials
   nothing legitimate uses): they caught 90.7-100% of successful attacks, none of 1,728 attack runs tuned
   against them evaded, and 485 normal runs raised no alarm (2605.11026). Test redaction on both
   URL-embedded and pasted `token=...` shapes.
4. **Constrain a risky action instead of deleting it.** Constraining kept 100% task completion; removing
   the action kept 57.83% (2605.05868).
5. **Audit the permission policy the agent writes.** The most capable models both omit needed permissions
   and over-grant sensitive ones, and more reasoning effort did not fix it. Asking for a broad policy first
   and then tightening it raised success on sensitive tasks by up to 15.8 points (2605.14859).
6. **Gate with rules first, a judge second, a human before irreversible effects.** Rules alone reached
   48.1% accuracy on out-of-distribution cases, LLM judges 83.6-85.2%, and rules plus a judge blocked no
   benign action in 45,000 (2606.08539). A risk label alone left attack success at 0.25, and the paper
   recommends human confirmation before irreversible actions (2606.18550). A check cannot undo a side
   effect already done, which is why that confirmation comes first. Gate the effect, not one verb (see rule 3 of
   [untrusted-content defense](untrusted-content-defense.md)). Put the gate in a hook: per a practitioner
   note, hooks still run under `--dangerously-skip-permissions`, which skips permission ask rules (see
   `claude-code-permissions`).
7. **Make tampering unprofitable.** Hide or freeze evaluation files, audit diffs that touch tests or
   graders, and tell the agent not to exploit the score. In one study, anti-exploit instructions alone cut
   exploitation from 100% to 8.3%. Under high "user pressure" (the task text stresses the score), the first
   exploit came on average in round 4.08 instead of 19.67 (2604.20200).
8. **Treat a monitor as a backstop, and feed it short inputs.** Monitors miss attacks built to evade them,
   lose recall on long transcripts, and are rarely measured against an adaptive agent, so a green monitor
   is not proof of safety. Recall = share of real attacks caught; FPR = share of normal runs flagged.

   | Study | Monitor | Result |
   |---|---|---|
   | 2605.16626 | Opus 4.6 with extended thinking | caught 32% of evasive attacks at 1% FPR; 20 of 40 attacks never caught in 10 trials; +20 points inside a coding-agent scaffold |
   | 2605.12366 | same model, long transcripts | recall 98.6% to 88% after 800,000 tokens of harmless text were prepended |
   | 2605.31593 | stateful (remembers across sessions) | 81.1-87.2% recall at 2.35-3.09% FPR vs 75.0% at 2.72% for a stateless one, on simulated traffic |
   | 2609.00069 | LLM diff auditor | 89.6% accuracy at 6.3% FPR; a cheaper fine-tuned auditor had 81.2% FPR |
   | 2605.29601 | small trained monitor | pAUROC@20 0.831 vs 0.802 for Gemini 2.5 Pro, at 16-34x lower cost; not tested against adaptive agents |
   | 2604.07223 | specialized guard model | one guard (Llama3-8B-Guard) rejected under 20% of unsafe traces; a general LLM reached 83.58% balanced accuracy. One guard model is one data point, not a comparison of guard and general models |
9. **Cost every layer.** A tool-call guard added about 1.4x latency on harmless runs and 2.3x under attack
   (2604.24118); crafted inputs made guard latency up to 148x longer (2606.14517). A guard that blocks
   harmless steps invites people to turn it off. Attack-resistant models also cost utility (see rule 4 of
   [untrusted-content defense](untrusted-content-defense.md)).

## Testing a control

Measure recall at a fixed 1% FPR on cases built to evade the control, not accuracy on obvious ones, with a
long harmless prefix. Report FPR on normal runs, and the added latency and tokens.

## Gaps

- No sandbox-escape study and no with/without-sandbox task-success comparison.
- No measured approval fatigue or risk-tiering evaluation.
- No per-action monitor cost on coding tasks; no adaptive agent evading a monitor in a live loop.
- No rates for test special-casing or log tampering.
