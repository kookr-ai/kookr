# RFC: Launch Dialog UX — better cwd selection and dialog rename

## Status

**Accepted** (v4 — post round-3 critic incorporation; implementation ships in PR 1 + PR 2; PR 3 gated on telemetry)

## Problem

The Launch dialog at `src/frontend/components/LaunchDialog.tsx` is the primary entry point for starting new tasks in Kookr. It has accumulated useful behavior — MRU autocomplete, draft persistence, agent-type selector, autonomy toggle, voice input, playbook tab — but two friction points remain:

1. **Working-directory entry is text-only.** Users type the absolute path of the target repo (or pick from the MRU dropdown). This is fine for paths the user already runs tasks in, but painful for first-time entries: there is no way to *browse* the filesystem, no validation that the typed path actually exists or is a git repo, no awareness of worktrees that already exist next to a typed repo, and no quick way to fall back to the server cwd.
2. **The header reads "Launch New Agent".** The rest of the user-facing surface has converged on *task* — `KOOKR_TASK_ID`, `taskStore`, the post-launch toast `Starting task: …` (`LaunchDialog.tsx:147`). The dialog header is one of the last places the older *agent* term appears in user copy. Internal documents (`docs/features.md` F4.1, `docs/requirements.md` R4.1) legitimately keep *agent* terminology because that is what the system technically launches at the runtime layer — but the user copy can be cleaner.

**Empirical caveat (round-1 finding).** Kookr does not currently instrument cwd-field interaction or MRU-hit rate. We do not know how often users launch tasks at paths *not* in the MRU. The author's intuition — that first-time path entry is the friction point — is conjecture. PR 1 and PR 2 ship unconditionally; PR 3 is gated on instrumented data showing a concrete threshold (see Shipping plan).

## Threat model

The dashboard is served on `localhost:4800` (production) / `localhost:4801` (dev) in a regular browser. The browser is the threat surface:

- **Cross-origin localhost reach.** Any tab the user visits can issue `fetch('http://localhost:4800/api/fs/list?path=/home/u', { mode: 'no-cors' })`. Without origin checks, an arbitrary website can probe the local filesystem.
- **DNS rebinding.** A hostile origin can resolve `evil.com` to `127.0.0.1`, defeating same-origin policy. The `Host` header still carries `evil.com:4800` (round-2 finding F3).
- **Origin-omitting GET vectors.** Some browsers historically omit the `Origin` header on simple navigations and certain `<img>`/CSS GET requests (round-2 finding F2). Origin-match-only is therefore insufficient.

**Mitigations specified for every endpoint introduced by this RFC:**

- **`Origin` header is required AND must match.** Reject when `Origin` is missing OR when it does not match `http://localhost:<port>` / `http://127.0.0.1:<port>` / `http://[::1]:<port>` for the configured listen port. (round-2 F2)
- **`Host` header validation.** Reject when `Host` is not in `{ localhost:<port>, 127.0.0.1:<port>, [::1]:<port> }`. Defeats DNS rebinding. (round-2 F3)
- **No CORS allowance.** No `Access-Control-Allow-Origin` on fs routes.
- **Method whitelist.** Only `GET` on `/api/fs/*`. No state-changing operations.

A future RFC will retrofit Origin+Host validation onto pre-existing endpoints. This RFC scopes only what it adds.

## Requirements

### Rename

- The dialog header SHALL read **"Launch New Task"** instead of "Launch New Agent".
- All user-visible copy SHALL be updated, including `SettingsDialog.tsx:277` and `gui-proposals/23-command-palette.html:337`.
- All test assertions on the header text SHALL be updated in the same commit.
- The component file and exported symbol SHALL be renamed (`LaunchDialog.tsx` → `LaunchTaskDialog.tsx`, `export LaunchDialog` → `export LaunchTaskDialog`) plus its test files. The store helper file likewise (`launch-dialog-draft.ts` → `launch-task-dialog-draft.ts`, function names `*LaunchDialogDraft` → `*LaunchTaskDialogDraft`).
- **Telemetry event names SHALL NOT be renamed.** They remain `launch_dialog_opened` / `launch_dialog_closed` / `launch_dialog_draft_restored` / `launch_dialog_draft_discarded` / `launch_submitted`. They are internal identifiers, not user copy. (round-2 design-minimalist finding — the dual-acceptance migration window in v2 was overengineered for invisible benefit.)
- **The localStorage draft key SHALL NOT be renamed.** It remains `kookr:launchDialogDraft`. Same rationale. (round-2 design-minimalist finding.)
- The "Launch new agent" label in `docs/features.md` (F4.1) and `docs/requirements.md` (R4.1) SHALL remain unchanged. They describe the system action at the runtime layer, not the UI label. The R4.1 evidence-line file path will be updated.

### Working-directory selection

- The cwd input SHALL preserve the current fast path: typing + MRU autocomplete dropdown + draft persistence. No regression on keyboard-only flows.
- The cwd input SHOULD show inline validation (exists / is a directory / is a git repo) when the user pauses typing. The badge MUST NOT block submit.
- The dialog SHOULD offer a one-click way to fall back to the server cwd, with a guard against the production-worktree footgun.
- The dialog SHOULD let the user open a server-side directory browser when they don't know the exact path.
- When a typed path is a git repository, the dialog SHOULD surface its existing worktrees as suggestions, with branch name visible.
- A clipboard-paste auto-detect SHOULD recognize an absolute path on the clipboard and offer to populate the field, with the input sanitized and the user shown the final value before commit.
- All filesystem access from the frontend SHALL go through new server endpoints that:
  - validate `Origin` (presence + match) and `Host` headers,
  - constrain the resolved path to a hardcoded `$HOME` root (no config knob),
  - canonicalize via `fs.promises.realpath` (async — `realpathSync` blocks the event loop on stalled NFS, round-2 F18),
  - require the **final canonicalized path** to lie within the allowlist using `path.relative(root, resolved).startsWith('..' + path.sep)` semantics (no naive `startsWith`),
  - apply NFC Unicode normalization to **the realpath result** before comparison (round-3 finding — macOS HFS+ stores NFD, so realpath output must be NFC'd, not just user input),
  - **allow** symlink traversal as long as the final realpath lands inside the allowlist (round-2 F4/F5 — the v2 "refuse any symlink in chain" rule broke macOS iCloud paths and WSL2 setups with `~/.aws` symlinks),
  - **TOCTOU invariant (round-3 finding):** all downstream fs operations (`readdir`, `stat`, subprocess cwd) use the realpath result, never the user-supplied path. The user-supplied path is discarded after validation. This prevents an attacker from swapping a symlink in the chain between `realpath` and the next syscall.
  - reject paths whose first character is `-` (subprocess arg-injection guard),
  - never return file content — directory entries only,
  - honor `Request.signal` on the server side for `readdir`/`stat`/`execFile` (acknowledged: `fs.promises.realpath` does not honor `AbortSignal` on Node ≤21; a request whose realpath blocks on a stalled mount will still tie up its own handler until the 3 s timeout fires, but the rest of the server stays responsive because the call is async),
  - cap concurrent in-flight `/api/fs/check?includeWorktrees=true` invocations at 1 per client (prevents per-keystroke git fan-out under fast typing — round-3 finding).

## Design

### Module structure

The route file is HTTP glue only. Filesystem and git logic live in `src/core` and `src/adapters/git-info.ts` (round-2 boundary finding — `git-worktree.ts` owns destructive cleanup; read-only discovery belongs in `git-info.ts`).

| Path | Responsibility | Layer |
|------|----------------|-------|
| `src/core/path-allowlist.ts` | `isWithinRoot(path, root)` private helper. Pure: NFC + relative-path comparator. | core |
| `src/adapters/fs-inspect.ts` | **Single security entry point**: `validatePath(path, root): ValidationResult` runs all path checks (NFC, realpath, allowlist, leading-`-`) in one place. Plus `checkPath()`, `listDirectory()` wrapping `fs.promises.{realpath,stat,readdir}` with timeout, allowlist enforcement, and `Request.signal` propagation. | adapter |
| `src/core/path-allowlist.test.ts` | Attack matrix: sibling-prefix bypass, `..` after canonicalize, NFC/NFD divergence, symlink chains where final lands inside vs outside allowlist. | core test |
| `src/adapters/git-info.ts` | New `listWorktreesForPath(path)`. Invocation: `execFile('git', ['-C', path, 'worktree', 'list', '--porcelain'])`. **No `--` separator** (round-2 F19 — `git -C <path> -- worktree list` is malformed; the leading-`-` rejection on `path` is the actual injection guard). | adapter |
| `src/server/routes/fs-routes.ts` | `GET /api/fs/check`, `GET /api/fs/list`. Origin + Host validation inline (round-2 design-minimalist — single consumer, premature to extract). Module-level comment scopes the file: "path inspection only — no file reads, no writes, no git mutation." | route |
| `src/shared/protocol.ts` (extend) | `FsCheckResponse`, `FsListResponse`, `FsListEntry`, `WorktreeEntry`. | shared |

### Layer 0 — Rename (mechanical, no migrations)

**User-copy changes:**
- `LaunchDialog.tsx:217` `Launch New Agent` → `Launch New Task`.
- `SettingsDialog.tsx:277` `launching new agents` → `launching new tasks`.
- `gui-proposals/23-command-palette.html:337` `Launch new agent` → `Launch new task`.

**File and symbol renames:**
- `src/frontend/components/LaunchDialog.tsx` → `LaunchTaskDialog.tsx`, default export `LaunchDialog` → `LaunchTaskDialog`.
- `src/frontend/store/launch-dialog-draft.ts` → `launch-task-dialog-draft.ts`. Functions: `loadLaunchDialogDraft`/`saveLaunchDialogDraft`/`clearLaunchDialogDraft` → `*LaunchTaskDialogDraft`. **Constant `LAUNCH_DIALOG_DRAFT_KEY` is renamed but its string value `kookr:launchDialogDraft` is unchanged** — no localStorage migration needed.
- Test files: `LaunchDialog.dismiss.test.ts` → `LaunchTaskDialog.dismiss.test.ts`, `LaunchDialog.draft.test.ts` → `LaunchTaskDialog.draft.test.ts`, `launch-dialog-draft.test.ts` → `launch-task-dialog-draft.test.ts`.

**No telemetry rename.** Events stay `launch_dialog_opened` etc. Internal identifiers, not user copy.

**Test-assertion updates (must ship in same commit):**
- `e2e/battle-ui.spec.ts:150` `toContainText('Launch New Agent')` → `toContainText('Launch New Task')`.
- `src/server/ws.test.ts:194` test name string update.

**Doc & screenshot survey:**
- `docs/requirements.md` R4.1 evidence-line file path update only.
- `docs/system-models/04-runtime-interactions.md` references "new agent session" at runtime — leave unchanged (it's correct at the runtime layer).
- No `.claude/skills/` or `plugin/skills/` matches on either string.
- No CI screenshot regression — the dialog isn't snapshotted.

**Full file survey for PR 1 (round-2 finding F1 — v2 missed `src/core/telemetry.ts`, `App.tsx`, etc.; this list is complete per `grep -rln 'launch_dialog\|LaunchDialog' src/ e2e/`):**

User-copy / header tests:
- `src/frontend/components/LaunchDialog.tsx` *(file rename + content)*
- `src/frontend/components/SettingsDialog.tsx` *(copy)*
- `gui-proposals/23-command-palette.html` *(copy)*
- `e2e/battle-ui.spec.ts` *(line 150 assertion)*
- `src/server/ws.test.ts` *(line 194 test name)*

File renames + import updates:
- `src/frontend/components/LaunchDialog.dismiss.test.ts` *(rename)*
- `src/frontend/components/LaunchDialog.draft.test.ts` *(rename)*
- `src/frontend/store/launch-dialog-draft.ts` *(rename + symbol renames)*
- `src/frontend/store/launch-dialog-draft.test.ts` *(rename + import updates)*
- `src/frontend/App.tsx` *(import path update only — telemetry event names unchanged)*

Doc:
- `docs/requirements.md` *(R4.1 evidence-line file path)*

Files **not** touched (telemetry events stay):
- `src/core/telemetry.ts` *(type union unchanged)*
- `src/core/telemetry-report.ts` *(case statements unchanged)*
- `src/core/telemetry-report.test.ts` *(fixtures unchanged)*
- `src/shared/contracts/client-message-schema.ts` *(union unchanged)*

PR 1 is purely mechanical: file moves, import path fixes, three string changes, two test-assertion updates. No migrations, no schema changes.

### Layer 1 — Inline path validation

A debounced fetch reports the path's status under the input. Best-effort; submit is never blocked.

**Endpoint:** `GET /api/fs/check?path=<absolute>&includeWorktrees=<bool>`

```ts
type FsCheckResponse = {
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  branch: string | null;        // null when isGitRepo=false or detached
  outsideAllowlist: boolean;
  // Discriminated:
  // - undefined  → caller did not pass includeWorktrees
  // - null       → asked, but path is not a git repo (so worktrees N/A)
  // - WorktreeEntry[] → asked + git repo (may be empty)
  worktrees?: WorktreeEntry[] | null;
};
```

The discriminated `worktrees` field (round-2 F23) removes the "didn't ask vs no worktrees" ambiguity.

**Badge state machine — collapsed to 4 states (round-2 design-minimalist finding):**

| State | Visual | aria copy | Triggered by |
|-------|--------|-----------|--------------|
| `pending` | small spinner, no color | "Checking path…" | Fetch in flight |
| `ok` | green ✓ + detail | detail-string e.g. "Path exists, is a git repo on branch main" / "Path exists, not a git repo" / "Path outside Kookr's browse root — submit allowed, validation skipped" | `exists=true` (any flavor; `outsideAllowlist=true` is just a detail variant) |
| `not-found` | red ✗ | "Path not found — submit will fail unless created first" | `exists=false` and `outsideAllowlist=false` |
| `unavailable` | grey, no badge | "Validation unavailable" | network/server/timeout error or path is outside allowlist AND server returned the response |

The "unavailable" state covers all unactionable cases — the user has nothing to fix, and visually distinguishing them adds no behavior.

**Pre-PR-3 draft restore handling.** Drafts are ephemeral form state (lifetime: hours). The standard `not-found` badge already surfaces the problem; the user already has a "Discard draft" button. No `draftSchemaVersion` field, no version-check logic. (round-3 design-minimalist finding — v3 added a versioning field for a self-healing transition.)

**Frontend implementation:**
- 250 ms debounce.
- `AbortController` on outbound fetch.
- Server honors `Request.signal` for `readdir`/`stat`/`execFile`. `fs.promises.realpath` does not (Node ≤21); the timeout still bounds the worst case.

### Layer 1.5 — Clipboard-paste auto-detect (replaces drag-and-drop)

When the cwd input fires a `paste` event, run sanitization in this order (round-3 finding — v3 had a step-ordering bug where the control-byte rejection ran before the multi-line first-line extraction, making multi-line handling dead code):

1. **Take first non-empty line.** Multi-line pastes (markdown bullets, terminal output) keep only line 1.
2. **Trim** leading/trailing whitespace.
3. **Strip ANSI escape sequences** — both CSI (`\x1B\[[0-9;]*[a-zA-Z]`) and OSC (`\x1B\][^\x07]*\x07`) — covers terminal title sequences from iTerm2 etc. (round-3 finding).
4. **Strip BOM and bidi/zero-width chars** in the range `​-‏`, `‪-‮`, `⁠`, `﻿`. (round-3 finding — v3 missed bidi overrides which can flip path-rendering invisibly.)
5. **If the result starts with `file://`**, decode the URI.

After sanitization: if the result starts with `/`, commit it. If it differs from the raw paste, the input shows the cleaned value normally — no preview/confirmation step. The validation badge will then rate it; the user sees the result and can edit. (round-3 finding — the v3 "preview" step gave false confidence against invisible characters that the input field can't visibly render anyway. The badge is the safety net.)

**Homoglyphs (Cyrillic `а` vs Latin `a`) are not handled.** They are rare in path input, would require a heuristic or a lookup table, and the validation badge will catch the wrong-target-on-disk case as `not-found`. Documented limitation.

Sanitization steps 4 (curly quotes) and 6 (control-byte rejection) from v3 are dropped: filesystems don't use curly quotes in paths, and control bytes that survive steps 1–4 are pathological — `not-found` is fine.

### Layer 2 — "Use server cwd" quick action

A small button adjacent to the cwd input populates it with the server cwd. Hidden when the field's current value already equals the server cwd.

**Production-worktree guard.** When `serverCwd` matches `isProtectedWorktreePath()`, the button label is `↩ kookr (server cwd is protected — use parent repo)` and clicking populates the cwd input with the parent path derived by stripping the trailing `-prod` segment (`/home/jean/git/kookr-prod` → `/home/jean/git/kookr`).

If `isProtectedWorktreePath` is later extended to other suffixes (e.g. `-staging`), this derivation will need updating in lockstep. The validation badge from PR 3 (when shipped) is the safety net for any wrong derivation — `not-found` will fire and the user sees it before clicking Launch. Until PR 3 ships, the user's submit attempt fails with the standard launch error if the parent path doesn't exist. (round-3 finding — v3's `git rev-parse --git-common-dir` approach was empirically asymmetric: returns relative `.git` from main repo, absolute path from linked worktrees, and fails for non-Kookr repos that happen to be named `kookr-prod`. Suffix-strip is simpler and the failure mode is bounded.)

When `serverCwd` is not protected, behavior is the simple populate.

### Layer 3 — Server-side directory browser

Modal opened by a "Browse…" button. Single-column list with breadcrumbs.

**Endpoint:** `GET /api/fs/list?path=<absolute>`

```ts
type FsListResponse = {
  path: string;
  parent: string | null;
  entries: FsListEntry[];
  truncated: boolean;
};

type FsListEntry = {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  // isGitRepo intentionally absent — computed lazily on hover/select via per-path /check.
};
```

**Permission errors:** if the *root* path is inaccessible, return `403`. If individual entries fail `lstat`, skip them silently. (round-2 design-minimalist finding — partial-success `permissionDenied` flag was premature.)

**Initial root**: input's current value if it exists, else MRU's most-recent parent, else `$HOME`.

**No auto-discovery in PR 3 initial scope.** (round-2 design-minimalist finding — gating auto-discovery on PR 3's evidence is circular: the same instrumentation that justifies PR 3 is the only thing that could justify auto-discovery within it.) If PR 3 ships and users report the browser starts in an unhelpful place, add the depth-1 scan as a follow-up.

**`<DirectoryBrowser>` props:**

```ts
interface DirectoryBrowserProps {
  initialPath?: string;
  onSelect: (path: string) => void;  // fires once on explicit commit
  onClose: () => void;
}
```

**Per-entry `isGitRepo` lookup** is fetched lazily on hover/select via `/api/fs/check`. The fetch logic is inline in `DirectoryBrowser.tsx` rather than extracted to a custom hook. (round-3 design-minimalist finding — v3's `useDirectoryEntryInfo` hook was premature extraction for a single-component feature that hasn't shipped yet. Extract when a second consumer appears or the inline logic exceeds ~40 lines.)

**Lazy-loaded** via `React.lazy`.

### Layer 4 — Worktree-aware suggestions

When the cwd input contains a path that is a git repo, `/api/fs/check?includeWorktrees=true` returns the worktrees in the same response. The dropdown extends with a section labeled `Worktrees of <repo>`. Each entry shows `<path> · <branch>` (or `<path> · detached`).

The endpoint composition is described directly — there is no named "composing endpoint pattern" to uphold (round-2 design-minimalist finding).

**"Create new worktree"** affordance is deferred to a future RFC.

### Backend invocation discipline

Every subprocess call from these endpoints:
- `execFile`, never `exec`/`execSync` with a shell.
- Argument arrays only.
- The first character of any path argument is verified not to be `-`.
- Path arguments are passed positionally; **no `--` separator** for `git -C <path> worktree list --porcelain` (the v2 spec was wrong — `git -C` does not take `--` between the `-C <path>` and the subcommand; the correct invocation is `git -C <path> worktree list --porcelain`, verified empirically).
- 3-second timeout per subprocess.
- `Request.signal` propagated to `execFile` so client-aborted requests cancel subprocesses.

Wrapper utility in `src/adapters/fs-inspect.ts` enforces these so future fs/git additions can't drift.

## Shipping plan

The four layers don't honestly decompose: Layer 1's allowlist is reused by 3 and 4. v3 is honest about bundling.

**PR 1 — Layer 0 (mechanical rename).** Ships unconditionally. ~10 files, file moves + import path fixes + three string changes + two test-assertion updates. No migrations.

**PR 2 — Layer 2 (server-cwd button) + instrumentation.** Ships unconditionally. Adds one telemetry event: `launch_dialog_cwd_field_used` with `method ∈ {typed, mru, server-cwd-button, paste}`. (round-3 design-minimalist finding — v3 added `wasInMru: boolean` on `launch_submitted` as a separate signal; that's redundant. The same rate is computable from `cwd_field_used.method` directly: `nonMruRate = count(method ∈ {typed, paste}) / total`.)

**Wait — instrumentation runs for at least 21 days.** After that, the team reviews the `nonMruRate` metric in the existing telemetry-report and decides whether to ship PR 3. (round-3 design-minimalist finding — v3's "≥15% over 21 days OR 200 events" was false precision on an admittedly guessed threshold. With n=200 events the 95% CI is ±5%, so the gate is a coin flip in a wide band. Single-parameter rule: 21 days minimum, team judgment for the call.)

**PR 3 — Layers 1 + 1.5 + 3 + 4 bundled.** Conditional on the threshold above. ~10 files, ~500 lines.

## Files to change

### PR 1

- `src/frontend/components/LaunchDialog.tsx` *(rename + content)*
- `src/frontend/components/SettingsDialog.tsx` *(copy line 277)*
- `gui-proposals/23-command-palette.html` *(line 337)*
- `e2e/battle-ui.spec.ts` *(line 150 assertion)*
- `src/server/ws.test.ts` *(line 194 test name)*
- `src/frontend/components/LaunchDialog.dismiss.test.ts` *(rename + import updates)*
- `src/frontend/components/LaunchDialog.draft.test.ts` *(rename + import updates)*
- `src/frontend/store/launch-dialog-draft.ts` *(rename + symbol renames)*
- `src/frontend/store/launch-dialog-draft.test.ts` *(rename + import updates)*
- `src/frontend/App.tsx` *(import path update only)*
- `docs/requirements.md` *(R4.1 evidence line — file path only)*

### PR 2

- `src/frontend/components/LaunchTaskDialog.tsx` — server-cwd button + `isProtectedWorktreePath` guard + suffix-strip parent derivation + telemetry emit.
- `src/shared/contracts/client-message-schema.ts` — add `launch_dialog_cwd_field_used` to telemetry-event union (with `method` enum payload).
- `src/core/telemetry.ts` — same union update.
- `src/core/telemetry-report.ts` — handle the new event; expose computed `nonMruRate` from `method` distribution.

### PR 3 (gated on telemetry threshold)

Backend:
- `src/core/path-allowlist.ts` (new) — `isWithinRoot()` private helper.
- `src/core/path-allowlist.test.ts` (new) — attack matrix (sibling-prefix, NFC/NFD, symlink-chain whose final lands inside vs outside allowlist).
- `src/adapters/fs-inspect.ts` (new) — `validatePath()` consolidated entry point + `checkPath()` + `listDirectory()` + subprocess discipline wrapper.
- `src/adapters/git-info.ts` — extend with `listWorktreesForPath()` (read-only; `git-worktree.ts` stays cleanup-only per round-2 boundary finding).
- `src/server/routes/fs-routes.ts` (new) — `GET /api/fs/check`, `GET /api/fs/list`. Origin+Host inline.
- `src/server/routes/fs-routes.test.ts` (new) — Origin-missing rejection, Origin-mismatched rejection, Host-mismatch rejection, sibling-prefix attack, leading-`-` rejection, NFC handling, symlink-chain final-realpath check.
- `src/server/routes.ts` — register fs-routes.
- `src/shared/protocol.ts` — `FsCheckResponse`, `FsListResponse`, `FsListEntry`, `WorktreeEntry`.

Frontend:
- `src/frontend/components/LaunchTaskDialog.tsx` — validation badge wiring; sanitized clipboard-paste; worktree section; "Browse…" button.
- `src/frontend/components/DirectoryBrowser.tsx` (new) — modal, breadcrumbs, lazy-loaded; per-entry `isGitRepo` fetch logic inline.
- `src/frontend/components/DirectoryBrowser.test.tsx` (new) — keyboard nav, commit semantics.
- `src/frontend/components/LaunchTaskDialog.fs.test.tsx` (new) — 4 badge states, clipboard sanitization, worktree section.

E2E:
- `e2e/launch-dialog.spec.ts` — extend with browse + validation flow.

(No standalone `fs-inspect.test.ts` or `origin-validation.ts` files — round-2 design-minimalist findings.)

## Edge cases

- **Symlinks: allowed if final realpath lands inside `$HOME`.** macOS iCloud symlinks under `~/Documents`, WSL2 `~/.aws` → `/mnt/c/...`, Linux `~/work` → network mounts: all allowed if the resolved path is inside `$HOME`. Refused only when the final realpath escapes the allowlist.
- **`$HOME` itself a symlink.** `realpath($HOME)` is computed once at server boot and used as the comparison root. If `$HOME` changes mid-process (rare), restart fixes it. Documented.
- **`$HOME` realpath ≠ raw `$HOME`.** Use the realpath form everywhere — both for comparison root and for `path.relative`.
- **NFC vs NFD on macOS.** All path comparisons normalize the **realpath result** to NFC (not just user input — macOS HFS+ stores NFD, and realpath returns whatever is on disk). Test fixture in `path-allowlist.test.ts`.
- **Permission errors during `/api/fs/list`.** Skip individual entries silently. If the root is inaccessible, 403.
- **Very large directories.** Cap at 5000 entries with `truncated: true`. Banner: "Listing truncated — type more of the path to narrow."
- **Stalled NFS.** `fs.promises.realpath` doesn't honor AbortSignal pre-Node-22; the 3 s timeout still bounds the worst case for the affected handler. Other endpoints stay responsive (async I/O doesn't block the loop).
- **`.git` file vs directory.** Detect both. Submodules are flagged `isGitRepo=true` — known false-positive for one entry class; submodule paths are valid cwds for an agent.
- **Bare repos.** Out of scope. Don't badge.
- **Validation badge during draft restore.** Fire validation immediately. If `not-found`, the standard badge appears. The user can edit or click the existing "Discard draft" button. (No `draftSchemaVersion` field — drafts age out within hours and the badge is sufficient signal.)
- **Outside-allowlist path.** `outsideAllowlist=true` triggers the `ok` (or `unavailable`) badge state; submit is never blocked.
- **`KOOKR_BYPASS_ALL_PERMISSIONS=true`.** Independent of fs allowlist; allowlist stays enforced. Documented at top of `fs-routes.ts`.
- **Server cwd inside protected worktree.** Layer 2 derives parent by stripping the trailing `-prod`. If `isProtectedWorktreePath` is later extended to other suffixes, the strip rule must be updated in lockstep — a code-review checklist item, not a runtime safety net. PR 3's validation badge catches misderivation as `not-found`.
- **Submodule cwd typed by user.** `isGitRepo=true`; Layer 4 may surface the parent repo's worktrees, which could be outside `$HOME`. **Mitigation:** every worktree dropdown entry is filtered through allowlist client-side before rendering — entries whose paths fall outside `$HOME` are rendered greyed-out with `(outside browse root)` and are not selectable. (round-3 finding.)
- **Cross-origin reach.** Origin missing → 403. Origin mismatched (case-insensitive comparison) → 403. Host mismatched → 403.
- **Local non-browser attacker.** Out of stated threat model. Any local process running as the same user can already read everything Kookr can. The Origin/Host validation defends only against the cross-origin browser case; it provides no defense against a local attacker who simply forges both headers via curl. Documented limitation.
- **DNS rebinding.** Host header validation defends.
- **Subprocess injection.** `execFile`, no shell, leading-`-` rejection on path. No `--` after `-C <path>`.
- **Clipboard paste sanitization.** First non-empty line → trim → strip ANSI (CSI + OSC) → strip BOM/bidi/zero-width → decode `file://`. Sanitized value populates the input directly; the validation badge is the safety net (no preview/confirmation step).
- **Worktree returned by git but unstat-able.** Endpoint returns the entry with `unreachable: true`; dropdown renders greyed-out and non-selectable.
- **Submodule path typed as cwd.** `isGitRepo=true`; `worktrees` of a submodule resolve to the parent repo's worktrees (git's actual behavior). Round-2 F27 — leave as-is; unlikely user flow, low impact.
- **Field interaction telemetry vs MRU hit rate.** PR 2 emits both `launch_dialog_cwd_field_used` (method) and `launch_submitted.wasInMru: boolean`. The `wasInMru` flag is what the threshold gate consumes.
- **Telemetry from concurrent tabs after PR 1.** No migration; events keep their existing names. No race possible.
- **`git -C <path>` invocation.** Verified: `git -C /home/jean/git/kookr worktree list --porcelain` works. No `--` separator.

## Alternatives considered

### Validation over WebSocket

Rejected. WS would multiplex pending requests, complicate state, and add abort handling for no transport benefit. HTTP `Request.signal` is the right shape.

### Skip validation; rely on submit-time error

Rejected. Misses the as-you-type goal. The endpoint also serves Layer 3.

### Push users toward QuickLaunch (auto-resolves cwd)

Noted as future work. QuickLaunch is the keyboard fast path; the full dialog is the discovery path. A separate RFC could reconsider whether the cwd field belongs on the discovery path at all.

### Native browser folder picker (`showDirectoryPicker`)

Rejected. Returns sandboxed handles, Chromium-only.

### `<input type="file" webkitdirectory>`

Rejected. Uploads contents, strips paths.

### Drag-and-drop folder

Rejected. Browser API doesn't expose paths reliably; Firefox returns empty `text/plain`. Replaced by sanitized clipboard paste.

### Auto-discovery (`~/git`, `~/projects`, `~/code`) in initial PR 3

Cut from initial PR 3 (round-2 design-minimalist). Circular gating: the same evidence that justifies PR 3 is the only thing that could justify auto-discovery within it. Add later if the browser's default `$HOME` start is reported as unhelpful.

### `cwdBrowseRoot` as a config field

Rejected (was in v1). Hardcoded `$HOME`.

### Reuse `worktree-protection.ts` as the allowlist helper

Rejected. v1 had this wrong. v3 introduces `path-allowlist.ts` for the actual `isWithinRoot` predicate. `worktree-protection.ts` keeps its narrow `isProtectedWorktreePath` use, called by Layer 2.

### Pull cwd suggestions from `ProjectSummary`

Rejected. Keyed by GitHub project ID, not local path.

### File-content read endpoint

Rejected. Browser doesn't need it.

### Telemetry event name rename + dual-acceptance window (in v2)

Rejected in v3 (round-2 design-minimalist). Internal-only events; renaming creates migration churn for invisible benefit. Telemetry events stay `launch_dialog_*`.

### localStorage key rename + fall-through migration (in v2)

Rejected in v3 (round-2 design-minimalist). Storage key is implementation-internal; renaming creates a migration window for zero user benefit.

### `origin-validation.ts` as a standalone module (in v2)

Rejected in v3 (round-2 design-minimalist). One consumer; inline. Extract when a second consumer appears.

### Standalone `fs-inspect.test.ts` test file (in v2)

Rejected in v3 (round-2 design-minimalist). Adapter is thin; meaningful behavior is covered by `path-allowlist.test.ts` (security invariants) and `fs-routes.test.ts` (HTTP contract).

### Refuse paths whose resolved chain contains a symlink (TOCTOU mitigation in v2)

Rejected in v3 (round-2 F4/F5). Breaks legitimate macOS iCloud setups, WSL2 `~/.aws` symlinks, Linux symlink-organized workspaces. Replaced by "final realpath must lie inside allowlist" — the symlink chain itself is allowed.

### "Create new worktree" affordance in Layer 4

Deferred to future RFC.

### Composing endpoint as a named pattern (in v2)

Rejected in v3 (round-2 design-minimalist). The endpoint composes worktrees into the check response; that's the design, no name needed.

## Open questions

- **`Request.signal` ⇨ `fs.promises.realpath`.** Node 22 added AbortSignal support; current Kookr Node version determines whether realpath cancels on disconnect. Verify at implementation time. Acceptable fallback: timeout-only; the route handler is async so other traffic isn't blocked.
- **Concurrent-tab draft race after PR 3.** PR 3 introduces `draftSchemaVersion` for the "saved before validation" hint. If two tabs interleave reads/writes during the schema bump, last-write-wins. Drafts are ephemeral form state (lifetime: hours); the worst case is one tab's in-progress edit being clobbered. Acceptable.
- **Threshold sensitivity.** "≥15% of launches outside MRU" is a guess. If the data clusters near the boundary, the team should look at the underlying distribution rather than mechanically apply the rule.

## Critic feedback incorporated

### Round 1 (v1 → v2 highlights, see v2 git history)

Falsified empirical claims caught early without `design-experimenter`: header-text test assertions exist (`battle-ui.spec.ts:150`); `worktree-protection.ts` is not an allowlist helper; user-copy "agent" survives in `SettingsDialog.tsx:277` and `gui-proposals/23-command-palette.html:337`. v2 fixed all three.

Added: Threat Model section, Origin validation, NFC normalization, allowlist comparator spec, subprocess discipline, `path-allowlist.ts` + `fs-inspect.ts` extraction, response types in shared protocol, drag-and-drop killed, clipboard paste added, prod-worktree guard, code-symbol rename considered.

Adversarial pair (round 1): sided with **design-minimalist on shipping order** (gated PR 3), **ambition-amplifier on layer quality** (clipboard replacing drag-and-drop, branch name in worktree label).

### Round 2 (v2 → v3)

**failure-mode-analyst (security/correctness):**
- Symlink-refusal (F4/F5) breaks macOS iCloud + WSL2 `~/.aws` setups → relaxed to "final realpath inside allowlist." (largest behavior change in v3)
- Origin-only insufficient (F2) → require Origin presence + match.
- DNS rebinding still partially exposed (F3) → added Host header validation.
- Telemetry survey incomplete (F1) → produced full `grep -rln` survey for PR 1's file list. v3 explicitly identifies which files are touched and which are not, with rationale.
- 30-day gate doesn't measure gating signal (F24) → PR 2 emits `wasInMru: boolean` on `launch_submitted`. Threshold is concrete: ≥15% non-MRU launches.
- `realpathSync` blocks event loop on stalled NFS (F18) → switched to `fs.promises.realpath`. Acknowledged AbortSignal limitation.
- `git -C <path> -- worktree list` is malformed (F19) → corrected to `git -C <path> worktree list --porcelain` (no `--`). Verified empirically.
- Clipboard paste silent transformation (F7/F9) → specified full sanitization (BOM/ANSI/zero-width/curly quotes/NUL); show preview when sanitized differs from raw.
- `worktrees` field ambiguity (F23) → discriminated `WorktreeEntry[] | null | undefined`.
- Pre-PR-3 draft restore outside allowlist (F12) → explicit one-time hint via new `draftSchemaVersion` field.
- Protected-worktree parent derivation fragility (F6/F25) → use `git rev-parse --git-common-dir` instead of suffix-strip.

**boundary-critic (module structure):**
- `listWorktreesForPath` moved from `git-worktree.ts` (cleanup) to `git-info.ts` (read-only).
- `validatePath()` consolidated entry point in `fs-inspect.ts`; `isWithinRoot` is a private helper, not the security boundary.
- Telemetry name migration removed entirely (no rename) → `telemetry-report.ts` no longer owns ingestion concerns.
- `useDirectoryEntryInfo` hook extracted from `DirectoryBrowser` for fetch orchestration.

**design-minimalist (simplicity):**
- 9-state badge collapsed to 4 (`pending`, `ok`, `not-found`, `unavailable`); detail string carries flavors that don't affect behavior.
- Telemetry event names NOT renamed (was a v2 dual-acceptance window for invisible benefit).
- localStorage draft key NOT renamed (was a v2 fall-through migration for invisible benefit).
- `origin-validation.ts` standalone module dropped; inlined.
- Standalone `fs-inspect.test.ts` dropped; covered by route + allowlist tests.
- Auto-discovery cut from initial PR 3 scope (circular evidence-gating).
- "30-day wait" replaced with concrete threshold (`≥15% non-MRU launches`, 21 days OR 200 events).
- "Composing endpoint pattern" prose removed; described directly.
- `permissionDenied` partial-success simplified to "skip silently for entries; 403 if root inaccessible."

### Round 3 (v3 → v4)

**failure-mode-analyst (security):**
- Symlink-relaxation reopened TOCTOU → added explicit invariant: all downstream fs ops use the realpath result, never the user-supplied path.
- `git rev-parse --git-common-dir` is empirically asymmetric (relative `.git` from main repo, absolute from linked worktrees) and fails for non-Kookr `kookr-prod`-named directories → reverted to suffix-strip; documented that the check is a code-review obligation if protection list expands.
- Sanitization step ordering bug — control-byte rejection ran before multi-line first-line extraction, making multi-line handling dead code → reordered: first-line extraction is now step 1.
- ANSI regex incomplete (only CSI, no OSC) → spec now strips both CSI and OSC sequences.
- Zero-width strip range too narrow (no bidi overrides) → expanded to `​-‏`, `‪-‮`, `⁠`, `﻿`.
- NFC normalization placement ambiguous → spec now states explicitly: NFC the realpath result, not just user input.
- Origin case-sensitivity unspecified → comparison is case-insensitive.
- Per-keystroke git fan-out under fast typing → cap of 1 in-flight `/check?includeWorktrees=true` per client.
- Submodule path surfacing parent-repo worktrees outside `$HOME` → each worktree dropdown entry is filtered through allowlist client-side.
- Sanitization preview gave false confidence against invisible characters that don't render in a text input → preview/confirmation step removed; sanitized value populates input directly, validation badge is the safety net.
- Local non-browser attacker explicitly out-of-scope.

**design-minimalist (simplicity cuts that v3 still had room for):**
- `draftSchemaVersion` field removed — drafts are ephemeral; the standard `not-found` badge already handles "saved before validation."
- `useDirectoryEntryInfo` custom hook removed — single component, premature extraction. Per-entry fetch is inline.
- `git rev-parse --git-common-dir` parent derivation removed — overengineered for one button click whose output is already validated by the badge. Suffix-strip is correct.
- `wasInMru: boolean` on `launch_submitted` removed — duplicates `cwd_field_used.method`. `nonMruRate` is computed from method distribution.
- Threshold "≥15% over 21 days OR 200 events" → simplified to "21 days minimum, team judges demand." False precision admitted in v3's own open question.
- Sanitization steps 4 (curly quotes) and 6 (NUL/control-byte rejection) removed — not real path-input hazards, redundant given the validation badge.

### Adversarial-pair re-resolution

Round 1: amplifier won on file/export rename + clipboard paste + branch-in-worktree-label. Minimalist won on shipping order. Round 2: minimalist reversed three v2 amplifier wins (telemetry rename, localStorage rename, origin-validation extraction) that added migration machinery for invisible benefit. Round 3: design-minimalist alone — no amplifier rerun (per skill rule, no new deferred/future-work items in v3), and round 3's design-minimalist findings were entirely about cuts to v3's own additions (`draftSchemaVersion`, `useDirectoryEntryInfo`, `git rev-parse`, `wasInMru`, threshold precision, sanitization steps 4+6).

The pattern that emerged across rounds: amplifier suggestions are useful when they identify substantive missing features (clipboard paste, branch-in-label) but harmful when they propose machinery for internal-only artifacts (telemetry rename windows, localStorage migrations, `draftSchemaVersion`). Default rule for future RFCs: amplifier suggestions that add code paths for internal-only invariants need explicit user-visible benefit before adoption.

### Invocation log

- ambition-amplifier 2026-05-05 (round 1): novel finding. Round 2: not invoked per skill rule. Round 3: not invoked.
- design-experimenter: not invoked across rounds. Load-bearing empirical claims were falsified directly by critic-anchored evidence at every round (test assertions in v1, `worktree-protection.ts` semantics in v2, `git -C` invocation form in v2, `git rev-parse --git-common-dir` shape in v3). Remaining empirical claims (Node AbortSignal support; threshold sensitivity) are documented as open questions for implementation-time verification, not RFC-review-time experimentation.

## Convergence note

Round 3 did not produce findings of round-1/round-2 severity. The findings were either small cuts (minimalist) or bugs in spec mechanics (failure-mode) — both fully addressable as edits without restructuring. v4 closes them. No further critic round is planned unless the user requests one or substantive new design questions arise during implementation.
