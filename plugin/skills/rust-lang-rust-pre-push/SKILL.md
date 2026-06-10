---
name: rust-lang-rust-pre-push
description: Pre-push checklist for rust-lang/rust PRs — catches naming, verification, description, and convention issues before they reach reviewers Applies to the rust-lang/rust repository only — not to other Rust projects.
keywords: rust-lang, rust compiler, pre-push, push, before push, submit PR, rust PR, regression test
related: rust-lang-rust-tests, pre-pr-review, oss-repo-recon
---

# Pre-Push Checklist for rust-lang/rust

Run this before every `git push` to rust-lang/rust. Every item here was learned from actual reviewer pushback or CI failures.

## 1. Local Verification

**Run the test with `rustc +nightly` before committing.** Issue reproducers go stale.

```bash
# build-pass / check-pass: must exit 0
rustc +nightly [compile-flags] <test-file>.rs 2>&1; echo "Exit: $?"

# Error tests: verify the error matches your .stderr / //~ annotations
rustc +nightly <test-file>.rs 2>&1
```

If the reproducer doesn't behave as the issue describes, investigate. Don't submit blind.

## 2. Test File Naming

Scan the test filename. Reject if it matches these patterns:

- `issue-NNNNN.rs` — just an issue number
- `ice-issue-NNNNN.rs` — issue number with generic prefix
- Anything where the issue number is the only descriptive content

The name should describe what the test exercises:

```
# Bad
ice-issue-149035.rs

# Good
generic-const-exprs-mono-collect-ice-149035.rs
```

## 3. Test Header

Check the `//!` header:

- [ ] First line describes what the test exercises (not "Regression test for...")
- [ ] Issue link uses full URL in angle brackets: `<https://github.com/rust-lang/rust/issues/NNNNN>`
- [ ] No `#NNN` shorthand issue references (these get flagged by rustbot in commits)

## 4. Attributes

Check for unnecessary attributes:

- [ ] No `#![allow(incomplete_features)]` — compiletest injects `-A incomplete_features`
- [ ] No `#![allow(dead_code)]` or `#![allow(unused)]` — compiletest injects `-A unused` for pass tests
- [ ] `#![feature(...)]` comes before any remaining `#![allow(...)]`

## 5. Directives

- [ ] Correct test type: `build-pass` only if ICE was in codegen/linking; `check-pass` if in analysis
- [ ] No parenthetical internal reasoning on directives (e.g., `//@ check-pass (ICE was in wfcheck, not codegen)` — remove the parenthetical)
- [ ] Directive comments explain why the directive is needed, not why you chose it over alternatives

## 6. Commit Message

```bash
git log --oneline -1
```

- [ ] No `#NNNNN` issue references in the commit message body
- [ ] No `Closes`, `Fixes`, or `Resolves` keywords — those go in PR body only

## 7. PR Title

The title should describe what the test exercises, not just reference an issue number:

```
# Bad
Add regression test for #149035

# Good
Add regression test for mono item collection ICE with generic_const_exprs
```

## 8. PR Description

Read it aloud. Check for LLM tells:

- [ ] No backtick-heavy formatting in prose
- [ ] No parenthetical explanations after every term
- [ ] No "this specific scenario", "the test exercises the exact reproducer"
- [ ] Uses contractions naturally ("didn't", "wasn't", not "was not", "did not")
- [ ] No bullet-point-heavy structure for simple descriptions
- [ ] Short — 2-4 sentences max for a regression test PR

## 9. .stderr Files (if applicable)

- [ ] Generated from actual `rustc +nightly` output, not hand-crafted
- [ ] Line numbers match the final test file (headers shift lines)
- [ ] `$DIR/filename.rs` matches the actual filename
- [ ] `LL |` replaces line numbers in source display
- [ ] Warnings suppressed by compiletest (`incomplete_features`, `unused`) are NOT in the .stderr
