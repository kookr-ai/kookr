---
name: kookr-oss-contribution-gate
description: Rate limiting and blocked-repo enforcement for OSS contributions — hook behavior, oss-gate CLI, ledger format, configuration
keywords: rate limit, oss, contribution, gate, hook, blocked, ledger, pr, pull request, safety, cadence
related: [oss-fork-manager, kookr-oss-repo-recon, kookr-pr-lifecycle]
---

# OSS Contribution Gate

A Claude Code PreToolUse hook that enforces per-repo daily PR rate limits and blocks contributions to repos with anti-AI policies.

## How It Works

The hook intercepts every `Bash` tool call. If the command matches `gh pr create`, it:

1. Extracts the target repo from `--repo`/`-R` flag (or git remote)
2. Checks the blocked list in `~/.kookr/rate-limits.json`
3. Checks `~/.kookr/oss-repos.json` for `anti-ai` or `blocked` status
4. Counts today's `pr_created` entries in the ledger for that repo
5. Blocks if the repo is banned, registry-blocked, or the daily limit is reached
6. Records the result in the contribution ledger

The hook is **fail-open**: if it crashes, the command proceeds (no rate limiting). Hook health is tracked via a heartbeat file.

## Files

| File | Purpose |
|------|---------|
| `~/.claude/hooks/oss-contribution-gate.sh` | The hook script (PreToolUse, matcher: Bash) |
| `~/.claude/hooks/oss-gate` | CLI helper for status, reset, log, health |
| `~/.kookr/rate-limits.json` | Configuration: defaults, per-repo overrides, blocked list |
| `~/.kookr/contribution-ledger.jsonl` | Append-only audit trail of all PR creation attempts |
| `~/.kookr/oss-repos.json` | OSS repo registry: AI scores, eligibility status (checked after blocked list) |
| `~/.kookr/gate-heartbeat` | Timestamp of last hook invocation |

## CLI Commands

```bash
# Check today's PR counts per repo
oss-gate status

# Check a specific repo
oss-gate status grafana/grafana

# Free a consumed slot (e.g., after gh pr create failed)
oss-gate reset grafana/grafana

# Show last 20 ledger entries
oss-gate log

# Show last 50
oss-gate log 50

# Check if the hook is alive
oss-gate health
```

## Configuration

Edit `~/.kookr/rate-limits.json`:

```json
{
  "defaults": { "maxPrsPerDay": 1 },
  "overrides": {
    "grafana/grafana": { "maxPrsPerDay": 2 }
  },
  "blocked": ["ggml-org/llama.cpp"]
}
```

- `defaults.maxPrsPerDay`: Global default. Set to 1 (conservative).
- `overrides`: Per-repo overrides keyed by `owner/repo`.
- `blocked`: Repos where PR creation is always rejected.

## Ledger Schema

Each line in `~/.kookr/contribution-ledger.jsonl` is a JSON object:

```typescript
interface LedgerEntry {
  timestamp: string;    // ISO 8601 UTC
  repo: string;         // "owner/repo"
  action: 'pr_created' | 'pr_allowed' | 'pr_blocked_rate_limit'
        | 'pr_blocked_blocked_repo' | 'pr_blocked_registry' | 'slot_reset';
  prUrl?: string;       // When parseable from gh output
  blockReason?: string; // When blocked
  taskId?: string;      // From KOOKR_TASK_ID env var
  command?: string;     // Matched command (truncated to 200 chars)
}
```

**Schema stability:** The `timestamp`, `repo`, and `action` fields are a stable contract. Other systems (e.g., Kookr dashboard) can read from this ledger.

## Key Design Decisions

| Decision | Why |
|----------|-----|
| **Fail-open** | A crashed hook = no rate limiting (pre-existing behavior), not "all contributions blocked" |
| **Over-counting accepted** | Hook writes `pr_created` BEFORE `gh pr create` runs. If the PR fails, use `oss-gate reset` |
| **`gh pr create` only** | Doesn't match `curl` or `gh api`. Bypass via raw API = instruction problem, not hook problem |
| **`mkdir`-based locking** | Portable across Linux and macOS (no `flock` dependency) |
| **1 PR/day default** | Conservative. Override per repo if needed |

## When an Agent Gets Blocked

The hook returns a structured message:

```
Rate limit exceeded for grafana/grafana: 1/1 PRs today.
Next slot opens at 2026-04-02T00:00:00Z.
Use 'oss-gate reset grafana/grafana' if the last PR failed and you need to free the slot.
```

**What to do:**
- If the previous PR actually failed → `oss-gate reset <repo>` and retry
- If the limit is genuinely reached → wait until tomorrow or ask the developer to increase the limit
- If the repo is blocked → do not attempt. Work on a different repo.

## For Playbook Authors

Playbooks should check limits *before* attempting `gh pr create` to fail fast:

```bash
# Quick pre-check (doesn't consume a slot)
TODAY=$(date -u +%Y-%m-%d)
REPO="grafana/grafana"
COUNT=$(grep -c "\"$TODAY\".*\"$REPO\".*\"pr_created\"" ~/.kookr/contribution-ledger.jsonl 2>/dev/null || echo 0)
LIMIT=$(jq -r ".overrides[\"$REPO\"].maxPrsPerDay // .defaults.maxPrsPerDay // 1" ~/.kookr/rate-limits.json 2>/dev/null || echo 1)
if [ "$COUNT" -ge "$LIMIT" ]; then
  echo "Rate limit reached for $REPO ($COUNT/$LIMIT today). Skipping."
  exit 0
fi
```

The hook is still the backstop — this just avoids wasted work.

## Testing

Run the test suite:

```bash
~/.claude/hooks/test-gate.sh
```

Covers: pass-through, blocked repos, rate limiting, -R flag, slot reset, heartbeat, ledger integrity.
