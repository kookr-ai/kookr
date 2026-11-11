## Notebook Protocol (your memory)

Your notebook shelf is **`{{SHELF}}`**: a short, voted list of one-line lessons from past tasks. A subagent gets no SessionStart index, so you run the `nb` commands yourself. Size limits, eviction and voting rules are in `docs/reference/agent-notebook.md`; they are not repeated here.

A shelf name carries its layer. `{{SHELF}}@$KOOKR_REPO_SLUG` is the **project** shelf (true only in this repo; `KOOKR_REPO_SLUG` is `owner-repo`). `{{SHELF}}` is the **domain** shelf (true in any repo). Never write `fleet-global` directly; lessons reach it by promotion.

**Start** (open both layers):

1. `nb show {{SHELF}}` and apply its lessons.
2. If `KOOKR_REPO_SLUG` is set, also `nb show {{SHELF}}@$KOOKR_REPO_SLUG`. Where the two disagree, the project shelf wins. A shelf that does not exist yet is fine.

`KOOKR_REPO_SLUG` is the session's repo, and a subagent inherits it even when its task is in another repo. Use it only when your task works in the session's own repo. Otherwise skip the project read and the project write, and say so in your final message. If it is unset, skip the project read too (never build a name that ends in `@`).

**End** (before your final message, on the lessons you actually used):

- `nb vote <shelf> <id1,id2,…> +1` for lessons that helped and `-1` for ones that misled you. An `<id>` is the short token at the start of each `nb show` line; give several ids at once. `<shelf>` is whichever of the two shelves the lesson came from.
- `nb rm <shelf> <id> --reason wrong|obsolete` for a lesson that is incorrect (`wrong`) or no longer true (`obsolete`).
- `nb add <shelf> "<lesson>"`: at most one new, non-obvious lesson, about 150 characters, or none. Add it to `{{SHELF}}@$KOOKR_REPO_SLUG` unless it would be true in another repo, then add it to the unscoped `{{SHELF}}` shelf instead. With no project shelf available (slug unset, or the task is in another repo), add it to `{{SHELF}}` only if it is true in any repo.

A multi-step procedure belongs in a skill, not the notebook.
