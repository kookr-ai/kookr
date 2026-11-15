#!/usr/bin/env bash
# review-patch-id — print an id of the exact file versions a pull request changes.
#
# A verdict from the independent reviewer can be bound to this id (the optional
# `review-patch-id:` line) as well as to the head SHA. A rebase moves the head
# SHA; if it leaves the PR's changes untouched the id is unchanged, so a passed
# review survives it. scripts/kookr-merge.sh recomputes the id with --pr and
# compares it with the verdict.
#
# The id is a git blob hash (40 lowercase hex) of the tree-level change list
#   git diff-tree -r --no-commit-id --full-index --no-renames <merge-base> <head>
# i.e. one raw line per changed path: old mode, new mode, old blob id, new blob
# id, status and path. Blob ids are content hashes, so ANY change to ANY byte of
# ANY file the PR touches changes the id (whitespace, NUL bytes, binary files,
# modes, renames, and the same edit made at a different place in a file).
# Rename detection is off, so the output never depends on similarity scores.
#
# Trade-off, stated plainly: the id survives a rebase ONLY when the new base did
# not change any file the PR also touches. If it did, the PR's "old" blob for
# that file differs, the id changes, and the reviewer must re-review. That fails
# closed on purpose; a rebase onto a base that changed only other files keeps
# the id.
#
# Neither common alternative is used. `git patch-id` strips all whitespace and
# sees no binary content, so a re-indent, a removed space inside a string or a
# replaced binary file keeps the same id. A normalised text diff (hunk headers
# reduced to `@@`) ignores WHERE a hunk applies, so the same edit made in a
# different but identical-looking function gets the same id.
#
# An empty change list (empty diff) prints nothing and exits non-zero.
#
# Usage:
#   review-patch-id.sh <base-ref> [<head-ref>]       local refs; head defaults to HEAD
#   review-patch-id.sh --pr <n> [--repo OWNER/NAME] [--expect-head <sha>]
#       fetch refs/pull/<n>/head and the PR's base branch from origin (working
#       tree and local branches untouched); with --expect-head, fail unless the
#       fetched head commit is exactly <sha>
set -euo pipefail

# shellcheck source=lib/repo-slug.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/repo-slug.sh"

usage() {
  cat >&2 <<'USAGE'
Usage: review-patch-id.sh <base-ref> [<head-ref>]
       review-patch-id.sh --pr <n> [--repo OWNER/NAME] [--expect-head <sha>]
USAGE
}

# patch_id <base> <head> — print the id; non-zero on an empty diff or a git failure.
patch_id() {
  local base="$1" head="$2" mb id
  local -a list_cmd
  mb="$(git merge-base "$base" "$head")" || { echo "review-patch-id: no merge base between $base and $head" >&2; return 1; }
  list_cmd=(git diff-tree -r --no-commit-id --full-index --no-renames "$mb" "$head")
  # `--quiet` exits 0 when there is no difference, 1 when there is one.
  if git diff-tree -r --quiet --no-renames "$mb" "$head"; then
    echo "review-patch-id: the diff between $mb and $head is empty" >&2
    return 1
  fi
  # The change list is piped straight into the hash and never held in a shell
  # variable (bash drops NUL bytes from a variable; paths may hold odd bytes).
  # pipefail makes a failing git fail the whole pipeline.
  id="$(set -o pipefail; "${list_cmd[@]}" | git hash-object --stdin)" \
    || { echo "review-patch-id: could not hash the changes between $mb and $head" >&2; return 1; }
  printf '%s\n' "$id"
}

PR=""
REPO=""
EXPECT_HEAD=""
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      PR="$2"; shift 2 ;;
    --repo)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      REPO="$2"; shift 2 ;;
    --expect-head)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      EXPECT_HEAD="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "review-patch-id: unknown option: $1" >&2; usage; exit 2 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

if [[ -n "$PR" ]]; then
  [[ "$PR" =~ ^[0-9]+$ && ${#POSITIONAL[@]} -eq 0 ]] || { usage; exit 2; }
  command -v gh >/dev/null || { echo "review-patch-id: gh is required for --pr" >&2; exit 1; }
  git rev-parse --git-dir >/dev/null 2>&1 || { echo "review-patch-id: not inside a git checkout" >&2; exit 1; }
  if [[ -n "$REPO" ]]; then
    want="$(repo_slug_of_url "$REPO")"
    have="$(repo_slug_of_url "$(git config --get remote.origin.url 2>/dev/null || true)")"
    if [[ -z "$have" || "$want" != "$have" ]]; then
      echo "review-patch-id: this checkout's origin (${have:-unknown}) is not $REPO" >&2
      exit 1
    fi
  fi
  repo_args=()
  [[ -n "$REPO" ]] && repo_args=(--repo "$REPO")
  base_name="$(gh pr view "$PR" ${repo_args[@]+"${repo_args[@]}"} --json baseRefName --jq .baseRefName)" || base_name=""
  [[ -n "$base_name" ]] || { echo "review-patch-id: could not read the base branch of PR #$PR" >&2; exit 1; }
  # Name both commits by SHA from one ls-remote, then fetch them. FETCH_HEAD is
  # never read: another fetch in the same worktree (a hook, an editor, a second
  # merge) can replace it between our fetch and our read. No ref, branch or
  # worktree changes.
  pull_ref="refs/pull/$PR/head"
  base_ref="refs/heads/$base_name"
  remote_refs="$(git ls-remote origin "$pull_ref" "$base_ref")" \
    || { echo "review-patch-id: could not list $pull_ref and $base_ref on origin" >&2; exit 1; }
  head_sha="$(printf '%s\n' "$remote_refs" | awk -v r="$pull_ref" '$2 == r { print tolower($1); exit }')"
  base_sha="$(printf '%s\n' "$remote_refs" | awk -v r="$base_ref" '$2 == r { print tolower($1); exit }')"
  [[ -n "$head_sha" ]] || { echo "review-patch-id: could not fetch $pull_ref from origin (no such ref)" >&2; exit 1; }
  if [[ -n "$EXPECT_HEAD" && "$head_sha" != "$EXPECT_HEAD" ]]; then
    echo "review-patch-id: $pull_ref is $head_sha, not the expected head $EXPECT_HEAD" >&2
    exit 1
  fi
  [[ -n "$base_sha" ]] || { echo "review-patch-id: could not fetch $base_name from origin (no such branch)" >&2; exit 1; }
  git fetch --quiet --no-tags origin "$pull_ref" "$base_ref" \
    || { echo "review-patch-id: could not fetch $pull_ref and $base_name from origin" >&2; exit 1; }
  # If a ref moved between ls-remote and the fetch, the listed commit may be
  # missing locally: fail rather than guess.
  for sha in "$head_sha" "$base_sha"; do
    git cat-file -e "$sha^{commit}" 2>/dev/null \
      || { echo "review-patch-id: commit $sha is not available after the fetch (did origin move?); retry" >&2; exit 1; }
  done
  patch_id "$base_sha" "$head_sha"
  exit $?
fi

[[ -z "$EXPECT_HEAD" ]] || { echo "review-patch-id: --expect-head requires --pr" >&2; usage; exit 2; }
[[ ${#POSITIONAL[@]} -ge 1 && ${#POSITIONAL[@]} -le 2 ]] || { usage; exit 2; }
patch_id "${POSITIONAL[0]}" "${POSITIONAL[1]:-HEAD}"
