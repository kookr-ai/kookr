#!/usr/bin/env bash
# git-identity-guard.sh — reject a push when the repo-local committer identity
# is a test/fixture identity rather than a real person.
#
# Why this exists
# ---------------
# Git worktrees SHARE the main repository's `.git/config` — there is no
# per-worktree config unless `extensions.worktreeConfig` is enabled. So a single
#
#     git config user.email test@example.com
#
# run inside ANY worktree silently rewrites `user.email` for the main repo AND
# every other worktree at once, permanently, with no warning. Roughly a dozen of
# this repo's tests set exactly `test@example.com` / "Kookr Test"; any one of
# them running with a cwd that resolves into the repo or a worktree (an undefined
# variable, a relative path, a test invoked from the wrong directory) poisons the
# shared identity. The symptom surfaces far away: every commit is authored by a
# fake person, and the upstream CLA bot rejects the PR because `test@example.com`
# belongs to no GitHub account.
#
# This guard catches the poisoned STATE at push time — the durable symptom, since
# nothing ever resets it — before more commits inherit the fake author or a PR
# bounces off the CLA check.
#
# What it flags
# -------------
# ONLY a repo-LOCAL `user.email` in an RFC 2606 reserved documentation domain
# (example.com / example.org / example.net / *.example). Those domains can never
# belong to a real committer, so the signal has no false positives. A real local
# override (work vs personal identity) is left alone. The user's GLOBAL identity
# is never inspected — only the repo-local `.git/config` value the poisoning
# lands in.
#
# Exits non-zero on a poisoned identity, printing the one-line fix. Exit 0 when
# clean or when no local identity is set (the global identity then applies, which
# is the healthy default).
#
# Run: bash hooks/git-identity-guard.sh [<repo-root>]

set -u

REPO_ROOT="${1:-${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}}"
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  echo "git-identity-guard: cannot resolve repo root" >&2
  exit 2
fi
cd "$REPO_ROOT" || exit 2

# --local so we inspect only the repo's own .git/config (the shared file the
# poisoning writes to), never the user's global identity. Empty when unset.
LOCAL_EMAIL=$(git config --local --get user.email 2>/dev/null || true)

# No local override → the global identity applies. Healthy; nothing to check.
if [ -z "$LOCAL_EMAIL" ]; then
  exit 0
fi

# RFC 2606 reserves these domains for documentation/examples — no real committer
# uses them. Match is case-insensitive and anchored to the domain end so only the
# address's domain part can trip it.
shopt -s nocasematch
case "$LOCAL_EMAIL" in
  *@example.com | *@example.org | *@example.net | *@*.example)
    shopt -u nocasematch
    LOCAL_NAME=$(git config --local --get user.name 2>/dev/null || true)
    echo "" >&2
    echo "Push rejected: repo-local git identity is a test/fixture identity." >&2
    echo "" >&2
    echo "  user.email = ${LOCAL_EMAIL}" >&2
    [ -n "$LOCAL_NAME" ] && echo "  user.name  = ${LOCAL_NAME}" >&2
    echo "" >&2
    echo "This almost always means a test poisoned the SHARED .git/config: running" >&2
    echo "'git config user.email ...' inside any worktree rewrites the identity for" >&2
    echo "the whole repo and every worktree. Commits made now would carry a fake" >&2
    echo "author and the CLA check would reject the PR." >&2
    echo "" >&2
    echo "Fix — drop the poisoned local override so your global identity applies:" >&2
    echo "  git config --local --remove-section user" >&2
    echo "" >&2
    echo "Then repair any commits already made with it:" >&2
    echo "  git commit --amend --reset-author   # per affected commit" >&2
    echo "" >&2
    echo "If this repo INTENTIONALLY uses a local identity, use a real address —" >&2
    echo "a reserved example.com/.org/.net domain is never a valid committer." >&2
    exit 1
    ;;
esac
shopt -u nocasematch

exit 0
