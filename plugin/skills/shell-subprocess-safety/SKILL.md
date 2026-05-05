---
name: shell-subprocess-safety
description: Shell subprocess safety patterns - execFileSync over execSync, array arguments, shell feature replacements, static analysis guards. Use when spawning child processes, running git/docker/system commands, or reviewing code that calls execSync.
keywords: execSync, execFileSync, spawnSync, shell injection, command injection, child_process, CWE-78, shellQuote, escapeShellArg, template literal, subprocess, git command, docker command
related: error-handling-patterns, process-lifecycle-patterns, cross-language-contract-propagation, testing-patterns
---
# Shell Subprocess Safety
## When to Use
- Writing code that calls external binaries (git, docker, lsof, grep, etc.)
- Reviewing code that uses `execSync()`, `child_process`, or shell commands
- Migrating existing shell-interpolated commands to safe patterns
- Adding new system commands to production code or scripts

## Non-Negotiable Rules
| # | Rule | Violation | Correct |
|---|------|-----------|---------|
| 1 | **Never `execSync` with interpolation** | `` execSync(`git checkout ${branch}`) `` | `execFileSync('git', ['checkout', branch])` |
| 2 | **Never `execSync` with concatenation** | `execSync('git checkout ' + branch)` | `execFileSync('git', ['checkout', branch])` |
| 3 | **No shell quoting helpers** | `shellQuote(val)`, `escapeShellArg(val)` | Not needed — `execFileSync` bypasses shell |
| 4 | **Array args for all binaries** | `execFileSync('git', 'checkout main')` | `execFileSync('git', ['checkout', 'main'])` |
| 5 | **Validate untrusted input** | Pass raw user string to binary | Validate format (hex SHA, port range) before exec |

## Shell Feature Replacements
| Shell Feature | Node.js Replacement |
|---|---|
| `cmd 2>/dev/null` | `execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] })` |
| `cmd \|\| true` | `try { execFileSync(...) } catch { /* handle or ignore */ }` |
| `cmd1 \| cmd2` | `spawnSync(cmd2, args2, { input: execFileSync(cmd1, args1) })` |
| `cat file \| cmd` | `execFileSync(cmd, args, { input: readFileSync(file) })` |
| `echo "text"` | Return string directly or `Buffer.from(text)` |
| `sleep N` | `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, N * 1000)` |

## Wrapper Method Pattern
```typescript
// CORRECT: Private wrapper accepts string[] — all call sites pass arrays
private git(args: string[]): string {
    return execFileSync('git', args, {
        cwd: this.workingDir,
        stdio: 'pipe',
        timeout: 30_000,
        encoding: 'utf-8',
    }).trim();
}

// Usage — no shell interpretation of metacharacters
this.git(['checkout', branchName]);
this.git(['merge', '--no-ff', '-m', commitMessage, sourceBranch]);
this.git(['checkout', '--theirs', '--', filePath]);
```

## Input Validation Patterns
```typescript
// SHA validation — hex characters only
function assertSha(sha: string): void {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
        throw new Error(`Invalid SHA: ${sha}`);
    }
}

// Port validation — numeric range
function assertPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${port}`);
    }
}
```

## Static Analysis Guard
Run `bun run scripts/lint-execsync.ts` to detect violations:
- **SA-SINJ-001**: `execSync` with template literal
- **SA-SINJ-002**: `execSync` with string concatenation

Add to CI pipeline or pre-commit hook to prevent regression.

## Common Pitfalls
| Pitfall | Why It Fails | Fix |
|---|---|---|
| `execFileSync('git', 'checkout main')` | Second arg is string not array | Always pass `string[]` |
| `execFileSync('sh', ['-c', cmd])` | Still spawns shell — defeats purpose | Call binary directly |
| `execSync(staticString)` without interpolation | OK but inconsistent | Prefer `execFileSync` for consistency |
| Forgetting `encoding: 'utf-8'` | Returns Buffer not string | Always pass encoding option |
| Not handling exit code 1 | grep returns 1 for no matches | Wrap in try/catch, check `status` |

## See Also
- [[error-handling-patterns]] — try/catch discipline for failed commands
- [[process-lifecycle-patterns]] — signal handling and cleanup
- [[cross-language-contract-propagation]] — when shell scripts also call same binaries
- [[testing-patterns]] — testing subprocess calls with mocked execFileSync
