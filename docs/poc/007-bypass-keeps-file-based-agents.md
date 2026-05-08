# PoC 007: KOOKR_BYPASS_ALL_PERMISSIONS must keep file-based agents discoverable

> **Date:** 2026-05-08
> **Supersedes (in part):** PoC 006 — only for the agent-discovery side-effect.
> The permission-bypass requirement from PoC 006 still holds.
> **Environment:** Claude Code v2.1.133, Linux (WSL2)

## Purpose

Empirically validate that PoC 006's `--setting-sources ""` flag — required to
prevent user `permissions.ask` rules from firing under `KOOKR_BYPASS_ALL_PERMISSIONS=true` —
also disables file-based agent discovery from `~/.claude/agents/` and
`<cwd>/.claude/agents/`, and find a flag combination that keeps the bypass
behavior while restoring agent discovery.

## Background

PoC 006 chose this argv combination for `KOOKR_BYPASS_ALL_PERMISSIONS=true`:

```
--dangerously-skip-permissions   (sets mode = bypassPermissions)
--setting-sources ""             (skips file-based ask/deny/allow sources)
```

The trade-off section of PoC 006 acknowledged that user-level deny rules,
project hooks, and `.claude/settings.local.json` overrides would no longer
load. What it did not document — and what was discovered empirically in a
Kookr-spawned session on 2026-05-08 — is that **`--setting-sources ""` also
disables discovery of file-based agents** declared in:

- `~/.claude/agents/*.md` (user scope)
- `<cwd>/.claude/agents/*.md` (project scope)

In Kookr-spawned sessions with bypass mode on, only built-in subagents
(`Explore`, `general-purpose`, `Plan`, `statusline-setup`) and agents loaded
via `--plugin-dir` (e.g. `kookr-toolkit:*`) appear. Project-scope agents like
`oss-issue-scout` — which the user runs from inside Kookr to scout OSS
issues — silently disappear.

## Test setup

Synthetic HOME and CWD with a permissions.ask rule plus one user-scope and
one project-scope agent:

```
$HOME/.claude/settings.json:
  { "permissions": { "ask": ["Bash(echo *)"] } }

$HOME/.claude/agents/synthetic-user-agent-x7q9.md:
  ---
  name: synthetic-user-agent-x7q9
  description: ...
  model: haiku
  ---
  ...

$CWD/.claude/agents/synthetic-project-agent-z2p4.md:
  ---
  name: synthetic-project-agent-z2p4
  description: ...
  model: haiku
  ---
  ...
```

Each invocation is non-interactive (`--print`). Two probes per candidate:

1. **Ask probe** — `"Run bash command: echo permcheck-X"`. Pass = empty
   `permission_denials`.
2. **Discovery probe** — `"List subagent_type values containing 'synthetic'.
   One per line. If none, say NONE."`. Pass = both synthetic agent names
   appear in output.

## Test 0: Reproduce the bug (current Kookr behavior)

```bash
claude --print --setting-sources "" --dangerously-skip-permissions \
       --output-format json "List subagent_type values..."
# → only built-ins. Both synthetic agents missing.
```

`claude agents --setting-sources ""` confirms the same — 4 active agents,
zero file-based:

```
4 active agents
Built-in agents:
  Explore · haiku
  general-purpose · inherit
  Plan · inherit
  statusline-setup · sonnet
```

Bug reproduced.

## Candidate A: explicit setting-sources + per-task --settings (merge)

```bash
claude --print --setting-sources "user,project,local" \
       --settings /tmp/kookr-settings.json \
       --dangerously-skip-permissions \
       --allowedTools "Bash" --output-format json "Run bash command: echo permcheck-A"
```

**Result:**
- Discovery probe: PASS — both synthetic agents listed.
- Ask probe: **FAIL** — `permission_denials` non-empty. The user
  `ask` rule on `Bash(echo *)` matched at evaluation rule #2 before bypass
  mode was consulted.

This matches PoC 006's "Rejected alternatives" entry: `--settings <file>`
**merges** with file-based settings rather than replacing them, so the user
`ask` array survives the merge. Restoring `--setting-sources` to a non-empty
value re-enables ask rules. Discovery and bypass cannot both hold under this
shape.

**Verdict:** rejected.

## Candidate B: synthetic per-launch `--plugin-dir`

Build a synthetic plugin tree on the fly with a stub `plugin.json` and copies
of the user/project agents in `agents/`:

```
/tmp/synth-plugin/
  .claude-plugin/plugin.json
  agents/
    synthetic-user-agent-x7q9.md
    synthetic-project-agent-z2p4.md
```

```bash
claude --print --setting-sources "" --dangerously-skip-permissions \
       --plugin-dir /tmp/synth-plugin \
       --output-format json "List subagent_type values..."
```

**Result:**
- Discovery probe: PASS — but **agents become prefixed** with the plugin name:
  `kookr-personal:synthetic-user-agent-x7q9`,
  `kookr-personal:synthetic-project-agent-z2p4`.
- Ask probe: PASS — `--setting-sources ""` still strips ask rules.
- **Side note:** symlinks in `agents/` were not followed by the plugin loader.
  Required real file copies, which means filesystem mutation per launch and a
  cleanup obligation on session end.

**Verdict:** rejected for the name-prefix change. Code that calls
`Agent({ subagent_type: "oss-issue-scout" })` would have to switch to
`subagent_type: "kookr-personal:oss-issue-scout"`, which is a behavior
change that breaks existing skills and slash-command flows.

## Candidate E (chosen): inline `--agents <json>`

`claude --help` lists a flag whose existence is the cleanest answer:

```
--agents <json>   JSON object defining custom agents (e.g.
                  '{"reviewer": {"description": "...", "prompt": "..."}}')
```

The flag accepts a serialized map of `name → {description, prompt, model?}`,
identical to the shape produced by parsing a `.claude/agents/*.md` file's
frontmatter and body. Agents injected this way:

1. Keep their original names (no plugin prefix).
2. Are not subject to setting-source filtering — they live on argv.
3. Coexist with `--setting-sources ""` so PoC 006's bypass behavior is
   preserved unchanged.

```bash
AGENTS_JSON=$(node build-agents-json.mjs)  # parses ~/.claude/agents + cwd/.claude/agents
claude --print --setting-sources "" --dangerously-skip-permissions \
       --agents "$AGENTS_JSON" \
       --allowedTools "Bash" --output-format json "Run bash command: echo permcheck-E"
```

**Result:**
- Discovery probe: PASS — both `synthetic-user-agent-x7q9` and
  `synthetic-project-agent-z2p4` listed by exact name.
- Ask probe: PASS — `permission_denials` empty.

Repeated against the real Kookr cwd with the actual `oss-issue-scout.md`
(32 KB body) and `kb-scout.md` (4.7 KB body): a 37 KB serialized JSON passes
through argv without truncation. ARG_MAX on the test host is 3.2 MB, so even
a corpus of ~100 agents averaging 10 KB each fits comfortably.

**Verdict:** chosen.

## Conclusion

`KOOKR_BYPASS_ALL_PERMISSIONS=true` now requires three argv contributions
when file-based agents are present:

```
--dangerously-skip-permissions    (PoC 006 — sets mode = bypassPermissions)
--setting-sources ""              (PoC 006 — strips ask/deny/allow sources)
--agents <json>                   (PoC 007 — re-injects file-based agents)
```

The `--agents` JSON is built per-launch by reading
`~/.claude/agents/*.md` and `<cwd>/.claude/agents/*.md`, parsing the
`---` frontmatter for `name`, `description`, optional `model`, and using the
post-fence body as `prompt`. Project-scope wins on name collision, matching
Claude Code's native precedence.

When no file-based agents are found, `--agents` is omitted (an empty JSON
object would be harmless but adds noise to argv).

## Trade-off

The injected agents are read at launch time. If the user edits an agent file
mid-session, the change won't take effect until the next session — same
behavior as Claude Code's native discovery, so no regression. The argv now
carries each agent's full prompt body, which inflates argv size; on the
~3 MB ARG_MAX of a typical Linux host this is not a concern, but a corpus of
hundreds of multi-KB agents would eventually need a fallback path (write the
JSON to a temp file and pass via shell substitution, or skip injection past
a size threshold). Not currently an issue.

## Rejected alternatives

| Mechanism | Why rejected |
|---|---|
| Drop `--setting-sources ""` and rely on `--dangerously-skip-permissions` | Reverts PoC 006 — user `ask` rules fire again. Kookr's autonomous flows would re-stall on `gh pr create`. |
| `--setting-sources "user,project,local"` + `--settings <kookr-file>` (Candidate A) | `--settings` merges; user `ask` array survives the merge. |
| Synthetic per-launch `--plugin-dir` (Candidate B) | Forces a `kookr-personal:` name prefix. Breaks any `subagent_type: <name>` invocation that relied on the original short name. |
| Pre-process `~/.claude/settings.json` into a temp file with permissions stripped, pass via `--settings` | Still subject to merge precedence — has the same defect as Candidate A. Also leaks user secrets if the temp file is not carefully managed. |

## Frontmatter parser scope

Real agents in `~/.claude/agents/` use a non-trivial subset of YAML —
block scalars (`description: |`), folded scalars (`description: >`), and
list values (`tools:` followed by indented `- ...`). A naive
`key: value`-only parser turns `description: |` into the literal string
`"|"` and silently drops the indented continuation, which would inject a
broken description into Claude Code under bypass mode while the same agent
loads fine outside bypass mode.

The parser in `file-based-agents.ts` therefore handles:

- `key: value` (with single-or-double-quote stripping)
- `key: |` literal block scalar — joined with `\n`, dedented to the
  smallest leading indent
- `key: >` folded block scalar — non-blank lines joined with single space
- `key:` followed by indented list/mapping continuation — value dropped, but
  continuation lines are skipped so the next top-level key is parsed correctly

A real YAML library (`js-yaml`, `yaml`) would be more correct but adds a
runtime dependency for one hot path. Empirically, every agent file in
`~/.claude/agents/` and `<cwd>/.claude/agents/` parses to the same shape as
Claude Code's native loader produces.

## Implementation pointer

- `src/adapters/file-based-agents.ts` — frontmatter parser + scope-aware
  loader that returns the JSON-ready map.
- `src/adapters/claude-code-adapter.ts` — gated on `bypassAllPermissions`,
  appends `--agents <json>` after `--setting-sources ""` when the loader
  returns a non-empty map.
