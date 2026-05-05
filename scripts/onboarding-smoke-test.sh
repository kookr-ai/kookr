#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="${REPORT_DIR:-/tmp}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
REPORT_FILE="$REPORT_DIR/onboarding-report-$TIMESTAMP.md"
CONTAINER_NAME="kookr-onboarding-$TIMESTAMP"
HOOKS_DIR="$REPORT_DIR/onboarding-hooks"
SETTINGS_FILE="$REPORT_DIR/onboarding-settings-$TIMESTAMP.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cleanup() {
  echo "Cleaning up container $CONTAINER_NAME..."
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  rm -f "$SETTINGS_FILE"
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
  -v "$REPORT_DIR:/reports" \
  kookr-onboarding-test \
  sleep infinity

# 3. Copy the repo into the container (simulates git clone)
echo "[3/5] Copying repo into container (simulates git clone)..."
docker cp "$REPO_DIR/." "$CONTAINER_NAME:/home/developer/kookr"
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

# 5. Read the prompt template and inject runtime values
echo "[5/5] Launching Claude Code agent (interactive mode, default model)..."
echo "       Container: $CONTAINER_NAME"
echo "       Settings: $SETTINGS_FILE"
echo ""

PROMPT="$(cat "$REPO_DIR/e2e/onboarding/prompt.md")

---

## Runtime parameters

- **Container name:** $CONTAINER_NAME
- **Report output path:** /reports/onboarding-report-$TIMESTAMP.md
"

# Launch the agent — same pattern as Kookr task agents:
#   claude --settings <settingsPath> '<prompt>'
# Interactive mode, default model, hook-instrumented
claude --settings "$SETTINGS_FILE" "$PROMPT"

# 6. Display results
echo ""
echo "=== Onboarding Smoke Test Complete ==="
echo ""

if [ -f "$REPORT_FILE" ]; then
  cat "$REPORT_FILE"
  echo ""

  # Check verdict
  if grep -qi "verdict.*pass" "$REPORT_FILE"; then
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
