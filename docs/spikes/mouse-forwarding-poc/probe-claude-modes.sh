#!/usr/bin/env bash
# Spawn Claude Code in an interactive PTY, capture the first N KB of output,
# then kill it. Decode DECSET / DECRST sequences so we can see exactly which
# modes Claude Code enables (alt-screen? mouse? alternate scroll?).
set -u
OUT="$(mktemp)"
# `script` allocates a PTY and records everything Claude Code writes to stdout.
# We send Ctrl-C then Ctrl-D to exit cleanly after 3 seconds.
(
  sleep 3
  # Send SIGTERM to claude to shut it down.
  pkill -TERM -f '^/home/jean/.local/bin/claude' 2>/dev/null || true
) &
timeout 4 script -qc 'claude' "$OUT" >/dev/null 2>&1 || true
wait 2>/dev/null || true

echo "--- RAW (first 4KB, hex) ---"
head -c 4096 "$OUT" | xxd | head -40
echo ""
echo "--- DECSET / DECRST hits ---"
# Decode \e[?NNNh / \e[?NNNl with grep + awk
grep -aoE $'\x1b\\[\\?[0-9;]+[hl]' "$OUT" | sort -u
echo ""
echo "--- ARROW-KEY-like sequences emitted by app (unlikely but check) ---"
grep -aoE $'\x1b\\[[ABCD]' "$OUT" | sort | uniq -c | head
echo ""
echo "Total bytes captured: $(wc -c < "$OUT")"
rm -f "$OUT"
