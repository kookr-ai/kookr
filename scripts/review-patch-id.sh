#!/usr/bin/env bash
# review-patch-id — print the stable patch id of a pull request's own diff.
#
# A verdict from the independent reviewer can be bound to this id (the optional
# `review-patch-id:` line) as well as to the head SHA. A clean rebase moves the
# head SHA but leaves the diff, and therefore the id, unchanged, so a passed
# review survives it. scripts/kookr-merge.sh recomputes the id with --pr and
# compares it with the verdict.
#
# The id is: git diff <merge-base(base, head)> <head> | git patch-id --stable
# An empty diff prints nothing and exits non-zero.
#
# Usage:
#   review-patch-id.sh <base-ref> [<head-ref>]       local refs; head defaults to HEAD
#   review-patch-id.sh --pr <n> [--repo OWNER/NAME]  fetch refs/pull/<n>/head and the
#       PR's base branch from origin (working tree and local branches untouched)
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: review-patch-id.sh <base-ref> [<head-ref>]
       review-patch-id.sh --pr <n> [--repo OWNER/NAME]
USAGE
}

# OWNER/NAME of a remote URL (https, ssh, scp-like), lowercased; empty if unknown.
slug_of_url() {
  local u="$1"
  u="${u%/}"; u="${u%.git}"; u="${u#*://}"; u="${u#*@}"; u="${u//://}"
  case "$u" in
    */*/*) u="${u#"${u%/*/*}/"}" ;;
    */*) ;;
    *) return 0 ;;
  esac
  printf '%s' "$u" | tr '[:upper:]' '[:lower:]'
}

# patch_id <base> <head> — print the id; non-zero on an empty diff or a git failure.
patch_id() {
  local base="$1" head="$2" mb id
  mb="$(git merge-base "$base" "$head")" || { echo "review-patch-id: no merge base between $base and $head" >&2; return 1; }
  id="$(git diff --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ "$mb" "$head" | git patch-id --stable | cut -d' ' -f1)"
  if [[ -z "$id" ]]; then
    echo "review-patch-id: the diff between $mb and $head is empty" >&2
    return 1
  fi
  printf '%s\n' "$id"
}

PR=""
REPO=""
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      PR="$2"; shift 2 ;;
    --repo)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      REPO="$2"; shift 2 ;;
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
    want="$(slug_of_url "$REPO")"
    have="$(slug_of_url "$(git config --get remote.origin.url 2>/dev/null || true)")"
    if [[ -z "$have" || "$want" != "$have" ]]; then
      echo "review-patch-id: this checkout's origin (${have:-unknown}) is not $REPO" >&2
      exit 1
    fi
  fi
  repo_args=()
  [[ -n "$REPO" ]] && repo_args=(--repo "$REPO")
  base_name="$(gh pr view "$PR" ${repo_args[@]+"${repo_args[@]}"} --json baseRefName --jq .baseRefName)" || base_name=""
  [[ -n "$base_name" ]] || { echo "review-patch-id: could not read the base branch of PR #$PR" >&2; exit 1; }
  # Each fetch reads FETCH_HEAD straight away; no ref, branch or worktree changes.
  git fetch --quiet --no-tags origin "refs/pull/$PR/head" || { echo "review-patch-id: could not fetch refs/pull/$PR/head from origin" >&2; exit 1; }
  head_sha="$(git rev-parse --verify FETCH_HEAD^{commit})"
  git fetch --quiet --no-tags origin "refs/heads/$base_name" || { echo "review-patch-id: could not fetch $base_name from origin" >&2; exit 1; }
  base_sha="$(git rev-parse --verify FETCH_HEAD^{commit})"
  patch_id "$base_sha" "$head_sha"
  exit $?
fi

[[ ${#POSITIONAL[@]} -ge 1 && ${#POSITIONAL[@]} -le 2 ]] || { usage; exit 2; }
patch_id "${POSITIONAL[0]}" "${POSITIONAL[1]:-HEAD}"
