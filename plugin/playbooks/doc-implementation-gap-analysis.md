---
name: Doc-Implementation Gap Analysis
description: Identify misalignments between system design docs and current implementation, present findings to user, then fix docs/code based on user direction
parameters:
  - name: srcRoot
    description: Source root directory to compare against docs
    required: false
    default: src
  - name: docsRoot
    description: Docs root directory containing design material
    required: false
    default: docs
  - name: prTitle
    description: Title for the PR that lands the resulting fixes
    required: false
    default: "fix: align docs and implementation"
checklist:
  - Read all design docs (README, agent-instruction docs, architecture, ADRs, roadmap, POCs)
  - Explored all implementation directories under the configured src root
  - Compared documented features vs implemented features
  - Checked architecture docs match actual module boundaries and data flow
  - Verified ADR decisions are reflected in code
  - Verified roadmap phase status matches reality
  - Wrote temporary working report to .tmp/gap-analysis-report.md
  - Presented synthetic report to user and waited for direction
  - Received user answer on which gaps to fix and how
  - Created worktree branch for fixes
  - Implemented doc and/or code changes per user direction
  - Removed temporary report file before committing
  - Verified no report artifacts in commit
  - Created PR with actual changes (not a report)
---

## Objective

Identify gaps between this project's system design documentation and the current codebase. Present a synthetic report to the user, wait for their direction on what to fix and how, then implement the actual changes and create a PR containing those fixes.

## Context

- **Source root**: `{{srcRoot}}`
- **Docs root**: `{{docsRoot}}`

Before starting, list which doc files actually exist under `{{docsRoot}}` and at the repo root. Common ones to scan when present: `README.md`, `CLAUDE.md`, `AGENTS.md`, `{{docsRoot}}/architecture.md`, `{{docsRoot}}/features.md`, `{{docsRoot}}/roadmap.md`, `{{docsRoot}}/adr/`, `{{docsRoot}}/poc/`, `{{docsRoot}}/system-models/`. Skip any that don't exist.

## Phase 1: Read all design docs

Read each document thoroughly that exists in this repo, noting key claims:

1. `README.md` — project overview, stated capabilities
2. `CLAUDE.md` / `AGENTS.md` — project instructions, decided technologies, repository structure
3. `{{docsRoot}}/features.md` — user-facing feature requirements (if present)
4. `{{docsRoot}}/architecture.md` — system design, module boundaries, data flow
5. `{{docsRoot}}/roadmap.md` — implementation phases with status markers (if present)
6. `{{docsRoot}}/adr/` — all architecture decision records (if present)
7. `{{docsRoot}}/poc/` or `{{docsRoot}}/spikes/` — proof-of-concept validation docs (if present)

For each doc, extract a list of concrete claims (features exist, modules exist, decisions applied, phases complete).

## Phase 2: Explore the implementation

Systematically walk the codebase under `{{srcRoot}}/`. Walk by top-level directory and note what each module actually exists for and does. Also read `package.json` (or the equivalent manifest for this project's language) for dependencies, scripts, and overall structure.

## Phase 3: Systematic comparison

For each design doc claim, check against reality:

- **Features gap**: Features documented but not implemented? Features implemented but not documented?
- **Architecture gaps**: Do module boundaries, data flow, and component relationships match the architecture doc?
- **ADR compliance**: Is each ADR decision reflected in the code? Any violated or outdated?
- **Roadmap accuracy**: Phases marked "complete" — are they really? Phases marked "in progress" — what's actually done?
- **Type/interface consistency**: Do type definitions match what docs describe?

Be specific — cite file paths and line numbers. Reference specific doc sections.

## Phase 4: Write temporary working report

Write the report to `.tmp/gap-analysis-report.md` (treat `.tmp` as a gitignored working directory; create it if missing). This is a thinking aid, not a deliverable.

```bash
mkdir -p .tmp
```

Write the report with these sections:

### Report structure

- **Executive Summary** — high-level findings (2-3 paragraphs)
- **Features Gap** — table of features documented but not implemented, and features implemented but not documented
- **Architecture Gaps** — structural mismatches between docs and code
- **ADR Compliance** — which ADRs are followed, which are violated or outdated
- **Roadmap Accuracy** — phase status vs actual implementation state
- **Recommendations** — for each gap, recommend: update docs OR update implementation, with brief rationale

## Phase 5: Present report and wait for user direction

**CRITICAL: Do NOT proceed to fixes without user input.**

Present a synthetic summary to the user covering:
- Number of gaps found, grouped by category
- Top 3-5 most impactful gaps with specific recommendations
- For each gap, clearly state: "update docs" or "update implementation" (or "either — user decides")

Then **ask the user**:
1. Which gaps should be fixed in this run?
2. For each gap, should we update the docs or the implementation?
3. Any gaps to skip or defer?

**Wait for the user's answer before proceeding.**

## Phase 6: Implement fixes per user direction

1. Create a worktree branch (e.g., `fix/doc-impl-alignment`)

2. For each gap the user approved:
   - If "update docs": modify the relevant doc files to match reality
   - If "update implementation": modify code to match what docs promise
   - Commit each logical change separately with clear messages

3. **Before committing, remove the temporary report:**
   ```bash
   rm -f .tmp/gap-analysis-report.md
   rmdir .tmp 2>/dev/null || true  # remove if empty
   ```

4. Verify no report artifacts are staged:
   ```bash
   git diff --cached --name-only | grep -i "gap-analysis" && echo "ERROR: report file in commit" && exit 1
   ```

## Phase 7: Create PR with actual changes

The PR contains the actual doc/code fixes — NOT a report.

```bash
gh pr create --title "{{prTitle}}" --body "$(cat <<'EOF'
## Summary

Fixes misalignments between design docs and current implementation based on gap analysis.

### Changes
- {bullet list of each fix: which file, what was changed, why}

### Gaps deferred
- {any gaps the user chose to skip, for future reference}
EOF
)"
```

## Idempotency Rules

1. **Check for existing temporary report.** If `.tmp/gap-analysis-report.md` exists, read it and update rather than starting from scratch.
2. **Check for existing PR.** Search for open PRs with a similar title before creating a new one.
3. **Don't duplicate work.** If a previous run partially completed, continue from where it left off.
4. **Date-stamp the temporary report.** Include the analysis date so staleness is visible.

## Anti-Patterns

- Don't skim docs — read them thoroughly; subtle claims are the ones most likely to be wrong
- Don't just check file existence — verify the documented behavior actually works as described
- Don't make value judgments about design quality — focus on doc-vs-reality alignment
- Don't commit the report — it's a temporary thinking artifact, not a deliverable
- Don't proceed to fixes without user direction — the user decides what to fix and how
- Don't bundle everything into one commit — separate logical changes for reviewability
- Don't fabricate references to docs that don't exist in this repo. Only inspect files that are actually present.
