# Development

This guide is for contributors working on Kookr itself.

## Setup

```bash
git clone git@github.com:kookr-ai/kookr.git
cd kookr
pnpm install
```

`pnpm install` runs the `prepare` script, which configures the repo pre-push hook path and builds the vendored dtach binary. As a second line of defense, `pnpm dev` and `pnpm start` also build the dtach binary on demand (idempotent, ~50ms when already present), so the dev loop still works if `prepare` was skipped — e.g., under `ignore-scripts=true` in `~/.npmrc`, after a `git pull` that added the prepare hook, or after a partial install. See [RFC: Self-Healing Dev/Start Scripts](rfc/rfc-dev-dtach-onboarding.md).

## Common Commands

```bash
pnpm dev                 # backend on 4801 plus Vite frontend on 5173
pnpm dev:server          # backend only
pnpm dev:frontend        # frontend only
pnpm test                # Vitest unit/integration tests
pnpm test:watch          # Vitest watch mode
pnpm exec playwright test # Playwright E2E tests
pnpm build               # generate build info, build dtach, typecheck, build frontend
pnpm build && pnpm start # production mode on 4800
pnpm run doctor          # local setup diagnostics
```

Dev mode uses port `4801` so it can run beside a stable production-style instance on port `4800`. Treat `pnpm dev` as a live development target, not the Kookr instance supervising important work: it restarts on source changes and may be broken while edits are in progress.

## Production-Style Worktree

For daily use while hacking on Kookr, keep a stable instance in `../kookr-prod`:

```bash
pnpm prod:setup
pnpm prod:update
```

`pnpm prod:update` fetches, builds, restarts, and health-checks the production-style worktree. The dashboard auto-deploy button calls the same script when Kookr is running on port `4800`.

The usual contributor setup is the production-style instance on `4800` for real agent supervision, plus `pnpm dev` on `4801`/`5173` only when you need to check current modifications with hot reload.

The dev checkout's `.env` is symlinked into `../kookr-prod/.env`, so use:

```bash
pnpm prod:restart
```

after runtime-only configuration edits.

## Project Structure

```text
src/
  shared/    Cross-boundary contracts and protocol types
  core/      Pure logic: monitor, anomaly detection, task store, queue, costs
  adapters/  I/O boundaries: dtach, Claude Code, Codex CLI, GitHub, git
  server/    Hono HTTP/WebSocket server, routes, reconciliation, schedules
  frontend/  React SPA, Zustand store, dashboard components, CSS
```

Other important directories:

- `.claude/skills/` and `.claude/agents/` - Kookr-internal agent assets
- `.kookr/playbooks/` - Kookr-internal playbooks
- `plugin/` - Kookr Toolkit Claude Code plugin
- `docs/adr/` - architecture decisions
- `docs/poc/` - focused proof-of-concept validations
- `docs/rfc/` - in-flight design proposals
- `docs/system-models/` - stable system views

For the detailed module tree, see [Architecture](architecture.md#module-structure-v1).

## Hooks

The repo pre-push hook is configured by `pnpm install`:

```bash
git config core.hooksPath
```

Expected output:

```text
.hooks
```

The pre-push hook runs server typecheck, E2E typecheck, and tests before upload. See [Hooks Setup](hooks-setup.md) for optional Claude Code workflow guardrails.

## Documentation Placement

- Top-level `README.md`: short project entry point
- `docs/getting-started.md`: novice install and first run
- `docs/user-guide.md`: daily dashboard usage
- `docs/configuration.md`: common configuration choices
- `docs/reference/`: API, CLI, environment variable references
- `docs/adr/`: accepted architecture decisions
- `docs/poc/`: proof-of-concept validations
- `docs/rfc/`: in-flight designs
- `docs/reports/`: point-in-time investigations

Do not put new design documents directly in `docs/`; use the appropriate subdirectory.

## Testing Guidance

Use focused tests for focused changes. Broaden verification when touching shared behavior, protocol contracts, task lifecycle, realtime state, or frontend workflows.

Dtach-based integration tests skip automatically when the vendored binary is not built, but normal development should keep `pnpm build:dtach` working.

## Onboarding Smoke Test

Maintainers can run the fresh-environment smoke harness locally or through the manual `Onboarding Smoke Test` GitHub Actions workflow:

```bash
ANTHROPIC_API_KEY=sk-ant-... bash scripts/onboarding-smoke-test.sh
```

The driver `claude` command runs on the host and controls a clean Ubuntu container through Docker. The script preflights host-side Claude Code authentication before starting the walkthrough and writes a failure report if auth is unavailable. Docker uses the default `bridge` network; override with `DOCKER_NETWORK=<name>` only when diagnosing host-specific Docker DNS issues.

Set `ONBOARDING_CONTAINER_AGENT_SMOKE=1` to additionally install Claude Code inside the clean container, pass only `ANTHROPIC_API_KEY` into that `docker exec` process, and verify that Kookr can launch an authenticated Claude Code agent with hooks and toolkit plugin injection. Do not mount your whole `~/.claude` into the container for this test; that would import user-global skills, hooks, MCP config, and auth state that can hide missing Kookr setup.
