# Spike 1: do the Kookr opencode hook plugin hooks fire under `opencode serve`?

Date 2026-11-09. opencode 1.19.5 (the pinned release), generated `kookr.js`
plugin from `buildKookrPluginSource`, run headless with `opencode serve`
(no TUI), temp HOME/XDG dirs, a mock OpenAI-compatible provider on a free
port (no real provider call, no production state touched).

## Result: yes. The plugin is a server-side component, not TUI-only.

Plugins load inside the opencode server process. The TUI is only a client of
that same server, so `serve` runs the identical plugin. Observed on one
session (prompt, one `bash` tool call, final answer, a Stop hook that exits 2
once):

| Kookr hook behaviour | Fired under `serve`? | Evidence |
| --- | --- | --- |
| `SessionStart` emit + hook stdout as context | yes | emitted at server boot; the stdout of the SessionStart hook reached the model request (grep count 1 in the provider request log) |
| `UserPromptSubmit` | yes | emitted on the REST `POST /session/:id/message` |
| `PreToolUse` / `PostToolUse` (Bash mapped) | yes | both in the ledger |
| `Stop` on `session.idle` | yes | emitted |
| `Stop` exit 2 re-prompt via `ctx.client.session.prompt` | yes | `stopReprompt:1`, the worker ran a second turn, the second Stop passed |
| Usage accounting | yes | `tokens` (total/input/output/cache) on each assistant message via `GET /session/:id/message`, and in `opencode.db` as before |
| Resume | yes, same mechanism | state is the sqlite db under `XDG_DATA_HOME`; sessions persist |

Control surfaces that replace TUI keystrokes: `POST /session`, `POST
/session/:id/message` (blocks until the turn ends), `POST /session/:id/abort`,
SSE `GET /event` and `/global/event`, `GET /global/health`, `/doc` OpenAPI.

## Caveats that shape the design

1. `SessionStart` fires once at plugin init (server boot), not per session,
   and plugin state (`stopReprompts`, `reentry`, the fixed `sessionId`) is
   per server process. Therefore one `serve` process = one Kookr task
   (consistent with opencode-a2a's one-instance-pair single-tenant boundary).
   Multiple A2A sessions on one instance would share the gate counters.
2. `OPENCODE_SERVER_PASSWORD` is unset by default ("server is unsecured"):
   a container must set it and bind only to its own network.
3. Idle `serve` RSS was about 635 MB (see Spike 2 for the controlled figure).

Not verified: SSE event-stream replacement for hooks (not needed, the plugin
hooks work); behaviour with opencode 2.x (refused by the adapter anyway).
