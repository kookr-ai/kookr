# Agent action containment

Use when: giving an agent shell access or credentials, choosing a permission mode or sandbox, writing a
pre-tool hook, adding an agent monitor, or running an unattended loop, with no attacker involved.

Plan for an agent doing more than asked. For injected instructions see
[untrusted-content defense](untrusted-content-defense.md).

1. **Choose the harness and the prompt for scope.** Prefer a harness that asks before out-of-scope or
   irreversible actions, and state scope and consent in the task. The harness explains more of the
   out-of-scope behavior than the model does, so do not count on model choice.
2. **Scope the environment, not the agent.** Isolated worktree or container, network off or allowlisted,
   tests and graders read-only or hidden, no ambient credentials. Expect lower, more honest scores once
   answer files are out of reach.
3. **Broker secrets.** The agent should never hold the plaintext key; a broker leaks nothing at negligible
   overhead. Plant honeytokens (decoy credentials nothing legitimate uses): they caught nearly all
   successful attacks with no false alarms. Test redaction on both URL-embedded and pasted `token=...`
   shapes.
4. **Constrain a risky action instead of deleting it.** Constraining kept full task completion; removing
   the action lost about 40% of tasks.
5. **Audit the permission policy the agent writes.** Capable models both omit needed permissions and
   over-grant sensitive ones, and more reasoning effort does not fix it. Ask for a broad policy first, then
   tighten it.
6. **Gate with rules first, a judge second, a human before irreversible effects.** Rules alone miss
   out-of-distribution cases (about 48% accuracy vs about 85% for LLM judges); rules plus a judge blocked no
   benign action. A risk label alone does not stop attacks, and a check cannot undo a side effect already
   done, so confirm irreversible actions with a human first. Gate the effect, not one verb (see rule 3 of
   [untrusted-content defense](untrusted-content-defense.md)). Put the gate in a hook: hooks reportedly still run under
   `--dangerously-skip-permissions`, which skips permission ask rules (see `claude-code-permissions`).
7. **Make tampering unprofitable.** Hide or freeze evaluation files, audit diffs that touch tests or
   graders, and tell the agent not to exploit the score; anti-exploit instructions alone cut exploitation
   from 100% to about 8% in one study. Pressure in the task text (stressing the score) brings the first
   exploit much sooner, so avoid it.
8. **Treat a monitor as a backstop, and feed it short inputs.** Monitors miss attacks built to evade them
   (one strong monitor caught about a third), lose recall on long transcripts, and are rarely tested against
   an adaptive agent, so a green monitor is not proof of safety. Guards and auditors vary widely (one guard
   model rejected under 20% of unsafe traces), so measure any monitor on your traffic. A stateful monitor
   beat a stateless one modestly; small trained monitors can match large LLMs at a fraction of the cost, but are untested against
   adaptive agents.
9. **Cost every layer.** A tool-call guard added about 1.4x latency on harmless runs and 2.3x under attack;
   crafted inputs can make a guard far slower. A guard that blocks harmless steps invites people to turn it
   off. Attack-resistant models also cost utility (see rule 4 of
   [untrusted-content defense](untrusted-content-defense.md)).

Testing a control: measure recall at a fixed 1% false-positive rate on cases built to evade it, with a long
harmless prefix, not accuracy on obvious cases. Report false positives on normal runs and the added latency
and tokens.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-containing-unsafe-actions-of-autonomous-coding-agents.md
