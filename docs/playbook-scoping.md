# Playbook scoping

Playbooks are reusable task templates. Kookr discovers them from three independent tiers, so generic workflows can ship once and apply everywhere instead of being copy-pasted into every repo.

## The three tiers

| Tier      | Location                                              | Use case                                   |
| --------- | ----------------------------------------------------- | ------------------------------------------ |
| `project` | `<cwd>/.kookr/playbooks/*.md`                         | Repo-specific workflows (e.g. project-only release flow) |
| `user`    | `~/.kookr/playbooks/*.md` or `$KOOKR_USER_PLAYBOOKS_DIR` | Personal workflows you want in every repo |
| `plugin`  | `<kookr-toolkit-plugin>/playbooks/*.md`               | Bundled playbooks shipped with kookr       |

The plugin tier is auto-detected from the running kookr install. Override with `KOOKR_PLUGIN_DIR` if you've installed the plugin somewhere unusual.

## Precedence

When two tiers contain a playbook with the same filename (id), the higher-precedence tier wins:

```
project > user > plugin
```

So a repo can shadow a bundled playbook by dropping a same-named file in `.kookr/playbooks/`.

## What appears in each repo

- `project` playbooks only appear when the dashboard cwd matches the repo.
- `user` playbooks appear in every cwd.
- `plugin` playbooks appear in every cwd by default — unless the playbook declares `repo-tags`, in which case it's filtered.

## Filtering plugin playbooks with `repo-tags`

Some bundled playbooks only make sense in certain kinds of repos (e.g. `oss-bug-fix` requires the `gh` CLI and a github remote). To avoid cluttering unrelated repos, a plugin playbook can declare `repo-tags`:

```yaml
---
name: OSS Bug Fix
repo-tags: [github]
---
```

A playbook with non-empty `repo-tags` is hidden in cwds whose detected tags don't intersect.

### How a cwd's tags are detected

In order, merged into one set:

1. **`KOOKR_REPO_TAGS` env** — comma- or newline-separated. Short-circuits everything below. Useful for tests and unusual setups.
2. **`<cwd>/.kookr/repo-tags`** — plain text, one tag per line. `#` comments and blank lines are ignored. Use this to manually opt a repo into tags.
3. **Auto-detected** — `github` is added if `git remote get-url origin` returns a github.com URL.

Example `.kookr/repo-tags`:

```
# Tags this repo opts into for plugin playbook filtering.
oss
typescript
```

### When the filter does NOT apply

- `project` and `user` tier playbooks are **never** filtered by `repo-tags` — you placed those files deliberately.
- `plugin` playbooks with no `repo-tags` are always visible.

## Environment variables

| Var | Effect |
| --- | ------ |
| `KOOKR_PLUGIN_DIR` | Override plugin tree location. Must contain `.claude-plugin/plugin.json`. |
| `KOOKR_USER_PLAYBOOKS_DIR` | Override the per-user playbooks dir (default `~/.kookr/playbooks`). |
| `KOOKR_REPO_TAGS` | Override the cwd's detected tags. Mostly for tests. Empty string forces "no tags". |

## UI provenance

The Playbook Browser shows a small `plugin` or `user` badge next to playbooks that came from outside the current project. Project-tier playbooks show no badge (they're the default).
