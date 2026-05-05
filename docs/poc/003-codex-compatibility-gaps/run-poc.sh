#!/usr/bin/env bash
# POC 003: Codex CLI vs Claude Code Compatibility Test
#
# Runs both agents with identical hook settings and compares:
# - Which hook events fire
# - Payload field structure
# - Tool name conventions
# - Session lifecycle
#
# Usage: bash run-poc.sh

set -euo pipefail

POC_DIR="/tmp/poc-codex-compat"
WORK_DIR="/tmp/poc-codex-compat/workdir"
HOOKS_DIR="$POC_DIR/hooks"
SETTINGS_DIR="$POC_DIR/settings"
RESULTS_DIR="$POC_DIR/results"

mkdir -p "$WORK_DIR" "$HOOKS_DIR" "$SETTINGS_DIR" "$RESULTS_DIR"

# Create a simple test workspace
echo "Hello World" > "$WORK_DIR/test.txt"
mkdir -p "$WORK_DIR/.git" 2>/dev/null || true
(cd "$WORK_DIR" && git init -q 2>/dev/null || true)

PROMPT='Read the file test.txt and tell me what it contains. Then create a file called output.txt with the text "done".'

# ──────────────────────────────────────────────────────────────────
# Generate hook settings (identical format for both agents)
# ──────────────────────────────────────────────────────────────────

generate_settings() {
  local name="$1"
  local hook_file="$HOOKS_DIR/${name}.jsonl"

  # Simple cat >> to capture raw hook JSON
  local hook_cmd="cat >> $hook_file"

  cat > "$SETTINGS_DIR/${name}.json" <<SETTINGS_EOF
{
  "hooks": {
    "SessionStart": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }],
    "StopFailure": [{ "matcher": "", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }],
    "SubagentStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }],
    "SubagentStop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }],
    "SessionEnd": [{ "matcher": "", "hooks": [{ "type": "command", "command": "$hook_cmd" }] }]
  }
}
SETTINGS_EOF
}

# ──────────────────────────────────────────────────────────────────
# Test 1: Claude Code (non-interactive --print mode)
# ──────────────────────────────────────────────────────────────────

run_claude() {
  echo "═══════════════════════════════════════════════════════"
  echo "  TEST: Claude Code (--print mode)"
  echo "═══════════════════════════════════════════════════════"

  local name="claude-test"
  generate_settings "$name"

  # Clean previous
  rm -f "$HOOKS_DIR/${name}.jsonl"
  rm -f "$WORK_DIR/output.txt"

  echo "[$(date +%T)] Launching Claude Code..."

  # Run with --print for non-interactive, --dangerously-skip-permissions for auto-approve
  timeout 120 claude \
    --print \
    --dangerously-skip-permissions \
    --settings "$SETTINGS_DIR/${name}.json" \
    --output-format stream-json \
    --include-hook-events \
    "$PROMPT" \
    2>"$RESULTS_DIR/claude-stderr.log" \
    >"$RESULTS_DIR/claude-stdout.jsonl" \
    || echo "[WARN] Claude exited with code $?"

  echo "[$(date +%T)] Claude Code finished."

  # Also run in plain text mode to compare
  rm -f "$HOOKS_DIR/${name}-plain.jsonl"
  rm -f "$WORK_DIR/output.txt"

  local name2="claude-plain"
  generate_settings "$name2"

  timeout 120 claude \
    --print \
    --dangerously-skip-permissions \
    --settings "$SETTINGS_DIR/${name2}.json" \
    "$PROMPT" \
    2>"$RESULTS_DIR/claude-plain-stderr.log" \
    >"$RESULTS_DIR/claude-plain-stdout.txt" \
    || echo "[WARN] Claude (plain) exited with code $?"

  echo "[$(date +%T)] Claude Code (plain) finished."
}

# ──────────────────────────────────────────────────────────────────
# Test 2: Codex CLI (exec mode, non-interactive)
# ──────────────────────────────────────────────────────────────────

run_codex_exec() {
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  TEST: Codex CLI (exec mode, --json)"
  echo "═══════════════════════════════════════════════════════"

  local name="codex-exec"
  generate_settings "$name"

  # Clean previous
  rm -f "$HOOKS_DIR/${name}.jsonl"
  rm -f "$WORK_DIR/output.txt"

  echo "[$(date +%T)] Launching Codex CLI exec..."

  timeout 120 codex exec \
    --json \
    --full-auto \
    --settings "$SETTINGS_DIR/${name}.json" \
    -C "$WORK_DIR" \
    "$PROMPT" \
    2>"$RESULTS_DIR/codex-exec-stderr.log" \
    >"$RESULTS_DIR/codex-exec-stdout.jsonl" \
    || echo "[WARN] Codex exec exited with code $?"

  echo "[$(date +%T)] Codex CLI exec finished."
}

# ──────────────────────────────────────────────────────────────────
# Test 3: Codex CLI (interactive mode, in tmux — like Kookr uses)
# ──────────────────────────────────────────────────────────────────

run_codex_interactive() {
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  TEST: Codex CLI (interactive mode via tmux)"
  echo "═══════════════════════════════════════════════════════"

  local name="codex-interactive"
  generate_settings "$name"

  # Clean previous
  rm -f "$HOOKS_DIR/${name}.jsonl"
  rm -f "$WORK_DIR/output.txt"

  local tmux_session="poc-codex-int"

  # Kill any existing session
  tmux kill-session -t "$tmux_session" 2>/dev/null || true

  echo "[$(date +%T)] Launching Codex CLI in tmux (interactive)..."

  # Launch exactly as Kookr does
  local escaped_prompt
  escaped_prompt=$(printf '%s' "$PROMPT" | sed "s/'/'\\\\''/g")

  tmux new-session -d -s "$tmux_session" -x 200 -y 50 \
    "cd '$WORK_DIR' && codex --full-auto --settings '$SETTINGS_DIR/${name}.json' '$escaped_prompt'; echo '=== CODEX EXITED ===' ; sleep 30"

  echo "[$(date +%T)] Waiting for Codex to complete (max 120s)..."

  # Wait for hook events or timeout
  local waited=0
  while [ $waited -lt 120 ]; do
    sleep 5
    waited=$((waited + 5))

    # Check if session still exists
    if ! tmux has-session -t "$tmux_session" 2>/dev/null; then
      echo "[$(date +%T)] Tmux session ended after ${waited}s"
      break
    fi

    # Check for Stop event (agent completed)
    if [ -f "$HOOKS_DIR/${name}.jsonl" ]; then
      if grep -q '"Stop"' "$HOOKS_DIR/${name}.jsonl" 2>/dev/null; then
        echo "[$(date +%T)] Stop event detected after ${waited}s"
        # Capture terminal display
        tmux capture-pane -t "$tmux_session" -p > "$RESULTS_DIR/codex-interactive-display.txt" 2>/dev/null || true
        sleep 2  # Let any final events flush
        break
      fi
    fi

    echo "  ... waiting (${waited}s, hook events: $(wc -l < "$HOOKS_DIR/${name}.jsonl" 2>/dev/null || echo 0))"
  done

  # Capture final display
  tmux capture-pane -t "$tmux_session" -p > "$RESULTS_DIR/codex-interactive-display.txt" 2>/dev/null || true

  # Kill session
  tmux kill-session -t "$tmux_session" 2>/dev/null || true

  echo "[$(date +%T)] Codex CLI interactive test finished."
}

# ──────────────────────────────────────────────────────────────────
# Test 4: Claude Code (interactive mode, in tmux — like Kookr uses)
# ──────────────────────────────────────────────────────────────────

run_claude_interactive() {
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  TEST: Claude Code (interactive mode via tmux)"
  echo "═══════════════════════════════════════════════════════"

  local name="claude-interactive"
  generate_settings "$name"

  # Clean previous
  rm -f "$HOOKS_DIR/${name}.jsonl"
  rm -f "$WORK_DIR/output.txt"

  local tmux_session="poc-claude-int"

  # Kill any existing session
  tmux kill-session -t "$tmux_session" 2>/dev/null || true

  echo "[$(date +%T)] Launching Claude Code in tmux (interactive)..."

  local escaped_prompt
  escaped_prompt=$(printf '%s' "$PROMPT" | sed "s/'/'\\\\''/g")

  tmux new-session -d -s "$tmux_session" -x 200 -y 50 \
    "cd '$WORK_DIR' && claude --settings '$SETTINGS_DIR/${name}.json' '$escaped_prompt'; echo '=== CLAUDE EXITED ===' ; sleep 30"

  echo "[$(date +%T)] Waiting for Claude to complete (max 120s)..."

  local waited=0
  while [ $waited -lt 120 ]; do
    sleep 5
    waited=$((waited + 5))

    if ! tmux has-session -t "$tmux_session" 2>/dev/null; then
      echo "[$(date +%T)] Tmux session ended after ${waited}s"
      break
    fi

    if [ -f "$HOOKS_DIR/${name}.jsonl" ]; then
      if grep -q '"Stop"' "$HOOKS_DIR/${name}.jsonl" 2>/dev/null; then
        echo "[$(date +%T)] Stop event detected after ${waited}s"
        tmux capture-pane -t "$tmux_session" -p > "$RESULTS_DIR/claude-interactive-display.txt" 2>/dev/null || true
        sleep 2
        break
      fi
    fi

    echo "  ... waiting (${waited}s, hook events: $(wc -l < "$HOOKS_DIR/${name}.jsonl" 2>/dev/null || echo 0))"
  done

  tmux capture-pane -t "$tmux_session" -p > "$RESULTS_DIR/claude-interactive-display.txt" 2>/dev/null || true
  tmux kill-session -t "$tmux_session" 2>/dev/null || true

  echo "[$(date +%T)] Claude Code interactive test finished."
}

# ──────────────────────────────────────────────────────────────────
# Analysis: Compare hook events
# ──────────────────────────────────────────────────────────────────

analyze_results() {
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  ANALYSIS: Hook Event Comparison"
  echo "═══════════════════════════════════════════════════════"
  echo ""

  for hook_file in "$HOOKS_DIR"/*.jsonl; do
    local base
    base=$(basename "$hook_file" .jsonl)
    echo "─── $base ───"

    if [ ! -s "$hook_file" ]; then
      echo "  (no events captured)"
      echo ""
      continue
    fi

    echo "  Total events: $(wc -l < "$hook_file")"
    echo ""

    # Event type counts
    echo "  Event types:"
    jq -r '.hook_event_name // "UNKNOWN"' "$hook_file" 2>/dev/null | sort | uniq -c | sort -rn | while read -r count name; do
      printf "    %-25s %s\n" "$name" "$count"
    done
    echo ""

    # Tool names used
    echo "  Tool names:"
    jq -r 'select(.tool_name != null) | .tool_name' "$hook_file" 2>/dev/null | sort | uniq -c | sort -rn | while read -r count name; do
      printf "    %-25s %s\n" "$name" "$count"
    done
    echo ""

    # Session ID
    echo "  Session IDs:"
    jq -r '.session_id // "MISSING"' "$hook_file" 2>/dev/null | sort -u | head -3
    echo ""

    # Fields present (sample from first event of each type)
    echo "  Fields in first event of each type:"
    jq -r '.hook_event_name // "UNKNOWN"' "$hook_file" 2>/dev/null | sort -u | while read -r etype; do
      fields=$(jq -r "select(.hook_event_name == \"$etype\") | keys | join(\", \")" "$hook_file" 2>/dev/null | head -1)
      printf "    %-25s → %s\n" "$etype" "$fields"
    done
    echo ""

    # Save prettified version for manual inspection
    jq '.' "$hook_file" > "$RESULTS_DIR/${base}-pretty.json" 2>/dev/null || true

  done

  echo ""
  echo "─── STDOUT JSONL comparison ───"
  echo ""

  if [ -f "$RESULTS_DIR/claude-stdout.jsonl" ] && [ -s "$RESULTS_DIR/claude-stdout.jsonl" ]; then
    echo "  Claude stream-json event types:"
    jq -r '.type // "UNKNOWN"' "$RESULTS_DIR/claude-stdout.jsonl" 2>/dev/null | sort | uniq -c | sort -rn | head -20
    echo ""
  fi

  if [ -f "$RESULTS_DIR/codex-exec-stdout.jsonl" ] && [ -s "$RESULTS_DIR/codex-exec-stdout.jsonl" ]; then
    echo "  Codex exec --json event types:"
    jq -r '.type // "UNKNOWN"' "$RESULTS_DIR/codex-exec-stdout.jsonl" 2>/dev/null | sort | uniq -c | sort -rn | head -20
    echo ""
  fi

  echo ""
  echo "─── Files in results directory ───"
  ls -la "$RESULTS_DIR/"
  echo ""
  echo "─── Files in hooks directory ───"
  ls -la "$HOOKS_DIR/"
}

# ──────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────

echo "POC 003: Codex CLI vs Claude Code Compatibility"
echo "================================================"
echo "Date: $(date)"
echo "Work dir: $WORK_DIR"
echo "Codex: $(codex --version 2>&1)"
echo "Claude: $(claude --version 2>&1)"
echo ""

# Run all tests
cd "$WORK_DIR"

run_claude
run_codex_exec
run_claude_interactive
run_codex_interactive

# Analyze
analyze_results

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  POC COMPLETE — Raw data in $RESULTS_DIR"
echo "═══════════════════════════════════════════════════════"
