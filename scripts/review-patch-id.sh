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
# modes, renames, and the same edit made at a different place in a file),
# except that for the three line-bound pages below the same changed lines made
# at a different place in the page keep the id. Rename detection is off, so the output never depends on similarity scores.
#
# Trade-off, stated plainly: outside the three line-bound pages below, the id
# survives a rebase ONLY when the new base did not change any file the PR also
# touches. If it did, the PR's "old" blob for
# that file differs, the id changes, and the reviewer must re-review. That fails
# closed on purpose; a rebase onto a base that changed only other files keeps
# the id.
#
# One exception, for three shared reference pages (#3798): an explicit list of
# exact paths, nothing pattern-based (LINE_BOUND_PATHS below):
#   docs/reference/environment-variables.md, docs/reference/api.md,
#   docs/reference/cli.md
# Most pull requests that add an environment variable, an API route or a CLI
# command add a row to one of them, so nearly every rebase onto a moved base
# changed the PR's "old" blob there and voided a passed review even when the
# two PRs shared no line. For these paths only, the change-list line carries,
# in place of the old/new blob ids, the hash of the PR's own changed lines for
# that file: every added and removed line, with its content and in order, but
# without line numbers, hunk headers or unchanged context
#   git diff -U0 <merge-base> <head> -- <path>, minus the header and `@@` lines
# So a rebase onto a base that added a different row elsewhere in the page
# keeps the id, and any change to the PR's own rows changes it. The cost, which
# the operator accepted: the same rows moved to another place in the page keep
# the id. The exception applies only to a plain text edit of one of these
# files (status M, mode 100644 on both sides, no NUL byte in either version);
# an add, delete, rename, mode change or binary content keeps the blob-level
# line, which fails closed. Every other path keeps the blob-level binding.
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

# Paths whose change-list line is bound to the PR's own changed lines instead
# of blob ids (see the header). Exact repository-relative paths only.
LINE_BOUND_PATHS=(
  docs/reference/environment-variables.md
  docs/reference/api.md
  docs/reference/cli.md
)

is_line_bound_path() {
  local p
  for p in "${LINE_BOUND_PATHS[@]}"; do
    [[ "$1" == "$p" ]] && return 0
  done
  return 1
}

# blob_is_nul_free <oid> — true only when the blob was read and holds no NUL
# byte. A read error answers false, which keeps the blob-level line.
blob_is_nul_free() {
  local size stripped
  size="$(git cat-file -s "$1")" || return 1
  stripped="$(set -o pipefail; git cat-file blob "$1" | LC_ALL=C tr -d '\000' | LC_ALL=C wc -c | tr -d ' ')" || return 1
  [[ -n "$size" && "$size" == "$stripped" ]]
}

# changed_lines_id <base> <head> <path> — print the hash of the added and
# removed lines of <path> between the two commits (content and order only).
# The diff options (and GIT_DIFF_OPTS) are pinned so user config and the
# environment cannot change the output, and the
# pathspec is anchored at the top of the tree (diff-tree prints root-relative
# paths; the script may run from a subdirectory).
changed_lines_id() {
  local id empty
  empty="$(git hash-object --stdin </dev/null)" || return 1
  id="$(set -o pipefail
    GIT_DIFF_OPTS= git -c diff.noprefix=false -c diff.mnemonicPrefix=false diff \
      --no-color --no-ext-diff --no-textconv --no-renames --no-relative \
      --diff-algorithm=myers --indent-heuristic -U0 --inter-hunk-context=0 \
      "$1" "$2" -- ":(top,literal)$3" \
      | awk 'body && !/^@@/ { print } /^@@/ { body = 1 }' \
      | git hash-object --stdin)" || return 1
  # The hash of empty input (SHA-1 or SHA-256 repo): no changed line was seen,
  # e.g. a diff attribute made git call the file binary. Refuse rather than
  # bind every version of the page to the same id.
  [[ -n "$id" && "$id" != "$empty" ]] || return 1
  printf '%s\n' "$id"
}

# change_list <merge-base> <head> — the raw change list, with each eligible
# line-bound entry rewritten as `:100644 100644 <lines-id> <lines-id> M<TAB>path`
# (the old and new blob slots both hold the changed-lines id). Every other line
# is passed through byte for byte, so the id of a PR that touches none of the
# line-bound paths is the same as before this exception existed.
# Without -z, diff-tree prints one line per path (it quotes any odd byte in a
# path, and a path cannot hold a NUL), so reading it line by line is lossless.
change_list() {
  local mb="$1" head="$2" line meta path old_mode new_mode old_oid new_oid status lid
  while IFS= read -r line; do
    meta="${line%%$'\t'*}"
    path="${line#*$'\t'}"
    if [[ "$meta" != "$line" ]] && is_line_bound_path "$path"; then
      read -r old_mode new_mode old_oid new_oid status <<<"${meta#:}"
      if [[ "$old_mode" == 100644 && "$new_mode" == 100644 && "$status" == M ]] \
        && blob_is_nul_free "$old_oid" && blob_is_nul_free "$new_oid"; then
        lid="$(changed_lines_id "$mb" "$head" "$path")" \
          || { echo "review-patch-id: could not hash the changed lines of $path" >&2; return 1; }
        printf ':100644 100644 %s %s M\t%s\n' "$lid" "$lid" "$path"
        continue
      fi
    fi
    printf '%s\n' "$line"
  done
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
  # variable as a whole. pipefail makes a failing git (or a failing
  # changed-lines hash) fail the whole pipeline.
  id="$(set -o pipefail; "${list_cmd[@]}" | change_list "$mb" "$head" | git hash-object --stdin)" \
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
