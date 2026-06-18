# Knowledge Base (`kb`) Setup — Optional

Kookr can use a local **knowledge base** to give agents prior-art lookup and to
record reusable task lessons. This is powered by the external
[`knowledge-base-mcp-server`](https://github.com/jeanibarz/knowledge-base-mcp-server)
project, which ships a `kb` CLI alongside an MCP server.

**`kb` is entirely optional. Kookr runs normally without it.** Every Kookr
feature that touches `kb` is fail-open: if the CLI is absent, errors, or returns
nothing, the surrounding work continues. Concretely:

- The `kb-context-inject` hook is **off by default** (`KOOKR_KB_CONTEXT_INJECT`)
  and degrades to "inject nothing" on any failure — see
  [hooks-setup.md](hooks-setup.md).
- The `repository-idea-scout` playbook treats a missing `kb` as "no signal" and
  keeps going.
- Task `dependencies: ['kb']` is advisory only — it never blocks task creation
  or launch.

Install it only if you want KB-backed search and lesson capture.

## Install

Requires Node.js ≥ 20 (Kookr already requires ≥ 22).

```bash
# Installs the `kb` bin globally. The OS resolves it on every call, so a later
# `npm i -g …@latest` is picked up without restarting anything.
npm install -g @jeanibarz/knowledge-base-mcp-server@latest

kb --version
kb --help
```

If `kb` isn't found afterward, make sure your global npm bin directory
(`npm bin -g`) is on your `PATH`.

## Configure

`kb` reads the same environment variables as the MCP server. The two you'll
usually set:

```bash
export KNOWLEDGE_BASES_ROOT_DIR="$HOME/knowledge_bases"   # where KB markdown lives
export EMBEDDING_PROVIDER=ollama                          # default backend
```

Add them to your shell rc (`~/.bashrc` / `~/.zshrc`). **Semantic `kb search`
needs an embedding backend** — by default a local [Ollama](https://ollama.com)
instance. Without a configured backend, `kb list` works but `kb search` cannot
build or query the index. Other providers are selectable via `EMBEDDING_PROVIDER`
plus the matching `OLLAMA_*` / `OPENAI_*` / `HUGGINGFACE_*` variables; see the
upstream project's README for the full matrix.

## Capability note (published CLI is search-only)

The current npm release (`0.2.x`) of the `kb` CLI exposes **`kb list` and
`kb search`** only. Kookr's agent instructions (`CLAUDE.md`) and the
`kb-context-inject` hook also reference richer subcommands documented upstream —
`kb remember`, `kb doctor`, `kb stats`, and `kb search --gate`. Those are **not**
in the published package yet, so:

- `kb search` (read-only lookup) works with a published install + an embedding
  backend.
- The "record a task lesson" step (`kb remember`) and the relevance-gated
  context-injection hook (`kb search --gate`) require a newer/source build of
  the server. Until then, treat those steps as no-ops — Kookr does not depend on
  them.

To build the full CLI from source instead of npm:

```bash
git clone https://github.com/jeanibarz/knowledge-base-mcp-server.git
cd knowledge-base-mcp-server
npm install && npm run build       # produces build/cli.js (the `kb` bin)
```

## Verify

```bash
kb --version          # prints the installed version
kb list               # lists knowledge bases under KNOWLEDGE_BASES_ROOT_DIR (empty is fine)
```

## Related

- [Getting Started](getting-started.md) — Kookr install and prerequisites
- [Hooks Setup](hooks-setup.md) — the optional `kb-context-inject` hook
- Upstream project: https://github.com/jeanibarz/knowledge-base-mcp-server
