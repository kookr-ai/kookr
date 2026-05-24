# RFC: macOS-Aware Shortcut Defaults and Custom Bindings

## Status

**Draft (v2 — round-1 critic feedback incorporated)**

**Date:** 2026-05-24
**Author:** Jean Ibarz (with Codex)

---

## Problem

Kookr's dashboard shortcuts are currently hard-coded around `Alt+<key>` combinations. That works on Linux and Windows, but it is a poor macOS default: Option is a character/dead-key modifier, so combinations such as `Alt+L` can produce text instead of a reliable application shortcut. The shortcut help dialog also owns a separate static table, so any runtime change can drift from the displayed cheatsheet.

The result is that Mac users lose access to several high-leverage controls: next finding, quick launch, project/sidebar toggles, snooze, terminal focus, and task navigation. Users also have no supported customization path when the default map conflicts with their browser, keyboard layout, assistive technology, or personal workflow.

## Requirements

- Kookr SHALL resolve shortcut defaults from the user's platform in the frontend.
- Kookr SHALL provide a macOS default for every existing global dashboard shortcut.
- Kookr SHALL keep Linux and Windows defaults behavior-compatible with the current `Alt+...` map.
- Kookr SHALL persist user shortcut overrides in the existing `settings.json` file.
- Kookr SHALL validate shortcut override syntax and report conflicts instead of silently accepting ambiguous bindings.
- Kookr SHALL let settings updates take effect in an already-open dashboard without a full page reload.
- Kookr SHALL render the shortcut help from the same resolved binding source that routes keyboard events.
- Tests SHALL cover platform resolution without requiring Playwright to run on multiple operating systems.

## Non-goals

- No full keybinding recorder in V1. Text inputs are enough for precise bindings and are easier to test.
- No per-project or per-agent shortcut profiles.
- No browser-extension-level interception of reserved browser or OS shortcuts. The defaults avoid known collisions instead.
- No migration of unknown historical browser-local shortcut state. There is no supported shortcut persistence today.
- No localization of modifier labels beyond platform-appropriate names (`Cmd`, `Ctrl`, `Alt`, `Option`).
- No multi-tab live settings synchronization in V1. The tab that saves settings updates immediately; other open tabs can refresh.
- No disable/null shortcut semantics in V1. Empty fields mean "use the platform default."

## Design

### Shared shortcut catalog

Add a pure shared module, `src/shared/contracts/shortcut-bindings.ts`, that defines:

- stable action IDs such as `next_bottleneck`, `quick_launch`, `toggle_terminal_focus`, and numbered project/terminal actions;
- default binding maps for `default` and `mac`;
- parser/canonicalizer for strings such as `Alt+N`, `Cmd+Ctrl+N`, `Ctrl+Backspace`, and `?`;
- conflict detection for a resolved platform map;
- platform detection input (`mac` vs `default`) kept outside the parser so tests can resolve both maps on any OS.

`App.tsx` imports the catalog and asks "which action matched this event?" rather than spelling out `e.altKey && e.key === 'n'` repeatedly. `ShortcutsHelp.tsx` receives the already-resolved binding map from `App` and renders rows from that map. It does not fetch or resolve settings independently.

Round-1 boundary feedback asked whether UI copy belongs in `shared/contracts`. The implementation keeps the module pure and deterministic; descriptions are used by the frontend, while the server uses only action IDs, parser/canonicalizer, and validation helpers. This is accepted for V1 to keep the single shortcut catalog from splitting again, but future non-frontend consumers should split display metadata out before broadening the contract.

### macOS defaults

The macOS map uses `Cmd+Ctrl+...` for application-level global actions. This intentionally avoids common browser/Electron `Cmd` and `Cmd+Shift` reservations such as new window, new tab, downloads, print, reload, location bar, save, and undo while still giving Mac users a Command-prefixed mental model.

| Action | Existing default | macOS default | Collision notes |
|---|---:|---:|---|
| Next finding | `Alt+N` | `Cmd+Ctrl+N` | avoids `Cmd+N` new window |
| Next task | `Alt+J` | `Cmd+Ctrl+J` | avoids `Cmd+J` downloads |
| Previous task | `Alt+K` | `Cmd+Ctrl+K` | avoids browser search variants |
| Quick launch | `Alt+L` | `Cmd+Ctrl+L` | avoids `Cmd+L` location bar |
| Toggle voice input | `Alt+M` | `Cmd+Ctrl+M` | no common browser collision |
| Snooze dialog | `Alt+S` | `Cmd+Ctrl+S` | avoids `Cmd+S` save |
| Quick snooze | `Alt+Z` | `Cmd+Ctrl+Z` | avoids `Cmd+Z` undo |
| Focus reply | `Alt+R` | `Cmd+Ctrl+R` | avoids `Cmd+R` reload |
| Complete task | `Alt+End` | `Cmd+Ctrl+Enter` | avoids sparse Mac `End` key availability |
| Cancel task | `Alt+Delete` | `Cmd+Ctrl+Backspace` | matches Mac keyboard labeling better than Delete |
| Project sidebar | `Alt+P` | `Cmd+Ctrl+P` | avoids `Cmd+P` print |
| Terminal focus | `Alt+T` | `Cmd+Ctrl+T` | avoids `Cmd+T` new tab |
| Achievements | `Alt+A` | `Cmd+Ctrl+A` | avoids `Cmd+A` select all |
| All projects | `Alt+0` | `Cmd+Ctrl+0` | avoids `Cmd+0` zoom reset |
| Terminal send 1-3 | `Alt+1`..`Alt+3` | `Cmd+Ctrl+1`..`Cmd+Ctrl+3` | avoids `Cmd+1` tab switching |
| Select project 1-6 | `Alt+4`..`Alt+9` | `Cmd+Ctrl+4`..`Cmd+Ctrl+9` | avoids `Cmd+number` tab switching |
| Help | `?` | `?` | unchanged, suppressed in inputs |
| Deselect | `Esc` | `Esc` | unchanged |

### Customization model

Extend `KookrSettings` with:

```json
{
  "shortcutBindings": {
    "mac": {
      "next_bottleneck": "Cmd+Ctrl+N",
      "quick_launch": "Cmd+Ctrl+Space"
    },
    "default": {
      "next_bottleneck": "Alt+N"
    }
  }
}
```

The object is a sparse override map keyed first by platform bucket and then by action ID. Missing platform buckets and missing actions use the platform default. Empty fields in the UI remove that override and return to default. This platform-scoped shape avoids a Mac user's `Cmd+Ctrl+...` overrides becoming the Linux/Windows defaults for another browser attached to the same local Kookr server.

The Settings dialog adds a "Keyboard Shortcuts" section in the General tab. Each row shows the action label, default binding, active binding, a text input for the current platform, a per-row reset, and a reset-all control. Inputs save through the existing `/api/settings` route. This is deliberately not a key recorder: recorders have harder focus, IME, and browser-reserved-key failure modes, while a parser makes the stored JSON inspectable and easy to recover by hand.

### Validation and conflicts

`validateSettingsWithWarnings` calls shortcut validation. Unknown platform buckets are dropped with warnings; only `mac` and `default` are accepted. Invalid action IDs are dropped. Invalid binding strings are dropped and reported as warnings from `/api/settings`. Duplicate effective bindings are reported per platform and the conflicting override is dropped deterministically against the existing accepted/default map. Defaults are conflict-free by construction and covered by tests.

The first implementation keeps warnings non-fatal because Kookr's settings route already clamps invalid values instead of rejecting the whole object. This preserves a recoverable settings file: one bad shortcut does not discard unrelated settings.

Malformed `settings.json` remains existing settings-store behavior: Kookr logs that settings failed to read, serves safe defaults, and marks `loadedFromDefaults` in `/api/settings`. Hand-edited but parseable shortcut mistakes are retained as load-time validation warnings and returned by `GET /api/settings` until the next successful settings save clears them. Shortcut validation warnings are separate from malformed-file fallback.

### Hot reload

The dashboard fetches `/api/settings` once at mount to resolve shortcut overrides. When the Settings dialog saves, it uses the committed `/api/settings` response to update the current `App` shortcut state immediately through an `onSettingsSaved(committedSettings)` callback owned by `App`. No new WebSocket message is introduced in V1; round-1 feedback correctly identified a separate `settings` message as a second settings protocol beside the existing snapshot path.

Direct edits to `~/.kookr/settings.json` still require the operator to trigger a route-backed save or restart. A file watcher is deferred because the current settings store is not an independently watched subsystem; adding a watcher just for shortcuts would create a second persistence path.

### Terminal focus and event routing

`TerminalPanel` currently lets `Alt+...` bubble out of xterm for global shortcuts. macOS defaults use `Cmd+Ctrl+...`, so it must also let `Meta+Ctrl+...` combinations bubble. It remains catalog-agnostic: it knows only which broad modifier classes are browser-app shortcuts, not which action IDs exist. Plain `Ctrl+...` remains terminal input by default to avoid stealing common shell controls, and bare printable custom bindings are rejected so typing into the dashboard cannot accidentally trigger a global action. A user may still choose a plain-Ctrl override, but that binding is not active while focus is inside xterm.

The global listener continues to suppress shortcuts while modal operations are open, and `?` remains suppressed inside inputs and textareas.

### Relationship to PR #583

PR #583 for issue #577 merged while this work was in progress and added a frontend shortcut cheatsheet catalog. This RFC supersedes that local-only catalog with the shared platform-aware catalog: the branch rebases onto #583, deletes `src/frontend/shortcut-bindings.ts`, and migrates the featured onboarding shortcuts into `src/shared/contracts/shortcut-bindings.ts`.

## Files To Change

- `src/shared/contracts/shortcut-bindings.ts`
- `src/core/settings-store.ts`
- `src/core/settings-store.test.ts`
- `src/server/routes/settings-routes.ts`
- `src/server/settings-api.test.ts`
- `src/frontend/App.tsx`
- `src/frontend/components/ShortcutsHelp.tsx`
- `src/frontend/components/SettingsDialog.tsx`
- `src/frontend/components/TerminalPanel.tsx`
- focused frontend tests for shortcut binding resolution and UI routing

## Edge Cases

- Invalid custom string: ignore that override, keep the action on its platform default, and return a warning.
- Duplicate custom binding: ignore the later override and return a warning naming both action IDs.
- Keyboard layouts where `event.key` differs by case: parser and matcher compare lowercase printable keys, but keep named keys such as `Enter`, `Backspace`, `Delete`, `End`, and `Escape` canonical.
- Terminal focused on macOS: `Cmd+Ctrl+...` bubbles out of xterm; plain `Ctrl+...` remains terminal input.
- Multiple dashboard tabs: the saving tab applies the committed settings response. Other tabs refresh manually in V1.
- `?` is stored and displayed as a literal key; matching ignores the implicit Shift generated by many layouts for `?`, and conflict identity normalizes `Shift+?` to collide with bare `?`.

## Alternatives Considered

- **Use `Cmd+...` defaults on macOS.** Rejected because several needed actions collide with browser defaults (`Cmd+N`, `Cmd+L`, `Cmd+J`, `Cmd+T`, `Cmd+P`, `Cmd+R`, `Cmd+S`, `Cmd+Z`).
- **Use `Ctrl+...` defaults on macOS.** Rejected as the primary default because xterm and shells use many Ctrl chords. It remains available as an explicit override.
- **Use `Option+...` only with physical-code matching.** Rejected because it preserves the root macOS complaint: Option is a text/dead-key modifier.
- **Add a full keybinding editor.** Deferred. It is more polished, but V1 gets correctness, persistence, conflict detection, and discoverability with simpler text inputs.
- **Add a new WebSocket settings message.** Rejected after round-1 review because current-tab hot reload can use the `/api/settings` response without creating a second settings delivery path.
- **Add a settings-file watcher.** Deferred. Route-backed hot reload covers in-product customization without adding a second settings mutation source.

## Critic Feedback Incorporated

- `boundary-critic` 2026-05-24: tightened ownership so server validation is platform-scoped but not based on server OS, `ShortcutsHelp` receives resolved bindings, and `TerminalPanel` stays catalog-agnostic.
- `design-minimalist` 2026-05-24: cut the new WebSocket settings message, cut disable/null semantics, and scoped hot reload to the tab that saves settings.
- `failure-mode-analyst` 2026-05-24: changed `shortcutBindings` to platform-scoped overrides, called out terminal focus zones, malformed JSON behavior, and shifted `?` matching.
- `delivery-pragmatist` 2026-05-24: added the PR #583 sequencing note and a concrete test matrix in implementation.
- `operability-reviewer` 2026-05-24: added visible Settings warnings, reset controls, and documented malformed-file fallback separately from shortcut validation warnings.
- `socratic-challenger` 2026-05-24: resolved platform-dependent validation, disabled shortcut discoverability, range action IDs, and settings hot-reload ambiguity.
- Round 2 `boundary-critic` / `failure-mode-analyst` / `delivery-pragmatist` 2026-05-24: added the explicit SettingsDialog save callback contract, rejected bare printable bindings, documented plain-Ctrl terminal-focus limits, surfaced load-time shortcut warnings on GET, normalized `Shift+?` conflicts, and rebased the implementation over merged PR #583's onboarding shortcut catalog.
