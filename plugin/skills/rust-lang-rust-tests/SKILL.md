---
name: rust-lang-rust-tests
description: Test writing conventions for rust-lang/rust contributions — naming, headers, directives, verification, PR descriptions Applies to the rust-lang/rust repository only — not to other Rust projects.
keywords: rust-lang, rust compiler, regression test, ICE test, E-needs-test, compiletest, build-pass, check-pass, tests/ui, tests/crashes
related: rust-lang-rust-pre-push, oss-repo-recon, pre-pr-review, pr-contribution-excellence, git-commit-discipline
---

# Writing Tests for rust-lang/rust

Reference: <https://rustc-dev-guide.rust-lang.org/tests/best-practices.html>

## Mandatory: Verify Before Submitting

**ALWAYS compile the test reproducer locally with `rustc +nightly` before committing.** The compiler evolves fast — reproducers from issues may no longer behave as described. A `build-pass` test that doesn't compile will fail CI and waste reviewer time.

```bash
# For build-pass / check-pass tests: must exit 0
rustc +nightly <test-file>.rs 2>&1; echo "Exit: $?"

# For error tests: verify the exact errors match what you expect
rustc +nightly <test-file>.rs 2>&1
```

If the reproducer no longer compiles as the issue describes, investigate what changed. The test may need to become an error test instead of build-pass, or the reproducer may need adapting.

## Test Naming

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

## Test Header

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

## Compiletest Directives

Add a brief remark explaining **why** each non-obvious directive is needed:

```rust
//@ build-pass (ICE was in codegen during mono item collection)
//@ compile-flags: -Clink-dead-code=true (required to trigger the codegen path)
//@ ignore-wasi (wasi codegens the main symbol differently)
```

## Attributes

- **Do NOT add `#![allow(incomplete_features)]`** — compiletest auto-injects `-A incomplete_features`
- **Do NOT add `#![allow(dead_code)]`** — compiletest auto-injects `-A unused` for pass tests
- **DO use** `#![feature(...)]` as needed
- **Attribute order:** `#![feature(...)]` first, then any `#![allow(...)]` if actually needed

## Choosing Test Type

| Scenario | Directive | When |
|----------|-----------|------|
| Code should compile + link | `//@ build-pass` | ICE was in codegen/linking |
| Code should type-check | `//@ check-pass` | ICE was in analysis/wfcheck |
| Code should error (not ICE) | No directive + `//~ ERROR` annotations + `.stderr` | Fixed ICE now produces proper errors |
| Code still ICEs (unfixed) | `//@ known-bug: #NNNNN` in `tests/crashes/` | Bug not yet fixed |

For error tests, **generate `.stderr` with `--bless`** or verify against actual `rustc +nightly` output. Never hand-craft `.stderr` files without verification.

## PR Descriptions

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

Instead: use contractions, be terse, skip the obvious.

## Checklist

Before submitting a test PR to rust-lang/rust:

1. [ ] Compiled reproducer locally with `rustc +nightly` — behavior matches expected
2. [ ] Test named after what it exercises, not just issue number
3. [ ] `//!` header with brief description and full issue URL
4. [ ] Correct test type (`build-pass` vs `check-pass` vs error test)
5. [ ] No unnecessary `#![allow(incomplete_features)]` or `#![allow(dead_code)]`
6. [ ] `.stderr` generated from actual compiler output (if applicable)
7. [ ] PR description is short, human-sounding, no LLM tells
8. [ ] No issue links (`#NNN`) in commit messages
9. [ ] No manual `r?` — let triagebot assign
