# Getting Started

This guide is for a first local Kookr install. It keeps optional features out of the critical path so you can see the dashboard quickly.

## Prerequisites

- `git`
- Node.js `>=22` (the project is tested with newer Node 22/24 releases)
- `pnpm` — use the version pinned in `package.json` (`packageManager: pnpm@10.x`). The simplest way is `corepack enable`, which runs the pinned version automatically. Installing an unpinned global pnpm (e.g. pnpm 11) works but prints a harmless "pnpm field is no longer read" deprecation warning and can rewrite the lockfile.
- Build tools (`build-essential` / Xcode CLT) **and `python3`** — `node-pty` compiles via `node-gyp`, which needs python3. The `dtach` binary is vendored and built automatically.
- On Linux, `setsid` (from `util-linux`, present on virtually every distro) — Kookr uses it to detach agent sessions. macOS does not need it.
- Claude Code CLI, only if you want Kookr to launch Claude Code agents
- For Codex CLI agents, the maintained fork — see [Codex CLI Setup](codex-cli-setup.md)
- Optional: the `kb` knowledge-base CLI for prior-art lookup and lesson capture — Kookr works without it; see [Knowledge Base Setup](knowledge-base-setup.md)

## Ubuntu / Debian

```bash
# Node.js 24 via NodeSource. Node 22 is also supported.
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Build tools, python3 (node-gyp/node-pty), git, and setsid (util-linux).
# dtach is vendored and built by `pnpm build:dtach`.
sudo apt-get install -y build-essential python3 git util-linux

# pnpm — Corepack runs the version pinned in package.json.
corepack enable
```

## macOS

```bash
# Xcode command line tools provide git, build tools, and python3.
xcode-select --install

# Homebrew, if you don't already have it. When it finishes, run the two
# `eval "$(... shellenv)"` lines it prints so `brew` is on your PATH (and add
# that line to ~/.zprofile for future shells).
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js via Homebrew. Corepack runs the pinned pnpm version.
brew install node@22
corepack enable
```

macOS is supported and does **not** require `setsid` or a manually installed
`dtach` — Kookr detects macOS, spawns the vendored `dtach` directly, and builds
it for you during `pnpm install`.

## Install And Run

```bash
git clone https://github.com/kookr-ai/kookr.git
cd kookr
pnpm install
pnpm prod:setup
pnpm prod:update
```

Open `http://localhost:4800`.

`pnpm prod:setup` creates a sibling `../kookr-prod` worktree and builds it. `pnpm prod:update` fetches, builds, restarts, and health-checks that production-style instance.

This is the right default for daily Kookr usage because the server supervising your agents should not be the same process that is restarting or breaking while you edit Kookr itself.

Use `pnpm dev` only when you are actively developing Kookr and need hot reload on source changes. Dev mode starts the backend on port `4801` and the Vite frontend on port `5173`, so it can run beside the stable production-style instance on port `4800`.

`pnpm dev` also builds the vendored dtach binary on demand if it is not already present (idempotent, fast when cached), so the first run works even if `pnpm install`'s `prepare` hook was skipped (e.g., under `ignore-scripts=true`).

## First Agent

1. Open the dashboard.
2. Click **Launch**.
3. Choose a working directory.
4. Enter a task prompt.
5. Watch the terminal panel and findings queue.

When an agent needs attention, Kookr adds a finding. Reply from the dashboard and Kookr advances to the next finding.

## Check Your Setup

If install or startup fails, run:

```bash
pnpm run doctor
```

`pnpm doctor` checks Node and pnpm versions, build tools, the dtach binary, Docker for voice features, GPU availability, and common port conflicts. It prints a copy-pasteable summary with suggested fixes.

## Daily Use Or Development?

Kookr has two common run modes:

| Mode | Port | Worktree | Use when |
| --- | --- | --- | --- |
| `pnpm prod:setup` then `pnpm prod:update` | `4800` | Sibling `../kookr-prod` | You want a stable Kookr instance supervising real agents while this checkout changes. |
| `pnpm dev` | `4801` plus Vite on `5173` | Current checkout | You are developing Kookr itself and need hot reload for active modifications. |

For daily supervision, use the production-style path:

```bash
pnpm prod:setup
pnpm prod:update
```

After setup, `pnpm prod:update` fetches, builds, restarts, and health-checks the `../kookr-prod` worktree. `pnpm prod:restart` restarts without rebuilding, useful after `.env` changes.

For Kookr development, keep the production-style instance open for real supervision and run `pnpm dev` separately only for checking your current changes in real time.

## Optional Features

Optional features are off by default:

- AI task names and response suggestions
- Speech-to-text and text-to-speech
- Telegram remote chat
- Permission bypass for supervised agents

Copy `.env.example` to `.env` and uncomment only what you need. See [Configuration](configuration.md) and [Environment Variables](reference/environment-variables.md).

## Next Steps

- [User Guide](user-guide.md) explains the dashboard workflow.
- [CLI Reference](reference/cli.md) covers `kookr spawn` and `kookr status`.
- [Troubleshooting](troubleshooting.md) covers common install and runtime problems.
