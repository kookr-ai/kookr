---
name: claude-code-metrics-analysis
description: Analyze Claude Code telemetry, stats-cache, and history data from ~/.claude to identify UX friction, performance issues, workflow inefficiencies, and improvement opportunities.
keywords: metrics, telemetry, UX, friction, performance, usage, analytics, stats, session, tool, rate-limit, stall, cost
related: self-reflect, token-efficiency
---

# Claude Code Metrics Analysis

## When to Use

- Periodically (weekly/monthly) to spot UX friction trends
- After noticing slowness, rate limits, or unexpected costs
- When deciding which permissions to auto-approve or which workflows to optimize
- When investigating whether Claude Code usage patterns are efficient

## Data Sources

All data lives under `~/.claude/`:

| Source | Path | Format | Contains |
|--------|------|--------|----------|
| Stats cache | `stats-cache.json` | JSON | Aggregate usage: daily activity, model tokens, hour distribution, session totals |
| Telemetry | `telemetry/*.json` | JSON lines | Granular events: tool use, errors, stalls, rate limits, session lifecycle, performance |
| History | `history.jsonl` | JSONL | User prompts with timestamps, paste events, session IDs, project paths |

**Verified against Claude Code v2.1.170:** `stats-cache.json` and `history.jsonl` exist with the shapes described; the `tengu_*` event names used below are present in the binary. `~/.claude/telemetry/` exists but **may be empty** — event files are not persisted on every install/version. Check `ls ~/.claude/telemetry/` first; if empty, skip the telemetry-based steps and work from `stats-cache.json` + `history.jsonl` alone rather than fabricating event analysis.

## Analysis Procedure

### Step 1: Load aggregate stats

Read `~/.claude/stats-cache.json` and extract:

- **Usage trends**: daily message/session/tool counts — look for spikes or drops
- **Hour distribution** (`hourCounts`): identify peak hours and potential burnout patterns
- **Model usage**: token consumption by model, cache hit ratios
- **Session extremes**: longest session, avg messages/session

### Step 2: Extract telemetry event counts

Run a frequency count across all `~/.claude/telemetry/*.json` files:

```bash
cat ~/.claude/telemetry/*.json | python3 -c "
import sys, json, collections
events = collections.Counter()
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        if d.get('event_type') == 'ClaudeCodeInternalEvent':
            events[d['event_data']['event_name']] += 1
        else:
            events[d['event_type']] += 1
    except: pass
for name, count in events.most_common(80):
    print(f'{count:>8}  {name}')
"
```

### Step 3: Deep-dive into UX-critical events

Parse the telemetry for structured analysis across these dimensions:

#### 3a. Tool Usage & Errors

Extract from `tengu_tool_use_success` and `tengu_tool_use_error`:

```bash
cat ~/.claude/telemetry/*.json | python3 -c "
import sys, json, collections
tool_ok = collections.Counter()
tool_err = collections.Counter()
tool_dur = collections.defaultdict(list)
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        if d.get('event_type') != 'ClaudeCodeInternalEvent': continue
        name = d['event_data']['event_name']
        meta = json.loads(d['event_data'].get('additional_metadata', '{}'))
        if name == 'tengu_tool_use_success':
            tn = meta.get('toolName', '?')
            tool_ok[tn] += 1
            tool_dur[tn].append(meta.get('durationMs', 0))
        elif name == 'tengu_tool_use_error':
            tool_err[meta.get('toolName', '?')] += 1
    except: pass

print('=== Tool Success (top 20) ===')
for tn, c in tool_ok.most_common(20):
    durs = tool_dur[tn]
    avg = sum(durs)/len(durs) if durs else 0
    err = tool_err.get(tn, 0)
    rate = err/(c+err)*100 if (c+err) else 0
    print(f'  {c:>6}x {tn:<25} avg={avg:>8.0f}ms  errors={err} ({rate:.1f}%)')
"
```

**What to look for:**
- High error rates on specific tools (>5% = investigate)
- Tools with very high avg duration (Bash p95 > 30s = long-running commands)
- Agent tool usage patterns (are subagents being used effectively?)

#### 3b. Permission & Auto-Approval Friction

Extract from `tengu_tool_use_granted_in_config` vs total tool uses:

**What to look for:**
- Tools used frequently but NOT in `granted_in_config` = user is clicking "approve" repeatedly
- High ratio of granted-in-config = good, permissions are well-configured
- `tengu_bash_security_check_triggered` count = how often security checks fire (may cause friction if too aggressive)

#### 3c. Rate Limits & API Errors

Extract from `tengu_api_error` and `tengu_claudeai_limits_status_changed`:

**What to look for:**
- `status: "rejected"` count = hard rate limit hits (user is blocked)
- `status: "allowed_warning"` = approaching limits (user may feel pressure)
- `errorType: "rate_limit"` with model breakdown = which models hit limits
- High reject count suggests reducing parallelism or switching models

#### 3d. Streaming Stalls & Performance

Extract from `tengu_streaming_stall` and `tengu_exit` (frame rate data):

**What to look for:**
- Stall durations > 30s = user sees frozen output (frustrating)
- FPS avg < 5 = UI may feel sluggish
- Frame p99 > 100ms = occasional visible jank
- Stalls per session ratio = how often users experience freezes

#### 3e. Session Economics

Extract from `tengu_exit` events:

**What to look for:**
- Cost per session distribution — outlier sessions burning disproportionate budget
- Lines changed vs cost — are expensive sessions productive?
- Session duration distribution — very long sessions may indicate stuck loops
- `tengu_cost_threshold_reached` frequency — how often cost warnings fire

#### 3f. Context & Compaction

Extract from `tengu_post_autocompact_turn` and `tengu_context_size`:

**What to look for:**
- Frequent auto-compaction = sessions hitting context limits regularly
- Large context sizes = prompts may be too verbose or include unnecessary files

#### 3g. User Input Patterns

Extract from `tengu_input_prompt` and `tengu_paste_text`:

**What to look for:**
- `is_negative: true` = user sent rejection/correction (friction signal)
- `is_keep_going: true` = user had to manually continue (automation gap)
- High paste count relative to prompts = user is providing context Claude should find itself
- Prompt count per session = high counts may mean agent isn't autonomous enough

## Friction Pattern Detection

### Pattern: Permission Click Fatigue

**Signal**: Tool X has high usage count but low `granted_in_config` count.
**Impact**: User clicks "approve" dozens of times per session.
**Fix**: Add the tool to `settings.local.json` allowlist or use `--allowedTools`.

### Pattern: Rate Limit Disruption

**Signal**: Multiple `rejected` limit status changes in a session; `tengu_api_retry` events.
**Impact**: User's flow is broken waiting for rate limits to reset.
**Fix**: Reduce concurrent agent count, use Haiku for exploration, batch requests.

### Pattern: Streaming Stall Frustration

**Signal**: `tengu_streaming_stall` with durations > 30s, especially on Opus.
**Impact**: User sees frozen terminal, may think it crashed.
**Fix**: Awareness only (server-side). Consider switching to Sonnet for interactive work.

### Pattern: Expensive Low-Output Sessions

**Signal**: Sessions with high cost but low `lines_added + lines_removed`.
**Impact**: Budget burn without visible progress.
**Fix**: Review what these sessions did — likely research/exploration. Consider using Haiku subagents for exploration.

### Pattern: Context Thrashing

**Signal**: Frequent `tengu_post_autocompact_turn` events in a session.
**Impact**: Lost context, repeated work, confused agent.
**Fix**: Break work into smaller sessions, use `tengu_token_efficiency` skill patterns.

### Pattern: Correction Overhead

**Signal**: High `is_negative` rate in `tengu_input_prompt`, or repeated similar prompts in `history.jsonl`.
**Impact**: User is spending time correcting instead of building.
**Fix**: Encode corrections as CLAUDE.md rules or skills so they persist.

## Output Format

After analysis, produce a report with:

```
## Claude Code Metrics Report — {date range}

### Summary
- Total sessions: X | Total messages: Y | Total cost: $Z
- Models used: {breakdown}
- Peak hour: {hour} ({count} sessions)

### Friction Signals (ordered by impact)

1. **{Pattern Name}** — {description}
   - Evidence: {metric values}
   - Impact: {user experience effect}
   - Recommendation: {specific action}

2. ...

### Efficiency Metrics
- Tool error rate: X%
- Auto-approved tools: X/Y (Z%)
- Rate limit rejections: N
- Streaming stalls: N (avg duration: Xms)
- Auto-compactions: N

### Trends
- Usage trend: {increasing/stable/decreasing}
- Cost trend: {per-session cost over time}
- Model migration: {any model switches visible in data}
```

## Automation Notes

This skill is designed for manual invocation (`/claude-code-metrics-analysis`). The analysis reads local files only — no network calls needed. All Python scripts use only stdlib (json, sys, collections). The telemetry directory can be large (400MB+), so parsing may take 30-60 seconds.
