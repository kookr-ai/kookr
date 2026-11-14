---
name: token-efficiency
group: meta-workflow
description: Reduce token waste — avoid redundant reads, duplicate searches, unnecessary tool calls, and keep a long agent session's context cheap and accurate (stable cached prefix, bounded tool output, batch eviction, when to summarize). Use when planning tool usage or when context is getting large.
keywords: tokens, efficiency, context, optimization, redundant, duplicate, waste, tool calls, performance, cost, prompt cache, cache hit rate, compaction, summarization, context rot, tool output truncation, long session
related: testing-patterns, agent-fleet-orchestration
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

## Long-session context policy

Every turn re-sends the whole context. In one measured agent loop about 96% of tokens were cache reads
(cheap per token, but they grow with context size times turns). Items 1 and 3 are harness settings; an
agent inside a session can apply 2, 4, 5 and 6. Items 1-3 are cheap and low-risk; 2 can lose detail if
truncation has no way back; 4 (summarizing) is the lossy one.

1. **Keep the prompt prefix byte-identical.** Put volatile fields (timestamps, paths, agent IDs) after
   the stable part or use placeholders; keep tool definitions stable. TokenPilot (2606.17016) combined
   this with eviction: cache hit rate 38.7% → 79.2%, cost -61% on PinchBench vs append-only history.
   Compaction alone gave 42% of the 61%, so prefix stability is not the whole gain (one model).
2. **Bound tool output when it enters the window; keep the full payload.** Write raw output to a file
   and name the path (capping by bytes rather than lines is our recommendation, not measured). TokenPilot
   added a re-fetch tool because truncated observations otherwise made the agent retry. Pruning file
   reads (2605.15315) saved 30.5% of tokens on Sonnet 4.5 but 3.0% on Opus 4.6 (success +1.2 / +0.4
   points): measure on your model.
3. **Evict finished steps' content in batches**, not every turn (that rewrites the cached prefix each
   turn). TokenPilot's every-3-turns is that paper's setting, not an optimum.
4. **Summarize only with a summarizer tested against full history.** SUMONE (2611.06445), a trained 2B
   summarizer, scored 0.48 F1 vs 0.52 (full history) on DeepSearchQA at about 78% lower total cost, and
   resolved 0.59 vs 0.63 on SWE-bench Verified.
   Write only vetted content into summaries: one built from toxic rollouts passed a toxicity check (mean
   0.0852) yet carried measurable influence (2605.16746); a stale summary kept reproducing a corrected
   fact in 69.8-94.3% of answers until repaired (2605.07242).
5. **Long context weakens prohibitions.** "Do not" rules fell from 73% obeyed at turn 5 to 33% at turn
   16 while "always do" rules stayed at 100% (Mistral Large 3; Gemma 4 31B did not decay; 2604.20911).
   Restating prohibitions near the end of the context, or restarting with a clean window, is untested
   advice that follows from this; clearing history beat a sliding window by 4.0 points (Qwen3-8B,
   2602.03664).
6. **Keep the main window small by design** (pattern 1): a viewer subagent cut main-agent non-cached
   input tokens 34.5% (2604.26102).

Not measured anywhere we looked: break-even between cache misses and compression, hosted-API cache
expiry effects, prompt-only rolling-summary accuracy on agent benchmarks, Claude Code auto-compact side
effects.

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
