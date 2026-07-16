# Changelog

## Unreleased

- Hardened task and workspace worktree cleanup so the primary checkout and
  arbitrary non-linked paths are never removed.
- Automatic cleanup now refuses protected branches (`main`, `master`,
  `develop`, and `dev` by default). User-initiated cleanup requires an
  explicit second confirmation; `KOOKR_PROTECTED_BRANCHES` configures the
  allowlist.
- The `.kookr-protected` marker remains supported as an additional opt-in
  protection layer.
- Task, workspace, and reflection cleanup now share one identity-checked Git
  removal boundary; Git failures leave worktrees on disk instead of falling
  back to recursive deletion.
- Bare Git registry entries remain metadata only: they are never treated as a
  primary checkout, removable worktree, or file-view root.
