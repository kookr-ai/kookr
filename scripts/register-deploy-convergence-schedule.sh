#!/usr/bin/env bash
# Register (or update) the deploy-convergence invariant schedule (issue #1883):
#   Every 15 minutes, assert kookr-prod's serving commit includes origin/main
#   HEAD; on divergence past the grace window, trigger the canonical redeploy
#   (POST /api/deploy/trigger -> prod-update.sh) and -- if that fails to
#   converge -- file a P0.
#
# Issue #2569: the scheduler execs the playbook's probe.command first. A
# converged / probe-blip tick records completed with no agent slot. Exit 2
# still launches the playbook for heal + P0.
#
# Requires: kookr server up on $KOOKR_API_BASE_URL; the project-tier playbook
# present at $KOOKR_DEV/.kookr/playbooks/kookr-deploy-convergence.md.
set -euo pipefail

API="${KOOKR_API_BASE_URL:-http://127.0.0.1:4800}"
# Prefer an explicit KOOKR_DEV_DIR; otherwise walk common trees so a dirty main
# checkout without the playbook (feature branch worktree) does not block
# registration of a schedule that already lives on kookr-prod (issue #2226).
KOOKR_DEV="${KOOKR_DEV_DIR:-}"
if [[ -z "$KOOKR_DEV" ]]; then
  for candidate in \
    "${KOOKR_PROD_DIR:-$HOME/git/kookr-prod}" \
    "$HOME/git/kookr" \
    "$(cd "$(dirname "$0")/.." && pwd)"; do
    if [[ -f "$candidate/.kookr/playbooks/kookr-deploy-convergence.md" ]]; then
      KOOKR_DEV="$candidate"
      break
    fi
  done
fi
KOOKR_DEV="${KOOKR_DEV:-$HOME/git/kookr}"
# Omit agentType when CONVERGENCE_AGENT_TYPE is unset so the schedule service
# pins the operator's settings.defaultAgentType (not a hard-coded claude-code).
AGENT="${CONVERGENCE_AGENT_TYPE:-}"
CRON="${CONVERGENCE_CRON:-*/15 * * * *}"
ENABLED="${CONVERGENCE_ENABLED:-true}"
BRANCH="${DEPLOY_BRANCH:-main}"
GRACE_MINUTES="${CONVERGENCE_GRACE_MINUTES:-15}"
ACT="${CONVERGENCE_ACT:-true}"
DRY_RUN="${CONVERGENCE_DRY_RUN:-false}"

PLAYBOOK_PATH="kookr-deploy-convergence.md"
PLAYBOOK_FILE="$KOOKR_DEV/.kookr/playbooks/$PLAYBOOK_PATH"
NAME="Kookr Deploy Convergence"

if [[ ! -f "$PLAYBOOK_FILE" ]]; then
  echo "ERROR: missing playbook at $PLAYBOOK_FILE" >&2
  echo "Check out the branch that adds .kookr/playbooks/$PLAYBOOK_PATH first," >&2
  echo "or set KOOKR_DEV_DIR / KOOKR_PROD_DIR to a tree that has it." >&2
  exit 1
fi

find_schedule_id() {
  local want_path="$1"
  local want_name="$2"
  curl -sS "$API/api/schedules" | WANT_PATH="$want_path" WANT_NAME="$want_name" python3 -c '
import json, os, sys
raw = json.load(sys.stdin)
if isinstance(raw, list):
  schedules = raw
elif isinstance(raw, dict):
  schedules = raw.get("schedules") or raw.get("items") or []
else:
  schedules = []
want_path = os.environ["WANT_PATH"]
want_name = os.environ["WANT_NAME"]
by_path = by_name = None
for s in schedules:
  if not isinstance(s, dict):
    continue
  pb = s.get("playbook") or {}
  path = pb.get("path") if isinstance(pb, dict) else None
  if path == want_path and by_path is None:
    by_path = s.get("id", "")
  if s.get("name") == want_name and by_name is None:
    by_name = s.get("id", "")
print(by_path or by_name or "")
' 2>/dev/null || true
}

BODY=$(
  NAME="$NAME" CRON="$CRON" KOOKR_DEV="$KOOKR_DEV" AGENT="$AGENT" \
  ENABLED="$ENABLED" BRANCH="$BRANCH" GRACE_MINUTES="$GRACE_MINUTES" \
  ACT="$ACT" DRY_RUN="$DRY_RUN" PLAYBOOK_PATH="$PLAYBOOK_PATH" python3 - <<'PY'
import json, os
body = {
  "name": os.environ["NAME"],
  "cron": os.environ["CRON"],
  "cwd": os.environ["KOOKR_DEV"],
  "enabled": os.environ["ENABLED"] == "true",
  "playbook": {
    "path": os.environ["PLAYBOOK_PATH"],
    "parameters": {
      "branch": os.environ["BRANCH"],
      "graceMinutes": os.environ["GRACE_MINUTES"],
      "act": os.environ["ACT"],
      "dryRun": os.environ["DRY_RUN"],
    },
  },
}
agent = os.environ.get("AGENT", "").strip()
if agent:
  body["agentType"] = agent
print(json.dumps(body))
PY
)

existing="$(find_schedule_id "$PLAYBOOK_PATH" "$NAME")"
if [[ -n "${existing:-}" ]]; then
  echo "Updating schedule $existing ($NAME) ..."
  curl -sS -X PATCH "$API/api/schedules/$existing" \
    -H 'content-type: application/json' \
    -d "$BODY" | python3 -m json.tool
else
  echo "Creating schedule ($NAME) ..."
  curl -sS -X POST "$API/api/schedules" \
    -H 'content-type: application/json' \
    -d "$BODY" | python3 -m json.tool
fi

echo
echo "Deploy-convergence schedule:"
curl -sS "$API/api/schedules" | python3 -c '
import json, sys
raw = json.load(sys.stdin)
schedules = raw if isinstance(raw, list) else (raw.get("schedules") or raw.get("items") or [])
for s in schedules:
  if not isinstance(s, dict):
    continue
  if s.get("name") == "Kookr Deploy Convergence":
    pb = s.get("playbook") or {}
    print(
      s.get("id"),
      "enabled=" + str(s.get("enabled")),
      "cron=" + str(s.get("cron")),
      "agent=" + str(s.get("agentType")),
      "playbook=" + str(pb.get("path") if isinstance(pb, dict) else pb),
    )
'
