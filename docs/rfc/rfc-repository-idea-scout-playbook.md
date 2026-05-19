# RFC: Repository Idea Scout Playbook

## Status

**Draft**

## Problem

Kookr has playbooks for OSS contribution, issue triage, architecture audits, and RFC drafting, but it does not have a generic workflow for finding a new product or repository improvement idea. The missing workflow is useful when the user wants an agent to understand an unfamiliar project, review the existing issue backlog, study the current feature set, and propose one non-duplicate improvement worth pursuing.

The workflow needs to be safe for Kookr's Ralph loop mode. A looped launch starts fresh agent runtimes, so the playbook cannot rely on conversation memory. It needs durable state, bounded iterations, idempotent reads and writes, and an observable completion path.

Issue search on `kookr-ai/kookr` on 2026-05-03 found related closed issues for loopable playbooks and Ralph loop support, but no issue for a generic repository idea scout playbook. The nearest related issues are #533, #475, #440, and #11.

## Requirements

- The playbook must be generic enough to run against any GitHub `owner/repo` project.
- It must inspect open issues and relevant closed issues before recommending an idea.
- It must study the project purpose and current features from local code and documentation.
- It must generate multiple candidate ideas, reject duplicates, and return one recommended idea.
- It must produce durable, inspectable state outside transient model context.
- It must be safe for Ralph looped launch with a hard iteration cap and self-cancellation when complete.
- It must not create GitHub issues, comments, branches, PRs, or tracked-file changes in the target repository by default.

## Design

Add `.kookr/playbooks/repository-idea-scout.md`.

The playbook accepts:

- `repoFullName`: optional GitHub repository override in `owner/repo` format. When omitted, Kookr resolves it from the launch CWD's git remote; project-drawer launches can still prefill the selected tracked project. A select-only tracked-projects source was rejected because the workflow must work for arbitrary GitHub repositories, not only projects already tracked by Kookr.
- `localPath`: optional path to an existing local checkout. If omitted, the agent derives common paths and clones read-only only when needed.
- `ideaFocus`: optional focus area selector, defaulting to `any`.
- `minimumIssueScan`: optional issue scan count, defaulting to `100`.
- `extraInstruction`: optional prose-only run hint.

The prompt writes durable state to:

`~/.kookr/playbook-state/repository-idea-scout/<repoSlug>/<runKey>/`

`runKey` is `KOOKR_TASK_ID` when available, otherwise a manual timestamp. That directory contains a run manifest, issue snapshots, feature notes, candidate scoring, duplicate-search matrices, critic notes, and the final recommendation report. State lives outside the target repo so the task does not dirty a checkout while it is only analyzing and proposing.

The Ralph contract is:

1. Every iteration reads the durable state directory first.
2. Every iteration advances exactly one missing phase when launched in loop mode.
3. Completion means the final report contains one recommended idea with duplicate-search evidence, code/documentation evidence, expected value, an implementation sketch, and risks.
4. Terminal states are explicit: `<promise>DONE</promise>` for a complete recommendation and `<promise>BLOCKED</promise>` for unrecoverable setup or evidence-gathering failures.
5. On a terminal state, the prompt retries active Ralph loop cancellation through Kookr's API when `KOOKR_API_BASE_URL` and `KOOKR_TASK_ID` are available.

The playbook defaults the local checkout to `~/git/<repoSlug>` rather than `~/git/<repoName>` to avoid owner collisions, and it verifies that an existing checkout's `origin` or `upstream` remote exactly matches the requested repository before analysis. Shell examples treat launch parameters as prose until validated; snippets use sanitized shell variables rather than raw `{{param}}` interpolation.

The playbook asks the agent to use subagents when available for three independent passes:

- product opportunity
- duplicate issue search
- implementation skepticism

If subagents are unavailable, the agent performs the same reviews as separate written passes. The prompt does not depend on a Kookr-specific subagent implementation, so it remains portable across agents.

## Files to change

- Add `.kookr/playbooks/repository-idea-scout.md`.
- Add a focused parser test in `src/core/playbook-parser.test.ts` for the new checked-in playbook.

## Edge cases

- `gh` is unavailable or unauthenticated: stop with a clear setup error before making claims about issue novelty.
- The repo is not cloned locally: derive a collision-safe local path and clone only when needed for read-only analysis.
- An existing local path points at a different GitHub repository: mark the run blocked instead of analyzing the wrong codebase.
- A previous run exists for the same repository: task-scoped state prevents stale `DONE` markers from satisfying a new run.
- The repo has more issues than the scan cap: scan the newest open issues first, then run targeted `--state all --search` queries for candidate keywords.
- Existing issue titles are vague: inspect issue bodies and comments for near-duplicate ideas, not only title matches.
- The project has sparse documentation: infer features from package metadata, route/module names, tests, examples, and recent releases.
- The loop reaches its iteration cap before convergence: report partial state and the missing phase rather than fabricating a final idea.

## Alternatives considered

### Extend the existing issue triage playbook

Rejected. Issue triage updates or closes existing issues. This workflow is about generating a new non-duplicate idea and should avoid backlog mutation by default.

### Extend the OSS contribution pipeline

Rejected. The contribution pipeline is optimized for finding an implementable upstream issue and creating a PR. This workflow may propose product, documentation, architecture, or developer-experience ideas without immediately implementing them.

### Write reports inside the target repository

Rejected. The task is intended to be read-only by default. Writing under `~/.kookr/playbook-state/` keeps analysis durable without dirtying unrelated checkouts.

## Critic Feedback Incorporated

- Loop-safety review: state is now task-scoped with a run manifest, terminal `DONE` and `BLOCKED` markers are handled at iteration start, and terminal failures cancel the loop instead of churning to the cap.
- Duplicate-search review: the playbook now requires a candidate-specific query matrix, adjacent issue/PR comment fetches, and a final duplicate evidence table.
- Correctness review: raw playbook parameters were removed from runnable shell snippets; the prompt now validates parameter values as prose first, then uses sanitized variables, exact remote matching, and data-bound `QUERY` values for GitHub searches.
- Design-minimalist review: the generic repo requirement is handled by keeping `repoFullName` as an optional free-text override with git-remote inference, while checkout safety is handled in the prompt through collision-safe paths and remote verification.

## Update: Diverse multi-idea production (2026-05-03)

The original design produced a single recommended idea per run and self-terminated after iteration 1. In practice every run finished after one or two iterations, leaving most of the iteration budget unused and producing only one idea per task. The new design produces multiple diverse ideas per run.

### What changed

- New parameter `targetIdeaCount` (1-15, default 10). The run produces this many ideas, one per iteration after bootstrap. The upper bound of 15 is paired with the new iteration cap so the cap math always works out.
- `loop.iterationCap` raised from `6` to `20` (the parser's existing global maximum) and `loop.costCapUsd` raised from `5` to `20` so that even `targetIdeaCount=15` plus the three bootstrap iterations fit within the cap with retry slack (15 + 3 + 2 = 20). The user explicitly requested generous caps so the loop doesn't terminate mid-run on a budget rather than on a real signal. Going higher would require bumping `PLAYBOOK_LOOP_LIMITS.maxIterationCap` for every playbook, which we didn't take on in this change.
- `ideaFocus` dropdown extended with `observability`, `operability`, `ux`, `security`, and `testing`. The full canonical dimension list now drives category rotation.
- The Ralph contract changed from "one phase per iteration, then DONE after Phase 5" to "Phases 1-3 run once each, then Phase 4 (idea production) repeats once per iteration until `<ideasLogFile>` length reaches `targetIdeaCount`".
- New durable state: `<stateDir>/ideas-log.json` is the rotation log (array of accepted-idea entries with `idx`, `slug`, `category`, `angle`, `title`, `iteration`, `reportPath`, `issueUrl`). Per-idea artifacts go under `<stateDir>/recommendations/<NN>-<slug>/`.
- `createIssue=true` now files one GitHub issue per accepted idea, not a single summary issue. Each idea's directory holds its own `issue-created.json` for idempotency.
- `extraInstruction`, when non-empty, is treated as a hard scope filter for every idea. Diversity is then achieved by varying the angle within that scope rather than by rotating dimensions across orthogonal scopes.

### Diversity rules

- When `ideaFocus = any`, iterations walk the canonical dimension list and pick the first dimension not in `usedCategories`. After all dimensions are covered, the agent picks the least-covered dimension and varies the angle.
- When `ideaFocus` is a specific dimension, iterations stay in that dimension and vary the angle. Two consecutive iterations that cannot find a novel angle transition to `BLOCKED` rather than churning to the iteration cap.
- The angle log in `<ideasLogFile>` is the source of truth for what has already been covered. Per-idea dup checks compare against upstream issues AND against the current run's prior entries.

### Why this shape

- One idea per iteration keeps the existing Ralph "one unit of work per iteration" discipline, which matched the original loop design.
- Caching the bootstrap (issue inventory, feature inventory) once and reusing it across idea iterations keeps cost roughly proportional to `targetIdeaCount` rather than re-fetching per idea.
- A separate per-idea report file (rather than one growing `recommendation.md`) keeps each idea's evidence reviewable on its own and makes one-issue-per-idea filing straightforward.

## Update: Knowledge-base-grounded ideation (2026-05-19)

### Problem

The playbook grounded every idea in three sources: the issue backlog, the local codebase and docs, and the model's own knowledge. The first two are rigorously evidenced — duplicate matrices, file-path citations, positive and negative capability checks. The third is unevidenced, bound by the model's training cutoff, and the most hallucination-prone input. It is what produces the generic "add caching" or "improve tests" ideas the Anti-Patterns section already fights.

Kookr ships a local knowledge base reachable through the `kb` CLI, with shelves covering software engineering, autonomous agents, fault tolerance, backend systems, observability, testing, security, and recorded process wisdom (`_wisdom`, `agent-task-lessons`). That corpus is the state-of-the-art substrate the idea-generation step was missing.

### What changed

- New `useKnowledgeBase` parameter (`auto` or `off`, default `auto`). `auto` grounds ideas in the KB when the `kb` CLI is installed and a relevant shelf exists; `off` reproduces the previous issue-backlog-and-codebase behavior exactly.
- New `dependencies: [kb]` frontmatter so the launch surfaces an advisory note when the `kb` CLI is unhealthy. The dependency is advisory, not blocking — a degraded or missing KB does not stop the launch.
- New **Phase 3.5: Domain Knowledge Survey**. After the feature inventory, the agent routes the project to candidate shelves with `kb where`, runs one broad multi-query survey — via a single `kb-scout` subagent when available, otherwise inline `kb search` — and writes `<stateDir>/kb-seeds.json`, a passage set bucketed by diversity dimension.
- KB retrieval enters at three points: **seed** (Phase 3.5, broad, once per run), **refine** (Phase 4.3, one scoped `kb search` per candidate to sharpen its implementation and risk sections), and **critique** (Phase 4.4, the product and implementation reviewers cite the `_wisdom` and `agent-task-lessons` shelves).
- New per-idea artifact `kb-evidence.md`, a new `## Knowledge base grounding` section in every per-idea report, a `## Knowledge base grounding summary` section in the consolidated document, and `groundedIn` / `kbStale` fields on every `ideas-log.json` entry.

### Design rationale

- **Best-effort, never blocking.** KB grounding follows the same optionality pattern the playbook already uses for critic subagents: when the capability is absent the agent does the rest of the work unchanged. The `kb` CLI and the `kb-scout` subagent are Kookr-local, so the prompt body stays portable across agents — only the optional KB phase depends on them.
- **Relevance gate.** The playbook is generic and runs against any GitHub repository, while the KB is skewed toward LLM, agent, and backend topics. A `kb where` miss, an empty KB, or an absent CLI all route to a `status: skipped` seeds file and the run proceeds without KB grounding. An off-domain scout run landing there is expected, not a failure, and does not reduce `targetIdeaCount`.
- **Diversity stays authoritative.** A narrow KB could collapse the dimension rotation if it were allowed to originate ideas. The rotation remains the source of truth for an idea's dimension; KB seeds, bucketed by dimension, only inform the angle. An idea with `groundedIn: []` is still valid.
- **Provenance.** Every KB-derived claim must cite a real `<kb>/<path>` passage observed in `kb` output, mirroring the evidence discipline the duplicate-search matrix already enforces. The codebase capability check is never skipped because a KB passage exists.
- **Mechanism choice.** The seeding survey is the canonical multi-query case for the `kb-scout` subagent — cheap Haiku tokens, ranked source-tagged passages. Per-candidate refinement is a single direct `kb search`: `kb-scout`'s own guidance is not to invoke it once a substantive search pass is already done, and spawning one subagent per idea would multiply cost across up to 15 ideas for no gain.
- **Staleness.** A playbook that claims state-of-the-art techniques off a stale index is a correctness hazard, so `kb` stale-index warnings are copied verbatim into `kb-seeds.json`, the per-idea `kb-evidence.md`, the `kbStale` log field, and the consolidated document.

### Alternatives considered

- **Use `kb ask` instead of `kb search`.** Rejected. `kb ask` synthesizes an answer through a local LLM; idea generation wants raw passages the agent reasons over itself, and `ask` adds an LLM-endpoint dependency.
- **Make KB grounding mandatory.** Rejected. The playbook must run against arbitrary repositories far from the KB's domains; a hard dependency would break the generic-repo requirement from the original design.
- **Write scouted ideas back into a KB shelf with `kb remember`.** Rejected for this change. The playbook is read-only by default and `kb-scout` is forbidden write paths; closing that loop is a deliberate non-goal.
