---
name: token-efficiency
description: Reduce token waste — avoid redundant reads, duplicate searches, unnecessary tool calls. Use when planning tool usage or when context is getting large.
keywords: tokens, efficiency, context, optimization, redundant, duplicate, waste, tool calls, performance, cost
related: testing-patterns
---

# Token Efficiency Patterns

Minimize token consumption without sacrificing correctness. Every unnecessary tool call burns tokens and slows the conversation.

## Core Principle

Before each tool call, ask: **"Do I already have this information in context?"** and **"Can I combine this with another call?"**

## Patterns

### 1. Delegate fan-out exploration by default

For broad or read-heavy exploration, use an available exploration subagent by
default. This includes multi-file searches, repo orientation, knowledge-base
scouting, dependency tracing, and any task where the main value is the
conclusion rather than the raw file dumps.

Ask the subagent to return a compact summary with file paths, line references,
and the smallest relevant excerpts. Keep the orchestrator's context for
decisions, edits, and verification instead of filling it with exploratory read
output.

Stay direct for single known-file reads, targeted grep lookups, or edits where
the orchestrator needs the exact nearby code.

### 2. Don't re-read files after entering a worktree

Worktrees clone HEAD. Files read before `EnterWorktree` are identical in the worktree. Use the content already in context instead of reading again.

### 3. Prefer one Write over multiple Edits

When rewriting more than ~50% of a file, a single `Write` is cheaper than multiple `Edit` calls. Each tool call has fixed overhead (request, response framing, permission check).

**Rule of thumb:** If you need 4+ Edits to a file, consider a single Write instead.

### 4. Run the full test suite directly

Don't run a single test file then the full suite. The full suite covers everything in one pass. Only run a single file when you need to iterate on a specific failing test.

### 5. Don't duplicate glob patterns

Use one brace pattern like `*.{test,spec}.ts` instead of separate overlapping globs (`*.test.ts` does not match `.spec.ts` files).

### 6. Use Grep over Read for type lookups

When you only need one type definition from a large file, grep for it instead of reading the whole file. Grep returns just the matching lines.

```
# Good: targeted lookup
Grep("interface TaskConfig", type: "ts")

# Wasteful: reading 500 lines to find one interface
Read("src/core/types.ts")
```

### 7. Parallelize independent tool calls

When you need to read multiple files or run multiple searches, issue them all in one message instead of sequentially. Independent reads, greps, and globs can all run concurrently.

### 8. Batch known read sets up front

When a reflection, review, or analysis loop already knows it must inspect N
specific files before reasoning, issue one batched read instead of N sequential
reads. This is especially useful for "read N files -> analyze" loops, where the
analysis cannot start until the whole known set is available.

### 9. Don't re-read what you just wrote

After a Write or Edit, you already know the file contents — you just specified them. Don't read the file to "verify" unless you suspect the tool failed.

### 10. Batch git operations

Instead of separate `git add`, `git status`, `git diff` calls, combine what you can:
```bash
git add file1.ts file2.ts && git status
```

### 11. Scope reads with offset/limit

For large files where you only need a specific section, use `offset` and `limit` parameters on Read instead of reading the entire file.

## Anti-Patterns

| Wasteful | Efficient |
|----------|-----------|
| Main agent reads many files to orient itself | Available exploration subagent returns concise findings with paths |
| Read file → Edit 1 line → Read file again | Read file → Edit 1 line |
| Glob `*.test.ts` + Glob `*.spec.ts` | Glob `*.{test,spec}.ts` |
| Read 2000-line file for one type | Grep for the type name |
| Read file A -> read file B -> read file C -> analyze | Batch known file reads -> analyze |
| Run one test → run all tests | Run all tests once |
| Enter worktree → re-read all files | Enter worktree → use context |
