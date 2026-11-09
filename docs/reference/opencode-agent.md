# opencode agent

Kookr can run [opencode](https://opencode.ai) as an agent type (`opencode`)
next to Claude Code, Codex CLI and Grok Build. It drives the interactive
opencode TUI in a managed terminal session and is aimed at cheap, scoped
worker tasks on an OpenAI-compatible provider (DeepInfra by default). Design
background: [RFC opencode agent integration](../rfc/rfc-opencode-agent-integration.md).

## Enabling it

opencode is opt-in and never blocks server startup. Set
`KOOKR_OPENCODE_ENABLED=1` where the server runs; without it the adapter is not
even constructed (no preflight probe, one debug line) and default Kookr
behaviour is unchanged. When enabled, the adapter registers only when the
pinned binary is present; otherwise `opencode` is simply absent from the agent
picker and round-robin.

1. Install the pinned release (1.19.5; the 1.x and 2.x plugin APIs are
   incompatible) under `~/.kookr/tools`:

   ```sh
   npm install --prefix ~/.kookr/tools/opencode-1.19.5 opencode-ai@1.19.5
   ```

   Kookr finds `~/.kookr/tools/opencode-1.19.5/node_modules/.bin/opencode`
   automatically, or you can point `KOOKR_OPENCODE_BIN` at another binary.
2. Export the provider key where the Kookr server runs. The adapter reads
   `OPENAI_API_KEY` (the DeepInfra key) from its own environment and only ever
   writes an `{env:OPENAI_API_KEY}` reference into the per-session config,
   never the key itself.
3. Restart the server. A startup warning explains why `opencode` was skipped
   if the binary is missing or on the wrong version.

Defaults: provider `deepinfra`, model `deepseek-ai/DeepSeek-V4.1-Flash-1017`,
permissions `allow` (unattended workers must not stall on prompts).

A per-task model pin is routed to this single configured provider: use `<model id>` or `deepinfra/<model id>`. A pin that names a different provider (for example `openrouter/...`) passes validation but fails on the first turn with a model-not-found error, because the adapter composes exactly one provider.

| Variable | Purpose |
| --- | --- |
| `KOOKR_OPENCODE_ENABLED` | `1` to enable the agent (default off). |
| `KOOKR_OPENCODE_BIN` | Binary path/command override. |
| `KOOKR_OPENCODE_ALLOW_ANY_VERSION` | Skip the pinned-version check (unsupported). |
| `KOOKR_OPENCODE_PLUGIN_DEBUG` | File to append one JSON line per emitted hook. |

## Launching a worker

Pick `opencode` in the agent picker, or send `agentType: "opencode"` (and
optionally a `provider/model` `model`) to `POST /api/tasks`. opencode is never
chosen automatically: it is excluded from round-robin rotation and from
automatic substitution for an unavailable pinned agent, and an explicit pin is
the only way to get one.

## How a session works

Each launch composes a private session directory (opencode config, a generated
plugin, optional `AGENTS.md`, XDG roots) so the operator's real
`~/.config/opencode` and `~/.local/share/opencode` are never read or modified.
The terminal session runs `opencode <cwd>` and Kookr pastes the initial prompt
once the composer is painted, confirming delivery from the `UserPromptSubmit`
hook (it never blindly resends the prompt). The generated plugin pipes
Claude-shaped hook payloads into `kookr-hook-writer`, so inbound events reuse
the Claude hook normaliser. The plugin can also run Claude-shaped hook commands
with Claude semantics (`SessionStart` stdout becomes context; `Stop` exit 2, or
a `{"decision":"block"}` line, re-prompts the worker, at most 4 times); which
hooks run is the caller's configuration (`OpenCodeAdapterOptions.profile`).
Stopping the session kills its process tree and removes the session directory.

The terminal status classifier recognises the opencode composer, so a worker
that finished its turn reads as waiting for input instead of being flagged as
hung.

Every launch starts a fresh conversation (a relaunch does not resume the
previous one), and no hooks beyond the monitoring emitter are installed unless
the caller configures them.

## Limits

- The TUI takes about 22 s to paint on first boot, so launches are slow and
  the ready timeout is 60 s.
- Expect roughly 0.6-0.8 GB resident memory per worker (about 1.2 GB on long tasks); size concurrency
  accordingly.
- One pinned opencode release (1.19.5); other versions are refused.
- `permission: ask` stalls an unattended worker; the default is `allow`.
