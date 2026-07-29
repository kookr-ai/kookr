#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="${REPORT_DIR:-/tmp}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
REPORT_FILE="$REPORT_DIR/onboarding-report-$TIMESTAMP.md"
CONTAINER_NAME="kookr-onboarding-$TIMESTAMP"
HOOKS_DIR="$REPORT_DIR/onboarding-hooks-$TIMESTAMP"
SETTINGS_FILE="$REPORT_DIR/onboarding-settings-$TIMESTAMP.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGING_DIR="$(mktemp -d -t kookr-onboarding-stage-XXXXXX)"
DOCKER_NETWORK="${DOCKER_NETWORK:-bridge}"
CLAUDE_PREFLIGHT_TIMEOUT_S="${CLAUDE_PREFLIGHT_TIMEOUT_S:-60}"
ONBOARDING_CONTAINER_AGENT_SMOKE="${ONBOARDING_CONTAINER_AGENT_SMOKE:-0}"

write_failure_report() {
  local title="$1"
  local detail="$2"
  mkdir -p "$REPORT_DIR"
  cat > "$REPORT_FILE" <<REPORT
# Onboarding Smoke Test Report

**Date:** $(date +%Y-%m-%d)
**README version:** $(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)
**Verdict:** FAIL

## Setup Steps

### Preflight: $title
- **Command:** \`claude -p --settings <settings-file> "Reply exactly KOOKR_PREFLIGHT_OK."\`
- **Result:** FAILURE
- **Output:** $detail
- **Issue:** The smoke harness cannot drive the clean environment unless the host running this script has a noninteractive Claude Code authentication path.

## Gaps Found

1. Claude Code authentication was not available to the smoke-test driver.

## Recommendations

1. In CI, set the \`CLAUDE_API_KEY\` repository secret so the workflow can export \`ANTHROPIC_API_KEY\` for Claude Code.
2. For local runs, either run \`claude /login\` on the host first or export \`ANTHROPIC_API_KEY\`.
REPORT
}

run_claude_preflight() {
  echo "[preflight] Checking host Claude Code authentication..."
  if ! command -v claude >/dev/null 2>&1; then
    write_failure_report "Claude Code CLI missing" "claude command not found"
    echo "ERROR: claude command not found. Report written to: $REPORT_FILE"
    return 1
  fi

  local output_file
  # Positional template (not `-t`): BSD/macOS `mktemp -t` treats the argument
  # as a literal prefix and leaves the `XXXXXX` in the path (issue #1431).
  output_file="$(mktemp "${TMPDIR:-/tmp}/kookr-claude-preflight-XXXXXX")"
  local preflight_status=0
  if command -v timeout >/dev/null 2>&1; then
    timeout "$CLAUDE_PREFLIGHT_TIMEOUT_S" \
      claude -p --settings "$SETTINGS_FILE" "Reply exactly KOOKR_PREFLIGHT_OK." \
      >"$output_file" 2>&1 || preflight_status=$?
  else
    claude -p --settings "$SETTINGS_FILE" "Reply exactly KOOKR_PREFLIGHT_OK." \
      >"$output_file" 2>&1 || preflight_status=$?
  fi
  if [ "$preflight_status" -ne 0 ]; then
    local detail
    detail="$(tail -n 20 "$output_file" | sed ':a;N;$!ba;s/\n/\\n/g')"
    write_failure_report "Claude Code auth unavailable" "$detail"
    echo "ERROR: Claude Code preflight failed. Report written to: $REPORT_FILE"
    cat "$REPORT_FILE"
    rm -f "$output_file"
    return 1
  fi
  rm -f "$output_file"
}

run_container_agent_smoke() {
  if [ "$ONBOARDING_CONTAINER_AGENT_SMOKE" != "1" ]; then
    return 0
  fi

  echo ""
  echo "=== Optional Container Agent Launch Smoke ==="

  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "ERROR: ONBOARDING_CONTAINER_AGENT_SMOKE=1 requires ANTHROPIC_API_KEY."
    return 1
  fi

  docker exec -u developer -w /home/developer/kookr "$CONTAINER_NAME" bash -lc '
    set -euo pipefail
    export PATH="$HOME/.local/bin:$PATH"
    if ! command -v claude >/dev/null 2>&1; then
      curl -fsSL https://claude.ai/install.sh | bash >/tmp/kookr-claude-install.log 2>&1
    fi
  '

  docker exec -e ANTHROPIC_API_KEY -u developer -w /home/developer/kookr "$CONTAINER_NAME" bash -lc '
    set -euo pipefail
    export PATH="$HOME/.local/bin:$PATH"

    pnpm build >/tmp/kookr-container-build.log 2>&1
    KOOKR_PORT=4901 ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" PATH="$PATH" \
      nohup node dist/server/start.js >/tmp/kookr-container-server.log 2>&1 &
    server_pid=$!
    trap "kill $server_pid 2>/dev/null || true" EXIT

    for _ in $(seq 1 60); do
      if curl -fsS http://127.0.0.1:4901/api/health >/tmp/kookr-container-health.json 2>/dev/null; then
        break
      fi
      sleep 1
    done
    curl -fsS http://127.0.0.1:4901/api/health >/tmp/kookr-container-health.json

    task_json="$(curl -fsS -X POST http://127.0.0.1:4901/api/tasks \
      -H "Content-Type: application/json" \
      -d "{\"prompt\":\"Reply exactly KOOKR_CONTAINER_AGENT_OK and then stop. Do not edit files.\",\"cwd\":\"/home/developer/kookr\",\"agentType\":\"claude-code\"}")"
    printf "%s" "$task_json" >/tmp/kookr-container-task.json
    task_id="$(printf "%s" "$task_json" | node -e "const fs=require(\"fs\"); const t=JSON.parse(fs.readFileSync(0,\"utf8\")); console.log(t.id)")"
    session_id="$(printf "%s" "$task_json" | node -e "const fs=require(\"fs\"); const t=JSON.parse(fs.readFileSync(0,\"utf8\")); console.log(t.sessions[0].tmuxSession)")"

    plugin_seen=0
    stop_seen=0
    for _ in $(seq 1 90); do
      if ps -ef | grep -F -- "--plugin-dir /home/developer/kookr/plugin" | grep -v grep >/tmp/kookr-container-agent-ps.txt; then
        plugin_seen=1
      fi
      hook_file="$HOME/.kookr-4901/hooks/$session_id.jsonl"
      if [ -s "$hook_file" ] && grep -q "\"hook_event_name\":\"Stop\"" "$hook_file"; then
        stop_seen=1
        break
      fi
      sleep 1
    done

    hook_file="$HOME/.kookr-4901/hooks/$session_id.jsonl"
    test "$plugin_seen" = "1"
    test -s "$hook_file"
    grep -q "\"hook_event_name\":\"SessionStart\"" "$hook_file"
    grep -q "\"hook_event_name\":\"UserPromptSubmit\"" "$hook_file"
    grep -q "\"hook_event_name\":\"Stop\"" "$hook_file"
    grep -q "KOOKR_CONTAINER_AGENT_OK" "$hook_file"

    curl -fsS -X DELETE "http://127.0.0.1:4901/api/tasks/$task_id" >/dev/null
  '
}

cleanup() {
  echo "Cleaning up container $CONTAINER_NAME..."
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  rm -f "$SETTINGS_FILE"
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

echo "=== Kookr Onboarding Smoke Test ==="
echo "Timestamp: $TIMESTAMP"
echo "Report will be written to: $REPORT_FILE"
echo ""

# 1. Build the minimal Docker image
echo "[1/5] Building Docker image..."
docker build -t kookr-onboarding-test -f "$REPO_DIR/e2e/onboarding/Dockerfile" "$REPO_DIR"

# 2. Start the container in the background
echo "[2/5] Starting clean Ubuntu container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --network "$DOCKER_NETWORK" \
  -v "$REPORT_DIR:/reports" \
  kookr-onboarding-test \
  sleep infinity

# 3. Stage a clean clone of the repo, then copy it in. We clone to a temp dir
#    rather than `docker cp`-ing $REPO_DIR/. directly because the working tree
#    typically contains node_modules/, dist/, vendor/dtach/dtach (compiled),
#    and — when run from a git worktree — a `.git` *file* pointing at a host
#    path that doesn't exist in the container. A clone gives us only HEAD-
#    tracked files and a real `.git` directory, which is what a real user
#    sees after `git clone`.
echo "[3/5] Staging clean clone (simulates fresh git clone)..."
git clone --quiet "$REPO_DIR" "$STAGING_DIR/kookr"
docker cp "$STAGING_DIR/kookr/." "$CONTAINER_NAME:/home/developer/kookr"
docker exec "$CONTAINER_NAME" sudo chown -R developer:developer /home/developer/kookr

# 4. Generate hook settings (same pattern as ClaudeCodeAdapter.generateSettings)
echo "[4/5] Generating agent settings..."
mkdir -p "$HOOKS_DIR"
cat > "$SETTINGS_FILE" <<SETTINGS
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)"
    ]
  },
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cat >> $HOOKS_DIR/onboarding.jsonl" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cat >> $HOOKS_DIR/onboarding.jsonl" }] }],
    "Stop": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cat >> $HOOKS_DIR/onboarding.jsonl" }] }]
  }
}
SETTINGS

run_claude_preflight

# 5. Read the prompt template and inject runtime values
echo "[5/5] Launching Claude Code agent (headless / -p mode, default model)..."
echo "       Container: $CONTAINER_NAME"
echo "       Settings: $SETTINGS_FILE"
echo ""

PROMPT="$(cat "$REPO_DIR/e2e/onboarding/prompt.md")

---

## Runtime parameters

- **Container name:** $CONTAINER_NAME
- **Report output path:** /reports/onboarding-report-$TIMESTAMP.md
"

# Launch the agent in headless mode (-p / --print). The agent runs through
# the prompt, drives the container via the Bash tool, writes its verdict
# report via the Write tool, and exits. Headless mode lets the script run
# from non-TTY contexts (CI, cron, in-conversation Bash). Hooks defined in
# $SETTINGS_FILE still fire.
claude -p --settings "$SETTINGS_FILE" "$PROMPT"

# 6. Display results
echo ""
echo "=== Onboarding Smoke Test Complete ==="
echo ""

if [ -f "$REPORT_FILE" ]; then
  cat "$REPORT_FILE"
  echo ""

  # Check verdict
  if grep -qi "verdict.*pass" "$REPORT_FILE"; then
    if ! run_container_agent_smoke; then
      {
        echo ""
        echo "## Optional Container Agent Launch Smoke"
        echo ""
        echo "- **Result:** FAILURE"
        echo "- **Issue:** Kookr could not launch an authenticated Claude Code agent from inside the clean container."
      } >> "$REPORT_FILE"
      echo "--- RESULT: Onboarding test FAILED — optional container agent smoke failed ---"
      exit 1
    fi
    if [ "$ONBOARDING_CONTAINER_AGENT_SMOKE" = "1" ]; then
      {
        echo ""
        echo "## Optional Container Agent Launch Smoke"
        echo ""
        echo "- **Result:** SUCCESS"
        echo "- **Checks:** Kookr launched Claude Code inside the clean container, injected the toolkit plugin directory, and captured SessionStart/UserPromptSubmit/Stop hook events."
      } >> "$REPORT_FILE"
    fi
    echo "--- RESULT: Onboarding test PASSED ---"
    exit 0
  else
    echo "--- RESULT: Onboarding test FAILED — README needs updates ---"
    exit 1
  fi
else
  echo "ERROR: Report was not generated at $REPORT_FILE"
  echo "Check hook log at: $HOOKS_DIR/onboarding.jsonl"
  echo ""
  # Check if the report was written without the timestamp suffix
  FOUND=$(find "$REPORT_DIR" -name "onboarding-report*.md" -newer "$SETTINGS_FILE" 2>/dev/null | head -1)
  if [ -n "$FOUND" ]; then
    echo "Found report at: $FOUND"
    cat "$FOUND"
  fi
  exit 1
fi
