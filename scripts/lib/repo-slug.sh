#!/usr/bin/env bash
# repo-slug.sh — sourced library; defines functions only, runs nothing.
# Shared by scripts/kookr-merge.sh and scripts/review-patch-id.sh.

# repo_slug_of_url — OWNER/NAME (lowercase) of a remote URL or `--repo` value
# (https, ssh, scp-like, HOST/OWNER/NAME); empty when it cannot be derived.
repo_slug_of_url() {
  local u="$1"
  u="${u%/}"; u="${u%.git}"; u="${u#*://}"; u="${u#*@}"; u="${u//://}"
  case "$u" in
    */*/*) u="${u#"${u%/*/*}/"}" ;;
    */*) ;;
    *) return 0 ;;
  esac
  printf '%s' "$u" | tr '[:upper:]' '[:lower:]'
}
