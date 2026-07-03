# ADR-012: GitHub PR/Issue Awareness

## Status

**Accepted** (2026-03-25)

> Implementation note (2026-05-09): The GitHub awareness pipeline is implemented, but Stage 1 reference extraction is deterministic regex extraction in `src/core/github-reference-scanner.ts`, not Haiku-assisted extraction. `GitHubScannerService.scanForReferences()` keeps LLM extraction as a future safety-net entry point; the accepted architecture remains periodic `gh` polling + diffing + attention alerts.

## Context

Kookr supervises AI coding agents and routes developer attention to agents that need help. Agents frequently interact with GitHub — creating PRs, referencing issues, pushing code — but Kookr currently has **zero visibility** into what happens on GitHub after an agent performs these actions.

### The Problem

When a supervised agent creates a PR (e.g., `gh pr create` → PR #42), the developer has no way to know through Kookr that:
- A reviewer left unresolved comments on PR #42 ten minutes later
- CI checks failed after the push
- The PR was marked "changes requested"
- A new comment appeared that requires the agent's attention

The developer must manually check GitHub, which defeats the purpose of a supervisor that routes attention. This is especially problematic when multiple agents are creating multiple PRs simultaneously.

### The Opportunity

Kookr already has the infrastructure for periodic monitoring (liveness checks, permission polling), event-driven alerts (anomaly detection → attention queue), and real-time UI updates (WebSocket snapshots). Adding GitHub awareness means:

1. **Extracting** GitHub references (PR numbers, issue URLs) from agent terminal output
2. **Fetching** GitHub context periodically (comments, CI status, review state)
3. **Diffing** fetched state to detect new actionable events
4. **Alerting** the developer through the existing attention queue
5. **Displaying** GitHub context in the dashboard

### Relationship to Existing Architecture

The supervisor agent (see `docs/architecture.md`) processes event streams and detects anomalies. GitHub PR awareness extends this by monitoring an **external event source** (GitHub) alongside the existing agent event stream. It follows the same pattern: detect → explain → alert → route attention.

Current data channels per agent:
- **Hooks** — real-time tool use, permission requests, stop events
- **Transcript JSONL** — full session history
- **Terminal bytes** — streamed via `LocalDtachBackend` ring buffer → `SessionBridge` → xterm.js (replaces the original `tmux capture-pane` snapshot channel per ADR-014)

This ADR adds a fourth channel:
- **GitHub state** — PR/issue status, comments, CI checks (polled periodically)

## Options

### Option A: Periodic `gh` CLI Polling with Haiku-Assisted Extraction (Recommended)

A two-stage pipeline:

**Stage 1 — Reference Extraction:**
Use Claude Haiku to periodically scan recent hook events (specifically `tool_result` events from `Bash` tool calls that contain GitHub output) and extract structured GitHub references. Haiku is chosen for cost efficiency — extraction is a simple structured-output task.

**Stage 2 — GitHub State Polling:**
For each extracted reference, periodically call `gh` CLI commands to fetch current state. Diff against previous state to detect new events.

#### Architecture

```
Agent hook events (tool_result from Bash)
  ↓
┌─────────────────────────────────────┐
│ GitHubReferenceScanner (periodic)    │
│ - Reads recent tool_result events    │
│ - Calls Haiku to extract PR/issue #s │
│ - Stores references per task         │
└────────────────┬────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│ GitHubStateFetcher (periodic)        │
│ - For each known reference:          │
│   - gh pr view / gh issue view       │
│   - gh pr checks                     │
│   - gh api for review threads        │
│ - Diffs against previous state       │
│ - Emits GitHubStateChange events     │
└────────────────┬────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│ Monitor (existing)                   │
│ - Receives GitHubStateChange         │
│ - Raises attention alert             │
│ - Broadcasts snapshot update         │
└────────────────┬────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│ Frontend — "GitHub" tab (new)        │
│ - Shows PR list with status badges   │
│ - Unresolved comments detail         │
│ - CI check summary                   │
│ - Timeline of recent events          │
└─────────────────────────────────────┘
```

#### Reference Extraction Strategy

Rather than regex-only parsing (which misses indirect references like "the PR I just created"), use Haiku with a structured-output prompt:

```typescript
// Prompt sent to Haiku periodically
const prompt = `Extract GitHub PR and issue references from these agent tool results.
Return JSON: { refs: [{ type: "pr"|"issue", number: number, owner: string, repo: string, url?: string }] }
If no references found, return { refs: [] }.

Tool results:
${recentToolResults}`;
```

**Fallback:** Also run a regex pass to catch obvious patterns (`#123`, `github.com/.../pull/42`, `gh pr create` output) without an API call. Haiku is only invoked when the regex finds potential references or on a slower interval.

#### GitHub State Model

```typescript
interface GitHubReference {
  type: 'pr' | 'issue';
  owner: string;
  repo: string;
  number: number;
  url: string;
  detectedAt: Date;
  detectedFrom: string; // agentId / tmuxSession
  taskId: string;
}

interface GitHubPRState {
  ref: GitHubReference;
  title: string;
  status: 'open' | 'closed' | 'merged' | 'draft';
  author: string;
  branch: string;
  baseBranch: string;

  // Review state
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  reviewers: Array<{
    login: string;
    state: 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  }>;

  // Comments
  unresolvedThreads: Array<{
    id: string;
    author: string;
    body: string;
    path?: string;
    line?: number;
    createdAt: string;
  }>;
  totalComments: number;

  // CI
  checks: Array<{
    name: string;
    status: 'queued' | 'in_progress' | 'completed';
    conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'skipped' | null;
  }>;

  lastFetchedAt: Date;
}

interface GitHubIssueState {
  ref: GitHubReference;
  title: string;
  status: 'open' | 'closed';
  author: string;
  labels: string[];
  commentCount: number;
  lastFetchedAt: Date;
}

// Event emitted when state changes
type GitHubStateChange =
  | { type: 'new_comment'; ref: GitHubReference; comment: { author: string; body: string; path?: string } }
  | { type: 'ci_failed'; ref: GitHubReference; check: { name: string; conclusion: string } }
  | { type: 'review_requested_changes'; ref: GitHubReference; reviewer: string }
  | { type: 'pr_merged'; ref: GitHubReference }
  | { type: 'pr_closed'; ref: GitHubReference }
  | { type: 'new_unresolved_thread'; ref: GitHubReference; thread: { author: string; body: string; path?: string } };
```

#### Polling Strategy

| What | Interval | Method | Cost |
|------|----------|--------|------|
| Regex scan of recent events | Every new `tool_result` event (event-driven) | Local regex, zero cost | Free |
| Haiku extraction (when regex finds potential refs) | Every 5 min per task | 1 Haiku API call (~200 input tokens, ~50 output tokens) | ~$0.0001/call |
| GitHub PR state fetch | Every 1 min per known PR | `gh` CLI calls (3-4 per PR) | Free (uses user's `gh` auth) |
| GitHub issue state fetch | Every 10 min per known issue | `gh` CLI calls (1 per issue) | Free |

**Rate limit safety:** GitHub API allows 5,000 requests/hour for authenticated users. With 10 PRs polled every 1 min at 4 calls each = 2,400 calls/hour — well within limits (52% headroom). The scanner respects `X-RateLimit-Remaining` headers and backs off when below 500 remaining.

#### `gh` CLI Commands

```bash
# PR summary (status, title, author, branch, review decision)
gh pr view 42 --json title,state,author,headRefName,baseRefName,reviewDecision,isDraft

# Review threads (unresolved comments)
gh api graphql -f query='{
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: 42) {
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          comments(first: 5) {
            nodes { author { login } body path line createdAt }
          }
        }
      }
    }
  }
}'

# CI checks
gh pr checks 42 --json name,state,conclusion

# Issue summary
gh issue view 123 --json title,state,author,labels,comments
```

**Pros:**
- Combines cheap regex scanning (event-driven, free) with smart Haiku extraction (periodic, very cheap)
- Uses `gh` CLI — no need to manage GitHub API tokens directly (uses user's existing auth)
- Leverages existing infrastructure: Monitor for alerts, WebSocket for UI updates, attention queue for priority
- Incremental: can start with regex-only extraction (no Haiku needed), add Haiku later for better recall
- GitHub state diffing is deterministic — same state always produces the same diff
- Cost is negligible: ~$0.003/hour for 10 PRs with Haiku extraction

**Cons:**
- Adds external dependency on `gh` CLI (must be installed and authenticated)
- Haiku API calls add marginal cost (though very small)
- 1-minute polling means events are near-real-time but not instant (acceptable for code review workflows)
- `gh` CLI calls are synchronous and slow (~1-2s each) — need to run in background

### Option B: Regex-Only Extraction, No LLM

Skip Haiku entirely. Use only regex patterns to extract GitHub references from tool results.

```typescript
const patterns = [
  /https:\/\/github\.com\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/,
  /(?:^|\s)#(\d+)\b/,                    // bare #123
  /gh pr create.*?(\d+)/,                 // gh pr create output
  /PR #(\d+)/i,                           // "PR #42"
  /(?:pull request|issue) (?:#)?(\d+)/i,  // "pull request 42"
];
```

**Pros:**
- Zero API cost for extraction
- Deterministic, testable
- No external LLM dependency
- Faster — no network call for extraction

**Cons:**
- Misses indirect references ("the PR I just created", "check the issue")
- Cannot disambiguate context (is `#123` a PR, issue, or commit ref?)
- Requires owner/repo inference (from git remote or cwd)
- Regex patterns need ongoing maintenance as agent output formats evolve

### Option C: GitHub Webhooks Instead of Polling

Instead of polling `gh` CLI, set up a local webhook receiver that GitHub pushes events to.

**Pros:**
- Real-time: events arrive immediately (seconds, not minutes)
- More efficient: no wasted API calls when nothing changed
- Richer data: webhook payloads include full context

**Cons:**
- **Requires ngrok/tunnel or public URL** — Kookr is local-only (ADR-003)
- Configuration complexity: user must set up GitHub webhooks per repo
- Security: exposes a local endpoint to the internet
- Doesn't work offline or on private networks
- Overkill for V1 — 1-minute polling is sufficient for code review workflows

### Option D: GitHub Actions Workflow + File Watcher

Create a GitHub Actions workflow that writes PR state to a file in the repo, which Kookr watches locally after `git pull`.

**Pros:**
- No `gh` CLI dependency
- Works with any git hosting (not just GitHub)
- State is versioned in git

**Cons:**
- Requires workflow changes per repo — not transparent to the user
- Latency: depends on git pull frequency
- Pollutes repo with state files
- Overcomplicated for the problem

## Evaluation

| Criterion | Weight | A: gh CLI + Haiku | B: Regex Only | C: Webhooks | D: Actions |
|-----------|--------|-------------------|---------------|-------------|------------|
| Detection accuracy (catches refs) | High | Best (regex + LLM) | Good (common patterns) | N/A (detection is separate) | N/A |
| Event freshness | Medium | 1 min (near-real-time) | 1 min | **Real-time** | Minutes+ |
| Implementation complexity | High | Medium | **Low** | **High** | High |
| No external dependencies | Medium | Needs `gh` CLI + API key | Needs `gh` CLI | Needs tunnel | Needs repo changes |
| Works with local-only deployment | Critical | **Yes** | **Yes** | **No** (needs tunnel) | Awkward |
| Cost | Medium | ~$0.003/hr | **Free** | Free | Free |
| Incremental implementation | High | **Yes** (regex first, Haiku later) | Yes | No | No |
| Aligns with V1 simplicity | High | Yes | **Yes** | No | No |

## Recommendation

**Option A: Periodic `gh` CLI Polling with Haiku-Assisted Extraction.**

Implemented in phases:

### Phase 1: Regex extraction + `gh` CLI polling (no Haiku)
- Regex-based reference extraction from `tool_result` events
- `gh` CLI polling for known references
- State diffing and alert integration
- Frontend "GitHub" tab with PR details
- This phase is functionally Option B — proving the pipeline works before adding LLM

### Phase 2: Haiku-assisted extraction
- Add Haiku structured-output calls for better reference detection
- Detect indirect references that regex misses
- Configurable: can be disabled to run regex-only

### Phase 3: Richer GitHub context
- PR diff summaries
- Suggested actions ("reviewer X requested changes — instruct agent to address")
- Cross-reference between agent's code changes and PR review comments

## Implementation Notes

### New Files

> Updated 2026-03-29: Added `github-alerts.ts` and `github-scanner-service.ts` which were created during implementation.

```
src/core/github-types.ts            — GitHubReference, GitHubPRState, GitHubStateChange types ✅
src/core/github-reference-scanner.ts — Regex extraction from events ✅
src/core/github-state-store.ts       — In-memory store for GitHub state per task ✅
src/core/github-state-differ.ts      — Diff previous vs current state → GitHubStateChange[] ✅
src/core/github-scanner-service.ts   — Periodic extraction + fetch orchestrator ✅
src/core/github-alerts.ts            — GitHub state change → human-readable alert formatter ✅
src/adapters/github-fetcher.ts       — gh CLI wrapper: fetch PR/issue details ✅
src/frontend/components/GitHubPanel.tsx — React component for GitHub tab ✅
```

### Modifications

> Updated 2026-03-29: `AnomalyType` was not extended and `Monitor` was not modified. GitHub alerts are broadcast directly from the server.

```
src/server/index.ts       — Wire periodic GitHub scanner, broadcast alerts directly
src/server/ws.ts          — Add 'github_update' server message, extend snapshot with github state
src/frontend/store/       — Add GitHub state to Zustand store
src/frontend/App.tsx      — Add GitHub tab toggle to detail panel
src/frontend/styles.css   — Styles for GitHub tab components
```

> **Implementation note (2026-03-31):** The implementation diverged from the planned `AnomalyType` integration. GitHub events do **not** flow through the anomaly detector or attention queue. Instead, they use a separate alert channel: `github_update` WebSocket messages carry `GitHubStateChange[]` directly to the frontend, and `github-alerts.ts` formats human-readable alert text. This was a deliberate simplification — GitHub events have different lifecycle and priority characteristics than agent anomalies, and mixing them in the attention queue would complicate triage.

### Integration with Existing Systems

> **Implementation note (Updated 2026-03-29):** The original design routed GitHub alerts through `Monitor` and extended `AnomalyType`. The actual implementation takes a simpler approach: GitHub alerts are broadcast directly from `src/server/index.ts` via `broadcastToAll()`, bypassing `Monitor` and the attention queue. `AnomalyType` was not extended with `github_*` variants. Instead, `src/core/github-alerts.ts` defines its own `GitHubAlert` type with `summary` and `severity` fields. The `github_update` and `alert` server messages carry GitHub state changes directly to the frontend.

**~~Monitor integration~~ (not implemented as designed):**
```typescript
// Originally planned — NOT implemented. AnomalyType was not extended.
// GitHub alerts use a separate GitHubAlert type in src/core/github-alerts.ts
// and are broadcast directly from the server, not routed through Monitor.
```

GitHub alert severity follows the same model as originally designed:
- `changes_requested` → warning severity (reviewer needs response)
- `ci_failed` → warning severity (CI needs fixing)
- `new_comments` → info severity (comments to review)

**WebSocket integration (as-built):**
```typescript
// Server message types (both implemented)
type ServerMessage =
  | ... existing types ...
  | { type: 'github_update'; taskId: string; prs: GitHubPRState[]; issues: GitHubIssueState[]; changes: GitHubStateChange[] }
  | { type: 'alert'; agentId: string; summary: string; details: string; severity: AnomalySeverity }; // also used for GitHub alerts
```

**Frontend tab:**
The GitHub tab is a panel within the DetailPanel (right side), toggled via a tab bar at the top of the detail area. When viewing an agent, the user can switch between "Terminal" and "GitHub" views. This avoids a 3-column layout change while keeping GitHub context accessible.

```
┌─────────────────────────────────────────────────────┐
│ DetailPanel                                          │
│ ┌─────────────────────────────────────────────────┐  │
│ │ [Terminal] [GitHub (2)]                          │  │
│ ├─────────────────────────────────────────────────┤  │
│ │                                                  │  │
│ │  (Terminal view or GitHub panel, based on tab)   │  │
│ │                                                  │  │
│ └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Configuration

```typescript
interface GitHubScannerConfig {
  enabled: boolean;                    // default: true
  referenceExtractionIntervalMs: number; // default: 60_000 (1 min)
  stateFetchIntervalMs: number;        // default: 60_000 (1 min)
  useHaikuExtraction: boolean;         // default: false (Phase 1: regex only)
  maxPRsPerTask: number;               // default: 10
  maxIssuesPerTask: number;            // default: 20
  maxScannedPromptCacheEntries: number; // default: 5_000
  maxOwnerRepoCacheEntries: number;    // default: 1_000
}
```

### `gh` CLI Dependency

The scanner checks for `gh` CLI availability on startup:
```typescript
// Check gh is available and authenticated
const { status } = spawnSync('gh', ['auth', 'status'], { timeout: 5000 });
if (status !== 0) {
  console.warn('GitHub awareness disabled: gh CLI not authenticated. Run: gh auth login');
}
```

If `gh` is unavailable, the entire GitHub awareness feature is silently disabled (graceful degradation). A status indicator in the UI shows whether GitHub monitoring is active.

### Owner/Repo Inference

For bare references like `#123`, the scanner needs to know the owner/repo. Strategy:
1. Check the task's `cwd` for a git remote: `git -C {cwd} remote get-url origin`
2. Parse the remote URL to extract owner/repo
3. Cache recent per-cwd lookups in a bounded cache; default max owner/repo cache entries: 1,000
4. Full URLs (`github.com/owner/repo/pull/42`) are self-contained — no inference needed

### Testing Strategy

**Unit tests:**
- `github-reference-scanner.test.ts` — regex extraction from various tool_result formats
- `github-state-differ.test.ts` — diff detection for all GitHubStateChange types
- `github-state-store.test.ts` — store CRUD operations

**Integration tests (mocked `gh` CLI):**
- `github-fetcher.test.ts` — mock `execFileSync('gh', ...)` responses
- `github-scanner-integration.test.ts` — full pipeline: events → extraction → fetch → diff → alert

**E2E test:**
- Agent creates a PR → GitHub tab shows PR details → simulated comment triggers alert
- (Requires mock `gh` CLI responses in test environment)
