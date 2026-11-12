---
name: disk-reclaim
group: agent-automation
description: >
  Free disk space safely when Kookr refuses task launches with "Data-directory
  disk free is critical" (HTTP 503, code data_directory_disk_critical), when a
  command fails with ENOSPC or "No space left on device", or when the operator
  asks to free disk space or the machine is low on disk. Classifies space into
  SAFE (reclaimed automatically), REVIEW (needs an operator yes) and NEVER, so
  nobody deletes a worktree blindly or hunts for space by hand.
keywords: >
  disk full, ENOSPC, no space left on device, low disk, free disk space,
  data_directory_disk_critical, disk critical 503, worktree cleanup,
  node_modules cleanup, reclaim space, kookr maintenance prune
related: [asking-the-operator]
---

# Disk reclaim

Kookr refuses every task launch once the data directory's filesystem is at or
below 5% free or 2 GiB free (override: `KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT`,
`KOOKR_ADMISSION_DATA_DIR_FREE_BYTES`). `kookr maintenance prune` alone frees
about 1 GB. The bulk is usually git worktrees and `node_modules` under the
operator's code directory (for example `~/git`). Worktrees may hold unmerged
work, so they cannot be deleted blindly. This skill's script sorts space by
safety: it reclaims the provably safe part itself and hands the risky rest to
the operator with sizes. A first real run freed tens of GiB in one pass; it also
held back merged, clean worktrees that contained ignored result files.

The script is `disk-reclaim.mjs` in this skill's `scripts/` directory (Node 20+,
Linux and macOS, no dependencies). The commands below call it through
`${CLAUDE_SKILL_DIR}`.

## Workflow

1. **Report (deletes nothing).**
   `node "${CLAUDE_SKILL_DIR}/scripts/disk-reclaim.mjs" --roots ~/git --data-dir ~/.kookr`
   It prints the filesystem view (free space, Kookr's floors, whether each root
   shares the data directory's filesystem), per-tier totals, and the top
   candidates. Add `--json` for machine-readable output. A scan of about 1,000
   directories takes a couple of minutes. Add `--fetch` to run
   `git fetch --prune` per repo first so "merged upstream" is current. It needs
   the network and **mutates remote-tracking refs** (updates and deletes them).
2. **Apply the SAFE tier.**
   `node "${CLAUDE_SKILL_DIR}/scripts/disk-reclaim.mjs" --roots ~/git --data-dir ~/.kookr --apply safe`
   It works biggest item first, re-checks each item right before acting, and
   stops once free space reaches `--until-free-percent` (default 10) or SAFE is
   exhausted. Each action is appended to `<data-dir>/disk-reclaim.log` (JSONL).
3. **Re-check free space.** The apply summary shows free space before and
   after. If it is comfortably above the floor, stop and tell the operator what
   was freed.
4. **Present the REVIEW tier** if more space is needed: sizes, paths and the
   reason each item is not safe (dirty, unmerged, unpushed, stashed, in use,
   main checkout, large home directory). Interactive session: use
   `AskUserQuestion`. Unattended Kookr task: use the `asking-the-operator`
   skill (`kookr ask`). Offer the largest items as concrete options.
5. **Delete a REVIEW item only after an explicit operator yes for that item.**
   The script never deletes REVIEW items; do it by hand with the narrowest
   command (for a worktree, `git worktree remove <path>` from its main repo,
   without `--force` unless the operator accepts losing the uncommitted work).

## What each tier means

| Tier | Items | Action |
|---|---|---|
| SAFE worktree | Linked worktree, clean, unlocked, no stash entries, no edits hidden by skip-worktree or assume-unchanged, no git-ignored files other than build output, HEAD merged into `origin/HEAD` (or its upstream is exactly `[gone]`), idle at least `--min-idle-days` (default 2), not in use | `git worktree remove` from the main repo, then `git branch -d` (never `-D`) |
| SAFE dependencies | Untracked `node_modules` of an idle, unused checkout that has a `package.json` and a lockfile beside it | Remove the directory; rebuild with `pnpm install` or `npm ci` |
| SAFE tool caches | pnpm store, npm, uv, pip caches (only installed tools), only while no Kookr task is live and no package manager is running | The tool's own prune/clean command |
| SAFE Kookr data | Aged artifacts under the data dir | `kookr maintenance prune` with the default ages |
| REVIEW | Everything else at least 500 MB, the lowered-age prune (deletes up to ~29 days of finished-task history the default policy keeps; the report prints the exact command and extra size), plus large directories outside the roots (`~/.ollama`, big `~/.cache` entries, other `~/.nvm` Node versions, `~/.rustup/toolchains`, `~/.local/share`) and reclaimable Docker data | Report only |
| NEVER | The data dir (except through `kookr maintenance prune`), `~/.ssh`, `~/.config`, anything outside the roots | Not scanned or touched |

"In use" means a process has its working directory inside the directory, or a
live Kookr task has its `cwd` or any session `cwd` there. Live means not
completed, cancelled or terminated, or terminated for a reason crash recovery
relaunches (`server-restart`, `oom`, `timeout`, `unknown`) within 7 days. The API
port must match the data dir (`~/.kookr` is 4800, `~/.kookr-<port>` is
`<port>`; `KOOKR_PORT` or `KOOKR_API_BASE_URL` must agree). If the API, the
port match or the process probe fails, in-use state is unknown and NOTHING is
SAFE, caches and Kookr data included: tell the operator and fix the probe.

## Guardrails

- Run the report first, every time. Never pass `--apply` without having read
  the report in this session.
- Never delete REVIEW items without an explicit operator yes, and never use
  `git worktree remove --force`, `git branch -D` or `rm -rf` on a path the
  script did not classify SAFE in the same run.
- Ignored files are part of what a worktree removal deletes (`git worktree
  remove` takes git-ignored content with it). A worktree holding ignored files
  other than rebuildable build output (`node_modules`, `dist`, caches) is
  REVIEW, even if merged and clean. Edits hidden by skip-worktree or
  assume-unchanged also make it REVIEW.
- Only space on the data directory's filesystem helps. Items on another
  filesystem are listed separately and are not applied.
- Removing a worktree keeps its branch unless the branch is merged, so commits
  are not lost; a squash-merged branch stays until deleted by hand.
- Do not "free space" by killing processes or deleting files under `~/.kookr`
  by hand; use `kookr maintenance prune` (the script does).
- The script refuses `--roots` that are `/`, the home directory, the data
  directory, or contain `~/.ssh` or `~/.config`.

## Platform notes

- **Docker Desktop (WSL or macOS):** images and volumes live in Docker
  Desktop's own VM disk. `docker system prune` does not free the Linux or
  macOS filesystem (measured: 6.2 GB pruned, root free space unchanged). The
  script says so and does not offer Docker as a lever. With plain Docker Engine
  it lists `docker system df` reclaimable amounts as REVIEW and never prunes.
- **WSL:** freed space inside the Linux filesystem does not shrink the Windows
  `ext4.vhdx` file; it only restores free space the Linux side sees, which is
  what Kookr measures.
- **pnpm:** `node_modules` entries are hard links into the shared pnpm store.
  Removing them frees little until the store is pruned, which the script runs
  last. Trust the free-space delta in the summary over the estimated sizes.
- **macOS:** process probing uses `lsof -d cwd` (Linux reads `/proc/*/cwd`);
  sizes use `du -k` and `df -Pk`, which behave the same on BSD.
