#!/bin/bash
# filter-conventions.sh <context-file> <conventions-file>
# Appends repository conventions to the context file.
# Conventions files are typically small enough to include in full.
set -euo pipefail

CONTEXT="$1"
CONVENTIONS="$2"

[ -f "$CONVENTIONS" ] || { echo "No conventions file at $CONVENTIONS"; exit 0; }

echo ""
echo "## Repository Conventions (for reviewer reference)"
echo ""
cat "$CONVENTIONS"
