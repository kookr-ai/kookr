#!/usr/bin/env bash
# Installer for the OSS tracking PostToolUse hook.
#
# Usage:
#   ./scripts/install-oss-tracking-hook.sh            # install
#   ./scripts/install-oss-tracking-hook.sh --uninstall # remove
#
# What it does:
#   1. Copies scripts/oss-contribution-gate-posttool.sh to ~/.claude/hooks/
#   2. Prints the ~/.claude/settings.json snippet you need to paste under the
#      "hooks" key (idempotent setup by hand — we don't touch settings.json
#      automatically because it's user-owned and contains other entries).
#
# See: docs/rfc/rfc-oss-contribution-tracking.md (section "PostToolUse hook")

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/scripts/oss-contribution-gate-posttool.sh"
DEST_DIR="$HOME/.claude/hooks"
DEST="$DEST_DIR/oss-contribution-gate-posttool.sh"

cmd="${1:-install}"

case "$cmd" in
  install)
    if [ ! -f "$SRC" ]; then
      echo "Source hook not found: $SRC" >&2
      exit 1
    fi
    mkdir -p "$DEST_DIR"
    cp "$SRC" "$DEST"
    chmod +x "$DEST"
    echo "Installed: $DEST"
    echo
    echo "Next step: add this block to ~/.claude/settings.json under 'hooks'."
    echo "If 'hooks.PostToolUse' already exists, append the entry to its array."
    echo
    cat <<'JSON'
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/oss-contribution-gate-posttool.sh",
            "if": "Bash(gh pr create*)"
          }
        ]
      }
    ]
  }
}
JSON
    echo
    echo "After editing settings.json, the hook will fire on the next 'gh pr create'."
    ;;
  --uninstall|uninstall)
    if [ -f "$DEST" ]; then
      rm "$DEST"
      echo "Removed: $DEST"
    else
      echo "Not installed: $DEST"
    fi
    echo
    echo "You still need to remove the 'PostToolUse' entry for"
    echo "oss-contribution-gate-posttool.sh from ~/.claude/settings.json by hand."
    ;;
  *)
    echo "Usage: $0 [install|--uninstall]" >&2
    exit 1
    ;;
esac
