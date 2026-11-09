# Spike 2: opencode-worker container + opencode-a2a smoke test

Date 2026-11-09. Host: WSL2, 16 CPU, 31 GB RAM, Docker 29.8 (overlay2, cgroup v2).
Image `opencode-worker` (prototype source in this folder; productised in `deploy/opencode-worker/`, Slice 1): opencode **1.19.5**
(npm lockfile integrity sha512 pinned, postinstall run in build), `opencode-a2a`
**1.4.0** (PyPI, `--require-hashes`, 44 hashed deps, a2a-sdk 1.2.3, A2A protocol
1.0), `nb` (agent-notebook 0.7.0), Kookr-generated `kookr.js` plugin mounted at
`/cfg`, base images pinned by digest (python:3.12-slim-bookworm, node:22-bookworm-slim).
Run flags: `--read-only --cap-drop ALL --no-new-privileges --user 1000:1000
--memory 3g --cpus 2 --pids-limit 512`, tmpfs `/tmp` (256 MB) and `/home/worker`
(512 MB), `/data` volume (opencode sqlite + A2A task store), `/work` bind mount.
Provider: a local mock OpenAI-compatible server (one bash tool call, then a
final message), so no real model cost and no external traffic.

## Results

| Check | Result |
| --- | --- |
| Agent card `/.well-known/agent-card.json` | 200, public; protocol 1.0, bindings HTTP+JSON and JSONRPC, `streaming: true` |
| Auth | bearer token required: no token on `/message:send` = 401 |
| `message:send` | task `COMPLETED`, artifact "All done.", file written in `/work` |
| `message:stream` | SSE: `WORKING` task, artifact updates (tool call visible, status `running`), `COMPLETED` |
| `tasks/get`, `GET /tasks` | works |
| Hooks inside the container (via A2A) | SessionStart 1, UserPromptSubmit/PreToolUse/PostToolUse/Stop per turn all in the ledger |
| **Cancel really stops tool execution** | YES. `sleep 120` tool running; `POST /tasks/{id}:cancel`; the `bash`+`sleep` processes were gone within 2 s and the late marker file never appeared (wrapper calls opencode `session.abort`). Hermes gap closed. |
| Cancel with a *streaming client attached* | cancel response said `CANCELED`, but a later `GET` showed `FAILED` (1 of 1). Cancel with `returnImmediately` (no stream attached): `CANCELED` stable (1 of 1). The docs promise `CANCELED`; treat as a wrapper bug to report/work around: Kookr must read state after the stream closes and not trust the first answer. |
| Restart persistence | `docker rm -f` then a new container on the same `/data` volume: all 5 tasks listed with the same states (SQLite task store). Hermes lost tasks on restart. |
| 2 concurrent sessions on one instance | both `COMPLETED`, distinct contexts, 0.4 s warm |
| Read-only root | writes to `/` and `/opt` fail as intended; all runtime writes go to tmpfs or the volume |
| Message-stream drop => FAILED (Hermes gap) | not reproduced in this spike; docs say SSE disconnect lets execution continue, `SubscribeToTask` re-attaches. Not tested. |

## Boot and memory (mock provider, one tool call per task)

| Figure | Unseeded image | Seeded image (final) | Hermes (known) |
| --- | --- | --- | --- |
| Container start to agent card | 3 s | 3.1 s | n/a |
| First message after cold start | 12.7 s (opencode installs `@opencode-ai/plugin`, 63 MB x2, from the network into tmpfs) | **1.7 s** | n/a |
| Container memory after tasks (cgroup, includes tmpfs) | 831 MiB | **~390-460 MiB** | ~2-2.6 GB, 3 GB cap |
| Processes inside | `opencode serve` 590 MB RSS, wrapper 88 MB RSS, 14 pids | same | |
| Image size | | 1.36 GB (shared base layers across containers) | |

The seed is built at image build time (`opencode debug config` with a stub
plugin, same trick as Kookr's `prepareOpenCodeSeed`) and symlinked read-only,
so a container needs no network to boot and spends no tmpfs on plugin deps.

## Concurrency on this host (each container: own volume, own workspace, 3 GB cap)

| Containers | All healthy | First message, all in parallel | Sum container memory | Host used delta |
| --- | --- | --- | --- | --- |
| 4 | 9.3 s | 2.3 s | 1.72 GiB (400-458 MiB each) | +1.0 GB idle, +1.75 GB after task (incl. page cache) |
| 8 | 11.1 s | 3.1 s (a first run took 35 s, not reproduced) | 3.2 GiB (387-410 MiB each) | +2.1 GB idle, +3.5 GB after task |

Linear, about 0.4 GB per container, so 8 uses about 3.2 GB of 31 GB. The limit on
this host is not RAM; it is disk (about 26 GB free) and the model provider's rate
limits. Not measured: a real LLM task (the mock does no reasoning, no large
file reads, no `npm test`), so a loaded worker will exceed the 400 MB idle
figure; the TUI measured 0.6-1.2 GB per worker in the opencode reference doc.

## Defects found and fixed while building

- The entrypoint health `curl` had no timeout; one of 4 parallel starts hung
  forever on a request that landed while opencode was initialising. Fixed with
  `--max-time 2` (the loop retries).
- opencode refuses to run without its npm `postinstall` (`--ignore-scripts`
  alone leaves it unusable); the build runs it explicitly.
- Boot needs `/data` writable and (unseeded) outbound network: both resolved by
  the seed and by mounting `/data` as a volume.

## Not verified

- Real provider calls, real task RAM, `a2a_call` peering, A2A push notifications.
- `--network none` or an egress allowlist (the worker must reach its provider).
- opencode-a2a behaviour after an abrupt `kill -9` of opencode mid-task.
