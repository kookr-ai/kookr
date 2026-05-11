# Viewer Critique — First-Time LinkedIn Scroll

Persona: SWE who runs ONE Claude Code session at a time. Sees Kookr for the first time. Phone, muted autoplay, ~360px wide.

---

## Scene-by-scene confusion log

### Act 0 (0:00–0:08) — Hook
1. **First second:** a dense dashboard with five rows, a sidebar, top bar numbers. At 360px the rows blur into stripes. I can't tell what the rows ARE — terminals? PRs? Tickets?
2. **Confusing:** what is "$1.47"? Per agent, per hour, lifetime? The yellow pulsing dot — is that an error? A unread badge?
3. **Bail point:** ~3s. "5 AI agents working. One needs you. Which one?" reads like a riddle the video isn't going to answer fast enough.
4. **Never explained:** "agent." I infer it's an LLM session, but the caption assumes I already think of agents as discrete workers I supervise.

### Act 1 (0:08–0:35) — Multi-project + Codex
1. **First second:** a cursor wiggling over chips. At 360px the chips look like tabs, but I can't read "acme/webapp" — it's 8pt text on a phone.
2. **Confusing:** "Codex via jeanibarz/codex#feat/claude-compat" — this is the single most jarring caption in the video. As a viewer I read "Codex," "jean-something," "feat/claude-compat" and conclude this is a beta hack. Why does using Codex require a fork from a random GitHub user? Red flag.
3. **Bail point:** ~12s. The filter-then-unfilter-then-filter-again dance is choreography I don't have a reason to care about yet.
4. **Never explained:** "runtime." Captions say "two runtimes" — I think of language runtimes. The script means "agent provider/CLI." Different mental model.

### Act 2 (0:35–0:55) — Permission block
1. **First second:** a row glows, jumps up. Clearest beat so far. I get it.
2. **Confusing:** "Allow Bash: npm test --coverage?" — fine for Claude Code users, but Codex CLI doesn't prompt this way. If half my audience is Codex-first, they'll wonder why the demo's permission UX looks like Claude's.
3. **Bail point:** I'd actually stay. This is the strongest 20 seconds.
4. **Never explained:** how Kookr knows the agent is blocked. Is it tailing stdout? A hook? A polling API? Devs want to know.

### Act 3 (0:55–1:25) — Cross-project triage
1. **First second:** two cards appear, panel slides in. Visually busy.
2. **Confusing:** "AI drafts a reply." Reply to WHAT? An agent isn't a person. I have to rewind to understand the agent asked a question to ME, and the "AI" (which AI? a third one?) is drafting my answer back to the first AI. That's three levels of agent-on-agent.
3. **Bail point:** ~1:10. The snooze + Redis-vs-in-memory micro-plot demands more attention than a muted feed scroll allows.
4. **Never explained:** "finding." It's used in captions and the RFC like a defined term. To me it sounds like a security-scanner result. "Question," "alert," or "prompt" would land faster.

### Act 4 (1:25–1:50) — GitHub awareness
1. **First second:** a toast pops, then another. Two toasts in 12s is OK.
2. **Confusing:** the detail panel switches "to the GitHub tab" — I never knew there WAS a GitHub tab. New surface area introduced 70% through the video.
3. **Bail point:** ~1:35. "Same queue. Same triage." sounds like marketing-speak repetition. I already got the queue idea in Act 0.
4. **Never explained:** does Kookr have GitHub permissions? Does it need a PAT? Does my agent's PR count against my LinkedIn-job-relevant repo?

### Act 5 (1:50–2:10) — Completion + cost
1. **First second:** a digest panel — files, tests, dollars. Clean.
2. **Confusing:** "$0.42 (input 28k, output 6.1k)" — k tokens, I assume, but 360px doesn't let me read it. Lifetime "$1.47 → $1.89" implies the whole demo session cost two bucks; nice anchor, but only if I can read it.
3. **Bail point:** I'd watch this one through. Cost is the most credible beat.
4. **Never explained:** is the cost coming from MY API key or from Kookr? If Kookr aggregates it, how — does it read provider invoices, or estimate from token counts?

### Act 6 (2:10–2:30) — CTA
1. **First second:** closing card, three pills, URL.
2. **Confusing:** "Local-first" — I take this to mean "runs on my machine," good, but the same card mentions a fork URL hosted on GitHub, which softens the local-first claim.
3. **Bail point:** I'd already have decided by now.
4. **Never explained:** how do I install it? `npm i`? Docker? Brew? The URL is a destination, not a verb.

---

## Killer questions

1. How does Kookr detect that an agent is "stuck" or "needs you"? Polling? Hooks? Log tailing? Without an answer, I can't tell if it works with my setup.
2. Why does Codex CLI require a personal fork (`jeanibarz/codex`)? Is upstream Codex incompatible forever, or is this temporary while a PR lands? The fork hint reads as "DIY at your own risk."
3. Is Kookr running my agents, or watching agents I already run? Does it spawn the CLI processes, or attach to existing ones?
4. What's the difference between Claude Code and Codex CLI in practice? The video assumes I run both — I run one. Why would I care about a unified queue?
5. Does the "AI suggests a reply" feature call a third LLM? Whose API key? At what additional cost?
6. What's a "finding"? Why not just call it an alert, prompt, or notification?
7. "Snooze" — does it dismiss the issue, defer the agent, or just hide the row? If the agent is genuinely blocked, snoozing the UI doesn't unblock it.
8. Is this for me if I only run ONE agent at a time? Every beat assumes parallelism. Solo-agent users will conclude this product isn't for them — but the GitHub/CI/cost features arguably are.

---

## LinkedIn post critique

**Hook:** "Running five AI coding agents in parallel sounded productive. / In practice, I spent more time switching between terminals than reviewing code."

- **Does it stop the thumb?** Half-yes. The number "five" is concrete and "spent more time switching" is a real pain. But I'm a one-agent dev — the first line risks excluding me before line two reels me back. Consider starting with the pain ("I lost two hours yesterday context-switching between AI coding agents") rather than the brag.
- **Skimmable in 4 seconds?** No. The body is seven paragraphs with three bullet groups. Skim-eye lands on bullets but the bullets are dense ("Detects permission prompts, repeated errors, merge conflicts, and idle agents — surfaces them as ranked findings, not toast spam"). "Findings" undefined; "toast spam" assumes UX vocabulary.
- **Marketing-copy smell:** "the parallelism doesn't quietly bankrupt you" is the only line with personality — keep it. "Both runtimes," "first-class," "load-bearing" all read like a product page. The PermissionRequest/Notification/SubagentStart/Stop list is API-doc bait dropped in the middle of a feed post — most readers eyes-glaze.
- **Hashtags:** `#AIcoding #DeveloperTools #ClaudeCode #OpenSource #DevProductivity` — #ClaudeCode is fine; #AIcoding is a stale 2024 tag, replace with #AIAgents or #LLMOps. No #CodexCLI? You're trying to reach Codex users.

---

## Top 5 changes I'd make

1. **Problem:** "finding" is undefined and used everywhere. **Fix:** rename to "alert" or "needs-input" in captions and post; reserve "finding" for product internals.
2. **Problem:** Act 1's Codex fork caption reads like a security warning to a first-time viewer. **Fix:** drop the slug from on-screen text; just say "Works with Codex CLI" in Act 1 and put the fork URL in Act 6 / description only.
3. **Problem:** the post and video both assume the viewer already runs 3+ parallel agents, which excludes the much larger "considering parallel agents" audience. **Fix:** add one caption beat ("Even with one agent, Kookr catches CI fails and stuck prompts") OR rewrite the LinkedIn hook to lead with the GitHub/cost angle.
4. **Problem:** Act 0 caption "One needs you. Which one?" is a riddle without a payoff visible at 360px. **Fix:** make the answering arrow/spotlight on the pulsing row land within the first 2 seconds, so the muted viewer sees the question AND the visual answer simultaneously.
5. **Problem:** no install verb appears anywhere — repo URL is a destination, not an action. **Fix:** add a one-line install hint to the closing card ("`npx kookr` or `brew install kookr`") and to the LinkedIn body just above the repo link.
