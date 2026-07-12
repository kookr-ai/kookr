# RFC: One-Click Bug Report Capture

## Status

**Draft (v2 - round-1 critic feedback incorporated)**

**Date:** 2026-05-24
**Author:** Jean Ibarz (with Codex)

---

## Problem

When Kookr shows a field failure, the user currently has no reliable way to send the maintainer the state that made the bug diagnosable. The practical report shape is "I saw an alert say X", plus screenshots and manual copy/paste. That loses the app build, browser context, selected task, recent WebSocket failure shape, visible alerts, and redacted task state.

Issue #574 is the motivating example: a malformed WebSocket alert needed the rejected value and surrounding runtime context. A useful report bundle should make that class of bug reproducible without asking the user five follow-up questions, while defaulting to privacy-preserving output.

## Requirements

- Kookr SHALL provide a visible bug-report entry point from the dashboard.
- Kookr SHALL capture a versioned, local JSON bundle with build metadata, browser metadata, selected task/project context, recent reportable alerts, recent WebSocket observations, and selected-agent summary.
- Kookr SHALL redact sensitive fields by default, including prompts, task names, project labels, full paths, token-looking values, raw terminal/event payloads, and prompt-derived text.
- Kookr SHALL show a complete JSON preview before download.
- Kookr SHALL download exactly the same serialized JSON string shown in the preview.
- Kookr SHALL keep bundle generation local in V1: no hosted upload endpoint, no GitHub issue creation, no server-side retention, no raw log files.
- Tests SHALL cover redaction defaults, allowlisted projection, bounded WebSocket observation, degraded capture diagnostics, and preview/download byte equality.

## Non-goals

- No direct upload service in V1. Hosted ingestion needs separate decisions for authentication, retention, abuse handling, deletion, indexing, and privacy notice work.
- No automatic screenshot capture in V1. Browser screenshot APIs are either unavailable, permission-heavy, or likely to include proprietary code in the terminal.
- No replay loader in V1. The schema should be stable enough for a future replay tool, but this issue only captures and previews reports.
- No raw hook, transcript, terminal, or full WebSocket payload inclusion.
- No prompt/full-path opt-in toggles in V1. The note field is the explicit user-authored context channel.
- No toast-level "Report" button in V1. The top-bar action is the only trigger; toast CTAs can be added after the core path proves useful.

## Boundary Contract

V1 report generation is frontend-owned. It lives under `src/frontend/bug-report-*` and is not re-exported from `src/shared/protocol.ts`. The server has no bundle endpoint, no retention, and no access to local files beyond state already projected to the dashboard.

The JSON artifact is the only boundary. Future upload or replay work must accept the versioned bug-report JSON, not raw app state, hook logs, transcripts, task-store records, or WebSocket frames.

## Design

### Delivery Channel

V1 uses local JSON download. The dashboard top bar gets a compact bug-report icon button. Opening it builds a local draft bundle, renders the complete JSON payload, and offers "Download JSON". The user then attaches that file to GitHub, chat, email, or any channel they trust.

This is less automated than direct upload, but it satisfies the field-report need without introducing server infrastructure or implying that Kookr can safely receive arbitrary local state.

### Bundle Schema

Add frontend-owned types in `src/frontend/bug-report-bundle.ts`:

```ts
export interface BugReportBundle {
  schemaVersion: 'kookr-bug-report.v1';
  generatedAt: string;
  note?: string;
  triage: BugReportTriage;
  source: BugReportSource;
  redaction: { policy: 'strict-v1'; applied: string[] };
  selection: {
    selectedAgentId: string | null;
    selectedTaskId?: string;
    selectedProjectPresent: boolean;
  };
  selectedAgent: BugReportAgentSnapshot | null;
  fleetSummary: BugReportFleetSummary;
  alerts: BugReportAlert[];
  wireObservations: BugReportWireObservation[];
  captureDiagnostics: BugReportCaptureDiagnostics;
}
```

The schema is intentionally narrow and JSON-only. It can evolve by adding optional fields or by introducing `kookr-bug-report.v2` later.

`BugReportTriage` contains `trigger`, `primaryAlertId`, `primaryErrorCode`, `suspectedArea`, `firstSeenAt`, `lastSeenAt`, and `summary`. The top-bar trigger uses the newest reportable alert when one exists; otherwise it records `trigger: 'manual'`.

`BugReportSource` avoids high-entropy browser fingerprinting:

```ts
interface BugReportSource {
  appVersion: string | null;
  commit: string | null;
  branch: '[redacted branch]' | null;
  buildTimestamp: string | null;
  versionUnavailableReason?: string;
  serverStartedAt: string | null;
  location: { originKind: 'localhost' | 'lan' | 'remote' | 'unknown'; protocol: string; route: string };
  browser: { family: string; platform: string; language: string; viewportBucket: string };
}
```

`BugReportAgentSnapshot` is an allowlisted DTO, produced by a pure projection that never spreads `AgentState`:

```ts
interface BugReportAgentSnapshot {
  agentId: string;
  taskId?: string;
  taskStatus?: string;
  turnState?: string;
  agentType?: string;
  anomaly?: { type: string; subType?: string; severity: string; summary: string };
  cwd: { present: boolean; kind: 'home' | 'temp' | 'workspace' | 'other' | 'unknown' };
  git: { branchPresent: boolean; commitPresent: boolean };
  tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; totalCostUsd?: number };
  health?: BugReportSessionHealthSnapshot;
}
```

`BugReportSessionHealthSnapshot` is the strict allowlisted projection of the
versioned `SessionHealthSnapshot` contract: it retains the task state, signal
states/timestamps, backend attach facts, browser bridge facts, progress, and
classification, plus redacted `evidence` and (when present) a redacted
`coordinatedStall` whose shape is `CoordinatedStallFinding` with its `evidence`
field replaced by the same bounded string list. It excludes transcript paths,
terminal bytes, and all raw event payloads.

The projection explicitly excludes `events`, raw `activityMeta`, `playbookParameterValues`, completion digests, finding-evidence pane excerpts, transcript paths, hook payloads, terminal output, and raw tool input/response objects.

When the dashboard has a `sessionHealth` projection, the selected-agent
summary may include its versioned classification, signal ages, attach/browser
state, bounded evidence, and coordinated-stall relationship. The capture path
uses an explicit allowlist and applies the same text redaction to health
evidence; it never includes transcript paths or terminal bytes.

### Capture Scope

The bundle includes:

- Build metadata already available in the frontend snapshot.
- Low-entropy browser metadata from `window.location`, `navigator`, and viewport bucket.
- Selected agent/task and whether a project filter was active. V1 does not include raw or hashed project identity because hashes are still correlatable across reports and guessable from common repo names.
- One selected-agent summary plus fleet counts by task status and anomaly severity.
- Cross-signal session health for the selected agent when available, including
  bounded classification evidence and attach/browser progress facts.
- Last 20 reportable alerts, captured before visual toast dismissal. DND may silence toasts, but it must not erase reportable alert history.
- Last 10 WebSocket observations from a browser-memory recorder.

The WebSocket recorder owns an in-memory ring buffer in `src/frontend/bug-report-recorder.ts`; `useWebSocket` only calls `recordInbound(raw, parsed)` and `recordOutbound(message)`. The recorder stores summaries, never raw payloads:

```ts
interface BugReportWireObservation {
  direction: 'inbound' | 'outbound';
  receivedAt: string;
  sequence: number;
  type: string | null;
  parseOk: boolean;
  byteLength: number;
  fieldNames: string[];
  validationError?: string;
  shortPreview?: string;
  truncated: boolean;
}
```

Unsafe message types such as `launch`, `respond`, `directReply`, `relaunch`, `launchPlaybook`, `setTaskFeedback`, and `permissionChoice` record only type, field names, byte length, and sequence metadata. Inbound `snapshot` and `update` observations never store `agents[*].events` or nested state; they record only type, size, keys, and counts.

Ring-buffer retention is count and age bounded: last 10 observations or 10 minutes, whichever is smaller. It is never written to `localStorage` or `sessionStorage`.

### Redaction Model

Redaction is strict and always on:

- Every free-text field is redacted unless explicitly categorized safe.
- User-authored note text is included, but still passes through secret and path redaction.
- Task names, task descriptions, project labels, prompts, completion digests, suggestions, quick actions, anomaly explanations, branch labels, and alert details are redacted or summarized.
- Raw paths are not retained in structured fields. Path-like text is reduced to coarse kind (`home`, `temp`, `workspace`, `other`, `unknown`) or `[redacted path]`; V1 does not include basenames because repo/customer names often live there.
- URL-like free text is reduced to `[redacted url]` so path segments cannot leak customer or repository identity.
- Build branch labels and non-root browser route paths are reduced to redacted markers; commit hash and route kind are enough for V1 diagnosis.
- Secret redaction is recursive, key-aware, and pattern-aware. Denylisted keys include `token`, `secret`, `password`, `authorization`, `cookie`, `apiKey`, private-key variants, and credentials. Value patterns cover JWTs, common provider key prefixes, private keys, AWS-style keys, bearer tokens, URL credentials, and long base64-like blobs.

The redactor is a pure module with sample-secret tests that assert no known token survives anywhere in the serialized JSON.

### Preview UX

`BugReportDialog` is a modal opened from the top bar. It contains:

- A note textarea.
- A short capture summary and byte count.
- A complete editable JSON preview for final manual redaction.
- "Download JSON" and close actions.

The modal derives a serialized JSON string from `{store snapshot, recorder snapshot, reportable alert history, note}`. The preview starts with that exact string, remains editable for final manual redaction, and the download Blob uses the current preview text. Tests assert byte-for-byte equality between the visible preview and downloaded Blob after note edits and manual preview edits.

If browser download creation fails, the complete JSON preview remains selectable so the user can copy it manually.

### Capture Diagnostics and Size Limits

Each capture section fails closed. A failure omits that section, records a capture diagnostic, and still allows download of the partial report:

```ts
interface BugReportCaptureDiagnostics {
  warnings: string[];
  omittedSections: string[];
  failures: Array<{ section: string; message: string }>;
  bundleSizeBytes: number;
  sizeLimitBytes: number;
  truncationApplied: boolean;
}
```

Target bundle size is below 250 KB. Hard cap is 1 MB. Truncation order is deterministic: oldest wire observations, oldest alerts, optional long previews, then selected-agent nonessential fields. The final bundle records whether truncation was applied.

## Implementation Sequence

1. Add frontend-owned bundle types, redactor, agent projection, fleet summary, and pure bundle builder with Vitest coverage.
2. Add `bug-report-recorder.ts` with ring-buffer and message-summary tests before wiring it into `useWebSocket`.
3. Wire the recorder through an extracted WebSocket message handler and test that inbound recording happens before malformed/non-object messages return, and that outbound `send()` records only summaries.
4. Add reportable alert history captured at alert dispatch time before DND/toast lifecycle decisions. `BugReportAlert` uses nullable/default triage fields because server alert messages do not carry error codes; tests cover normal visible alerts, dismissed alerts retained in report history, and DND-suppressed visual alerts retained in report history.
5. Add `BugReportDialog` with preview/download equality tests.
6. Add the top-bar trigger and `App` dialog state. `TopBar` receives only `onBugReport`; it does not build bundles.
7. Add troubleshooting documentation for maintainers and reporters.

## Files To Change

- `src/frontend/bug-report-bundle.ts`
- `src/frontend/bug-report-recorder.ts`
- `src/frontend/hooks/useWebSocket.ts`
- `src/frontend/store/store-types.ts`
- `src/frontend/store/slices/triage-navigation-slice.ts`
- `src/frontend/components/BugReportDialog.tsx`
- `src/frontend/components/TopBar.tsx`
- `src/frontend/App.tsx`
- `src/frontend/styles.css`
- `docs/troubleshooting.md`
- focused frontend tests

## Edge Cases

- Browser download blocked: keep the complete JSON preview selectable.
- Offline/disconnected dashboard: still generate a report from local store state and captured connection errors.
- Malformed inbound WebSocket frame: record parse failure with byte length and a short redacted preview, not the entire payload.
- Missing build metadata: include `versionUnavailableReason` and a capture warning.
- Empty dashboard: generate a bundle with metadata, empty alert/wire arrays, and null selected agent.
- Oversized bundle: apply deterministic truncation and record diagnostics.

## Alternatives Considered

- **Direct hosted upload.** Rejected for V1 because it needs auth, retention, abuse limits, data deletion, indexing, and privacy notice work.
- **Open a GitHub issue directly.** Rejected for V1 because many users will not have `gh` auth in the browser context, and private state should not be pushed into a public issue by accident.
- **Server-side bundle endpoint.** Deferred. The server can see settings and files the browser cannot, but that is also the privacy risk. A browser-local bundle is easier to preview exactly.
- **Zip with logs and screenshots.** Rejected for V1 because raw logs/screenshots are the highest-risk data and hardest to redact reliably.
- **Prompt/path opt-ins.** Rejected for V1 after privacy and minimalist review. Users can add deliberate context in the note; default reports should stay conservative.
- **Toast-level Report button.** Deferred. It adds alert identity/lifecycle work and can follow after the top-bar flow proves insufficient.

## Critic Feedback Incorporated

- `boundary-critic` 2026-05-24: moved the artifact to a frontend-owned boundary, added allowlisted agent DTO projection, kept WebSocket recording in a separate recorder, split reportable alert history from toast state, and made `TopBar` trigger-only.
- `design-minimalist` 2026-05-24: cut toast-level reporting, cut prompt/full-path toggles, narrowed capture to selected-agent plus fleet summary, reduced wire observations to 10, and simplified the modal.
- `delivery-pragmatist` 2026-05-24: added an implementation sequence, pure recorder API, explicit subtype definitions, path-redaction semantics, and Vitest-first coverage.
- `operability-reviewer` 2026-05-24: added triage summary, defined wire observation fields, capture diagnostics, byte caps, agent count/fleet summary, browser-memory retention, preview/download parity, and docs intake requirements.
- `failure-mode-analyst` 2026-05-24: made secret redaction recursive and key-aware, forbade raw snapshot/update payloads, redacted alert text and prompt-derived fields, reduced browser fingerprinting, removed correlatable project hashes/raw path summaries, and required one serialized string for preview and download.
- Round 2 `boundary-critic` / `failure-mode-analyst` / `delivery-pragmatist` 2026-05-24: confirmed the frontend boundary converged, removed hashed project identity and retained path names, and added explicit WebSocket wiring plus reportable-alert/DND tests to the implementation sequence.
