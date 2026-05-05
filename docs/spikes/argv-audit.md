# Prereq B — argv Audit

**Status:** Complete
**Date:** 2026-04-21
**Outcome:** Clean conversion — **no wrapper scripts needed.** Main B can refactor `command: string` → `SessionSpec.args: string[]` directly without any `execFile`/`eval`/`sh` shim layer.

## Goal

v7 Main B replaces the shell-string `command: string` with `SessionSpec { command, args[], env }`. To do this safely we need to enumerate every shell feature used by today's agent-launch code paths and map each to an argv equivalent. Anything that does not map cleanly must ship as a per-adapter wrapper script with a binding contract (`execFile`-only, no `eval` / `$(…)` / backticks).

## Method

Static read of the three files that together produce the command string passed to `TerminalManager.createSession`:

- `src/adapters/agent-launch-context.ts` — env assembly + single-quote escape (`buildEnvPrefix`, `shellQuote`)
- `src/adapters/claude-code-adapter.ts` — final command string (line 118)
- `src/adapters/codex-cli-adapter.ts` — final command string (line 152)

Metric used: **shell-metachar count across both adapters.** LoC is the wrong metric — a 95-LoC wrapper with one `eval` is RCE; a 300-LoC wrapper of `execFile` calls is safe.

## Findings

### Claude Code adapter — line 118

```ts
const command = `${envPrefix} ${this.agentBin} ${bypassFlag}${checkpointFlag}--settings ${settingsPath} '${escapedPrompt}'`;
```

Shell features present:

| Feature | Source | argv equivalent |
|---|---|---|
| `env KEY='value' KEY2='value2' …` prefix | `buildEnvPrefix` | `SessionSpec.env: Record<string, string>` — passed to node-pty / child spawn as `options.env`. No shell involvement. |
| Single-quote escape of prompt (`'${escapedPrompt}'`) | inline string interpolation | not needed — prompt becomes a single argv element, passed verbatim to `exec`. No quoting. |
| `--settings <path>` flag | string interpolation of `settingsPath` | two argv elements: `['--settings', settingsPath]`. No quoting. |
| `--dangerously-skip-permissions` conditional flag | `bypassFlag` string | push into argv array conditionally: `if (bypass) args.push('--dangerously-skip-permissions')`. |
| `--append-system-prompt '…'` conditional flag | `checkpointFlag` string | same pattern: `if (checkpoint) args.push('--append-system-prompt', CHECKPOINT_LOAD_INSTRUCTION)`. Single-quote escape disappears. |

**No** `&&` / `||` / `;` / `\|` / subshells / redirection / backticks / `$()` / tilde expansion. Paths are absolute (`settingsPath` built from `settingsDir` joined via `/`). No glob expansion. No process substitution.

### Codex CLI adapter — line 152

```ts
const command = `${envPrefix} ${this.agentBin} -c features.codex_hooks=true ${permissionFlag} --settings ${settingsPath} '${escapedPrompt}'`;
```

Shell features present:

| Feature | Source | argv equivalent |
|---|---|---|
| `env` prefix | shared with Claude Code path | `SessionSpec.env` |
| `-c features.codex_hooks=true` | literal string | two argv elements: `['-c', 'features.codex_hooks=true']` |
| `--full-auto` OR `--dangerously-bypass-approvals-and-sandbox` | `permissionFlag` string | conditional `args.push(...)` |
| `--settings <path>` | same as Claude | two argv elements |
| Single-quoted prompt | same as Claude | single argv element, verbatim |

**No** shell features beyond what Claude Code uses. Same conclusion.

### Shared — `agent-launch-context.ts:buildEnvPrefix`

The only shell-escape logic in the current call path is `shellQuote` at lines 107-109:

```ts
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
```

This exists purely because `buildEnvPrefix` emits a shell string of the form `env KEY='value' KEY2='value2'`. Once we pass env via `SessionSpec.env: Record<string, string>` (a JS object passed directly to `node-pty`'s `options.env`), **this function and its callers are deleted entirely.** No quoting logic remains in the launch path.

## Shell metachar count across both adapters

**Zero** — after the conversion. Today there are:
- ~4 single-quote escapes (env values, prompt)
- 0 `&&` / `||` / `;` / `\|` / subshells / backticks / `$()`
- 0 redirection operators
- 0 glob expansion

All four single-quote escapes disappear because argv passes each value as a distinct element, unparsed by any shell.

## Decision

**Main B converts the adapters to `SessionSpec` directly. No wrapper scripts. No third prerequisite PR.**

The wrapper-script contingency documented in the v7 RFC §Prereq B ("if wrapper LoC > 100 or any `eval`/`$()`/backticks, ship wrappers in a separate security-sensitive PR") does **not trigger** — the audit found zero shell features that would require wrapping.

## What Main B does in the adapters

Replace this (Claude Code):
```ts
const command = `${envPrefix} ${this.agentBin} ${bypassFlag}${checkpointFlag}--settings ${settingsPath} '${escapedPrompt}'`;
await this.terminal.createSession(tmuxName, command, { cwd, width: 200, height: 50 });
```

With this:
```ts
const args: string[] = [];
if (this.bypassAllPermissions) args.push('--dangerously-skip-permissions');
if (checkpointDir) args.push('--append-system-prompt', CHECKPOINT_LOAD_INSTRUCTION);
args.push('--settings', settingsPath, prompt);

await this.backend.createSession({
  id: tmuxName,
  command: this.agentBin,
  args,
  env: launchContext.env,
  cwd,
  size: { cols: 200, rows: 50 },
});
```

Equivalent structural change for Codex CLI (add `['-c', 'features.codex_hooks=true']`, switch flag on `bypassAllPermissions`).

## Secondary benefits

- **Injection safety.** A prompt containing single quotes, command-substitution syntax (`$(...)`), or backticks can today only be exploited through a shell-parsing bug in tmux's `send-keys` path. Argv passing removes the entire attack surface — no shell parses the prompt, period.
- **No `shellQuote` to maintain.** The regex-based escape at `agent-launch-context.ts:107-109` is a small but real correctness hazard (shell quoting rules differ subtly between `sh` and `bash` for edge cases like `$'…'`). Deleting it removes that hazard.
- **Env values pass verbatim.** If an env value ever contained a byte that tripped shell parsing, today's path would silently corrupt it. argv passing removes that risk too.

## Out of scope

This audit only covers the two adapter-to-terminal paths. It does **not** audit:

- **Hook invocation paths** — `generateSettings()` writes JSON consumed by Claude Code / Codex CLI's own hook runner. No change in Main B.
- **Auto-relaunch** — `crash-recovery.ts` calls `adapter.launch(...)` with the same arguments the initial launch received; no new shell parsing is introduced.
- **Prompt contents themselves** — the prompt is user-generated text that will reach the agent's system-prompt injection path unchanged. Separate concern from terminal backend.
