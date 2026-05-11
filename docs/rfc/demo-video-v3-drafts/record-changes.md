# `demo/record.ts` — Required Edits (v3)

This is the apply-able change plan. Each entry has: **file & approximate line**, **what changes**, **why**. Group A = blocking for recording. Group B = polish. Group C = optional / stretch.

The goal is a single contained PR (`feat/demo-video-v3`) that lands record-pipeline changes + new docs + README diff. No production-runtime changes to Kookr itself.

---

## Group A — Blocking changes (must land before recording)

### A1. Viewport + device scale → HiDPI 1080p

**File:** `demo/record.ts` line ~58

```diff
-const VIEWPORT = { width: 1280, height: 720 };
+const VIEWPORT = { width: 1920, height: 1080 };
```

**File:** `demo/record.ts` line ~713 (context.newContext call)

```diff
   const context = await browser.newContext({
     viewport: VIEWPORT,
+    deviceScaleFactor: 2,
     recordVideo: { dir: videoTmpDir, size: VIEWPORT },
   });
```

**Why:** Critic v1 + v3 + user decision. `deviceScaleFactor: 2` gives crisp text under the lanczos upscale to 4K. Playwright video size param stays at the logical viewport — Playwright internally captures at scaled resolution.

**Verify before recording:** dry-run a 30-second segment, confirm text is sharp and confirm Chromium memory usage stays under ~3GB on the recording host.

### A2. NARRATIONS map — replace with v2 keys

**File:** `demo/record.ts` line ~500

Replace the current 13-entry `NARRATIONS` constant with the 15-entry v2 map from [`script-v2.md`](script-v2.md) ("NARRATIONS map summary"). Exact key→text values listed there. Critical: rename `intro` → `cold_open` + `hook`, rename `manual_launch` / `playbook_launch` / `quick_launch` → REMOVED (Act 0 in v3 is a cold open with pre-seeded agents, no live launching). Add: `cold_open`, `projects_open`, `providers_mixed`, `codex_fork`, `inference_stamp` (silent — no narration, but used in tracker), `two_alerts` (replaces `two_findings`), `pr_opened`, `ci_failed`, `repo_url`.

### A3. Cold open — 2×2 fake tmux grid

**File:** new helper at top of `demo/record.ts` (after the existing helpers, before `record()`)

```ts
/**
 * Cold-open visual: a 2×2 grid of fake-tmux panes that fades to make room
 * for the real dashboard. Pure DOM injection, no terminal back-end touched.
 */
async function showColdOpenGrid(page: Page) {
  await page.evaluate(() => {
    const root = document.createElement('div');
    root.id = 'demo-cold-open';
    root.style.cssText = `
      position: fixed; inset: 0; z-index: 99996;
      display: grid; grid-template: 1fr 1fr / 1fr 1fr;
      background: #0b0d12; gap: 4px;
      font-family: 'JetBrains Mono', monospace; font-size: 13px;
      transition: opacity 0.5s, transform 0.5s;
    `;
    const panes = [
      { color: '#dfe4f0', body: '$ claude code\n> Should I proceed with this approach?\nContinue? [y/n]_' },
      { color: '#ff6b6b', body: 'FAIL test/auth.spec.ts > token refresh\n  TypeError: jwt.verify is not a function\n  at Object.<anonymous> (auth.ts:42)' },
      { color: '#48d597', body: '[14:22:11] streaming output...\n[14:22:11] partial result OK\n[14:22:12] retry 3/5...' },
      { color: '#dfe4f0', body: '$ codex exec --task "add pagination"\n# (waiting)\n_' },
    ];
    for (const p of panes) {
      const pane = document.createElement('pre');
      pane.style.cssText = `
        background: #14171f; color: ${p.color}; padding: 24px;
        margin: 0; white-space: pre-wrap; overflow: hidden;
        border: 1px solid #232838; border-radius: 6px;
      `;
      pane.textContent = p.body;
      root.appendChild(pane);
    }
    document.body.appendChild(root);
  });
}

async function fadeOutColdOpenGrid(page: Page, durationMs = 500) {
  await page.evaluate((d) => {
    const root = document.getElementById('demo-cold-open');
    if (!root) return;
    root.style.transition = `opacity ${d}ms, transform ${d}ms`;
    root.style.opacity = '0';
    root.style.transform = 'scale(0.96)';
    setTimeout(() => root.remove(), d + 50);
  }, durationMs);
}
```

**Why:** Productivity critic flagged the missing "before" pain frame. This is the cheapest implementation — pure DOM, no real terminals, ~80 lines total. The grid appears for 3s, then fades during the dashboard reveal.

### A4. Codex agent — set agentType on one of the five tasks

**File:** `demo/record.ts` Act 1 section (~line 760, after the second launchViaUI)

`taskStore.createTask` already accepts `agentType: 'codex-cli'`. Currently the demo only launches Claude tasks because the test-server route doesn't pass `agentType` through. Two fix options:

- **Option A (preferred — additive endpoint):** Add to `e2e/test-server.ts` a new POST endpoint `/api/test/set-agent-type` that takes `{ taskId, agentType: 'claude-code' | 'codex-cli' }` and updates the task in `taskStore`. The demo calls it after launching agent #4. ~10 lines in test-server.ts.

- **Option B (use existing API):** `POST /api/tasks` (live, not test-helper) already accepts `agentType` (`src/server/routes/task-routes.ts:129`). Launch agent #4 by direct fetch instead of `launchViaQuickLaunch`. Slightly higher behavioural realism but bypasses the launch dialog interaction the script counts as a "feature shown."

Recommend **Option A**. Smaller diff, demo logic stays uniform.

### A5. Provider badge tooltip overlay

**File:** new helper in `demo/record.ts`

```ts
async function showProviderTooltip(page: Page, holdMs = 2500) {
  await page.evaluate(() => {
    let el = document.getElementById('demo-provider-tooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-provider-tooltip';
      el.style.cssText = `
        position: fixed; top: 90px; right: 32px; z-index: 99998;
        background: rgba(20, 23, 31, 0.95); color: #dfe4f0;
        padding: 12px 18px; border-radius: 8px;
        border: 1px solid rgba(45, 212, 191, 0.4);
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
        font-size: 13px; line-height: 1.5; max-width: 340px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
        transition: opacity 0.3s;
      `;
      el.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px;color:#2dd4bf;">
          Codex CLI <span style="color:#8b94aa;font-weight:400;">via jeanibarz/codex · feat/claude-compat</span>
        </div>
        <div style="color:#b3bccc;">Adds 4 missing hooks: PermissionRequest, Notification, SubagentStart/Stop, SessionEnd.</div>
      `;
      document.body.appendChild(el);
    }
    el.style.opacity = '1';
  });
  await page.waitForTimeout(holdMs);
  await page.evaluate(() => {
    const el = document.getElementById('demo-provider-tooltip');
    if (el) el.style.opacity = '0';
    setTimeout(() => el?.remove(), 400);
  });
}
```

**Why:** Critic flagged the v1 fork-slug-as-caption as security-warning-coded. Tooltip = present + calm.

### A6. Inference-stamp overlay (Act 2)

**File:** new helper

```ts
async function showInferenceStamp(page: Page, rowSelector: string, ruleText: string, holdMs = 400) {
  await page.evaluate(([sel, text]) => {
    const row = document.querySelector(sel as string);
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const stamp = document.createElement('div');
    stamp.className = 'demo-inference-stamp';
    stamp.textContent = text as string;
    stamp.style.cssText = `
      position: fixed; left: ${rect.right - 240}px; top: ${rect.top + 8}px;
      z-index: 99997; background: rgba(45, 212, 191, 0.12);
      color: #2dd4bf; padding: 4px 10px; border-radius: 4px;
      font: 600 11px/1.4 'JetBrains Mono', monospace;
      border: 1px solid rgba(45, 212, 191, 0.45);
      opacity: 0; transition: opacity 0.15s;
    `;
    document.body.appendChild(stamp);
    requestAnimationFrame(() => { stamp.style.opacity = '1'; });
  }, [rowSelector, ruleText]);
  await page.waitForTimeout(holdMs);
  await page.evaluate(() => {
    document.querySelectorAll('.demo-inference-stamp').forEach((el) => {
      (el as HTMLElement).style.opacity = '0';
      setTimeout(() => el.remove(), 200);
    });
  });
}
```

Call in Act 2:

```ts
await showInferenceStamp(page, '.agent-row[data-tmux="' + tmux1 + '"]', 'rule F2.4: PermissionRequest → severity=warning');
```

### A7. Time-reclaimed overlay (Act 3, after snooze)

**File:** new helper, same pattern as A6 but anchored to the snoozed row:

```ts
async function showTimeReclaimedBadge(page: Page, holdMs = 1200) {
  await page.evaluate(() => {
    const snoozed = document.querySelector('.finding-card.snoozed, .snoozed-row');
    if (!snoozed) return;
    const rect = snoozed.getBoundingClientRect();
    const badge = document.createElement('div');
    badge.textContent = '~14 min reclaimed today';
    badge.style.cssText = `
      position: fixed; left: ${rect.left + rect.width - 180}px; top: ${rect.top + 6}px;
      z-index: 99997; background: rgba(244, 195, 65, 0.15);
      color: #f4c341; padding: 5px 12px; border-radius: 4px;
      font: 600 12px/1.3 -apple-system, sans-serif;
      border: 1px solid rgba(244, 195, 65, 0.4);
      opacity: 0; transition: opacity 0.2s;
    `;
    document.body.appendChild(badge);
    requestAnimationFrame(() => { badge.style.opacity = '1'; });
    setTimeout(() => {
      badge.style.opacity = '0';
      setTimeout(() => badge.remove(), 200);
    }, 1000);
  });
  await page.waitForTimeout(holdMs);
}
```

### A8. Completion digest — extra row for supervision-avoided

**File:** `e2e/test-server.ts` — extend the `set-completion-digest` endpoint to accept an optional `supervisionAvoided: { minutes: number; checks: number }` field.

**File:** `src/frontend/.../CompletionDigest.svelte` (or equivalent) — render the new field if present, with a small `*demo overlay` footnote (gated on `KOOKR_DEMO_MODE=true` env var so this doesn't ship in production UI).

Alternative: render purely as a DOM-injected overlay via `page.evaluate` in `demo/record.ts`. Lower-risk; no Svelte change.

Recommend overlay (lower risk for a single-use demo asset).

### A9. ffmpeg upscale pass

**File:** `demo/record.ts` `record()` finalization (~line 1250)

After the existing `mergeAudioIntoVideo()` step, add:

```ts
// 4K upscale
const k4Path = join(OUTPUT_DIR, 'kookr-demo-4k.mp4');
try {
  await execFileAsync('ffmpeg', [
    '-y', '-i', finalPath,
    '-vf', 'scale=3840:2160:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-c:a', 'copy',
    k4Path,
  ], { timeout: 300_000 });
  console.log(`[ffmpeg] 4K upscale saved: ${k4Path}`);
} catch (err) {
  console.warn(`[ffmpeg] 4K upscale failed: ${err instanceof Error ? err.message : String(err)}`);
  console.warn('[ffmpeg] 1080p output preserved at:', finalPath);
}
```

**Why:** Produces the LinkedIn 4K asset without re-recording. The 1080p `kookr-demo.webm` stays as the README inline asset.

---

## Group B — Polish (apply before recording if time allows)

### B1. AI suggestion shimmer (Act 3)

Add a 600ms placeholder shimmer before each suggestion text resolves. Cheapest fix: a CSS keyframe animation on a `.demo-shimmer` class, applied to the suggestion DOM nodes for 600ms after they're injected. Reduces the "this is a fixture" feel that the competitive critic flagged.

### B2. Closing card install line

The current closing-card render lives in DOM. Add a single new line above the QR code (production-style install — matches what the video demonstrates):

```html
<div style="font-family:'JetBrains Mono';font-size:13px;color:#b3bccc;margin-top:8px;line-height:1.5;">
  git clone … && pnpm install<br/>
  && pnpm prod:setup && pnpm prod:update
</div>
```

### B3. Tighten Act 4 (GitHub) by 5s

Remove the 4-second lull between PR-open toast and CI-fail toast. Replace with a 1.5-second pause.

---

## Group C — Optional / stretch

### C1. Second cut for X/social

X engagement data favours <90s vertical clips. After the 2:33 horizontal master ships, optionally produce a 70s 9:16 social cut by:

- Re-recording at viewport 720×1280 with a vertical re-layout of the dashboard (requires a `demo-vertical` flag).
- OR cropping the 1080p master to a 16:9 centred slice and re-cutting captions for narrower lines.

Not in scope for the v3 PR.

### C2. Frame-by-frame captions QA

After recording, sample every 15th frame and run a contrast/legibility check on caption text. If any caption falls below 4.5:1 contrast on the dashboard background, bump caption background to `rgba(0,0,0,0.92)`.

---

## Files touched (preview)

```
demo/record.ts                                    (modified, ~+200 lines)
e2e/test-server.ts                                (modified, +2 endpoints)
docs/codex-cli-setup.md                           (new)
docs/rfc/demo-video-v3-drafts/*                   (new — this RFC bundle)
README.md                                         (modified, ~6 lines)
```

No `src/server/*` or `src/frontend/*` changes (per Group A.8 alternative choice).

---

## Test plan before recording

1. `pnpm typecheck` — confirm no breakage from new helpers and endpoint.
2. `pnpm vitest run e2e/test-server.test.ts` (if present) — confirm new endpoints respond.
3. **Dry-run capture: just Act 0 + Act 1.** Run a forked record script that exits after Act 1. Inspect the output webm visually. Confirm: viewport is 1920×1080, text is sharp under deviceScaleFactor 2, Codex tooltip renders correctly, cold-open grid → dashboard transition is smooth.
4. **Full recording with TTS off first.** Confirm pacing matches the 2:33 budget. Trim Act 4 by 5s if total exceeds 2:40.
5. **Full recording with TTS on.** Confirm audio sync within ±150ms on each clip via spot-check.
6. **ffmpeg upscale.** Inspect `kookr-demo-4k.mp4` at 100% zoom. Confirm no aliasing on the project badges.
7. **File size check.** Target: <80 MB for the 4K master, <20 MB for the 1080p inline. If 4K exceeds 120 MB, raise `-crf` to 20 and re-encode.

---

## Risk callouts

- **`deviceScaleFactor: 2` doubles recording memory.** Chromium will use ~2× more RAM during capture. If the recording host has <16GB, drop to `deviceScaleFactor: 1.5` and accept slightly softer text.
- **The cold-open grid is a CSS overlay, not real tmux.** A skeptical viewer might notice the panes don't update. Mitigation: keep the grid on screen for only 3s, then fade to dashboard. Long enough to anchor pain, short enough to dodge "is that real?" scrutiny.
- **The `~22 min supervision avoided` heuristic is editorial.** It's footnoted in-scene and explicitly marked as a demo overlay, but a contributor reviewing the PR may push back. If they do, the fallback is to drop the row and replace the closing-card pill with `Skip the 30-second polling tax.` — a similar productivity beat without a specific number.
