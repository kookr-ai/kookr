# RFC: Notebook memory layers (project > domain > global) for every Kookr agent

**Status:** Draft (v5, after review round 1 and three independent merge reviews). Progress: K1 merged (#3595); upstream janitor signals merged (agent-notebook #362 via #364, #365); K2-K5 pending (K5 = #3598).
**Date:** 2026-11-10
**Author:** Jean Ibarz (with Claude)

---

## Summary

Kookr agents keep lessons in `agent-notebook` shelves. The operator decided
earlier that memory should be layered **project > domain > global** (the
"shared layered memory" section of
[rfc-opencode-worker-containers.md](rfc-opencode-worker-containers.md), still
unbuilt: slice S3 of #3541). Today that decision exists only as prose for
opencode container workers. Claude Code agents, which do nearly all the work,
get one flat index of every shelf and no instruction on where a new lesson
belongs, so the store drifts away from the decision with every task.

This RFC does three things:

1. Defines each layer in terms of **shelf names that already exist** in `nb`
   (no new storage, no new tool concept).
2. Makes the Claude Code session-start and end-of-task hooks layer-aware **and**
   the 23 agent definitions that have a notebook section and the spawn skill (which is where subagents,
   the bulk of memory use, actually get their shelf names), using only released
   `agent-notebook` 0.7.0, and fixes the places where the harness misuses the
   0.6/0.7 CLI.
3. Proposes the **smallest** set of upstream `agent-notebook` additions that the
   harness cannot do for itself, and says plainly which ideas were rejected.

The answer to "should agent-notebook gain features for layers?" is: not yet,
and not a layer engine. Two neutral janitor signals and one documentation page
help any harness. A scope filter inside `nb` was considered and **deferred**
(review round 1: Kookr owns the hook and the `nb` shim, so it can filter
without an upstream release, and `nb` has so far kept `@` opaque). Layer
metadata inside shelf files, precedence logic and a promote command are
rejected.

## Problem

### What "new release" means here

`agent-notebook` 0.7.0 is the latest npm release (2026-11-06) and Kookr already
pins it. So there are two separate gaps:

- **Released features Kookr does not use correctly** (0.6/0.7): evidence below.
- **Unreleased work on upstream `main`** (53 commits at last count: `nb doctor`, new-shelf
  notice #354, case-collision refusal #337, merge-marker refusal #352, per-shelf
  add-rate stats #353). Using it needs a 0.8.0 release. Publishing to npm is
  irreversible, so it is an operator decision, not part of this RFC's slices.

### Evidence (live store `~/.kookr/notebooks`, 2026-11-10, `nb stats --since 7d`, `nb-janitor`)

| # | Finding | Why it matters for layers |
|---|---|---|
| E1 | Layering is spec-only. `composeLayeredPack` does not exist on `origin/main`; opencode workers get per-profile shelf listings, Claude Code agents get the whole index. | The decision is not delivered to any worker. |
| E2 | 44 shelves: 24 project-scoped (`name@slug`, 9 distinct slugs), 20 bare. An agent working in `jeanibarz-agent-notebook` is shown all 44: 15 belong to other projects, 2 are its own, and 7 more carry the legacy short slug of this very repo (see E3). | Noise in every session, and lessons from other repos are one `nb show` away (no isolation). |
| E3 | The same repo has two slugs: 7 shelves use `@agent-notebook`, 2 use `@jeanibarz-agent-notebook` (the form `KOOKR_REPO_SLUG` produces). `nb-janitor` section 2 reports "no suspiciously similar shelf names" for both. | A project filter would hide the 7 legacy shelves from the very project they describe. |
| E4 | All 24 project shelves have no `# desc:` trigger; 7 of 20 bare shelves have none, including `fleet-global`. The janitor lists a dozen shown-but-never-voted shelves. | Index rows fall back to a lesson fragment, so agents choose shelves by guesswork. |
| E5 | Placement is ambiguous. `orchestrator@kookr-ai-kookr` and `orchestrator@jeanibarz-agent-notebook` both hold a **paraphrase** of the same merge-gate lesson ("Codex lane `model_not_found`, fall back to Claude reviewer", worded differently) and a host-wide git-worktree lesson; a scan of all 368 project lessons found **0 exact duplicates** across shelves of the same base, so cross-project overlap exists but is not exact; `fleet-global` holds 3 lessons. | Cross-project lessons sit in project shelves and are never promoted. |
| E6 | `code-review@X` and `orchestrator@X` are shown together in 5/5, 2/2 sessions (janitor co-access). | Project shelves are consumed as one bundle, so the project layer should be injected as a group. |
| E7 | `nb stats`: `add` 35% errors over 883 calls, 96% of the classified ones `too_long`; `vote` 16% errors; `move` 2/2 failed. Kookr's retro hook text says "≤200 chars" without upstream's "aim ~150" guidance, passes free text as `--reason` where `nb` expects a code (accepted as `other`, so `nb stats` cannot group the reasons), and teaches single-id votes though batch voting exists. | The write path itself is wasting calls, and it is where layer placement must be taught. |
| E8 | `bin/nb.js` copies its own `MUTATING` set (`add vote merge rm split describe`). `move` is missing, so a promotion is never auto-committed to the store's git history (0 `nb move` commits in the store log). Upstream fixed the same bug in its example wrapper (#253). | Promotion is the verb that moves lessons up a layer; it must be recoverable. |
| E9 | `nb-inject.mjs` swallows a failing `nb list` and injects nothing; upstream's example hook prints a warning. | A broken store looks like an empty one. |
| E10 | Hermes shadow runs: memory had no measurable effect because "the packs held almost no lessons relevant to the issue" (operator-published Hermes shadow-run findings; not in this repo). | Layer content must be relevant (project-first), not merely larger. |
| E11 | Of the 25 `plugin/agents/*.md`, 14 hardcode only a bare shelf (`nb show change-verifier`), 9 already name only a project shelf (`X@<owner>-<repo>`, no domain read), and 2 (`product-owner`, `user-test-simulator`) have no notebook section. None mention `KOOKR_REPO_SLUG` as a variable, and they teach quoted-id votes and a "≤120 chars" target. They say plainly that "a subagent gets no SessionStart index injection". The `notebook-role-reuse` skill offers project *or* domain, "pick one per spawn", never both. Two of the most-opened shelves, `change-verifier` and `test-quality-reviewer`, are opened by name from these files; the other two, `orchestrator@…` and `code-review@…`, are routed elsewhere (the orchestrator skill, `plugin/reviewer-specialists/*.md`, `plugin/skills/pre-pr-review/SKILL.md` and `src/core/reviewer-fanout.ts`, which still picks a single shelf), covered by slice K5. | The routing layer for subagents is the agent definitions, not the hook. A hook-only change would leave most memory use where it is. |

E7-E9 describe the state before slice K1; K1 (#3595) has since fixed E8, E9 and the retro-text parts of E7.

Source pointers: `plugin/hooks/nb-inject.mjs`, `plugin/hooks/nb-retro.mjs`,
`bin/nb.js` (`MUTATING`), `src/adapters/agent-launch-context.ts` (exports
`NB_SESSION` and `KOOKR_REPO_SLUG`), `src/adapters/opencode-shelf-memory.ts`
(`capShelfListing`), upstream `examples/hooks/claude-code/*.sh` at
`origin/main`.

## Layer definitions

A layer is **derived from the shelf name**; nothing is stored in the shelf file.

| Layer | Shelf name | Holds | Who may add |
|---|---|---|---|
| Project | `<situation>@<slug>`, slug = `KOOKR_REPO_SLUG` (`owner-repo`) | Facts true only in this repo: build/test quirks, CI, conventions, gate rules. | Any worker in that project (the default for new lessons). |
| Domain | bare `<situation>` (e.g. `code-review`, `change-verifier`) | Lessons about a kind of work that hold in any repo. | Any worker, when the lesson mentions no repo-specific path, tool or gate. |
| Global | `fleet-global` (single shelf, name owned by Kookr) | Facts about this host, `gh`/`git`/Kookr that hold for every agent everywhere. | Promotion only (curator). Workers do not write it directly. |

Rules:

- **Precedence on conflict:** project wins over domain, domain over global. This
  is an ordering plus an instruction to the model, not enforcement (same honest
  limit as the opencode RFC).
- **Narrowest layer first.** A worker unsure where a lesson belongs writes it to
  the project shelf. Evidence (a cross-project duplicate, or a high score) later
  promotes it. Over-promotion pollutes every session; under-promotion only
  costs one repo.
- **Project shelf base names** reuse a domain shelf name where one fits
  (`code-review@kookr-ai-kookr` refines `code-review`) so the pairing is
  visible. Co-access data (E6) is the reason the project layer is *injected* as
  a group, not the reason to merge shelves: consolidation stays deferred, as in
  the shelf-reorg RFC.
- **Slug is canonical:** exactly `KOOKR_REPO_SLUG`. Shelves under another slug
  for the same repo are legacy and are migrated (see slice K2).
- **Parsing rule (one place, tested):** split the shelf name on the **last** `@`;
  the part after it is the slug, compared **case-insensitively** and after
  trimming. A name with no `@` is bare. `a@b@slug`, `a@@slug` and
  `Code-Review@Kookr-AI-Kookr` all classify (the last two are names `nb` 0.7.0
  accepts; the case-collision refusal, #337, is not released yet).
  `KOOKR_REPO_SLUG` is trimmed and an empty value counts as unset.
- **Promotion is `nb move <from> <to> <id>`** (score-preserving, upstream since
  0.5.0). A duplicate left in a second project shelf is removed with
  `nb rm … --reason obsolete --note duplicate` (`duplicate` is a `merge` reason
  code, not an `rm` one; an unknown `rm` code is stored as free text and lost to
  `nb stats`, the same defect as E7).

## Design

### D1. Layer-aware session start (Claude Code)

`plugin/hooks/nb-inject.mjs` keeps its role (inject an index, never content) and
gains grouping. This reverses a stated choice in the hook's header comment
("nothing guesses a per-repo shelf"); the reason is evidence E2-E4. The hook
still never opens a shelf *for* the agent.

1. Read `KOOKR_REPO_SLUG`. Missing, or `KOOKR_NB_LAYERS=0` (the kill switch) →
   behave as today (flat index, still capped by item 6 below).
2. Run `nb list --json --limit 1000` (works on 0.7.0; without the limit it returns only 50 rows and the hidden count would be wrong). Classify each row with the shared
   classifier (D3). A shelf `base@s` is in the project layer when `s` equals the
   slug **or** `plugin/notebooks/slug-aliases.json` (shipped by K2, read by the K2 migration script and the K3 hook) maps `s` to the slug (today:
   `agent-notebook` → `jeanibarz-agent-notebook`). Aliases make the filter safe
   before the store migration runs, and the file is deleted only once **no legacy-slug shelf remains** (the migration may refuse to move a low-scored lesson, which would otherwise be hidden from its own repo).
3. Print three groups, project first, then one line that always states what was
   hidden: `3 shelves for other projects hidden (slug: owner-repo); nb list
   shows all`:

   ```
   ## Your agent-notebook index (project: owner-repo)
   Precedence if lessons conflict: project > domain > global.
   ### Project layer (this repo) …rows…
   ### Domain layer …rows…
   ### Global layer …rows…
   ```
4. Append the short **placement rule** (three lines: narrowest layer first, what
   makes a lesson domain-level, global only by promotion) and the existing
   vote/add reminders.
5. Failure handling, all on **stdout** (stderr never reaches the agent): a
   missing `nb` stays silent (hosts without it must not get noise); a timeout or
   non-zero `nb list` prints a one-line warning (E9). If the project group is
   empty while other projects' shelves are hidden, the hidden-count line says so
   plainly (a wrong slug must be loud, not a quiet empty section). Exit code
   stays 0; a session start never blocks.
6. Output is bounded: the project group is never truncated; the other groups are cut after grouping to at most 60 index rows and 8 KB in total, with a trailing "N more:
   run nb list". This also applies to the flat fallback.

The hook runs once in the main session; subagents get no SessionStart index
and inherit the parent's `KOOKR_REPO_SLUG` even when they work in another repo,
so they must not rely on the filter. Only the injected index is filtered. An agent's own mid-task `nb list` and
`nb search` still show everything. That gap is accepted for now: it is measured
(share of `list`/`search` calls per session, in the success measures) and the
shim-side filter is the follow-up if it matters, not an upstream feature.
A shelf with no `@` is never hidden. The index stays smaller (29 rows instead of 44
for `jeanibarz-agent-notebook`: the 15 other-project shelves are hidden, and the
7 legacy-slug shelves stay visible through the alias file).

### D2. Layer-aware end of task (Claude Code)

`plugin/hooks/nb-retro.mjs` text follows upstream's retrospective where that is
right and goes beyond it where it is not (batch vote `id1,id2`, reason codes
`wrong|obsolete`, "aim ~150 chars"; as built in #3595, upstream's own
`nb-retrospective.sh` still teaches single-id votes and restates the 200-character
cap, so those two points are Kookr's, not synced), and its
`nb add` step names the placement rule: "add to `<situation>@<slug>` unless the
lesson would be true in another repo; never write `fleet-global` directly". The
sentinel claim becomes atomic (`wx` flag, as upstream did in #245; the merged hook
exits 0 on `EEXIST` and also, deliberately, on any other write failure so a stop can
never loop) and the sentinel TTL follows upstream (7 days, `NB_RETRO_TTL_DAYS`),
because the current 24 h prune would re-nudge a session that runs longer than a
day. `SubagentStop` fires with the parent's session id, so in a fan-out the
**first** agent to stop, often a subagent, receives the one nudge. That is
accepted: the placement rule is therefore carried in the nudge text itself (not
only in the SessionStart index), and K1 tests the fan-out.

### D2b. Subagents: the agent definitions are the routing layer

Most reads and writes come from subagents, which get no SessionStart index and
open the shelf their agent file names. So the layer vocabulary must be in those
files. One shared **Notebook Protocol** block (single source in
`plugin/skills/notebook-role-reuse/`, copied into each agent doc by a script and
checked by a test, as the shelf-reorg RFC did for its FR-1 guard) replaces the
per-agent text. It is applied to the 23 agent docs that have a notebook section; the 2 that have none are left alone (a read-only role must not start writing the notebook):

- Start: `nb show <domain-shelf>`, and if it exists `nb show <domain-shelf>@$KOOKR_REPO_SLUG`
  (project layer, applies first on conflict). Missing shelf is fine. If `KOOKR_REPO_SLUG` is unset, skip the project read and write to the domain shelf (never build a name ending in `@`; `nb` refuses it). Match the slug's exact spelling (`KOOKR_REPO_SLUG` is lower-case; the index classifies case-insensitively, so a mixed-case legacy shelf shows as project but is not found by this literal read). A subagent
  inherits its parent's slug even when its task is in another repo, so the block
  says: use `$KOOKR_REPO_SLUG` only when your task works in the session's own
  repo; otherwise skip the project read and write, and say so. Until K2's
  migration is applied, shelves under a legacy slug are not read by this line;
  that gap is accepted and the migration closes it.
- End: vote by id (`id1,id2` batch), `nb rm … --reason wrong|obsolete`, and
  `nb add` to the project shelf unless the lesson would be true in another repo,
  in which case the domain shelf. Never `fleet-global` directly. ~150 characters.
- No restated caps or eviction rules (FR-1 of the shelf-reorg RFC): a pointer to
  `docs/reference/agent-notebook.md` only.

The `notebook-role-reuse` skill's "pick one per spawn" scope rule becomes "open
both layers; write to the narrowest that is true". A guard test fails when an
agent doc hardcodes a bare shelf with no project line, or restates a tool-owned
fact. This is the highest-leverage part of the RFC for subagents; D1 serves the
main session.

### D3. One vocabulary, one owner

The layer rules (the `fleet-global` name, the slug rule, aliases, the precedence
order) live in **one dependency-free ES module**,
`plugin/hooks/lib/notebook-layers.mjs`. The hook and the shim's advisory (K3 moves it off its own first-`@` split) use it. The opencode
adapter (`opencode-shelf-memory.ts`) does **not** get a TS copy now: its layered
composer (slice S3 of #3541) is not built, and a classifier written for a future
caller is speculative. When S3 is built it must import this module (or, if the
TS build cannot, add a copy with a parity test over shared fixtures and amend
this RFC). Claude Code gets an **index**; opencode will get **content packs**
(small models, byte caps): two delivery modes, one definition.

### D4. Shim and store hygiene

- `bin/nb.js`: add `move` to `MUTATING`; a test fails if a verb that
  `nb --help` lists as mutating is missing. The shim also prints a one-line
  stderr **advisory** (never a refusal; the shim stays fail-open) when `add`
  targets `fleet-global` outside a curator run (`KOOKR_NB_CURATOR` unset), and
  another when it targets `base@s` where `s` is neither `KOOKR_REPO_SLUG` nor an
  alias of it (this catches agents re-creating legacy short slugs after the
  migration, and cross-project writes). The first makes the global layer's
  "promotion only" rule more than prose.
- Seed descriptions for project shelves: `apply-shelf-descriptions.mjs` derives
  `<base trigger> (only in <slug>)` for any undescribed `base@slug` whose base
  has a seed description. Today that covers only 12 of the 24 project shelves
  (`code-review` 7, and one each for `change-verifier`, `clear-writing-reviewer`,
  `patch-author`, `repo-cartographer`, `test-quality-reviewer`). The other 12 have
  bases with **no seed entry**: `orchestrator` (8, among the most-opened shelves),
  `diagnostician`, `planner`, `refactorer`, `tester` (1 each). K2 therefore adds
  seed triggers for those five bases (written as situations, from reading each
  shelf's lessons) **and** an explicit `fleet-global` trigger, and its test asserts
  that after applying the seed to a copy of the live store **no** project shelf is
  left undescribed.
- `scripts/migrate-notebook-slugs.mjs` (new, **dry-run by default**): lists the
  legacy-slug shelves and the exact `nb move` calls that would fold them into
  canonical-slug shelves. `nb` evicts the **lowest-scored** line of a full
  target, and a moved lesson is always admitted, so a `-1` lesson moved into a
  full shelf evicts a better one. The script therefore (a) simulates the moves
  **sequentially**, re-predicting evictions after each, (b) refuses to move a
  lesson scoring below the target's current minimum unless `--force-low`, (c)
  checks `len(base@slug) <= 128` and reports a name that would fail with
  `bad_args` before starting, (d) is **resumable** (it re-reads the store before
  every move), and (e) `--apply` tags the store's git repo first
  (`pre-slug-migration`). Every move is its own commit (K1 makes `move`
  auto-commit), so rollback is `git revert` of that range, not `reset --hard`,
  which would discard writes agents make meanwhile. It is an operator action;
  this RFC does not run it against the live store.

### D5. Promotion loop (harness-side, so the global layer is not empty)

A promotion needs to find lessons that appear in more than one project shelf.
Kookr can do that with `nb list --json` + `nb show --json`, so it does:

- `scripts/promote-notebook-lessons.mjs` (new, **dry-run by default**) finds
  lessons that look shared across `*@<slug>` shelves of the same base, in two
  tiers:
  - **Exact group**: equal text after trimming, collapsing whitespace and
    case-folding (conservative; `nb` 0.7.0's `show --json` has no dedup key). The
    script prints the `nb move` of the highest-scored copy to the domain shelf (or
    `fleet-global` when the lesson names no work type) plus the
    `nb rm --reason obsolete --note duplicate` of the other copies. Only an exact
    group's other copies are ever removed.
  - **Candidate group** (token-overlap above a printed threshold, so paraphrases
    such as the E5 pair): **report-only by default**, with both texts, scores and
    shelf ids side by side. `--apply --only <group-id,...>` lets a reviewer
    promote chosen groups: it `nb move`s the highest-scored copy up (score kept)
    and **removes nothing**; the other paraphrases stay in their project shelves
    (project wins on conflict) until a reviewer `nb rm`s them by hand. Fuzzy
    matching never deletes, because a lesson and its negation can score as
    near-identical (#286) and a lesson found in one copy only would be lost.
  `--apply` tags the store first and shares the migration script's
  sequential-simulation (evictions **and** the one-point aging `nb` applies to the
  oldest surviving line on every over-cap admit), minimum-score and resumability
  rules.
- `.kookr/playbooks/agent-notebook-reflection.md` runs it and runs the shipped
  janitor, and sets `KOOKR_NB_CURATOR=1` for its own `nb` calls.
- First use is a one-shot **seed pass**. Measured today: 0 exact groups in the
  store, so the pass yields **candidate groups only**, and `fleet-global` is
  populated by a human choosing which candidates to promote, not automatically.
  That is slower than "populated by evidence on day one" but is the honest
  outcome of the data; it is an operator action with the same dry-run discipline.

### D6. Upstream `agent-notebook` additions (neutral primitives only)

Test applied to every idea: *can the harness do it with `nb list --json` /
`nb show --json`, or with the shim and hook it already owns?* If yes it stays in
Kookr (`CLAUDE.md` section 6 of agent-notebook: harness integration lives around
the package, never in the hot `nb` path). Upstream issue #286 (completed) drew
the same line: scope precedence is the harness's job because `nb` treats
`@project` as opaque.

| Idea | Verdict | Reason |
|---|---|---|
| **A1. `NB_PROJECT` read filter and a `scope` field in `--json`.** | **Deferred.** | Review round 1: the Kookr shim and hook already own the choke points, and the filter would make `nb` define slug grammar (`a@b@c`, case, dots) and change output by ambient env var. Revisit if a second harness asks, or if the measured mid-task `list`/`search` noise is large. If it ships, it must be an explicit `--project` flag, and `scope` stays a derived, read-only field (no NG-004 conflict). |
| **A2. Two neutral janitor signals** (merged #364/#365): (a) slug-variant shelf names (same base, one slug a `-`-suffix of the other), (b) exact cross-shelf duplicate lessons by the tool's own `dedupKey`. | **Proposed here; merged upstream (#364, #365, #366).** | The shipped janitor missed E3 entirely. Framed as hygiene signals, not "promotion" (promotion is Kookr's lifecycle). Read-only, in `examples/`, off the hot path. |
| **A3. `docs/memory-layers.md` + AGENTS.md section 4 + a layered example session-start hook.** | **Proposed here; merged upstream (#364, #365, #366).** | Upstream's guidance (group by co-access, `shelf@project`) says nothing about precedence or promotion; other harnesses need the pattern. Documented as a *convention* built on `@` and bare names, not tool behavior. |
| Layer metadata in shelf files / a `layer:` header | Reject. | New storage and a schema migration for something a name already encodes. Violates NG-004. |
| `nb promote` command | Reject. | `nb move` already does it, score-preserving. |
| Ordered multi-shelf output / a `nb context` verb | Reject. | Already examined and cut in #286: ordering and budget are caller policy. |
| `nb contract` (print canonical hook text) | Defer. | Would end hook text drift (E7), but a drift test in Kookr against the package's shipped `examples/hooks` is cheaper. |
| Global-layer awareness in `nb` (reserved shelf name) | Reject. | Which shelf is "global" is harness policy. |

No Kookr slice depends on an upstream change or release.

## Requirements

- **FR-1** The Claude Code SessionStart hook SHALL group the index into project,
  domain and global sections when `KOOKR_REPO_SLUG` is set and
  `KOOKR_NB_LAYERS` is not `0`, hide other projects' shelves while always
  stating the hidden count and slug, honor `slug-aliases.json`, and otherwise
  emit today's flat index.
- **FR-2** The hook SHALL state the precedence order and the placement rule, and
  SHALL surface a failing `nb list`.
- **FR-3** The retrospective hook SHALL teach batch voting, valid reason codes,
  the ~150-char target and the placement rule, and SHALL claim its sentinel
  atomically.
- **FR-4** `bin/nb.js` SHALL auto-commit every mutating verb, `move` included.
- **FR-5** Layer classification SHALL have one owning module
  (`plugin/hooks/lib/notebook-layers.mjs`). The session-start hook **and the
  `bin/nb.js` shim** (whose K1 advisory currently splits on the first `@`,
  case-sensitively, unlike the last-`@`, case-insensitive rule above) SHALL import
  it (the shim through a **guarded dynamic import** that falls back to its current
  behavior if the module cannot be loaded, so a missing file can never break every
  `nb` call); a second implementation (opencode S3) SHALL import it too, or ship
  with a parity test and an RFC amendment.
- **FR-6** Slices that ship before an `agent-notebook` release SHALL work on
  0.7.0. No slice publishes to npm.
- **FR-7** The store migration and promotion scripts SHALL default to dry-run
  and tag the store's git repo before `--apply`.
- **FR-8** The hook SHALL be disable-able without a release (`KOOKR_NB_LAYERS=0`).
- **FR-9** Every `plugin/agents/*.md` that has a notebook section SHALL carry the
  shared Notebook Protocol block (both layers on read, narrowest-true layer on
  write, slug caveat for subagents), verified by a test.

Non-goals: merging shelves by co-access; injecting lesson *content* into Claude
Code sessions; enforcing precedence in code; changing the 50-line cap; migrating
the live store as part of the merge.

## Slices

Kookr (`kookr-ai/kookr`). Order matters: the filter must not ship before the data
it relies on is described and alias-covered.

| Slice | Content | Depends on |
|---|---|---|
| K1 | Three small fixes, one commit each, one PR: `bin/nb.js` `move` in `MUTATING` + drift test + `fleet-global` and cross-slug advisories (merged); retro hook sync (batch vote, reason codes, ~150 chars, placement rule, atomic sentinel); `nb list` failure warning in the inject hook. | none |
| K2 | Store tooling: project-shelf descriptions in the seed (applied to the live store, idempotent, never overwrites a human description) + seed triggers for the five bases that have none (`orchestrator`, `diagnostician`, `planner`, `refactorer`, `tester`) + a `fleet-global` trigger, with a test that no project shelf is left undescribed; `plugin/notebooks/slug-aliases.json` (the legacy-to-canonical slug map the migration script reads); `migrate-notebook-slugs.mjs` and `promote-notebook-lessons.mjs`, both dry-run by default; the reflection playbook's promotion step (it runs the promotion script, sets `KOOKR_NB_CURATOR=1`, and only reports; the flag exists so the shim does not warn about the `fleet-global` writes an operator's reviewed `--apply` makes). | K1 (`move` auto-commit) |
| K3 | `notebook-layers.mjs`, layered index, the shim advisory moved onto it, the index reading K2's `slug-aliases.json`, kill switch, fixture test on a snapshot of the 44-shelf store, baseline numbers in the PR. | K1, K2 (descriptions applied) |
| K4 | D2b: shared Notebook Protocol block in the `notebook-role-reuse` skill, applied to the 23 agent docs that have a notebook section, by script + guard test; skill scope rule ("open both layers"). | K1 (can ship before or with K3) |
| K5 | Reviewer and orchestrator routing: `plugin/reviewer-specialists/*.md`, `plugin/skills/pre-pr-review/SKILL.md` and `src/core/reviewer-fanout.ts` (still one shelf, "≤120 chars") get the same two-layer read and placement rule. | K4 |

Upstream (`jeanibarz/agent-notebook`): **A2** (neutral janitor signals; merged as #364/#365) and **A3**
(layers documentation; written to describe what Kookr does, no code; merged as #366).

Operator actions left, deliberately: run the slug migration `--apply`, run the
promotion seed pass `--apply`, and any `agent-notebook` release.

## Success measures

Baseline recorded now (usage ring, last 15 days): 1550 `show` calls, 894 (58%)
on a project-scoped shelf; 455 `list` calls in 7 days; `add` 35% errors (96% of
classified `too_long`); 0 `nb move` commits in the store log; 24 undescribed
project shelves. K2's PR records the same numbers before merging so the later
comparison is like for like. Read a week after K1+K2+K3:

- Rows injected per session for `jeanibarz-agent-notebook`: 44 → 29 (the 15 other-project shelves hidden; 22 would be hidden without the alias file, wrongly including this repo's 7 legacy shelves).
- `add` error rate and its `too_long` share fall from 35% / 96%.
- Undescribed project shelves: 24 → 0.
- Agent-definition audit: agent docs with a notebook section that lack the shared
  Notebook Protocol (both layers): 23 of 23 → 0 (14 name only a bare shelf, 9 only a
  project shelf).
- Relevance proxy: share of `show` calls that target a project-layer shelf, and
  `+1` votes per injected shelf, per session (`nb stats`, keyed by `NB_SESSION`).
  Expect the first to rise; if it does not, the index grouping did not change
  behavior and D1 should be questioned.
- Mid-task `list`/`search` volume (decides whether the shim filter is worth it).
- `nb move` commits appear in the store log; after the seed pass, `fleet-global`
  holds the candidate lessons a reviewer chose to promote (the script cannot
  populate it unattended, see D5).

Honest limit: the usage log records the shelf and the session but not whether
the caller was the main agent or a subagent, so the log cannot separate "the
index grouping changed behavior" from "the agent files already pointed there".
The agent-definition audit is the cleaner signal for subagents; the show-share
proxy is read alongside it, not alone. These are process and attention signals. Nothing here proves
layered memory improves task outcomes. Evidence E10 says memory helped nothing
when its content was irrelevant; this RFC makes relevance more likely, not
proven.

## Edge cases

- **No `KOOKR_REPO_SLUG`** (probe failed, non-git dir): flat index, as today.
- **Legacy slug until migrated**: `slug-aliases.json` counts the 7
  `@agent-notebook` shelves as project-layer, so the filter is correct before
  the migration; the hidden count and slug are always printed so a wrong filter
  is visible, and `KOOKR_NB_LAYERS=0` turns the feature off with no release.
- **Full target shelf on migration/promotion**: `nb move` evicts the target's
  lowest-scored other lesson (note `nb --help` still says "stalest"; the code
  evicts by score). The migration dry-run lists these before anything runs.
- **Slug collisions and drift**: `a-b/c` and `a/b-c` both produce `a-b-c`; a
  fork produces `forkowner-repo`, a different slug from upstream (separate shelf
  sets); a repo with no remote gets `local-<dirname>`, so each differently named
  worktree has its own slug. None is solved here; the hidden-count line and the
  shim advisory make the symptom visible. `deriveRepoSlug` has no length cap
  (shelf names are capped at 128 chars): the dry-run reports it, and capping it
  is a separate Kookr issue.
- **Project shelf grows past 50 lines**: normal; eviction/aging apply. Defaulting
  new lessons to the project layer fills that cap faster, so useful lessons can be
  evicted before a second repo rediscovers them. This cost is real and not shown
  to be small: project-shelf eviction counts (janitor section 1) are a success
  measure, and the promotion script (no upstream dependency) runs on the
  reflection playbook's cadence instead of waiting for a rediscovery.
- **Worker disagrees with a higher layer**: precedence says project wins; a
  worker that finds a global lesson wrong votes `-1` / `nb rm --reason wrong`
  as today.

## Alternatives considered

1. **Do nothing; rely on the shelf descriptions.** Rejected: E2–E5 show agents
   neither filter noise nor place lessons consistently.
2. **Inject lesson content for all layers into Claude Code sessions** (like the
   opencode pack). Rejected: ~700 lessons across the store. See alternative 6
   for the narrower project-only version.
3. **One `project@<slug>` shelf per repo** (co-access argues for it, E6).
   Rejected: a 50-line cap across all of a repo's roles forces eviction;
   role-sized shelves keep the cap meaningful. Revisit with `nb stats`
   co-access evidence once slugs are canonical.
4. **Put the layer engine, or the scope filter, in agent-notebook.** Rejected /
   deferred above (D6). A `.`-prefix filter was considered as a smaller upstream
   alternative: it cannot express "everything except other projects' `@`
   shelves", and `.` already means namespace.
5. **Make the hook derive the slug from `git remote`.** Rejected:
   `KOOKR_REPO_SLUG` already exists and is the canonical form.
6. **Inject the project layer's content (a byte-capped top-scored pack) into
   Claude Code sessions.** Deferred with a number: the project layer is ~17 KB
   for `jeanibarz-agent-notebook` (about 4k tokens per session) and ~12 KB for
   `kookr-ai-kookr`. Reconsider as a flag-gated follow-up once the baseline shows
   whether agents open project shelves after the grouped index.

## Critic feedback incorporated

Round 1 panel (5 lenses, cap respected): design-minimalist, boundary-critic,
delivery-pragmatist, failure-mode-analyst, ambition-amplifier. Shared evidence
pack supplied to all; each re-verified claims against source. The failure-mode
critic also ran probes against a throwaway `NB_DIR` (name parsing, eviction
order, reason codes). No second round was run: round-1 changes were corrections
and cuts, not new design.

| Finding | Source | Decision |
|---|---|---|
| Upstream `NB_PROJECT` filter (A1) is unjustified: Kookr owns the shim and hook; it makes `nb` define slug grammar | minimalist, boundary, failure-mode | **Incorporated.** A1 deferred; the upstream-release slice removed; no Kookr slice needs a release. |
| Filter shipped before the slug repair hides 7 legacy shelves from their own repo; no kill switch | delivery, ambition | **Incorporated.** `slug-aliases.json`, `KOOKR_NB_LAYERS=0`, always-printed hidden count, K2 (descriptions, tooling) before K3 (filter). |
| `@` parsing unspecified (`a@b@c`, case) | failure-mode | **Incorporated.** Last-`@` split, case-insensitive, trimmed slug, in the layer rules and tests. |
| Global layer stays empty; no promotion without unreleased A2 | ambition, failure-mode | **Incorporated, then narrowed.** Harness-side promotion script (A2 off the critical path). The second independent review showed the real duplicates are paraphrases (0 exact groups in 368 lessons), so the script reports paraphrase candidates and a reviewer chooses what to promote; it does not populate `fleet-global` unattended. |
| Classifier duplicated in `.mjs` and TS with a parity test | minimalist, boundary | **Incorporated.** One `.mjs` owner; no TS copy until opencode S3 exists. |
| `nb move` into a full shelf evicts the lowest-scored line; "stalest" was wrong; dry-run order-dependent; `reset --hard` rollback unsafe | failure-mode | **Incorporated.** Sequential simulation, minimum-score refusal, resumable, rollback by `git revert`. Verified by probe. |
| `nb rm --reason duplicate` is not a valid code | failure-mode | **Incorporated.** Verified; now `--reason obsolete --note duplicate`. |
| Hook output: warnings must be on stdout, missing `nb` silent, no row cap; legacy slugs can be re-created | failure-mode | **Incorporated** (D1 items 5-6, shim advisory). |
| Retro sentinel goes to the first stopper (often a subagent); 24 h TTL re-nudges | failure-mode | **Incorporated.** Placement rule carried in the nudge text; TTL 7 days; K1 tests fan-out. |
| DP-6 cited wrongly | boundary | **Incorporated.** Cites agent-notebook `CLAUDE.md` section 6 instead. |
| Five metrics / seven edge cases is too heavy for a text change | minimalist | **Rejected.** The change touches every session and the failure modes found are silent; the measures are how a silent regression would be seen. |
| Cut D5 (promotion), A2, A3, the migration script, and treat `fleet-global` as a plain shelf | minimalist | **Partly rejected.** See the adversarial-pair line below. |
| Pull content injection of the project layer in now | ambition | **Deferred with a number** (alternative 6): ~17 KB per session, flag-gated follow-up after the baseline. |
| Add an outcome/relevance metric and a baseline | ambition | **Incorporated** (project-shelf share of `show` calls, baseline recorded). |
| Slug length and collisions (`a-b/c` vs `a/b-c`), per-worktree `local-` slugs | failure-mode | **Incorporated as documented edge cases**; capping `deriveRepoSlug` is a separate issue. |

Adversarial pair (design-minimalist vs ambition-amplifier): I agreed with
ambition that promotion must not wait for upstream, because the store holds real cross-project overlap (E5, as paraphrases) and the
global layer would otherwise be three lines; I agreed with minimalist that nothing upstream blocks it and that
the TS classifier, the filter, and the release dependency are speculative and
cut. Result: a small harness-side dry-run script instead of an upstream feature.

Invocation log: ambition-amplifier 2026-11-10: novel finding (global layer empty by construction; outcome metric).

Independent merge review (blind Opus-class reviewer, exact head `cd16c5e1`, 2026-11-11):
**BLOCK**, two confirmed defects, both fixed in v3: (1) the promotion script used
fuzzy matching to pick copies to `nb rm`, which can delete a lesson that says the
opposite (#286) or one found in only one copy, so removal is now exact-text-only and
fuzzy matches are report-only (D5); (2) the single-owner parsing rule contradicted
the merged K1 shim, which splits on the first `@` case-sensitively, so FR-5 now
makes the shim import the same module (K3). Non-blocking notes also fixed: E11
counts (14 bare-only, 9 project-only, 2 without a notebook section, so 23 docs not
25), the subagent-slug caveat in D2b, "lowest-scored" eviction wording, the K3→K2
migration reference, the D1 fallback wording, slice table, FR/alternative order,
and stale status text.

Second independent merge review (blind Opus-class, exact head `427cea06`):
**BLOCK**, one confirmed defect, fixed in v4: the v3 exact-match-only promotion
yields nothing on the real store (368 project lessons, 0 exact cross-shelf groups;
the E5 pair are paraphrases), which undercut the claim that the global layer is
populated on day one. D5 now has two tiers (exact groups are eligible for removal;
paraphrase candidates are report-only and a reviewer promotes chosen groups with a
score-preserving move and no deletion) and every claim and measure that assumed
automatic population was narrowed. Non-blocking notes fixed: `--limit 1000` on
`nb list --json`, alias-file deletion gated on no legacy shelf remaining, the
migration simulation now models the one-point aging as well as eviction, the
sentinel description matches the merged hook, E11's routing claim corrected and the
reviewer/orchestrator routing split out as slice K5, a guarded dynamic import for
the shim, and stale upstream status.

Third independent merge review (blind Opus-class, exact head `5826da6b`): **BLOCK**,
one confirmed defect, fixed in v5: the description-derivation rule (D4) can describe
only the 12 project shelves whose base already has a seed entry; the other 12
(`orchestrator` 8, plus `diagnostician`, `planner`, `refactorer`, `tester`) would
stay undescribed while the "24 → 0" measure was reported as met. K2 now adds seed
triggers for those five bases, ships `slug-aliases.json`, and tests that no project
shelf is left undescribed. Non-blocking notes fixed: the row cap applies after
grouping and never cuts the project group, the unset-slug and mixed-case rules for
subagents, the `KOOKR_NB_CURATOR` purpose, and stale status/A2/A3 wording. Left as
noted: D5's exact-match normalization is deliberately narrower than `nb`'s own
`dedupKey` (the safe direction).

Intent preservation check: the operator asked for (1) check what changed in the
release and adapt the harness, (2) make agents aware of project > domain > global
structure, (3) decide whether `agent-notebook` should grow features. All three
are still the center of the design; the answer to (3) became narrower (docs and
neutral signals, filter deferred) and is presented as an explicit tradeoff, not
silently.

general-purpose 2026-11-10: consensus-attack — **finding**. The panel assumed
the injected index is how agents choose shelves. Checked and confirmed against
`plugin/agents/*.md`: every agent with a notebook section names one shelf by hand (14 bare, 9 project-only; 2 have no section) and subagents get no index,
so a hook-only design would leave most memory use unchanged and its success
metric could not tell the difference. Incorporated (one revision): E11, D2b,
FR-9, K4 widened, the agent-definition audit measure, and the honest-limit text.
The attack's unmeasured counterfactual question (what share of `show` calls
survive with no hook) cannot be answered from the usage log and is recorded as
a known gap rather than debated further.
