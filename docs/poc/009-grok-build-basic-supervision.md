# PoC 009: Grok Build Basic-Supervision Viability (POC-A)

> **Date:** 2026-07-11
> **Issue:** [#1339](https://github.com/kookr-ai/kookr/issues/1339) — Phase 0A
> **RFC:** `docs/rfc/rfc-grok-build-agent-integration.md`
> **Question:** Can Kookr safely supervise **one** basic official Grok Build session?
> **Environment:** `@xai-official/grok` **0.2.93** build `f00f96316d`, Linux x86_64 (Ubuntu 22.04.3, WSL2, glibc 2.35), OAuth (grok.com), model `grok-build`
> **Artifacts:** `009-grok-build-basic-supervision/run-poc.sh` (+ `pty-interactive.py`), redacted fixtures in `009-grok-build-basic-supervision/fixtures/`, reviewed manifest `009-grok-build-basic-supervision/grok-build-compatibility.v1.json`, tests `scripts/grok-build-compatibility-manifest.test.ts` and `scripts/grok-build-hook-shapes.test.ts`

## Decision

**Constrained proceed.** All **nine POC-A hard gates pass** on the exact tested build. Proceed to the Phase 1 experimental adapter **subject to the constraints below** — supervision is not compromised, but three RFC hypotheses were falsified and must be honored in implementation. This is not an unqualified "proceed" because the first slice's assumed subagent-disable capability is unavailable and the plugin-injection mechanism differs from the RFC's assumption.

## What this PoC did (and did not) do

It ran a real, operator-installed official binary against bounded synthetic fixtures inside an isolated runner and recorded ground-truth behaviour for: binary identity, local CLI capabilities, `CLAUDE.md`/`AGENTS.md` discovery **and** following, injected Toolkit plugin discovery **and** one explicit skill invocation, additive launch-scoped monitoring hooks, a harmless tool call, a structured permission boundary, the success/failure outcome contract, subagent control, interactive dtach readiness/input, and owned process-tree cleanup.

It did **not** implement `GrokBuildAdapter`, frontend selection, production agent types, ACP, semantic resume, model mappings, usage/cost, or macOS support (all out of scope per the issue). The one small schema/decoder helper (`grok-build-compatibility.v1.schema.ts`) exists only to schema-validate the manifest; the hook-shapes test is characterization evidence, not a production normalizer.

### Safety / isolation contract actually enforced

- The binary was installed by the operator from the **official npm registry** (`npm install -g @xai-official/grok@0.2.93`); the runner never installs it and never uses `curl | bash`.
- Every invocation ran under an **isolated synthetic `HOME` + `GROK_HOME`** (`0700`), with `GROK_DISABLE_AUTOUPDATER=1` and `GROK_WORKSPACE_DATA_COLLECTION_DISABLED=1`. The operator's real project/user hooks and MCP servers were never read.
- Live turns seeded **only** `~/.grok/auth.json` into the synthetic home. The credential was never printed, never copied into `$OUTDIR`, and is not committed. The canary is a harmless marker (`CANARY_DO_NOT_LOG_…`), not a provider-token-shaped string.
- Wall-clock, output size, and process lifetime were bounded; the runner drains its own process tree. No orphan `grok` or leader process survived.

## Exact build identity

| Field | Value |
|---|---|
| Package | `@xai-official/grok@0.2.93` (npm, `license: Proprietary`) |
| npm integrity | `sha512-StW5WskGJYc3RRMylkNDyYogfJKf5tuzzdq1BMKTTHfFW3cHKABgly/r6tJWPFcnBhsWIQuW0npdZIcJCO6ugA==` |
| Advertised build | `grok 0.2.93 (f00f96316d)` |
| Canonical binary | `~/.grok/bin/grok-0.2.93` (postinstall symlink layout) |
| Real binary | ELF 64-bit static-pie, x86-64, stripped, **159,465,672 bytes**, BuildID `b2a926bda144f1fa29d85f30e4814e47c467c4ad` |
| sha256 | `4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135` |
| Ownership/perms | owner `755` (`rwxr-xr-x`) |
| Platform | linux / x86_64 / glibc 2.35 / kernel 6.6.87.2-microsoft-standard-WSL2 |

The npm package is a **16.7 KB trampoline**; the ~152 MB platform binary ships via optional dep `@xai-official/grok-linux-x64@0.2.93` (brotli-compressed, decompressed by `postinstall.js` into `~/.grok/bin/`). Identity is recorded for the **decompressed executable actually exec'd**, not the launcher.

## Hard-gate results

| # | Gate | Verdict | Evidence |
|---|---|:---:|---|
| 1 | Additive hook injection | ✅ **pass** | Two independent hook sources (simulated user + Kookr monitoring) both fired for every lifecycle event in the same session. Grok merges `~/.grok/hooks/*.json` + `~/.claude/settings.json` + plugin `hooks/hooks.json`. |
| 2 | Minimum supervision | ✅ **pass** | Harmless `echo` fired `pre_tool_use` **and** `post_tool_use` with `toolName=run_terminal_command` + `toolInput.command`; command executed (exit 0). Stable `sessionId` correlates events. |
| 3 | Permission visibility | ✅ **pass** | A Kookr `PreToolUse` hook receives `toolName`+`toolInput` and returns an explicit `{"decision":"deny"}`; the blocked command never runs (no `post_tool_use`). **Caveat:** the advertised `PermissionDenied` event did **not** fire for `--deny`-rule or hook-deny blocks in headless `-p`. Detect blocks via *PreToolUse-without-PostToolUse* + Kookr's own deny decisions, not a `PermissionDenied` event. |
| 4 | Toolkit discovery | ✅ **pass** | A synthetic Kookr toolkit plugin in `~/.grok/plugins/` is discovered by `grok inspect --json` (`provides.skills=1, hooks=true`). |
| 5 | Instruction discovery | ✅ **pass** | `grok inspect --json` lists both `CLAUDE.md` and `AGENTS.md` under `projectInstructions` in independent single-file cwds. |
| 6 | Instruction following | ✅ **pass** | Two **independent** runs from non-Kookr cwds returned the exact sentinels `CLAUDE_SENTINEL_7F3A` (CLAUDE.md-only) and `AGENTS_SENTINEL_9B2C` (AGENTS.md-only). |
| 7 | Toolkit skill invocation | ✅ **pass** | From an arbitrary cwd the model invoked the injected sentinel skill and emitted `SKILL_SENTINEL_5E1D`. |
| 8 | Interactive dtach | ✅ **pass** | TUI reached readiness (honoring `--no-alt-screen`), accepted byte-level input, initial-prompt flow worked — under a bare PTY **and** through Kookr's vendored `dtach` (`dtach -p` byte-push), draining cleanly on kill. |
| 9 | Stable outcome | ✅ **pass** | Success: `Stop.reason=end_turn` + exit 0 → `completed`. Failure (403): `Stop.reason=error` + `StopFailure{http_status:403}` + exit 1 → `terminated`. **Note:** `SessionEnd` does **not** fire in headless `-p`. |
| 10 | Child control | ✅ **pass** (via correlation) | `subagent_start` carries a distinct `subagentId` (child) vs `sessionId` (parent) + `subagentType` + child `transcriptPath`. **Constraint:** enforceable disablement is **not reliable** (see below). |
| 11 | Process ownership | ✅ **pass** | SIGKILL of the owned tree drained every descendant (`clean_drain=true`). Default config spawns no detached leader daemon, so nothing orphaned. |

There are no waiverable POC-A gates; every one is backed by a captured fixture referenced from the manifest.

## Outcome truth table (observed)

| Structured semantic outcome | Process end | Observed → classification |
|---|---|---|
| `Stop.reason="end_turn"` | clean exit(0) | ✅ observed → `completed` |
| `Stop.reason="error"` + `StopFailure{http_status}` | exit(1) | ✅ observed (403) → `terminated` with failure reason |
| `Stop.reason` in {`cancelled`,`shutdown`} | — | captured; treat as `terminated`/non-success |

`SessionEnd` is unreliable in headless `-p` (never fired) — Kookr must classify terminal state from `Stop.reason` + process exit, exactly as the RFC's truth table prescribes ("never infer success from process exit or a turn-level Stop alone").

## Hook schema — Grok is NOT Claude-shaped

Grok's hook payloads use **camelCase** keys, unlike Claude Code's snake_case:

| Concept | Claude Code | Grok Build 0.2.93 |
|---|---|---|
| session id | `session_id` | **`sessionId`** (UUIDv7, stable across the session) |
| event name | `hook_event_name` | **`hookEventName`** (value is snake_case, e.g. `pre_tool_use`) |
| tool | `tool_name` / `tool_input` | **`toolName`** / **`toolInput`** |
| transcript | `transcript_path` | **`transcriptPath`** (`sessions/<enc-cwd>/<sessionId>/updates.jsonl`) |
| turn | (n/a) | **`promptId`** links `UserPromptSubmit`→`Stop` |
| subagent | (n/a) | **`subagentId`** + **`subagentType`** on `SubagentStart/Stop` |

**Consequence (RFC Open Question 1 answered):** Kookr's existing `parseHookEvent()` cannot decode Grok events unchanged — Phase 1 needs a **Grok-specific decoder** (a pure helper, per the RFC — not a `ClaudeCodeAdapter` subclass). Grok's event vocabulary is a **superset** of Claude's (adds `PermissionDenied`, `SubagentStart/Stop`, `SessionEnd`, `StopFailure`, `PreCompact/PostCompact`). Reserved env includes Claude aliases (`CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`). Tool-name aliases map `Bash→run_terminal_command`, `Task→spawn_subagent`, etc. Captured shapes: `fixtures/hook-payloads.redacted.json`, `fixtures/hook-shapes.redacted.json`.

## Injection mechanism — `--plugin-dir` is not the interactive answer

- **`--plugin-dir` is `grok agent`-only.** The interactive root `grok` **rejects** `--plugin-dir` (verified: "root `--plugin-dir`: REJECTED"). It is documented as ignored in leader mode. So the RFC's assumed launch-time `--plugin-dir` injection does **not** apply to the interactive first slice.
- **Viable mechanisms (both proven):**
  - **Toolkit distribution** → sync/install the Kookr Toolkit into **`~/.grok/plugins/`** (user scope, auto-trusted, discovered by interactive `grok`). This mirrors Kookr's existing `~/.claude/plugins/` deploy flow (`deploy-routes.ts` marketplace install), and Grok ships `grok plugin install <src> --trust` + marketplaces.
  - **Launch-scoped monitoring hooks** → per-session **`GROK_HOME` composition** (proven viable in every run). Never a persistent `~/.grok` mutation as a launch side effect (RFC constraint upheld). Keep monitoring hooks out of the distributed Toolkit plugin so ordinary consumers never see them.

## Subagent control — disablement is not enforceable

Enforceable disablement was tested and **failed** in headless `-p`:

| Attempt | Result |
|---|---|
| `--no-subagents` | subagent **still spawned** |
| `--disallowed-tools spawn_subagent` | subagent **still spawned** |
| `--no-subagents --disallowed-tools spawn_subagent` | subagent **still spawned** |
| `--disallowed-tools Task` | **internal error** (session creation failed) |

The gate passes on the RFC's *alternative* path — **child identity/correlation is proven** (distinct `subagentId`, `subagentType`, child transcript, `subagent_start`). Kookr therefore **supervises** children via correlation rather than assuming they are off. `subagent_stop` did **not** fire before the headless process exited — a **late-event/drain** concern: Phase 1 must apply the RFC's bounded late-event drain (and interactive-mode behaviour is a POC-B follow-up).

## Secret handling

The canary appeared only in `UserPromptSubmit.prompt` (the user's own prompt text) and Grok's session/transcript files — the **env-injected `MY_CANARY` never leaked into any hook field**. This confirms the RFC mandate: Kookr's hook writer must **redact prompt/transcript before durable diagnostics**, because prompt text can carry secrets. No uncontrolled leak was observed.

## Blocker encountered and resolved

Initial live turns returned **HTTP 403** at `cli-chat-proxy.grok.com/v1/responses`: *"Access to the chat endpoint is denied … log into console.x.ai and update the permissions."* This reproduced from the operator's real home (not an isolation artifact) — a **grok.com OAuth account lacks chat-endpoint entitlement until granted at console.x.ai**. Notably, `SessionStart`/`UserPromptSubmit`/`Stop{reason:error}`/`StopFailure`/`Notification` hooks still fired under the 403, and the failure mapped cleanly to `terminated`. Once the operator enabled access, all live gates were exercised for real. **Regional/entitlement availability is an operational prerequisite, not an adapter bug** (RFC §7).

## Constraints Phase 1 must honor

1. **Interactive injection:** sync Toolkit into `~/.grok/plugins/`; inject monitoring hooks via per-session `GROK_HOME` composition — **not** `--plugin-dir` (agent-only) and never a persistent `~/.grok` edit.
2. **Grok-specific hook decoder:** camelCase schema; do not reuse Claude's snake_case parser or subclass `ClaudeCodeAdapter`.
3. **Subagents:** supervise via `subagent_start` correlation; do not assume `--no-subagents` disables them. Apply a bounded late-event drain for `subagent_stop`.
4. **Permission blocks:** detect via `PreToolUse`-without-`PostToolUse` + Kookr's own deny decisions; `PermissionDenied` is not a reliable signal in headless mode.
5. **Terminal classification:** use `Stop.reason` + process exit; `SessionEnd` is unreliable in headless `-p`.
6. **Build allowlisting:** only `0.2.93 / f00f96316d / linux-x86_64 / glibc 2.35` is `tested`. Other builds/platforms (incl. macOS) are unqualified and may run **only** inside the POC runner. Qualification derives solely from `grok-build-compatibility.v1.json` (CI-enforced).
7. **Access:** chat requires a console.x.ai entitlement; surface the 403 as an actionable launch-readiness diagnostic, not a crash.

## Reproduce

```bash
# 1. Operator installs the exact official build (reviewed source: official npm registry)
npm install -g @xai-official/grok@0.2.93
grok login --oauth            # requires an account with chat-endpoint access (console.x.ai)

# 2. Run the bounded, isolated POC harness (seeds only ~/.grok/auth.json for live turns)
docs/poc/009-grok-build-basic-supervision/run-poc.sh --out /tmp/grok-poc

# 3. Inspect verdicts and redacted evidence
cat /tmp/grok-poc/results.json

# 4. CI schema-validation + hook-shape characterization
npx vitest run scripts/grok-build-compatibility-manifest.test.ts scripts/grok-build-hook-shapes.test.ts
```

`run-poc.sh --no-live` (or an account still returning 403) records identity, help, discovery, and additive-hook-under-failure evidence, and marks live gates `blocked` with the exact blocker — it never invents results.

## POC-B follow-ups (not blockers)

Model aliases, semantic resume, transcript/usage/cost, MCP discovery, wider skill/agent invocation, interactive user-driven permission-deny signal shape, `subagent_stop` drain timing, macOS, and one deliberate CLI upgrade — each graduates independently per RFC Phase 0B and must not block the constrained first slice.
