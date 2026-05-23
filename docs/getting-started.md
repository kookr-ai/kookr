# Getting Started

This guide is for a first local Kookr install. It keeps optional features out of the critical path so you can see the dashboard quickly.

## Prerequisites

- `git`
- Node.js `>=22` (the project is tested with newer Node 22/24 releases)
- `pnpm >=10`
- Build tools for native module compilation (`node-pty`) and the vendored `dtach` binary
- Claude Code CLI, only if you want Kookr to launch Claude Code agents

## Ubuntu / Debian

```bash
# Node.js 24 via NodeSource. Node 22 is also supported.
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Build tools and git. dtach is vendored and built by `pnpm build:dtach`.
sudo apt-get install -y build-essential git

# pnpm
sudo npm install -g pnpm
```

## macOS

```bash
# Xcode command line tools provide git and build tools.
xcode-select --install

# Node.js and pnpm via Homebrew.
brew install node@22 pnpm
```

## Install And Run

```bash
git clone https://github.com/kookr-ai/kookr.git
cd kookr
pnpm install
pnpm dev
```

Open `http://localhost:5173`.

`pnpm dev` starts the backend on port `4801` and the Vite frontend on port `5173`. Port `4800` is reserved for the stable production-style instance described below.

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
| `pnpm dev` | `4801` | Current checkout | You are developing Kookr itself. Backend and frontend reload on source changes. |
| `pnpm prod:setup` then `pnpm prod:update` | `4800` | Sibling `../kookr-prod` | You want a stable Kookr instance supervising real agents while this checkout changes. |

For daily supervision, use the production-style path:

```bash
pnpm prod:setup
pnpm prod:update
```

After setup, `pnpm prod:update` fetches, builds, restarts, and health-checks the `../kookr-prod` worktree. `pnpm prod:restart` restarts without rebuilding, useful after `.env` changes.

## Optional Features

Optional features are off by default:

- AI task names and response suggestions
- Speech-to-text and text-to-speech
- Telegram remote chat
- Permission bypass for supervised agents

Copy `.env.example` to `.env` and uncomment only what you need. See [Configuration](configuration.md) and [Environment Variables](reference/environment-variables.md).

## Next Steps

- [User Guide](user-guide.md) explains the dashboard workflow.
- [CLI Reference](reference/cli.md) covers `kookr-spawn` and `kookr-status`.
- [Troubleshooting](troubleshooting.md) covers common install and runtime problems.
