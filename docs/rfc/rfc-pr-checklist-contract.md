# RFC: PR Checklist Contract — customizable, cross-runtime, cross-repo drift gates

## Status

Draft (revised after critic round 1 — see "Critic Feedback Incorporated")

## Date

2026-07-01

## Author

Jean IBARZ (ibarz.jean@gmail.com)

## Problem

Kookr already gates PR creation across every repo on a machine via user-global
hooks (`pr-workflow-gate.sh` blocks `gh pr create` until the `pre-pr-review`
skill stamps a state file). But the *content* of a PR is verified only by human
honesty: a PR can change behavior and leave docs, `.env` examples, MBSE views,
or tests stale, and nothing mechanically catches it. Drift accumulates.

A per-repo experiment (lucy, PR #735) shows a **machine-verified anti-drift
checklist** is feasible: a PR template with machine-readable markers, plus a
verifier that checks each claimed item against the actual diff. That
implementation is repo-local and assumes an npm/Node toolchain
(`npm run pr:checklist`). The ambition is to generalize it so it fires for every
kookr agent (Codex CLI + Claude Code), in every repo (npm or not), with per-repo
customization — **but** critic review (round 1) established that the ambitious
surface carries real security and false-assurance risk and rests on thin
evidence (n=1 repo, hours old). This RFC therefore keeps the full ambition as the
North Star while **sequencing** it: a tiny, safe, high-confidence v1, then
progressively riskier capability behind explicit security gates.

## Requirements

Each requirement is tagged with the phase (§ "Phased delivery") that first
satisfies it. Nothing is cut; risk is sequenced.

- **R1 — Cross-runtime** (P3). Verification fires for every kookr agent that can
  open a PR (Claude Code, Codex CLI). This keeps the *local pre-PR* trigger in
  the user-global hook layer, not `plugin/hooks/`, so it also fires for non-agent
  `gh pr create` (plain terminal, CI) where no plugin loads. (This revision
  originally cited "Codex does not inject plugin hooks"; the Codex fork now loads
  plugin hooks via `--plugin-dir`, so that is no longer the reason — non-agent
  coverage is.) v1 satisfies "cross-runtime" via **CI**, which is
  runtime-independent; the local hook comes in P3.
- **R2 — Cross-repo, toolchain-agnostic** (P1). A repo with no local toolchain
  still gets meaningful verification; the engine runs on kookr's own runtime.
- **R3 — Customizable per repo** (P4). Each repo can declare its own checklist
  items and, for each, how it is verified — including escape-hatch verification
  in the repo's own language. Deferred to P4 because it introduces the
  highest-risk surface (repo-controlled command execution).
- **R4 — Zero-config baseline** (P1). A repo that adds only a marked PR template
  (no config file) already gets useful checks.
- **R5 — Authoritative backstop** (P1). A server-side CI check that cannot be
  bypassed with `--no-verify` is the source of truth. In v1 it is the *only*
  enforcement point.
- **R6 — Safe by default** (P1 for the safety model; enforced hardest at P4).
  Running repo-defined verification must never turn "clone a repo and open a PR"
  into local code execution, and repo-controlled *input* (not just commands) must
  not be an execution or exfiltration vector.
- **R7 — GitHub first, GitLab designed-in** (P5). Ship GitHub (`gh` + Actions);
  the engine core stays platform-neutral so GitLab (`glab` + `.gitlab-ci.yml`) is
  additive.

## Non-goals

- Judging whether prose is *semantically correct*. The engine proves **facts
  about the diff** (a claimed file changed, a coupling holds, a command exited 0),
  never "is this doc right". No AI in the gate.
- Catching *modified-behavior* drift where no new file/symbol appears. The
  built-in coupling checks (§Design 3) key on **structural additions** precisely
  to stay low-false-positive; behavior changes to existing code with no new
  symbol are **not** caught by `changed-when` and fall to `attest` (honesty) or a
  repo `command` rule. This residual gap is stated openly, not oversold.
- Replacing the `pre-pr-review` skill's reviewer specialists.
- A hosted service or dashboard.

## Security requirements (hard gates)

These are mandatory acceptance criteria for the phase that first introduces the
named surface. A phase does not ship until its security requirements have tests.

- **S1 — Safe parsing (P1).** Config/template/body/diff parsing must not execute
  or instantiate code. YAML (when introduced, P4) uses a schema-restricted safe
  loader; a `!!js/function`/custom-tag fixture must be proven inert. Unknown keys
  rejected.
- **S2 — Config/input errors fail *closed* (P1 for CI; P3 for hook).** A verifier
  that cannot parse the repo's own config/template, hits a resource cap, or times
  out is a **verification failure**, not a soft "engine error" — otherwise anyone
  who can supply input can bypass the gate by crashing it. Fail-*open* is reserved
  strictly for kookr-*internal* faults (e.g. the CLI binary missing) and is always
  surfaced in-band (§Design 6), never silent.
- **S3 — No shell interpolation of untrusted data (P3).** The hook must pass the
  PR body and all paths to the engine via stdin/temp-file/array-args, never
  interpolated into a command string. Static guard + an injection fixture
  (`$(...)`, `;`, backticks in a body) required. (Reuse the repo's
  `shell-subprocess-safety` skill.)
- **S4 — Path confinement (P1).** Every glob match and every config-supplied path
  is resolved and rejected if it escapes the repo root; symlinks out of the repo
  are not followed; `--body-file` outside the repo is rejected; non-regular files
  refused. Bound glob expansion time/result count (no ReDoS/globstar bomb).
- **S5 — No untrusted code with secrets in CI (P1 for the generator).** The CI
  job runs on `pull_request` (no secrets, unprivileged token), never
  `pull_request_target` with a head checkout. `command` rules (P4) execute only in
  this unprivileged context.
- **S6 — Never echo content (P1).** Secret-scan hits, body text, and file
  contents are reported by location/type/count only — never value — in logs,
  block reasons, or CI output, so the gate can't become an exfiltration primitive.
- **S7 — Deterministic exit protocol (P1).** The CLI uses a rigid contract:
  `0` = pass, `2` = verification failure (structured JSON on stdout), `≥64` =
  kookr-internal error (message on stderr). A top-level try/catch maps any
  uncaught throw to `≥64`, never a bare `1` that callers can't classify. Every
  caller (CI, later the hook) branches on the code, not on output presence.
- **S8 — Bounded resource use (P1).** Hard caps on diff size, body size, file
  size, glob time, and total wall-clock. Cap exceeded ⇒ S2 (fail closed), not a
  crash and not fail-open.

## Design

### 1. The contract: template markers (v1) + optional rule map (P4)

A repo opts in by adding **machine-readable markers** to its PR template
(GitHub v1: `.github/PULL_REQUEST_TEMPLATE.md`):

```markdown
- [ ] <!-- kookr:check:env --> New env vars documented in .env.example.
- [ ] <!-- kookr:check:tests --> New behavior has tests.
- [ ] <!-- kookr:check:mbse --> Architecture docs refreshed if a subsystem changed.
```

In v1 there is **no config file**. Marker ids map to built-in rules (§3).
**P4a** adds one narrow, safe config: `.kookr/pr-checklist.json` with a single
`disable` key, letting a repo opt its own gate out of named built-in rules
(declarative-only, no execution — see §"Phased delivery" P4a). The fuller
`.kookr/pr-checklist.yaml` (repo-defined rules, including `command`) arrives at
P4 with its own security review; its rule-merge precedence is defined there as
**per-marker whole-rule replacement** (a repo rule for id `X` replaces the
built-in for `X`; unknown ids fall back to `attest`), with the resolved set
inspectable via `kookr pr-checklist verify --explain`.

### 2. Rule types

- **`presence`** (v1, implicit — runs before any per-box rule) — every marker id
  the repo's PR template declares must appear in the PR body. GitHub only injects
  `.github/PULL_REQUEST_TEMPLATE.md` in the web UI (or when `gh pr create` runs
  with **no** `--body`); an inline `--body` silently drops the whole checklist and
  the `attest` rules below then pass *vacuously* — there is nothing to verify. A
  template id absent from the body ⇒ fail, naming the missing ids and pointing at
  `gh pr create --body-file`. No-op when the repo ships no marked template, or when
  no body was provided (CI stays authoritative). The `.github/PULL_REQUEST_TEMPLATE/`
  multi-template *directory* layout is skipped (which template applies is not
  statically knowable from the command). This closes the exact bypass that forced
  the per-repo non-blocking `pre-push` reminder in lucy PR #835 — here it is a
  blocking, cross-runtime, cross-repo rule in the shared engine.
- **`attest`** (v1) — the box must be checked, or struck with a reason
  (`~~item~~ — reason`). Blank marked box ⇒ fail; checked box whose mapped path is
  absent from the diff ⇒ fail ("ticked but not touched"); struck ⇒ waived, reason
  recorded. CI **counts** waivers and fails if *every* item is waived, and
  requires a non-empty reason — a partial guard against reflexive striking (this
  is honestly a weak, honesty-dependent check; see Non-goals + Alternatives).
- **`changed-when`** (v1, two named variants only) — deterministic, low-false-
  positive coupling: (a) a **newly referenced** `process.env.X` in changed source
  must appear in `.env.example`; (b) a **new** source file must be referenced
  somewhere under the test paths. The generic "if any of globs A changed then
  globs B must change" form is **not** in v1 (high false-positive; trains
  reflexive striking) — deferred to P4 as an opt-in repo rule.
- **`command`** (P4) — repo-supplied shell command, exit 0 = pass. The
  any-language escape hatch. Executes **only in CI's unprivileged context** (S5);
  never locally by default. `run_in`/machine-allowlist semantics are specified at
  P4, owned by the **engine** (single authority — not the hook), with exact
  full-command matching (no prefix match).

### 3. Default built-in rules (zero-config, v1)

| Marker id | Default rule |
|---|---|
| `kookr:check:env` | `changed-when` (a): new `process.env.X` in changed source ⇒ must be in `.env.example` |
| `kookr:check:tests` | `changed-when` (b): a new source file ⇒ referenced under a test path |
| `kookr:check:docs`, `:mbse`, `:readme`, `:roadmap`, unknown ids | `attest` (checked ⇒ conventionally-named path in diff; struck ⇒ waived) |

v1 hardcodes JS/Node path/env conventions (the only proven profile). A
"language profile" abstraction is introduced only when a second-language repo
adopts (P5-adjacent), not speculatively.

### 4. The engine: `kookr pr-checklist verify`

New CLI verb, dispatched by `bin/kookr.js` (`argv[2]` → `./kookr-pr-checklist.js`),
backed by a pure engine in `src/pr-checklist/`:

```
kookr pr-checklist verify [--pr-body <file|->] [--base <ref>] [--from-command <raw>]
                          [--run-commands <none|ci>] [--explain]
```

- Pure logic (parse markers, evaluate `attest`/`changed-when`, structural env/test
  checks) is unit-tested independently of git — ported from lucy #735.
- **Command-grammar parsing lives in the engine, not bash.** `--from-command`
  accepts the raw `gh`/`glab` invocation and a per-platform pure adapter under
  `src/pr-checklist/adapters/{gh,glab}.js` extracts the body/base. This keeps the
  fragile parsing in testable Node (boundary-critic fix) and turns "hook
  integration tests" into pure-function tests. The hook only forwards the raw
  command and branches on the exit code (S7).
- git/diff is the only impure dependency; merge-base resolves
  `origin/<base>` → `<base>` → **skip with an explicit "diff base unresolved"
  result** (never diff against a bogus `HEAD~1` and assert a verdict).

### 5. Triggers and authority (who decides "passed")

Three components may run the engine; their authority is now explicit (boundary-
critic fix) to avoid duplicated/inconsistent verdicts:

- **CI (P1) — the sole authority.** Runs
  `kookr pr-checklist verify --pr-body <final-body> --base <base_ref>` on
  `pull_request` (S5), triggers include `edited`/`synchronize` so late body edits
  can't erase attestations, and the adoption guide states plainly: **make it a
  required status check or it is advisory only.**
- **`pre-pr-review` skill (P2) — advisory only.** May call the engine so an agent
  sees problems *before* attempting `gh pr create`. Never the gate of record.
- **User-global hook `pr-workflow-gate.sh` (P3) — local pre-create authority,
  opt-in.** Gated exactly like `kb-context-inject.sh`: a bash-side fast-exit
  (default OFF; env `KOOKR_PR_CHECKLIST=1` and/or a `~/.kookr/pr-checklist-repos.json`
  scope list) **before** spawning Node; a `command -v kookr`/`node` guard; and the
  call written as `if ! kookr pr-checklist verify …; then` (NOT bare — a bare
  non-zero would trip the existing `set -euo pipefail` + `trap ERR fail_open` and
  silently fail-open; delivery-critic bug). Runs `--run-commands none` (never
  executes repo commands locally). Body extraction: for `--body-file`/`--body`
  the body is verified; for `--fill`/`$(...)`/unparseable forms the run is marked
  **attest-unverified** and CI remains authoritative — degraded state is printed,
  not silent.

### 6. Fail semantics and observability

- **CI:** fail-closed throughout (S2). A verification failure fails the check.
- **Hook (P3):** fail-*closed* on verification failure and on config/parse/cap
  errors derived from repo input (S2); fail-*open* only on kookr-internal faults
  (missing binary), always with an in-band line: `checklist gate degraded
  (<reason>) — CI is authoritative`. A machine kill-switch (`KOOKR_PR_CHECKLIST=0`)
  and `kookr pr-checklist doctor` (recent degrade/fail-open rate) make silent
  long-term fail-open detectable (failure-critic M4).

### 7. Documentation

`docs/pr-checklist-contract.md` (author guide), `docs/hooks-setup.md` (the P3 gate
step + kill-switch + `--run-commands` model), `plugin/skills/pre-pr-review/SKILL.md`
(the P2 advisory step, calling `kookr pr-checklist verify`, npm-agnostic).

## Phased delivery

Ordered by increasing blast radius; each phase is independently shippable and
reversible, and does not start until the prior phase has baked.

- **P1 — Engine + CLI + tests (zero blast radius).** `src/pr-checklist/`,
  `bin/kookr-pr-checklist.js`, dispatch case, unit tests, `attest` +
  `changed-when` (two variants), S1/S2/S4/S6/S7/S8 for the CLI. Touches nothing
  live; reversible by deleting files. Validate against lucy's real diff history +
  measure false-positive rate of each built-in before it becomes a default.
- **P2 — CI-only on lucy, by hand.** Wire the engine into lucy's existing Actions
  workflow (not a generator), on `pull_request` (S5), required check. Proves the
  engine on real PRs. This already satisfies R2/R4/R5 for lucy and is the
  "80% of value" the minimalist/socratic critics identified.
- **P3 — Local hook, opt-in, default OFF.** Wire `pr-workflow-gate.sh` behind the
  env/scope gate (S3), attest + changed-when only, `--run-commands none`, the
  `if !`-guarded call, kill-switch + `doctor`. Canary on lucy + author repos
  before considering default-on. Satisfies R1.
- **P4a — `.kookr/pr-checklist.json`, disable-only (SHIPPED).** The minimal,
  safe slice of P4, carved out ahead of the risky remainder. A repo declares
  `{ "disable": ["env", ...] }` to opt its own gate out of named built-in rules.
  It is **JSON, not YAML** (no parser-bomb surface) and **declarative-only** —
  the config can only ever *remove* checks, never add a rule, redirect a source,
  or execute anything. So it cannot be an execution or exfiltration vector: worst
  case a repo weakens its own gate, and CI stays authoritative. That property is
  why it needs none of the S1/S5 command-execution review below. Motivating case:
  `knowledge-base-mcp-server` documents 100+ config vars in typed config modules /
  a reference doc, not a flat `.env.example`, so the built-in `env` rule is a
  structural mismatch — `{ "disable": ["env"] }` resolves it without a brittle
  125-var `.env.example`. Malformed config degrades to "no config" with a note,
  never a hard fail (a broken config must not fail-close the gate). Rule redirect
  (`env.source: <path>`) and the `--explain` resolved-set view are deferred to
  full P4; today, disabled rules are surfaced as report notes.
- **P4 — `.kookr/pr-checklist.yaml` + `command` rules + CI generator.** Highest
  risk (repo-controlled execution, generated CI files in consumer repos). Its own
  review cycle; must pass S1/S5 with fork-PR exfil and hostile-YAML fixtures.
  Builds on P4a's config file (adding YAML + the executing rule types). Satisfies R3.
- **P5 — GitLab.** `glab` adapter + `.gitlab/merge_request_templates/` discovery +
  `.gitlab-ci.yml` generator + first non-JS language profile. Satisfies R7.

## Files to change (P1–P2 only; later phases scoped in their own PRs)

- `bin/kookr.js` — dispatch `pr-checklist` → `./kookr-pr-checklist.js`.
- `bin/kookr-pr-checklist.js` + `src/pr-checklist/` (engine, pure logic + git glue
  + `adapters/gh.js`).
- Tests under the repo's test layout (ported from lucy #735 + adapter/exit-code/
  security fixtures).
- (P2) lucy: replace its local `scripts/verify-pr-checklist.mjs` call with
  `kookr pr-checklist verify` in `.github/workflows/pr-checklist.yml`.

## Edge cases

- **No template:** engine no-ops with a note; behaves exactly as today. The no-op
  path is *first and cheap* (grep for `kookr:check:` before any git op) so the
  per-`gh pr create` latency on non-adopting repos is negligible (failure-critic
  M2).
- **Body not statically extractable (`--fill`, `$(...)`):** marked
  attest-unverified locally; CI authoritative. Never silently "pass".
- **Merge-base unresolved:** explicit skip result, not a bogus-base verdict.
- **Version skew** (`version: N` config on old kookr, P4): fail-closed with
  "upgrade kookr", never silent pass (S2).
- **Rename/format-only diffs:** coupling keys on new symbols/files, so they don't
  fire; the modified-behavior gap is documented (Non-goals).

## Alternatives considered

- **Ship the full contract at once (original draft).** Rejected after critics:
  over-built for n=1 evidence, large security surface, no rollback. Replaced by
  phased delivery.
- **Move gates into `plugin/hooks/`.** Rejected: no Codex firing (R1). The local
  trigger stays user-global.
- **CI-only, forever (no local hook).** Tempting (socratic Q2, failure-critic:
  the local gate is the risky, bypassable part). We keep the local hook but demote
  it to opt-in/advisory-grade (P3) so v1 delivers value with none of that risk;
  the local gate must justify itself during P3 canary or be dropped.
- **Per-repo `npm run pr:checklist` as the universal mechanism.** Rejected:
  assumes npm (R2). Demoted to one P4 `command` rule.
- **Generic glob `changed-when` as a default.** Rejected: high false-positive,
  trains reflexive striking. Opt-in only, P4.
- **AI reviewer as the gate.** Rejected: non-deterministic; blocking on a flaky
  judge is worse than the drift.

## Migration

lucy #735 keeps working standalone. At P2 its CI workflow calls
`kookr pr-checklist verify` instead of the local script; the local
`scripts/verify-pr-checklist.mjs` is removed **only after** the engine is proven
green on lucy in the same PR (no window where neither enforces — delivery-critic).
Markers: the engine accepts both `<!-- pr:id -->` and `<!-- kookr:check:id -->`
for a deprecation window before lucy renames.

## Critic Feedback Incorporated

Round 1 ran five parallel critics (design-minimalist, socratic-challenger,
boundary-critic, failure-mode-analyst, delivery-pragmatist). Strong convergence
drove a substantial revision from the original draft:

- **Over-built for the evidence (minimalist, socratic).** The original shipped a
  YAML DSL, `command` rules, `run_in`/allowlist, language profiles, generic
  coupling, secret-scan, and GitLab all at once against n=1. → Descoped v1 to
  `attest` + two named `changed-when` checks, zero config, GitHub-only, no local
  hook. Everything else is *sequenced* (P4/P5), not cut — preserving the stated
  cross-runtime/customization/GitLab ambition.
- **The local gate is the weak, dangerous part; CI is the real enforcement
  (socratic, failure, delivery).** → CI is the sole authority in v1 (P1–P2); the
  local hook is deferred to P3, opt-in, default OFF, and must earn its keep in
  canary.
- **Fail-open-on-error is self-defeating for an integrity gate (failure C3).**
  Anyone who can supply input can crash the engine to bypass. → New S2: repo-input
  errors fail *closed*; fail-open only for kookr-internal faults, surfaced in-band,
  with kill-switch + `doctor`.
- **Parse-layer is the real attack surface, not just command execution
  (failure C1–C4, H1–H3, M6–M7).** → New S1/S3/S4/S5/S6/S8: safe YAML loader,
  no shell interpolation (stdin/argv), path confinement + ReDoS bounds,
  `pull_request` not `pull_request_target`, never echo content, resource caps.
- **Exit-code protocol underspecified — the whole ballgame (failure H4).** →
  New S7: `0`/`2`/`≥64` contract with top-level try/catch.
- **God-hook / parsing-in-bash (boundary).** → Command-grammar parsing moves into
  a pure Node adapter (`--from-command`, `adapters/{gh,glab}.js`); the hook only
  forwards + branches on exit code.
- **Unowned authority & merge semantics (boundary).** → Engine owns command-exec
  authority (single owner); skill = advisory, hook = local pre-create, CI =
  authoritative; YAML merge = per-marker whole-rule replacement.
- **Coupling misses modified-behavior drift (socratic Q5, failure H5).** → Stated
  openly in Non-goals; not oversold.
- **Checkbox theater / waivers (socratic Q3, failure H6).** → CI counts waivers,
  requires non-empty reasons, fails if all-waived; acknowledged as an honesty-
  dependent weak check, not a guarantee.
- **No rollout plan / kill-switch, and a real bug (delivery).** → Added the P1–P5
  plan reusing existing precedent (`KOOKR_KB_CONTEXT_INJECT`-style env gate,
  `pr-gated-repos.json`-style scope list); fixed the `set -e` + `trap ERR
  fail_open` fail-open bug via the `if !`-guarded call; lucy migration has no
  unenforced window.

Decisions (author, post-review):
- **P3 local hook is in scope.** The cross-runtime local pre-PR gate is a core
  goal (fire for Codex CLI + Claude Code in every repo), so P3 ships despite the
  critics' cost/risk doubts — but exactly as scoped here: opt-in, default OFF,
  attest + changed-when only, `--run-commands none`, kill-switch + `doctor`,
  canaried before any default-on. The critics' concerns are addressed by that
  scoping, not by dropping the phase.

Open question deferred to round 2 / implementation:
- Whether to gate P1 defaults behind a report-only dogfooding period (socratic
  Q1): run the built-ins in report-only mode across active repos for a while and
  let the measured true-vs-false-positive rates justify (or kill) each default
  before it blocks anything. (Recommended before P3 flips default-on.)
