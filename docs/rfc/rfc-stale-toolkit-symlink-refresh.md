# RFC: Stale Toolkit Symlink Refresh

## Status

**Draft v2 - critic-reviewed implementation companion**
**Date:** 2026-05-11
**Author:** Jean Ibarz (with Codex)

---

## Problem

Kookr maintainer machines can have user-global Claude Code hooks and toolkit skills symlinked to the intentionally bare `~/git/kookr` directory. The bare checkout does not advance as `main` advances, so hook and skill changes can merge without becoming active in new Claude Code sessions. The failure mode is delayed and quiet: the dashboard can be current while the user-global hook stack still points at a stale tree.

## Requirements

- Surface stale user-global Kookr hook/toolkit links in the existing dashboard update affordance.
- Provide a one-click refresh path for the links.
- Keep the maintainer's bare-main discipline intact; do not flip `core.bare` from the UI.
- Avoid a broad "system status" framework for one local artifact family.
- Do not change marketplace plugin update semantics.

## Design

Use `kookr-prod` as the canonical symlink target. It already updates through `pnpm prod:update`, carries the protected-worktree marker, and is the tree the production dashboard is meant to represent.

The existing `/api/deploy/status` response grows a `toolkit` field. The server asks `scripts/install-hooks.sh --print-global-assets` for the installer-owned asset list, then checks those symlinks:

- `~/.claude/hooks/{oss-stale-scout-gate,pr-workflow-gate,oss-contribution-gate,post-merge-keyword-scan}.sh`
- `~/.claude/skills/pre-pr-review`
- `~/.claude/skills/pr-contribution-excellence`
- `~/.claude/reviewer-specialists`

Each link is compared to the expected path under the resolved prod worktree, and the expected target must exist. Missing links, real files, links to any other root, and links to missing targets are stale. The TopBar checks status on load and when the version popover opens; the existing update dot pulses when either production is behind `origin/main` or toolkit links are stale.

Toolkit status is computed independently from `git fetch origin`. If remote deploy freshness fails, the response still includes local toolkit status plus the deploy error.

`POST /api/deploy/toolkit-refresh` runs `scripts/install-hooks.sh` from the resolved prod worktree with the current user home. That repoints the links to prod and leaves settings registration in the same script that already owns those hooks.

## Files To Change

- `src/server/toolkit-symlink-status.ts` - installer-manifest reader and filesystem detector.
- `src/server/routes/deploy-routes.ts` - expose status and refresh endpoint.
- `src/frontend/components/TopBar.tsx` and `src/frontend/styles.css` - show and refresh stale links.
- `scripts/install-hooks.sh` - source globally installed plugin skills from `plugin/skills`, matching the post-PR #263 layout.

## Edge Cases

- Non-symlink user files are never overwritten silently. They surface as stale, and the refresh script refuses to overwrite both hook files and plugin assets.
- Dev dashboards on port 4801 still show toolkit status because refreshing user-global hooks is independent of deploying the prod process.
- A missing prod worktree keeps the existing `configured:false` behavior; no toolkit refresh button is offered.
- The refresh endpoint runs synchronously, rejects concurrent refreshes, and returns command failure details when the installer refuses a conflict.

## Alternatives Considered

- **Bare-main refresh ritual.** Rejected because it preserves the hidden mutable snapshot and encodes the bare-flag bypass in a server endpoint.
- **Dedicated main mirror worktree.** Reasonable, but it adds another local tree and another refresh command when the protected prod worktree already exists.
- **New system-status panel.** Rejected for this iteration. The deploy popover already owns "local tree is behind / update now" semantics.

## Critic Feedback Incorporated

- Boundary critic and design minimalist both flagged duplicate asset ownership. The detector now reads the asset list from `install-hooks.sh --print-global-assets`; the shell installer remains the single source of truth.
- Boundary critic and operability reviewer flagged that `git fetch` failures could hide local symlink state. Toolkit status is now computed independently and returned with deploy errors.
- Delivery pragmatist and operability reviewer flagged clobber risk for real hook files. `install-hooks.sh` now refuses non-symlink hook destinations, matching plugin asset behavior.
- Design minimalist flagged the per-link UI as too much for a one-click repair. The TopBar now shows only aggregate stale/current count and the refresh action.
