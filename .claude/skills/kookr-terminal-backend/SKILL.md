---
name: kookr-terminal-backend
description: How Kookr runs agent terminal sessions — TerminalBackend interface, dtach persistence, KOOKR_BACKEND env var, SessionBridge routing, legacy tmux paths. Use when touching adapter launch code, session I/O, stuck detection's paneContent, reconciliation, or the circuit-breaker-registry terminal entry.
keywords: terminal, dtach, tmux, TerminalBackend, LocalDtachBackend, SessionBridge, TerminalBridge, TmuxTerminalManager, CircuitBreakerTerminalManager, KOOKR_BACKEND, bridgeKind, reconcile, captureDisplay, sendInput, agent launch
related: claude-code-hooks, logging-design-patterns
---

# Kookr Terminal Backend

Kookr runs agents (Claude Code, Codex CLI) in persistent terminal sessions so the agent survives Kookr restart. Two backends coexist in the code:

- **dtach** (`LocalDtachBackend` at `src/adapters/local-dtach-backend.ts`) — current default as of v7 Main B.b (#343, 2026-04-21). Byte-transparent. Unix-socket-based. Selected when `KOOKR_BACKEND !== 'tmux'`.
- **tmux** (`TmuxTerminalManager` at `src/adapters/tmux-terminal-manager.ts`) — legacy. Still constructed at startup. Kept for the `KOOKR_BACKEND=tmux` rollback path. Scheduled for deletion in V8 (`docs/rfc/rfc-v8-tmux-removal.md`).

## Two interface shapes (know which one you're holding)

```
TerminalManager (legacy, tmux-shaped)
├── createSession(name, command, options)
├── sendKeys(name, keys)           // text + Enter
├── pasteText(name, text)          // bracketed paste (Codex only)
├── sendKeystroke(name, key)       // single key, no Enter
├── capturePane(name, lines?)      // rendered screen text
├── isAlive(name)
├── killSession(name)
├── listSessions(prefix?)
└── setSessionOption(name, opt, val)  // tmux-only

TerminalBackend (new, backend-agnostic)
├── createSession(spec: SessionSpec): Promise<SessionHandle>
├── attachSession(id): Promise<SessionHandle>
├── listSessions(): Promise<SessionId[]>
├── isAlive(id)
└── killSession(id)

SessionHandle (returned by createSession/attachSession)
├── write(data: Uint8Array)    // byte-transparent
├── resize(cols, rows)
├── onData(cb)                 // subscribe to child PTY bytes
├── onExit(cb)
└── dispose()                  // detach; child survives
```

## Backend selection at startup

`src/server/start.ts:42`:
```ts
const BACKEND_KIND: 'tmux' | 'dtach' = process.env.KOOKR_BACKEND === 'tmux' ? 'tmux' : 'dtach';
```

- `BACKEND_KIND === 'dtach'` → `LocalDtachBackend` constructed + passed to adapters as `options.backend`.
- `TmuxTerminalManager` is **always** constructed (`start.ts:180`) and passed as `terminal`, regardless of BACKEND_KIND. This is intentional — the adapters' legacy method paths still thread through it.

## The critical seam: adapter partial wiring

`ClaudeCodeAdapter` / `CodexCliAdapter` receive both `terminal` and `backend`:

```ts
// launch() — uses backend when set:
if (this.backend) {
  await this.backend.createSession({...});   // dtach path
} else {
  await this.terminal.createSession(...);    // tmux path
}

// sendInput / sendKeystroke / stop / captureDisplay — ALWAYS use terminal:
await this.terminal.sendKeys(tmuxName, text);
```

**Consequence:** when `KOOKR_BACKEND=dtach`, sessions live in dtach, but per-session ops still call `tmux send-keys -t kookr-XXXX` → throws "no such session" → breaker increments.

**V8 fixes this by porting per-session ops onto the backend** (new `backend.write(id, bytes)` + `writeSequence(id, payloads[])`).

## The CircuitBreaker (currently named `'tmux'`)

`src/server/index.ts:220`:
```ts
const tmuxBreaker = new CircuitBreaker({ name: 'tmux', failureThreshold: 5, failureWindowMs: 60_000, resetTimeoutMs: 15_000 });
const wrappedTerminal = new CircuitBreakerTerminalManager(terminal, tmuxBreaker);
```

- Only wraps `TerminalManager` calls (the legacy path).
- Does **not** wrap dtach backend calls.
- The "tmux" label is correct re: implementation but misleading re: operator intent — failures it catches are always adapter-legacy-path calls failing for missing tmux sessions.

**Dashboard symptom:** breaker showing `open` state with 3+ failures when `KOOKR_BACKEND=dtach` is the default = not a tmux bug, it's the adapter-partial-wiring bug. RFC v8 deletes the breaker entirely in favor of backend-emitted structured `BackendError` events.

## WebSocket routing: three bridge kinds

`src/server/index.ts:745-786` — when a browser xterm.js connects to `/ws/terminal/<session>`:

1. **FakeTerminalBridge** — E2E / demo mode (`useFakeTerminalBridge`).
2. **SessionBridge** (new, byte-transparent) — if `terminalBackend?.isAlive(id)` returns true. Uses `backend.attachSession()` + ring buffer.
3. **TerminalBridge** (legacy, tmux) — fallback. Spawns `tmux attach -t <id>` via node-pty. Used when dtach doesn't know the session (e.g., pre-V7 tmux-era session, or a stale session ID from task store).

Sessions with `kind=terminal` bridge opens in the log are the tell-tale sign of a task whose session ID points to a session that dtach does not have.

## dtach on-disk layout

- **Sockets:** `/tmp/kookr-dtach/<uid>/<instanceId>/<sessionId>.sock` (e.g. `/tmp/kookr-dtach/1000/port-4800/kookr-c1c8bcc4.sock`).
- **Manifest:** `/tmp/kookr-dtach/<uid>/<instanceId>/manifest.json` — array of `{sessionId, pid, startedAt, status, sock}`. Written atomically via temp+rename. `LocalDtachBackend` owns this exclusively.
- **Per-instance isolation:** `instanceId = port-${PORT}`. `kookr-prod` (port 4800) and dev (4801) never collide.
- **Session ID cap 40 chars** — keeps socket paths under Linux UDS 107-byte limit.
- **The instance directory self-heals (#3042).** It lives in `/tmp`, so an OS temp sweeper, `scripts/rollback-dtach.sh`, or a stray `rm` can delete it while the server runs. Every write path (`DtachManifestStore.writeAtomic`, `LocalDtachBackend.createSession`, `DtachRingStore.persist`) re-creates it via `ensureDtachDir` immediately before writing. Before that fix it was created once in the backend constructor, so losing it made **every** launch fail with a bare `ENOENT` on the manifest temp file until the server was restarted. If you see that ENOENT in `~/.kookr/server.log`, `mkdir -p` the directory — no restart needed.

## Reconciliation

`src/server/reconciliation.ts`:
- Takes a `TerminalManager` (NOT wrappedTerminal — not breaker-guarded). Calls `terminal.listSessions('kookr-')`.
- **Problem for dtach:** tmux's list returns `[]` when there's no tmux server running; this silently makes ALL task sessions look dead to reconcile.
- Fixed partially in PR #346 (commit `a42ccfd` — "reconcile queries dtach backend") but reconcile still calls `TerminalManager`.
- V8 changes the signature to `reconcile(taskStore, backend: TerminalBackend)`.
- `reconcile()` only COMPUTES the orphan set (sessions the backend reports live that no task accounts for — including a session whose OWN record already carries `lastStatus: 'completed'`/`'aborted'`, since the loop `continue`s past those without marking them accounted-for). It never acts on it.

## Session reaping (issue #1720)

`src/server/session-reaper.ts` (`SessionReaperService`) is the separate "act on it" step run after every `reconcile()` call (boot + periodic liveness tick, wired from `index.ts` / `lifecycle-timers.ts`):
- Cross-references every backend-reported live session against the TaskStore itself (not reconcile's output) and classifies each with the pure `src/core/session-reap-policy.ts` logic into `unowned` (leak class 1 — the original orphan report) or `terminal-task-leak` (leak class 2 — task already `completed`/`terminated`/`cancelled`, or its session record already terminal, but the process tree is still resident; e.g. `completeTask`'s fire-and-forget `adapter.stop()` silently failed).
- Reaps via the backend's existing `killSession` (TERM → grace → KILL + socket removal) once past an age/grace threshold (`KOOKR_REAP_ORPHAN_AGE_MS` default 24h for unowned sessions — never race a mid-launch session per #1537 item 2 — or the shorter `KOOKR_REAP_ORPHAN_AGE_UNDER_PRESSURE_MS` default 2h when dtach count ≥ soft bound 20, issue #2081; `KOOKR_REAP_TERMINAL_TASK_GRACE_MS` default 60s for owned leaks, since the owning task is already known to be done). Master flag `KOOKR_REAP_ORPHAN_SESSIONS` (default on). Each sweep logs `effectiveOrphanAgeMs` and surfaces it on `/api/health` → `sessionReaper`.
- Boot-only `runStaleAttacherSweep` (backed by `src/adapters/dtach-attach-reaper.ts`) kills leaked `dtach -a` attach-client processes from dead server generations (leak class 3), scoped to `LocalDtachBackend.getInstanceDir()` so it never touches another port's sessions or a user's own terminal.
- Every reap is logged to `audit.jsonl` and surfaced cheaply (cached counters, no re-scan) on `GET /api/health`'s `sessionReaper` block.

## Gotchas

- **`tmuxName` parameter name is load-bearing in logs** but has nothing to do with tmux post-v7. Leaky abstraction. Planned for rename in a follow-up PR.
- **`session.tmuxSession` field in persisted `tasks.json`** — same story. Renaming requires a schema-migration step.
- **TmuxTerminalManager swallows some errors, throws others.** `listSessions`, `killSession`, `isAlive`, `setSessionOption` swallow "no such session." `sendKeys`, `capturePane`, `pasteText`, `sendKeystroke` throw it. Breaker sees only the throwing paths.
- **TerminalBridge spawns `tmux attach` via node-pty directly** — does NOT go through the breaker. So bridge open failures don't count toward breaker.
- **Cutover detection runs on every dtach startup** (`start.ts:124-164`) — runs `tmux list-sessions`, warns about stale `kookr-*` sessions. Noise after V7 has baked; V8 removes this.

## Where to make changes

| Task | File |
|---|---|
| Change how sessions are spawned | `ClaudeCodeAdapter.launch` / `CodexCliAdapter.launch` |
| Change per-session I/O | Same adapters' `sendInput`/`sendKeystroke`/`stop`/`captureDisplay` |
| Change backend selection / startup | `src/server/start.ts:42, 108-167, 180` |
| Change WS routing | `src/server/index.ts:733-794` |
| Change reconciliation | `src/server/reconciliation.ts` + `src/server/index.ts:409, 419-421` |
| Change breaker | `src/server/index.ts:220, 224, 237` + `src/adapters/circuit-breaker-terminal-manager.ts` |

## References

- V7 RFC: `docs/rfc/rfc-claude-code-terminal-parity.md`
- V8 RFC: `docs/rfc/rfc-v8-tmux-removal.md`
- ADR-014 local-dtach-backend.
- ADR-007 managed-terminal-sessions (to be superseded).
