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

### 1. Don't re-read files after entering a worktree

Worktrees clone HEAD. Files read before `EnterWorktree` are identical in the worktree. Use the content already in context instead of reading again.

### 2. Prefer one Write over multiple Edits

When rewriting more than ~50% of a file, a single `Write` is cheaper than multiple `Edit` calls. Each tool call has fixed overhead (request, response framing, permission check).

**Rule of thumb:** If you need 4+ Edits to a file, consider a single Write instead.

### 3. Run the full test suite directly

Don't run a single test file then the full suite. The full suite covers everything in one pass. Only run a single file when you need to iterate on a specific failing test.

### 4. Don't duplicate glob patterns

`*test*` already covers `.spec.` files. One glob with a broad pattern is better than multiple narrow globs that overlap.

### 5. Use Grep over Read for type lookups

When you only need one type definition from a large file, grep for it instead of reading the whole file. Grep returns just the matching lines.

```
# Good: targeted lookup
Grep("interface TaskConfig", type: "ts")

# Wasteful: reading 500 lines to find one interface
Read("src/core/types.ts")
```

### 6. Parallelize independent tool calls

When you need to read multiple files or run multiple searches, issue them all in one message instead of sequentially. Independent reads, greps, and globs can all run concurrently.

### 7. Don't re-read what you just wrote

After a Write or Edit, you already know the file contents — you just specified them. Don't read the file to "verify" unless you suspect the tool failed.

### 8. Batch git operations

Instead of separate `git add`, `git status`, `git diff` calls, combine what you can:
```bash
git add file1.ts file2.ts && git status
```

### 9. Scope reads with offset/limit

For large files where you only need a specific section, use `offset` and `limit` parameters on Read instead of reading the entire file.

## Anti-Patterns

| Wasteful | Efficient |
|----------|-----------|
| Read file → Edit 1 line → Read file again | Read file → Edit 1 line |
| Glob `*.test.ts` + Glob `*.spec.ts` | Glob `*.{test,spec}.ts` |
| Read 2000-line file for one type | Grep for the type name |
| Run one test → run all tests | Run all tests once |
| Enter worktree → re-read all files | Enter worktree → use context |
