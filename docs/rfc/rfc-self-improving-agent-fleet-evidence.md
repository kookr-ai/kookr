# Evidence Pack — Self-Improving Agent Fleet with Bounded Memory

> Shared evidence for the brainstorm swarm and the critic panel. **Everything here is "evidence to check," not settled fact.** Re-read the cited source before relying on any load-bearing claim. Assembled 2026-10-22 from four parallel research agents (two internal, two external).

## The question being designed

Design how Kookr should let a **main orchestrator agent launch specialized sub-agents** — each with its **own bounded, auto-purgeable, self-improving memory** — that **intervene across multiple git repositories** and **capitalize their experience**, under a **brief → artifact → structured-feedback contract** that **minimizes orchestrator↔worker back-and-forth**.

**Hard constraints (given to every agent):**
1. **Reuse first.** Prefer existing Kookr machinery and proven external primitives over bespoke infrastructure.
2. **Memory must stay small and auto-purging.** This is the primary requirement. Unbounded memory growth degrades speed, cost, and reasoning quality (noise, stale/contradictory entries, "context rot"). A design that only *adds* memory fails.
3. **Role division need not mirror humans.** Specialization can be by capability/lens, not job title.

---

## PART A — Kookr current state (what to reuse / the gaps)

### A1. Kookr has TWO distinct "agent" layers (conflating them is the #1 risk)

- **Layer A — task-level agents (processes).** A Kookr *task* launches a coding-agent CLI process (`claude-code`, `codex-cli`, `grok-build`, `round-robin`) inside a managed **dtach/tmux terminal session**, in a specific repo `cwd`, in its own **git worktree**. Long-lived, cross-repo. Launched via `POST /api/tasks` → `src/server/launch-service.ts` (`launchTask`) / `bin/kookr-spawn.js`. **This is the real "sub-agent with persistent memory across repos."**
- **Layer B — Claude Code sub-agents (in-process).** `plugin/agents/*.md` review specialists invoked via the `Agent` tool + `subagent_type` inside one process. Fresh context window, return a text summary, no persistence. This is the "swarm/critic panel" roster.

The user's "orchestrator launches sub-agents with their own persistent memory across repos" = **Layer A**. "Specialized sub-agents each with a lens" = **Layer B**. An RFC proposing one "sub-agent" abstraction must reconcile both.

### A2. The "dark factory" (lights-out loop) is real and composed of reusable pieces

- **Launch substrate:** `POST /api/tasks` → `launch-service.ts`; CLI `bin/kookr-spawn.js` (idempotency keys, ambiguous-POST reconcile, 429 backpressure). Contract: `docs/reference/spawn-contract.md`.
- **Scheduler (cron):** `src/server/schedule-runner.ts` + `src/core/cron.ts`; CLI `bin/kookr-schedule.js`.
- **Capacity queue-feeder:** `src/cli/kookr-queue-feeder.ts` + `src/core/umbrella-decomposer.ts` — auto-decomposes umbrellas into leaf issues when idle capacity appears.
- **Self-advancing chains:** `src/server/self-advancing-authority.ts` (merge-safety predicates; `KOOKR_SELF_ADVANCING_DISABLED` kill switch; `DEFAULT_SELF_MERGE_RATE_CAP_PER_HOUR = 4`); `src/server/use-cases/umbrella-chain-advancer.ts`.
- **Sequential continuation ("Ralph"):** `plugin/skills/self-continuation-task` + `bin/kookr-ralph.js` + `RalphLoopService` — task N records durable state, spawns N+1 with the same contract (no reliance on conversation memory).
- **Bounded autonomous implement/review:** `plugin/skills/autonomous-review-loop` — default **10** correction/review iterations/unit, durable ledger, exact-head merge, periodic reflection every 5 units.
- **Operator controls:** `src/cli/kookr-orchestration.ts` (`pause|resume|status`), `src/core/automation-kill-switch.ts`.
- **Supervisor/observability (how results come back today):** no return value — `src/core/anomaly-detector.ts` + `HookFileWatcher` read each agent's hook JSONL + transcript, scrape `gh pr create` URLs, route PR/CI state back (ADR-012). Terminal state reconciled by sweeps (`delivered-task-completion-sweep.ts`, `completion-ready-sweep.ts`) and TTLs.

### A3. Orchestrator↔worker tooling today, and where back-and-forth comes from

- **`implementer` agent** (built-in): "main agent writes a crisp brief (goal, acceptance criteria, file paths, test command), this agent implements and tests, main agent verifies the diff." Closest thing to a brief→artifact contract — but brief is prose, return is the diff.
- **Child-task spawn:** `.claude/skills/kookr-spawn-child-task` — fields `prompt`, `cwd`, optional `criteria`, `parentTaskId`; injects `KOOKR_TASK_ID`, `KOOKR_PARENT_TASK_ID`, `KOOKR_API_BASE_URL`. Hard rule: **"the child does ONE thing"**; iteration/judgement stays in the parent.
- **The one machine-readable return that works:** the independent-review verdict triple (`src/core/independent-review.ts`): `kookr-review-verdict: pass|block`, `review-lane: codex|claude`, `review-head-sha: <sha>`, parsed by `scripts/kookr-merge.sh`. A template for typed work-product returns.
- **Gaps causing back-and-forth:** (i) no typed brief / typed result for Layer A — only free-text `prompt` in, PR + verdict-triple out; (ii) no parent↔child request/response channel — the parent polls `GET /api/tasks` or re-reads the diff; outcome is *inferred* from hooks (hence sweeps/TTLs); (iii) Layer A and B are unreconciled; (iv) per-agent memory is convention, not a facility; (v) critic output is unstructured prose with ad-hoc tables.

### A4. Plugin surfaces (cheap to extend)

- Manifest `plugin/.claude-plugin/plugin.json` (`kookr-toolkit`). Layout `plugin/{agents,skills,hooks,playbooks,reviewer-specialists}/`.
- **Agent** = flat Markdown + YAML frontmatter (`name`, `description`, `model`), body + output schema. Add one → invoke `Agent({subagent_type: "kookr-toolkit:<name>"})` (the `kookr-toolkit:` prefix is required).
- **Skill** = `SKILL.md` + frontmatter. **Hooks** = `plugin/hooks/hooks.json` event→matcher→command.
- Adding a new *task-level backend* is heavy (adapter in `src/adapters/` + `AdapterRegistry`).

### A5. Cross-repo is already first-class (Layer A)

- Playbook param `source: tracked-projects` → project ID `github.com/owner/repo`; `cwd` / `defaultFrom: git-remote` set the directory.
- **Per-repo autonomy policy:** `src/core/repo-policy-resolver.ts` — `known_policy` vs `unknown_policy`, **fail-closed**; `independent-merge-review` is a **hard merge gate on kookr-ai/kookr, advisory elsewhere**.
- **Worktree isolation:** `src/server/worktree-guardrails.ts` blocks main-checkout edits; `src/adapters/git-worktree.ts`, `git-worktree-registry.ts`; reclaim sweeps.
- **OSS tooling:** `kookr-oss-issue-scout` agent, `oss-fork-manager`, `oss-pr-*`, `oss-contribution-pipeline.md`. Per-repo learning state at `~/.kookr/oss-attempts.json`, `~/.claude/<slug>-recon/`.

### A6. Memory / learning / reflection surfaces (the core area)

- **KB is EXTERNAL** to the repo: `kb` CLI = `@jeanibarz/knowledge-base-mcp-server`; `kb-scout` = `kb-scout-evol` (bounded DeepSeek ReAct, `max_steps=5`). Shelves at `~/knowledge_bases/<shelf>/*.md` (markdown + optional YAML frontmatter `tags/status/type/confidence/last_verified_at/contradicted_by`). Retrieval: **FAISS (dense) + BM25 (lexical) fused with RRF**. Commands: `kb search`, `kb ask`, `kb remember --kb=<shelf> …`, `kb remember --suggest|--append`, `kb superseded`, `kb feedback`, `kb reindex`.
- **Kookr integration (in-repo):** `bin/kb` → `bin/kb-spool-shim.js` (write-behind spool when KB degraded); `src/core/kb-lesson-classifier.ts`; **read-time relevance gate** `src/core/kb-context-injection.ts` + `hooks/kb-context-inject.sh` (RFC 018 — injects only gate-approved context, `task_context` capped at 2000 chars). **This is the one read-side bounding mechanism today.**
- **Reflection workflows:** `self-reflect` (writes ONE skill/CLAUDE.md/hook; memory banned for rules); `task-feedback-reflect` (thumbs up/down → one edit; **2 human gates**; frontmatter gate blocks `type: feedback`); `task-snapshot-reflect`; `capitalize-wisdom.md` (new `kb remember` notes); `session-self-reflect.md` (report only); `agent-efficiency-retrofit`; **`codex-pr-distill` / `oss-pr-distill`** (accumulate `learnings-raw.md` → distill to patterns → **reset raw to a 6-line header** [anti-growth Rule 4], preserve prior distilled [Rule 2]); `reviewer-distillation-*` (mutates a reviewer skill; `closed_axes` negative memory).
  - **`codex-pr-distill`'s accumulate→distill→reset-raw is the single best in-repo model of *bounded* self-improving memory.**
- **Placement decision:** `plugin/skills/placement-picker/SKILL.md` + CLAUDE.md "Persistence Mechanism Picker" — 12 surfaces; **memory BANNED for behavioral rules** (Codex CLI can't read Claude memory); fix ranking **Hook > Skill > CLAUDE.md > new skill > memory (weakest)**; domain knowledge → `kb remember`.

### A7. Bounding / pruning TODAY — the critical gap

- **On KB/memory notes: essentially no actuator.**
  - **Memory frontmatter gate** (`plugin/hooks/parse-frontmatter.ts`): gates *type/whether* (`type: feedback` banned; `CLAUDE_CODE_DISABLE_AUTO_MEMORY` redirects to `kb remember`) — **never volume or age.**
  - **`kb superseded`** scans frontmatter for staleness/contradiction and proposes — **read-only, no delete/demote/TTL.** Most `agent-task-lessons` notes have **no frontmatter**, so it's blind on them.
  - **Post-task lesson gate** (issue #1538): `kookr signal completion-ready` → **409** unless a `kb remember` or explicit `No generic KB lesson: <reason>` marker is in the hook trail. **This forces writes up; nothing bounds down.**
  - **Scale:** `agent-task-lessons` = **1319 notes**, `_wisdom` = **342**, monotonically growing.
- **Bounded-purge patterns that DO exist — on task records/buffers, directly reusable as templates:**
  - **`src/server/use-cases/prune-aged-task-records.ts`** (THE gold template, this branch's #2765): age **TTL** (`DEFAULT_TASK_RECORD_MAX_AGE_DAYS = 1`), **predelete snapshot (abort on failure)**, **archive-before-delete** (`archive_failed` aborts the prune), **tree-integrity** (never prune a parent with a live child), **audit row per sweep**. Scheduled via `maintenance-prune-schedule.ts`.
  - **Ring-buffer caps:** `KOOKR_RING_FLEET_BUDGET_BYTES` (32 MiB, LRU-shrink), `KOOKR_RELAY_METADATA_AUDIT_CAP` (5000-row ring, **oldest dropped so it "cannot grow without bound"**, reports `retained/droppedCount/truncated`).
  - **`repository-pruning-scout.md`** (commit `5d8d8cb9`): preservation-first taxonomy **keep / prune-mechanical / condense-superseded / remove-orphaned / consolidate-duplicated**; **proposal-only** (`humanApprovalRequired`); mechanical content in a journal/ADR is **condensed, never removed** (the wrong-turn lesson survives); growth-budget ledger. **Targets repo files, not `~/knowledge_bases/`, and has no actuator.**

### A8. Failure evidence from inside Kookr (memory-becomes-noise)

- `docs/rfc/rfc-cost-comparison-coverage-and-perf.md:214`: "if the entries become noise, retire the autowrite." (Memory-as-noise named, with a retire mitigation.)
- `kb-scout-evol` `closed_axes` / "do not reopen" — one closed axis retired because "the judge **devalues injected `_wisdom` chunks**": empirical evidence that *more injected memory hurt quality.*
- `self-reflect` anti-patterns: "don't add redundant guardrails… CLAUDE.md line + skill + memory all saying the same thing."
- No dedicated ADR/RFC on *context rot in the KB* exists yet.

### A9. Gaps the RFC must close (memory)

No actuator for purge/TTL/decay on notes · no size cap / growth budget per shelf · write path lacks the frontmatter staleness detection needs · no dedup-on-write enforcement · no consolidation loop wired to `agent-task-lessons`/`_wisdom` · no retrieval-feedback→retirement loop · lifecycle gate pushes volume up with no symmetric down-step · Repository Pruning Scout not pointed at memory · **self-write paths built & gated, no self-*prune* path exists.**

---

## PART B — External multi-agent orchestration (what to reuse)

### B1. Anthropic's own guidance & production system

- **"Building effective agents"** (patterns vocabulary): prompt chaining · routing · parallelization (sectioning/voting) · **orchestrator-workers** (central LLM derives *non-predefined* subtasks, delegates, synthesizes) · **evaluator-optimizer** (generate→evaluate→feedback loop when criteria are clear). Guidance: start simple, add complexity only when it demonstrably helps; a carefully crafted agent-computer interface. <https://www.anthropic.com/engineering/building-effective-agents>
- **"How we built our multi-agent research system"** (the key reference):
  - Lead (Opus) + parallel subagents (Sonnet) beat single-agent Opus by **90.2%** on their research eval.
  - **The brief contract:** each subagent needs "an objective, an output format, guidance on tools and sources, and clear task boundaries." Vague briefs → duplicated work.
  - **Effort scaling in the prompt:** 1 agent/3–10 calls (simple) · 2–4 subagents (comparison) · 10+ (complex). Early failure: 50 subagents for a trivial query.
  - **Return by reference:** subagents write bulk output to a filesystem and pass lightweight references back; lead **saves its plan to Memory** (context >200K truncates).
  - **Token economics:** multi-agent ≈ **15× chat tokens**; token count alone explained **80% of variance**. "Multi-agent systems only make economic sense when task value is high enough to justify the extra cost."
  - **When multi-agent HURTS:** tasks needing shared context or with many inter-agent dependencies — "**most coding tasks** fall here." Subagents run synchronously (lead can't steer mid-run; one slow subagent blocks).
  - **Eval:** LLM judge, rubric, single 0.0–1.0 + pass/fail, evaluate end-state not path. <https://www.anthropic.com/engineering/multi-agent-research-system>

### B2. Claude Code / Agent SDK subagents (the mechanism to build on)

- Markdown + frontmatter in `.claude/agents/` (or programmatic `AgentDefinition`): `name`/`description` (routing), `prompt`, `tools`/`disallowedTools` (least privilege), `model`, `effort`, `memory`, `skills`, `mcpServers`, `isolation`, `maxTurns`.
- **Context isolation:** fresh window per subagent; sees only its system prompt + the task message the parent wrote + CLAUDE.md + git snapshot; **only the final summary returns.** A **fork** inherits full context.
- **Async by default** (`status: async_launched`); parent blocks when it needs the report; `SendMessage` resumes a subagent with full history.
- **Built-in caps (adopt as-is):** `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (3), `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (20), **`maxBudgetUsd`** (refuses new subagents / stops background ones at the cap → `error_max_budget_usd`), per-agent `maxTurns`. `isolation: "worktree"` gives a subagent its own worktree.
- **`Workflow` tool** for dozens-to-hundreds of agents (orchestration in a runtime script, outside conversation context).
- Output-scanning safety: the harness neutralizes instruction-shaped patterns in a subagent's final message. <https://code.claude.com/docs/en/agent-sdk/subagents> · <https://code.claude.com/docs/en/sub-agents>

### B3. Other frameworks (reference designs, not reusable code here)

- **OpenAI Agents SDK:** handoff (transfers the conversation) vs **`Agent.as_tool()`** (calls a specialist *without* transferring control — the closer analogue to "get an artifact back, caller stays in charge"). `input_type` = typed JSON params.
- **LangGraph:** graph of nodes over **shared, checkpointed state**; handoff = `Command(goto, update)`. Inspectable state vs Claude's isolated windows.
- **CrewAI:** roles/tasks/crews; `Process.hierarchical` = a manager LLM delegating typed tasks (closest external analogue to the target).
- **AutoGen/AG2:** GroupChat broadcast + shared transcript (opposite of isolation — strong for emergent collab, weak for token economy / "talking past each other").
- **MetaGPT:** role SOPs with **mandatory structured intermediate artifacts** to cut inter-LLM chatter — reusable idea for typed handoffs.
- **A2A protocol** (Linux Foundation): Agent Card + **Task** (submitted→working→input-required→completed) + **Artifact** + Message/Part over JSON-RPC/SSE. The standards-track vocabulary **if** workers become remote/cross-vendor. MCP = tools; A2A = agent-to-agent.
  <https://openai.github.io/openai-agents-python/handoffs/> · <https://docs.langchain.com/oss/python/multi-agent> · <https://docs.crewai.com/en/learn/hierarchical-process> · <https://arxiv.org/html/2308.00352v7> · <https://a2a-protocol.org/latest/topics/what-is-a2a/>

### B4. The recurring orchestrator↔worker contract (shows up everywhere)

1. **Structured brief in** (objective, output format, acceptance criteria, allowed tools, boundaries, repo scope) — the worker has no shared memory.
2. **Typed result out, by reference** (write artifact to a store; return a short pointer + status, not the full payload).
3. **Acceptance criteria / evaluator** — close the loop with a rubric-driven reviewer (evaluator-optimizer), not a chat.
4. **Context isolation per worker.**
5. **Cost/turn/depth caps** — the element most frameworks lack; Claude has it built in.
6. **Delegation driven by a description.**

### B5. Multi-agent failure modes

Token blowup (~15×) · duplicated/missing work from vague briefs · agents talking past each other · over-spawning · compounding errors in long runs · lost-in-the-middle >200K · emergent sensitivity to the lead prompt · **single-agent wins for shared-context / dependency-heavy / low-parallelism work (most coding).**

---

## PART C — Bounded, self-purging, self-improving memory (the primary requirement)

### C1. Memory-type taxonomy (CoALA)

**working** (current decision cycle) · **episodic** (past trajectories) · **semantic** (facts) · **procedural** (learned skills). Keep them separate; each bounds differently. <https://arxiv.org/abs/2309.02427>

### C2. Foundational mechanisms

- **Reflexion** (2303.11366): on failure, write a verbal self-reflection to an episodic buffer; condition next attempt on it. Bounding = **sliding window** (last 1–3). 91% pass@1 HumanEval.
- **Generative Agents** (2304.03442) — the scoring + decay reference: retrieval = **recency × importance × relevance**, each min-max normalized, equal weights. recency = exp decay **factor 0.995** on last-access; importance = LLM **1–10** at creation; relevance = embedding cosine. **Reflection** synthesizes higher-level insights when summed importance > **150**. Forgetting is *soft* (decay demotes) — the stream still grows on disk (the limitation to fix).

### C3. Long-term memory systems

- **MemGPT/Letta** (2310.08560): LLM-as-OS, context = RAM, external store = disk, function calls page in/out; **the context window itself is the hard cap** (external store unbounded = weakness).
- **Mem0** (2504.19413) — the canonical consolidation algorithm: extract candidate facts from **last m=10 msgs + running summary**; for each, retrieve top **s=10** similar, then LLM picks **ADD / UPDATE(merge, replace only if higher info) / DELETE(contradiction) / NOOP(duplicate)**. **Mem0g** marks contradictions **"invalid, not removed."** LOCOMO: ~**7K tokens** (Mem0) vs **26K** full-context; **p95 1.44s vs 17.1s** (~91% lower); but **full-context still scores ~6 J-points higher on accuracy** — bounded memory trades accuracy for speed/cost.
- **A-MEM** (2502.12110): Zettelkasten linked notes; a new note can **update linked notes' attributes** (memory evolution). No explicit cap (gap).
- **Zep / Graphiti** (2501.13956) — best-in-class contradiction handling: **bi-temporal** edges (`t_valid`/`t_invalid` event time; `t'_created`/`t'_expired` ingestion time); on contradiction, **set `t_invalid` — don't delete** (history preserved). Non-lossy **episode subgraph** backing store. LongMemEval +15–18% vs full-context, ~90% lower latency, avg context **115k → 1.6k tokens**. Caveat: single-session accuracy **regressed 9–18%**.
- **Cognee** `memify`: usage-driven pass that **removes stale nodes, reinforces frequent connections, adjusts edge weights.**
- **LangMem:** hot-path + background managers; consolidation merges/resolves contradictions; **hard cap ≤16 memories per write** (fact/preference/intention/rule/other).

### C4. Self-improvement loops (procedural memory the agent writes for itself)

- **Voyager** (2305.16291): growing **skill library** of executable code, indexed by docstring embedding; **added only after self-verification passes + behavior dedup** → sublinear growth. 
- **Anthropic Agent Skills:** procedural memory as `SKILL.md` on the filesystem with **progressive disclosure** (startup sees only name/description; full content loads on demand) — keeps the window small. <https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>
- **Anthropic "Effective context engineering":** context is a finite budget with diminishing returns; goal = "smallest set of high-signal tokens." **Compaction** (summarize, keep decisions/bugs + 5 most-recent files), **structured note-taking** (NOTES.md outside context), **just-in-time retrieval** (keep identifiers, load at runtime; sub-agents return **1–2K-token summaries**). <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>

### C5. "Context rot" — why bounding is non-negotiable

Chroma tested 18 models: performance **degrades non-uniformly as input grows, even on trivial tasks**; one distractor lowers accuracy, four compound; every family scored **higher on ~300-token focused prompts than ~113k full prompts**. "Whether information is in context matters less than how it is presented" → keep memory minimal and high-signal. <https://www.trychroma.com/research/context-rot>

### C6. The five bounding mechanisms (use several together)

| Mechanism | How | Proven by | Pitfall |
|---|---|---|---|
| Recency decay / TTL | exp decay (0.995) or Weibull; TTL-expire time-sensitive facts | Generative Agents | decaying the wrong time axis buries rare-critical facts |
| Importance-weighted eviction | score (LLM 1–10 or usage freq); evict/down-rank lowest | Generative Agents; Cognee | LLM importance is noisy, recency-biased |
| Dedup & merge | cosine ≈0.85 drop near-dup; LLM merges complementary | Mem0 UPDATE | **false-dedup** collapses distinct facts |
| Contradiction → temporal invalidate | mark `t_invalid`, don't delete; prefer newest | Zep; Mem0g | over-eager invalidation erases *refinements*; need temporal-overlap check |
| Consolidation / summarization | compress many episodic → few semantic; reflection; compaction | Generative Agents; Anthropic compaction | **loses crucial detail — the biggest risk**; keep raw episode, make reversible |
| Hard caps + review gates | max-N (LangMem ≤16); confidence/quality gate before permanence | LangMem; Voyager | too-tight cap thrashes; no gate → poisoned memory |

### C7. BOUNDED-MEMORY RECIPE (implementable)

1. **Three typed stores:** episodic (raw, non-lossy, cheap backing store — never injected wholesale) · semantic (bounded hot store, **hard cap ~50–200 facts/scope**) · procedural (`SKILL.md`, metadata-only load).
2. **Write by reflect-then-write, not log-everything:** reflect at **completion** and **on failure** (Reflexion) or when importance-sum > 150; extract from **last ~10 msgs + summary** (Mem0); **gate before persisting** (binary confidence + for skills: fingerprint-dedup + safety blacklist + self-verification).
3. **The write = Mem0 four-op reconciliation** (ADD/UPDATE/INVALIDATE/NOOP), not blind append; INVALIDATE keeps the row (Zep), prefer newest.
4. **Retrieve bounded, high-signal:** score recency×importance×relevance (0.995 decay, LLM 1–10, cosine); return a **~1–2K-token top-k** budget (k≈5–20), never the whole store; load skills just-in-time by metadata.
5. **Bounding strategy (periodic janitor + inline):** decay inline every retrieval; cap inline every write (evict lowest importance×recency×usage); dedup inline (cosine >0.85, LLM-confirm merge); contradiction-invalidate inline (temporal-overlap); **consolidation periodic** (every K tasks/nightly — summarize clusters, promote repeated lessons to a skill, prune low-fitness, **always keep raw episode so it's reversible**); **review gate** (provisional until it survives a confidence gate, optional human/agent review for shared memory).
   - **Defaults:** semantic cap 50–200; decay 0.995; importance 1–10; dedup cosine 0.85; retrieval 1–2K tokens / top-k 5–20; extraction m=10; similar-lookup s=10; reflect on completion+failure; consolidate every K tasks or nightly.

### C8. Pitfalls to avoid

Unbounded episodic growth masquerading as "memory" · consolidation losing detail (keep reversible raw) · false-dedup · over-eager contradiction deletion (invalidate, don't delete) · trusting noisy LLM importance (combine with usage) · no gate → poisoned/injected memory · accuracy regressions from aggressive retrieval (measure the tradeoff) · context rot from dumping memory into the prompt · decaying the wrong time axis · paying context cost for the whole skill library (use progressive disclosure).

> **`[KB]`-sourced 2026-dated arXiv IDs** (RecMem 2605.16045, 2604.12231, 2605.12741, 2604.14399, Weibull 2511.01448) were **not independently fetched** — do not treat as load-bearing without verifying the primary.
