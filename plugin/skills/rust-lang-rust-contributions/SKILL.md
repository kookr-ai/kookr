---
name: rust-lang-rust-contributions
description: Contributing tests and PRs to rust-lang/rust — test writing conventions (naming, headers, directives, verification), pre-push checklist, and human-sounding PR descriptions — applies to the rust-lang/rust repository only, not to other Rust projects.
keywords: rust-lang, rust compiler, regression test, ICE test, E-needs-test, compiletest, build-pass, check-pass, tests/ui, tests/crashes, pre-push, push, before push, submit PR, rust PR
related: oss-repo-recon, pre-pr-review, pr-contribution-excellence, git-commit-discipline
---

# Contributing to rust-lang/rust

Merged from the former `rust-lang-rust-tests` and `rust-lang-rust-pre-push`
skills — one flow: write the test, run the pre-push checklist, write the PR.
Every rule here was learned from actual reviewer pushback or CI failures.

Reference: <https://rustc-dev-guide.rust-lang.org/tests/best-practices.html>

## Part 1 — Writing Tests

### Mandatory: verify before submitting

**ALWAYS compile the test reproducer locally with `rustc +nightly` before committing.** The compiler evolves fast — reproducers from issues may no longer behave as described. A `build-pass` test that doesn't compile will fail CI and waste reviewer time.

```bash
# For build-pass / check-pass tests: must exit 0
rustc +nightly [compile-flags] <test-file>.rs 2>&1; echo "Exit: $?"

# For error tests: verify the exact errors match what you expect
rustc +nightly <test-file>.rs 2>&1
```

If the reproducer no longer compiles as the issue describes, investigate what changed. The test may need to become an error test instead of build-pass, or the reproducer may need adapting. Don't submit blind.

### Test naming

Name tests after **what they exercise**, not just the issue number.

```
# BAD — issue number alone or leading
issue-149035.rs
ice-issue-149035.rs

# GOOD — descriptive, issue number at end
generic-const-exprs-link-dead-code-ice-149035.rs
transmute-from-min-generic-const-args-ice-150457.rs
recursive-lazy-type-alias-ice-152633.rs

# Also acceptable — descriptive without issue number
generic-const-exprs-link-dead-code-ice.rs
```

**Exception:** `tests/crashes/` uses issue numbers only (e.g., `149035.rs`). This is the canonical convention for that directory.

### Test header

Use `//!` inner doc comments. Follow this template from the rustc-dev-guide:

```rust
//! Brief summary of what the test exercises.
//!
//! Optional: remarks on related tests, fix mechanism, etc.
//!
//! Regression test for <https://github.com/rust-lang/rust/issues/NNNNN>.
```

Rules:
- First line: what the test exercises (not "Regression test for..." — that goes at the end)
- Issue links as full URLs in angle brackets: `<https://github.com/rust-lang/rust/issues/NNNNN>`
- Keep it concise. Don't over-explain.

### Compiletest directives

A directive comment must explain **why the directive is needed** — never why you chose it over alternatives:

```rust
//@ compile-flags: -Clink-dead-code=true (required to trigger the codegen path)   // OK: why it's needed
//@ ignore-wasi (wasi codegens the main symbol differently)                       // OK: why it's needed
//@ check-pass (ICE was in wfcheck, not codegen)                                  // REMOVE: choice reasoning
```

If the parenthetical reads like you justifying a decision to a reviewer, delete it; if it states a precondition the directive satisfies, keep it.

### Attributes

- **Do NOT add `#![allow(incomplete_features)]`** — compiletest auto-injects `-A incomplete_features`
- **Do NOT add `#![allow(dead_code)]`** or `#![allow(unused)]` — compiletest auto-injects `-A unused` for pass tests
- **DO use** `#![feature(...)]` as needed
- **Attribute order:** `#![feature(...)]` first, then any `#![allow(...)]` if actually needed

### Choosing test type

| Scenario | Directive | When |
|----------|-----------|------|
| Code should compile + link | `//@ build-pass` | ICE was in codegen/linking |
| Code should type-check | `//@ check-pass` | ICE was in analysis/wfcheck |
| Code should error (not ICE) | No directive + `//~ ERROR` annotations + `.stderr` | Fixed ICE now produces proper errors |
| Code still ICEs (unfixed) | `//@ known-bug: #NNNNN` in `tests/crashes/` | Bug not yet fixed |

For error tests, **generate `.stderr` with `--bless`** or verify against actual `rustc +nightly` output. Never hand-craft `.stderr` files without verification.

## Part 2 — Pre-Push Checklist

Run this before every `git push` to rust-lang/rust.

1. **Local verification** — reproducer compiled with `rustc +nightly`; behavior matches expected (Part 1 rules).
2. **Test file naming** — descriptive name, issue number at the end only; reject `issue-NNNNN.rs` / `ice-issue-NNNNN.rs` shapes.
3. **Test header** — `//!` first line describes what the test exercises; full issue URL in angle brackets; no `#NNN` shorthand (rustbot flags these in commits).
4. **Attributes** — no auto-injected `allow`s; `#![feature(...)]` first.
5. **Directives** — correct test type for where the ICE lived; directive comments state why needed, never choice reasoning.
6. **Commit message** (`git log --oneline -1`) — no `#NNNNN` issue references in the body; no `Closes`/`Fixes`/`Resolves` keywords (those go in the PR body only).
7. **PR title** — describes what the test exercises, not just an issue number:

   ```
   # Bad
   Add regression test for #149035

   # Good
   Add regression test for mono item collection ICE with generic_const_exprs
   ```

8. **PR description** — passes the LLM-tells check (Part 3); 2–4 sentences max for a regression-test PR.
9. **`.stderr` files** (if applicable) — generated from actual `rustc +nightly` output, not hand-crafted; line numbers match the final file (headers shift lines); `$DIR/filename.rs` matches the actual filename; `LL |` replaces line numbers in source display; warnings compiletest suppresses (`incomplete_features`, `unused`) are NOT present.
10. **No manual `r?`** — let triagebot assign.

## Part 3 — PR Descriptions

Write like a human. Short, direct, no filler.

```
# BAD — sounds like an LLM
Add a `build-pass` regression test for #149035. Using `-Clink-dead-code=true`
with `generic_const_exprs` and `min_generic_const_args` previously caused an
ICE (`erroneous constant missed by mono item collection`). This was fixed by
#152129, but no regression test was added for this specific scenario. The test
exercises the exact reproducer from the issue report.

# GOOD — sounds like a person
Regression test for #149035.

The ICE in mono item collection with `-Clink-dead-code=true` was fixed by
#152129 but had no test. Added one.

Closes #149035
```

Key tells that flag LLM-generated text:
- Backtick-heavy formatting in prose
- Parenthetical explanations after every term
- "This was fixed by X, but no Y was added for this specific scenario"
- "The test exercises the exact reproducer from the issue report"
- Perfect grammar with no contractions
- Bullet-point-heavy structure for simple descriptions

Instead: use contractions, be terse, skip the obvious.
