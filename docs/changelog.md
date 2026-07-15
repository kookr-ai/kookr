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
