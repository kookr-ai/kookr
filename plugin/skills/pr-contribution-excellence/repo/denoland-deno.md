# denoland/deno Contribution Patterns

Last updated: 2026-04-10 | Distillation #1 | Based on 20 PRs analyzed (4 batches)

---

## Repository Conventions

### Conventional Commit Titles (CI-enforced)
PR title prefix must match `tools/verify_pr_title.js`. Valid: `fix`, `feat`, `perf`, `refactor`, `docs`, `test`, `chore`, `cleanup`, `ci`, `bench`, `build`. **Don't** use `chore:` for `deno_core`/v8 upgrades. Scopes are conventional (not strictly enforced): `ext/net`, `ext/fs`, `ext/node`, `ext/fetch`, `ext/http`, `ext/url`, `ext/web`, `ext/napi`, `ext/webgpu`, `ext/websocket`, `cli`, `runtime`, `core`, `lsp`, `lockfile`, `permissions`, `io`. A bare `refactor:` (no scope) is accepted when the touch area spans subsystems (see #33222).

### Squash Merge — Title is the Commit
All PRs squash-merge. The PR title becomes the final commit message. Commit message divergence during the branch is harmless, but the title must stand alone. Seen in #33020 where commits used `fix(tests):` but PR title `test:` — only the title survived.

### Tooling: `./x` vs `tools/*.js`
Both work; the recon CLAUDE.md lists `./x fmt` / `./x lint` as the common path, but maintainers cite `tools/format.js` / `tools/lint.js --js` in test plans (#33224). Either is accepted; citing the tool path signals deeper familiarity. `./x verify` = fmt + lint-js quick pre-commit.

### Mandatory AI Disclosure
`🤖 Generated with Claude Code` (or equivalent disclosure line) is universal — 100% of analyzed AI-assisted PRs (including maintainer-authored ones) carry it. Maintainer behavior is the ceiling; omitting disclosure when AI is used is an instant-reject signal. Maintainers actively detect undisclosed AI, especially when paired with placeholder tests (#33094: "AI slop with unfinished test").

### Clippy `#[allow(...)]` Is A Yellow Flag
Repo culture rejects lint suppressions when an idiomatic alternative exists. In #33224 a maintainer initially added `#[allow(clippy::field_reassign_with_default)]` then replaced it with a struct-init in the same PR. If you add a clippy allow, expect to justify it or rewrite.

### Deletion PRs Need `-D warnings`
For deletion-heavy PRs add `RUSTFLAGS="-D warnings"` to your test plan (#33222). It catches dead-import regressions that cargo build would let through.

### Submodule Checkout Required
Clone with `--recurse-submodules`. Feature branches use descriptive names (`fix/bug-in-worker-threads` style).

### Never Force Push
All commits squash on merge, so iterating with fresh commits is preferred over force-push. Rewriting history during review is discouraged.

## Reviewer Expectations

### CI Is The Real Gate, Not Human Review
Multi-platform CI matrix (linux/macos/windows × x86_64/aarch64 + lint-windows + node_compat) is where PRs actually die. Seen in #33154: human approval *preceded* the CI failure that killed the PR. Don't treat local spec-test passes as a merge signal — the matrix is wider than any single dev machine.

### Platform-Gated Constants Are A Recurring CI Failure
`cfg(unix)` / `cfg(windows)` test constants frequently break cross-platform CI even for core maintainers (#33225 needed a follow-up `gate UV_HANDLE_ACTIVE const behind cfg(unix) in test` commit). Before pushing anything that uses OS-specific types or constants in tests, mentally compile for both Unix and Windows.

### Benchmark Numbers In Performance PRs (Non-Negotiable)
Performance PRs ship with quantified before/after tables. #33110 included a 2.2x–3.5x speedup table, RFC 7539 test vectors, and edge-case tag testing. "It's faster" without numbers is rejected.

### Security-Adjacent Code Gets Post-Merge Bot Review
`@miracatbot` flags gaps after merge on permission-system / net / IPv6 / parser normalization PRs. #33223 merged in 4h with zero humans, then miracatbot flagged a missed `SocketAddr` fast-path. When touching any parser/normalizer, grep EVERY early-return and add one test per early-return branch before you submit.

### Description Archetypes Maintainers Actually Use

- **Fix PR**: 2-point bullets → root cause (with upstream reference like libuv/Node) → why both changes are needed. See #33221, #33225.
- **Security fix**: bypass example (`::ffff:127.0.0.1` vs `127.0.0.1`) → enumerated changes → checked test plan. See #33223.
- **Refactor/deletion**: Removed (bullet list of symbols/ops/structs) → Why (direction-of-travel justification) → Net result (`-102 lines`). See #33222.
- **Test PR**: enumerate invariant categories, not "added tests". See #33224 (9 categories, 23 proptests).
- **Perf PR**: benchmark table first, then implementation summary, then SAFETY justifications for unsafe blocks. See #33110.

### Test Plan Format
Checkbox list with exact reproducer commands. `- [x] deno eval 'console.log("hello")' works` is a valid entry. Smoke tests count for deletion/refactor PRs.

## Process & Workflow

### Search Open PRs Before Starting
`gh pr list -R denoland/deno --state open --search "<feature>"`. #33107 was closed as a duplicate of #33080 — quality code, wasted work. Also check for parallel architectural refactors in the same subsystem (#32888 died because a different approach to TypeScript diagnostics was being explored).

### CLA Bot Trips On Mismatched Git Email
Use the same email on GitHub and in your git config before first push. #33107 flagged a CLA mismatch that blocked merge.

### Maintainer Self-Merges Are Normal
Core maintainers (bartlomieju, littledivy) routinely self-merge with zero formal reviewers. This is expected maintainer velocity; external contributors should not assume the same cadence or bypass review.

### Link Issues Only When Acting On One
Only 1 of 20 analyzed maintainer PRs linked an issue (via `Closes #N`). External contributors should still link the originating issue — the data is skewed by maintainers authoring from internal context. `Closes #N` + `Supersedes #M` documents full lineage.

## Common Rejection Reasons

| Reason | Count | Example |
|--------|-------|---------|
| Superseded by smaller self-rewrite | 4 | #33154→#33230, #33078→#33221, #32888→#33163, #33107→#33080 |
| Too much churn, no functional payoff | 1 | #32796 (3307 lines reorg) |
| Placeholder/unfinished test | 1 | #33094 |
| Duplicate effort | 1 | #33107 |
| Stale/abandoned by contributor | 1 | #33094 never responded |

**The #1 failure mode is "too big."** Author's first attempt gets superseded by author's own smaller rewrite. Assume your first pass is over-scoped and plan to cut it.

### "Too Much Churn" Is A Verbatim Close Reason
Pure reorganization PRs die. #32796 (3307 lines across 50 files of config.jsonc splits) closed by author with "Not gonna do it — too much churn." Even if the author is a maintainer. No reorg-only PRs without a concrete behavioral driver.

### AI Thoroughness = Over-Scoping
`root cause fix + defense in depth + bonus fix` is a classic AI description shape. #33078 had all three and was closed; the superseding #33221 kept only the defense-in-depth piece (one file, 20 lines). File every concern as a separate PR.

## Success Patterns

### Negative-Sum Changesets Merge Fastest
#33222 (-100 net), #33221 (+15 net), #33179 (+1 net), #33196 (-1 net) all merged in <1h. Positive-only PRs above +500 lines take multiple hours with CI iteration even for maintainers.

### Cross-PR Lineage In The Description
"This is the write-side complement to #33219", "Supersedes #33078", "Closes #33069" — lineage references in #33221 set review expectations and document the arc. When your PR is part of a series or replaces another, name the other PR.

### Upstream-Reference Technical Narrative
"In libuv, `uv_pipe_open` only associates an fd with the handle…" (#33225) — grounding a fix in the upstream reference implementation's behavior (libuv, Node.js, POSIX standards) justifies it with zero back-and-forth.

### Node Compat Polyfill Pattern
New polyfill → `ext/node/polyfills/` (JS file) → register in `lib.rs` → re-export in the public module → lazy-load, defer `_initialize()` until after parent class is available (snapshot-safe). #33226 (fs.SyncWriteStream) is the template.

### Single-Line Trivial Correctness
JSON schema typo, `i8` → `c_char` cast — single-line fixes with 0 tests merge with a "Thanks" reply (#33196, #33179). But don't generalize: these are the exception, not the default.

### Pre-compute Invariants At Registration
For perf work on callback hot paths: canonicalize / resolve / normalize at registration time, not inside the poll/event callback. #33123 moved path canonicalization out of the watcher callback and exposed latent bugs it had been masking.

### Reverts Are The Fast Path
Reverts of already-shipped behavior changes merge in hours with minimal description. But the original merge was usually premature — behavior changes to test/runtime semantics should ship behind a config opt-in first, flip default later (#33215).

## Quick Checklist Before `gh pr create`

1. **Scope**: Is this one change, or three? Split before submitting.
2. **Search**: `gh pr list -R denoland/deno --state open --search "<keyword>"` — any overlap?
3. **Platform constants**: Any test uses OS-specific types/constants → `#[cfg(...)]` gate.
4. **Early returns**: If touching a parser/normalizer, grep every `return` and add a test per branch.
5. **Test plan**: Checked boxes with exact reproducer commands, not "works locally".
6. **Clippy**: No `#[allow]` unless you can justify it in a comment.
7. **Deletion**: `RUSTFLAGS="-D warnings"` check in test plan.
8. **Perf**: Benchmark table in body, not "it's faster".
9. **Disclose AI**: `🤖 Generated with Claude Code` (or equivalent) if AI assisted.
10. **Link issue**: `Closes #N` if fixing a tracked bug; `Supersedes #M` if replacing another PR.
11. **Title**: Conventional Commit with valid prefix; stands alone as the squash commit.
12. **Commit email**: Matches GitHub-registered email (CLA gate).
