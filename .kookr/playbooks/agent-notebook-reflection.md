---
name: Agent-Notebook Reflection & Improvement
description: Analyze how this harness uses agent-notebook, ground findings in the KB, produce a pedagogical HTML report, and file issues for the improvements — separating already-upstream behavior from genuine harness misconfiguration.
tags: [workflow, analysis, memory]
cwd: $HOME/git/kookr
parameters:
  - name: toolRepo
    description: "The agent-notebook source repo whose latest docs to compare the running harness against (owner/repo)."
    required: false
    default: "jeanibarz/agent-notebook"
    type: text
  - name: harnessRepo
    description: "Where harness-configuration issues are filed (owner/repo)."
    required: false
    default: "kookr-ai/kookr"
    type: text
  - name: statsWindow
    description: "Lookback window for nb stats (e.g. 30d, 14d)."
    required: false
    default: "30d"
    type: text
  - name: fileIssues
    description: "Actually file issues (yes), or stop at drafts for human review (no)."
    required: false
    default: "yes"
    type: select
    options:
      - label: "yes — file issues after de-duplicating"
        value: "yes"
      - label: "no — draft only, do not post"
        value: "no"
checklist:
  - Captured harness usage (nb stats + .nb-usage.log error breakdown) and ran the SHIPPED nb-janitor over NB_DIR
  - Read the latest toolRepo docs at origin/main and noted installed-vs-released version
  - Grounded findings in the KB (kb search / kb-scout) with source citations and an honesty caveat on stale notes
  - Classified every problem into one bucket — upstream-by-design / already-fixed / harness-misconfig / genuine-upstream-gap — with disk/doc evidence
  - Ran the promotion report (dry-run only, KOOKR_NB_CURATOR=1) and put its exact and candidate groups in the HTML report, without applying anything
  - Produced a self-contained pedagogical HTML report and reported its path (served over localhost, opened only if interactive)
  - Filed de-duplicated issues in the correct repo (or drafted them when fileIssues=no), reporting URLs
  - Ran the nb retrospective (vote by id, add at most one ≤200-char lesson) and emitted the completion lesson decision
---

## Objective

Reflect on how **this harness** actually uses `agent-notebook` (the `nb` CLI), compare the usage against the **latest** `{{toolRepo}}` docs, ground the analysis in expert knowledge from the local knowledge base, produce one pedagogical HTML report, and file the resulting improvements as issues — **in the right repository**. The central discipline is a clean distinction: *a problem is only a problem if the latest agent-notebook does not already solve it by design.* Many apparent issues are already implemented, documented, fixed in a newer release, or self-correcting at the tool level — those are **not** bugs, and filing them is noise.

## Context — tools you rely on

- `nb` — the agent-notebook CLI. `nb --version`, `nb path` (prints `NB_DIR`), `nb stats [--since <w>] [--json]`, `nb show <shelf>`, `nb list`.
- `NB_DIR` — the notebooks directory (`nb path`), which also holds `.nb-usage.log` (append-only TSV: `ts, shelf, op, status, dur, session, …` with richer 12-column rows carrying outcomes/ids).
- The **shipped janitor**: `examples/nb-janitor.mjs` in `{{toolRepo}}` — a read-only cross-notebook hygiene report (`node nb-janitor.mjs [--json] [--days N] [--sim 0.6]`). **Run this; do not re-implement its analysis by hand.**
- `kb` — knowledge-base CLI: `kb list`, `kb search "<query>"` (noisy stderr — filter `INFO|TYPELESS|Reparsing|warning`), `kb open kb://<path>`. The `kb-scout` subagent runs a multi-query survey on separate tokens.
- `gh` — for listing and filing issues. Confirm `gh auth status` first.

## Phases

### Phase 1 — Capture how the harness uses nb

1. `nb --version` and `nb path`; set `NB_DIR` to the latter.
2. `nb stats --since {{statsWindow}}` — read the `surfacing:` line (recall-miss / precision-miss / coverage / engagement), the `anomalies:` block (`[loop]`, `[high-error-rate]`), the per-shelf `[browse-without-use]` signals, and every command's call/err%/latency.
3. Parse `$NB_DIR/.nb-usage.log` for the **per-command error breakdown** (especially `add`, `vote`, `ls`/`list`) and note whether error rows are recent or stale (old rows are pre-fix and may describe already-solved bugs — check timestamps before treating an error rate as live).
4. Run the shipped janitor over `NB_DIR` (extract it from `{{toolRepo}}` origin/main if the working tree lacks it):
   `NB_DIR=<dir> node <path-to>/nb-janitor.mjs` — read all five sections (lessons-lost-to-eviction, near-duplicate shelf names, duplicate lessons, volume & silence, shelf co-access).

### Phase 2 — Read the latest tool docs

In a clone of `{{toolRepo}}` (e.g. `$HOME/git/agent-notebook`): `git fetch origin main`, compare the installed `nb` version to `origin/main`'s `package.json`, then read at `origin/main`: `README.md`, `AGENTS.md` (the operating contract — note the ≤200-char and vote-by-`<id>` rules and "a full shelf is the normal state"), `CHANGELOG.md` (recently fixed items), `docs/harness-setup.md` (the recommended wiring + "Diagnosing low engagement" runbook), `docs/eviction-and-aging.md` (the eviction/aging design), `docs/self-observing-notebook.md`, and any `docs/rfcs/*`.

### Phase 3 — Ground in expert knowledge

Run `kb search` over memory-design shelves (`llm-memory`, `agent-task-lessons`, `llm-agents`, `autonomous-agent`) for: agent-memory failure modes (unregulated growth, missing semantic revision, capacity-driven forgetting, read-only retrieval), forgetting/decay policy, delayed consolidation, and what makes stored lessons get re-used. Prefer the distilled `patterns/*.md` notes, and **honestly flag** any note marked `deprecated` / `stale` / low-confidence — use it for direction, not proof. For a broad survey, spawn the `kb-scout` subagent. Keep `kb://…` citations.

### Phase 4 — Classify every problem (the core analytical step)

Put each observed problem into exactly **one** bucket, each backed by on-disk / in-doc evidence:

- **A — upstream by design**: the latest docs show this is intended behavior (e.g. reject-not-truncate on >200 chars; positive-only votes offset by staleness decay; a full shelf being normal). → Not an issue.
- **B — already fixed in a newer release than installed**: the CHANGELOG fixes it above our version. → Upgrade, do not re-file.
- **C — harness misconfiguration**: the latest docs recommend a wiring this harness does not have (e.g. the injected contract omits vote-by-id or the ≤200-char rule; `NB_SESSION` unset). → Issue in `{{harnessRepo}}`. (The "janitor is not scheduled" gap this bucket used to cite is now wired for kookr — see `docs/reference/nb-janitor-schedule.md` and `.kookr/playbooks/nb-janitor.md`; do not re-file it.)
- **D — genuine upstream gap**: a real defect/missing feature in the latest agent-notebook, not already tracked in its open issues. → Issue in `{{toolRepo}}`.

### Phase 5 — Produce the report

Write a self-contained HTML report to the scratchpad (`$SCRATCHPAD/agent-notebook-reflection-report.html`). Make it **pedagogical**: for each finding give *metric → observation → what it means → recommendation → grounding citation*, and include an explicit honesty caveat for any stale KB source. Credit what already works (the surfacing metrics) before criticising. Serve it over loopback and, **only in an interactive session**, open it: `python3 -m http.server <port> --bind 127.0.0.1` then open `http://127.0.0.1:<port>/<file>` (the Claude-in-Chrome extension cannot open `file://` URLs). For a scheduled/non-interactive run, just save the file and report its absolute path.

### Phase 5b — Promotion report (report only, never `--apply`)

Memory is layered project > domain > global (`docs/reference/agent-notebook.md`, "Memory layers"). A lesson that several repos' project shelves share is evidence it belongs one layer up. This phase only **reports** what could move; moving anything is an operator action, and `fleet-global` is written only through this path.

1. Export `KOOKR_NB_CURATOR=1` for this playbook's own `nb` calls. It only silences the shim's advisory for an `nb add` to `fleet-global`; it has no effect on `nb move`/`nb rm` or on the dry-run below, which write nothing. The step still sets it so a curator run is never mistaken for an agent writing the global shelf.
2. Run the report: `node scripts/promote-notebook-lessons.mjs` (dry-run is the default; add `--threshold <0..1>` to widen or narrow what counts as a paraphrase). Never pass `--apply` from this playbook.
3. Put the result in the HTML report: how many **exact groups** (equal text in two or more repos; `--apply` would move the best copy to the domain shelf and remove the other copies) and how many **candidate groups** (paraphrases; report only, `--apply --only <id>` would move the best copy and remove nothing). State plainly when there are 0 exact groups (the first seed pass found none, so `fleet-global` fills only by a person choosing candidates). Show candidates side by side with their scores and ids so the operator can read both texts; a lesson and its negation can look alike.
4. Cross-check against the janitor's "duplicate lessons" and "near-duplicate shelf names" sections from Phase 1: a duplicate the janitor sees inside one repo is not a promotion.
5. Run `node scripts/migrate-notebook-slugs.mjs` (also a dry-run). If it lists legacy-slug shelves, say the migration is pending; do not run it with `--apply`.
6. Give the operator the exact commands to apply what they choose (`node scripts/promote-notebook-lessons.mjs --apply --only <group-ids>`, plus `--to-global <group-ids>` for any lesson that belongs on `fleet-global`).

### Phase 6 — File the issues (only if `{{fileIssues}}` = yes)

For each bucket-C and bucket-D finding:

1. **De-duplicate first**: `gh issue list --repo <repo> --state open --search "<keywords>"` — skip anything already open.
2. Write an evidence-grounded body that states the **distinction explicitly** ("agent-notebook already does X; the gap is that this harness does Y"), with the measured numbers and the doc/source references.
3. `gh issue create --repo <repo> --title "…" --label <fitting-label> --body-file <file>` (C → `{{harnessRepo}}`, D → `{{toolRepo}}`). Verify the label exists (`gh label list`) or omit it.
4. Report every created issue URL. For bucket-A/B findings, **file nothing** — record one line on why (by-design / fixed-in-vX.Y).

If `{{fileIssues}}` = no, stop after writing the drafts to the scratchpad and listing them.

### Phase 7 — Retrospective

Run the nb retrospective on the shelves you opened: **vote by the `<id>`** `nb show` prints (not fuzzy text — a non-unique query errors), `nb rm`/`merge` only with a `--reason`, and `nb add` **at most one** concrete `≤200-char` lesson to the fitting shelf (adding nothing is valid). Then emit the completion lesson decision the harness expects.

## Idempotency Rules

1. **Never double-file.** Phase 6 always runs `gh issue list --search` first and skips open duplicates; re-running the playbook updates understanding, not the issue count.
2. The HTML report is disposable and timestamped — overwrite freely; it is never committed.
3. The nb retrospective adds **at most one** lesson per run (the tool's own dedup also blocks near-duplicates), so repeated runs do not inflate a shelf.
4. Treat stale `.nb-usage.log` error rows (old timestamps) as historical — do not re-raise a bug the CHANGELOG already shows fixed.

## Anti-Patterns

- **Re-implementing the janitor by hand.** It ships with agent-notebook (`examples/nb-janitor.mjs`) and is read-only — run it; a hand-rolled analysis both wastes effort and invents alarms the real tool calls normal.
- **Alarming on by-design behavior.** A full shelf is normal; eviction is utility+staleness aware (not naive recency); votes are overwhelmingly positive by design; an over-200-char `add` is *meant* to be rejected, not truncated. Check `docs/eviction-and-aging.md` + `AGENTS.md` before calling any of these a bug.
- **Filing a harness problem upstream (or vice-versa).** Vote-by-id and ≤200-char are already in agent-notebook's contract and its CLI already emits corrective messages — if agents still trip on them, the fix is the *harness's* injected guidance (bucket C), not an agent-notebook issue.
- **Voting by fuzzy text.** Use the `<id>`; a non-unique snippet errors and, retried, trips the `[loop]` anomaly.
- **Opening `file://` in Claude-in-Chrome.** It is rejected — serve the report over `127.0.0.1` and open the `http://` URL.
- **Applying a promotion or the slug migration from this playbook.** The playbook reports; `--apply` on either script is an operator decision (they move and, for exact groups, remove lessons). The dry-runs are safe to run every time.
- **Calling a candidate group a duplicate.** Candidates are paraphrases found by word overlap; only an exact group is a duplicate, and even then the script removes the extra copies only after the move worked.
- **Manufacturing issues to look productive.** If the latest agent-notebook already solves everything you found, the honest outcome is "no upstream issues needed" — say so.
