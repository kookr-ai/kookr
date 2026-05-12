/**
 * Demo recording script V3 — produces a narrated 1080p WebM plus a 4K MP4
 * release asset showcasing
 * the full Kookr feature set.
 *
 * Scenario: "A morning with 5 agents" — launch agents across 2 projects
 * using playbooks and quick launch, then triage findings that demonstrate
 * quick actions, AI suggestions, snooze, merge conflict detection, and
 * completion digests.
 *
 * Reuses the E2E test server (FakeTerminalManager + event injection) with
 * Playwright's built-in video recording. Captions are injected as plain DOM
 * elements.
 *
 * When TTS is available (KOOKR_TTS_URL or KOOKR_TTS=true), generates
 * narration audio for each caption and merges it into the final video with ffmpeg.
 *
 * Usage:
 *   pnpm demo:record                    # Uses TTS when KOOKR_TTS=true
 *   KOOKR_TTS_URL=http://localhost:8004 pnpm demo:record   # External narration service
 *
 * Output:
 *   demo/output/kookr-demo.webm
 */
// Load .env file if present (for KOOKR_TTS, KOOKR_TTS_URL, etc.)
try {
  process.loadEnvFile();
} catch {
  // .env not found — env vars may be set via shell
}

import { chromium, type Page, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { resolve, join, dirname } from 'node:path';
import { mkdtempSync, renameSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  jwtFixContent,
  paginationContent,
  cacheRefactorContent,
  rateLimitContent,
  authRefactorContent,
  mergeConflictContent,
} from './terminal-content.js';
import { startTTS, type TTSManager } from '../src/server/tts-manager.js';
import { preflight } from './lib/preflight.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 4803;
const BASE = `http://127.0.0.1:${PORT}`;
const OUTPUT_DIR = resolve(__dirname, 'output');
const VIEWPORT = { width: 1920, height: 1080 };
const DEVICE_SCALE_FACTOR = 2;

// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = fork(
      join(__dirname, '..', 'e2e', 'test-server.ts'),
      [],
      {
        env: { ...process.env, E2E_PORT: String(PORT) },
        execArgv: ['--import', 'tsx'],
        stdio: 'pipe',
      },
    );

    child.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString();
      process.stdout.write(`[server] ${msg}`);
      if (msg.includes('ready')) {
        resolve(child);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`[server] ${data.toString()}`);
    });

    child.on('error', reject);

    // Timeout after 15s
    setTimeout(() => reject(new Error('Server start timeout')), 15000);
  });
}

// ---------------------------------------------------------------------------
// Caption helper
// ---------------------------------------------------------------------------

async function showCaption(page: Page, text: string) {
  await page.evaluate((t) => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      el.style.cssText = `
        position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.88); color: #dfe4f0; padding: 12px 28px;
        border-radius: 10px; font-size: 16px; z-index: 99999;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
        transition: opacity 0.4s; max-width: 80%; text-align: center;
        border: 1px solid rgba(45,53,80,0.6); letter-spacing: 0.2px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        pointer-events: none;
      `;
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.opacity = t ? '1' : '0';
  }, text);
}

async function hideCaption(page: Page) {
  await showCaption(page, '');
}

// ---------------------------------------------------------------------------
// Visual interaction indicators (click ripple + keystroke badge)
// ---------------------------------------------------------------------------

/** Inject the CSS and JS needed for visual feedback on clicks and keystrokes. */
async function injectInteractionIndicators(page: Page) {
  await page.evaluate(() => {
    // --- CSS for click ripple and keystroke badge ---
    const style = document.createElement('style');
    style.textContent = `
      .demo-click-ripple {
        position: fixed; pointer-events: none; z-index: 99998;
        width: 28px; height: 28px; border-radius: 50%;
        border: 2.5px solid #2dd4bf; background: rgba(45,212,191,0.25);
        transform: translate(-50%, -50%) scale(0.5);
        animation: demo-ripple 0.6s ease-out forwards;
      }
      @keyframes demo-ripple {
        0% { transform: translate(-50%, -50%) scale(0.5); opacity: 1; }
        100% { transform: translate(-50%, -50%) scale(2); opacity: 0; }
      }
      .demo-keystroke {
        position: fixed; top: 12px; right: 12px; z-index: 99998;
        background: rgba(0,0,0,0.85); color: #2dd4bf; padding: 8px 16px;
        border-radius: 8px; font-size: 15px; font-weight: 600;
        font-family: 'JetBrains Mono', 'Fira Code', monospace;
        border: 1px solid rgba(45,212,191,0.4);
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        animation: demo-keystroke-fade 1.2s ease-out forwards;
        letter-spacing: 0.5px;
      }
      @keyframes demo-keystroke-fade {
        0% { opacity: 0; transform: translateY(-8px); }
        15% { opacity: 1; transform: translateY(0); }
        70% { opacity: 1; }
        100% { opacity: 0; }
      }
    `;
    document.head.appendChild(style);

    // --- Click ripple listener ---
    document.addEventListener('click', (e) => {
      const ripple = document.createElement('div');
      ripple.className = 'demo-click-ripple';
      ripple.style.left = e.clientX + 'px';
      ripple.style.top = e.clientY + 'px';
      document.body.appendChild(ripple);
      setTimeout(() => ripple.remove(), 700);
    }, true);
  });
}

/** Show a keystroke badge in the top-right corner (e.g., "Alt+N", "1"). */
async function showKeystroke(page: Page, label: string) {
  await page.evaluate((lbl) => {
    // Remove any existing keystroke badge
    document.querySelectorAll('.demo-keystroke').forEach(el => el.remove());
    const badge = document.createElement('div');
    badge.className = 'demo-keystroke';
    badge.textContent = lbl;
    document.body.appendChild(badge);
    setTimeout(() => badge.remove(), 1300);
  }, label);
}

async function waitForDetailTitle(page: Page, title: string, timeout = 3000) {
  await page.waitForFunction(
    `document.querySelector('.detail-header-left')?.textContent?.includes(${JSON.stringify(title)}) === true`,
    undefined,
    { timeout },
  );
}

async function selectFindingByText(page: Page, text: string, expectedTitle = text) {
  const card = page.locator('.finding-card').filter({ hasText: text }).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  await card.scrollIntoViewIfNeeded();
  await card.click({ force: true });
  await waitForDetailTitle(page, expectedTitle);
}

async function selectCompletedRowByText(page: Page, text: string) {
  const row = page.locator('.completed-row').filter({ hasText: text }).first();
  await row.waitFor({ state: 'visible', timeout: 5000 });
  await row.scrollIntoViewIfNeeded();
  await row.click({ force: true });
  await waitForDetailTitle(page, text);
}

// ---------------------------------------------------------------------------
// v3 demo overlays — cold-open grid, provider tooltip, inference stamp,
// time-reclaimed badge, supervision-avoided digest row. All pure DOM.
// ---------------------------------------------------------------------------

/** Mount the full-screen intro card: animated Kookr logo + playful tagline
 *  + subtitle. Used at the very start so the recording opens with branding.
 *  The addInitScript "startup curtain" hides everything else until this
 *  overlay is on screen — no dashboard flash. */
async function showIntroLogoScreen(page: Page) {
  await page.evaluate(() => {
    if (document.getElementById('demo-intro-logo')) return;
    const root = document.createElement('div');
    root.id = 'demo-intro-logo';
    root.style.cssText = `
      position: fixed; inset: 0; z-index: 99998;
      background: #0b0d12;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 28px; padding: 48px;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      opacity: 1; visibility: visible !important;
    `;
    root.innerHTML = `
      <div id="demo-intro-content" style="display:flex;flex-direction:column;align-items:center;gap:28px;opacity:0;">
      <video id="demo-intro-logo-video" autoplay muted playsinline preload="auto"
             style="width: 360px; height: 540px; display: block; object-fit: contain; visibility: visible;"
             src="/demo-assets/kookr-logo.mp4"></video>
      <div style="font-size: 32px; color: #dfe4f0; font-weight: 600; letter-spacing: 0.2px; text-align: center; visibility: visible;">
        Let your AI agents cook.
      </div>
      <div style="font-size: 20px; color: #8b94aa; letter-spacing: 0.3px; font-weight: 400; text-align: center; visibility: visible;">
        an attention router for parallel AI coding agents
      </div>
      </div>
    `;
    document.body.appendChild(root);

    const content = document.getElementById('demo-intro-content') as HTMLElement | null;
    const video = document.getElementById('demo-intro-logo-video') as HTMLVideoElement | null;
    content?.setAttribute('data-ready', 'false');
    video?.load();
  });
  await page.waitForFunction(
    "(() => { const video = document.getElementById('demo-intro-logo-video'); return !video || video.readyState >= 2; })()",
    undefined,
    { timeout: 1500 },
  ).catch(() => {});
  await page.evaluate(() => {
    const content = document.getElementById('demo-intro-content') as HTMLElement | null;
    if (!content) return;
    content.style.transition = 'opacity 250ms ease-out';
    content.style.opacity = '1';
    content.setAttribute('data-ready', 'true');
  });
}

async function hideIntroLogoScreen(page: Page, durationMs = 600) {
  await page.evaluate((d) => {
    const root = document.getElementById('demo-intro-logo');
    if (!root) return;
    root.style.transition = `opacity ${d}ms`;
    root.style.opacity = '0';
    setTimeout(() => root.remove(), d + 50);
  }, durationMs);
  // Lift the startup curtain so the underlying dashboard becomes visible
  // when the intro fades out.
  await page.evaluate(() => {
    document.getElementById('demo-startup-curtain')?.remove();
  });
}

/** 3x2 fake-tmux grid that anchors the "before" pain in Act 0. Six panes
 *  with distinct real-world states: healthy progress, permission prompt,
 *  product decision, review/CI, planning, retry/backoff. */
async function showColdOpenGrid(page: Page) {
  await page.evaluate(() => {
    const root = document.createElement('div');
    root.id = 'demo-cold-open';
    root.style.cssText = `
      position: fixed; inset: 0; z-index: 99996;
      display: grid; grid-template: 1fr 1fr / 1fr 1fr 1fr;
      background: #0b0d12; gap: 3px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 16px;
      transition: opacity 0.5s, transform 0.5s;
    `;
    const panes = [
      // Top row
      {
        color: '#48d597',
        body: '$ claude code\n> Implementing cursor pagination\n  Read src/routes/users.ts\n  Edit src/routes/users.ts (+42 -8)\n  npm test -- users\n  PASS users.pagination.test.ts (8/8)\n  next: update API docs',
      },
      {
        color: '#f4c341',
        body: '$ codex exec "fix auth middleware"\nPermission requested\n  Tool: Bash\n  Command: npm test -- --runInBand\nAllow? [1] yes  [2] no\n_',
      },
      {
        color: '#dfe4f0',
        body: '$ claude code\n> Rate-limit storage decision needed:\n  1. in-memory TTL + Redis adapter\n  2. Redis immediately\n  3. config flag + follow-up issue\nWaiting for product call...',
      },
      // Bottom row
      {
        color: '#ffb86c',
        body: '$ claude code\nPR #142 opened\n  review: changes requested\n  CI / build: pass\n  CI / lint: import order failed\n  next: apply reviewer fix',
      },
      {
        color: '#8ab4ff',
        body: '● Planning security review\n  grep auth guards\n  read 9 files\n  found 3 untested edge cases\n  drafting test plan...\n  18.4k tok · 42s elapsed',
      },
      {
        color: '#dfe4f0',
        body: '$ codex exec "refresh dependencies"\ntool: pnpm install timed out (network)\nretry 2/5 in 8s\ncache warm, lockfile unchanged\nno code changed yet',
      },
    ];
    for (const p of panes) {
      const pane = document.createElement('pre');
      pane.style.cssText = `
        background: #14171f; color: ${p.color}; padding: 28px;
        margin: 0; white-space: pre-wrap; overflow: hidden;
        border: 1px solid #232838; border-radius: 6px;
        line-height: 1.55;
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

/** Top-right tooltip explaining the Codex CLI fork. Fades out after holdMs. */
async function showProviderTooltip(page: Page, holdMs = 2500) {
  await page.evaluate(() => {
    let el = document.getElementById('demo-provider-tooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-provider-tooltip';
      el.style.cssText = `
        position: fixed; top: 120px; right: 48px; z-index: 99998;
        background: rgba(20, 23, 31, 0.95); color: #dfe4f0;
        padding: 16px 22px; border-radius: 10px;
        border: 1px solid rgba(45, 212, 191, 0.4);
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
        font-size: 14px; line-height: 1.5; max-width: 420px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
        transition: opacity 0.3s;
      `;
      el.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px;color:#2dd4bf;font-size:15px;">
          Codex CLI <span style="color:#8b94aa;font-weight:400;font-size:13px;">via jeanibarz/codex · feat/claude-compat</span>
        </div>
        <div style="color:#b3bccc;">Adds 4 hooks vanilla Codex is missing: PermissionRequest, Notification, SubagentStart/Stop, SessionEnd.</div>
      `;
      document.body.appendChild(el);
    }
    el.style.opacity = '1';
  });
  await page.waitForTimeout(holdMs);
  await page.evaluate(() => {
    const el = document.getElementById('demo-provider-tooltip');
    if (el) {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 400);
    }
  });
}

/** ~400ms inference-rule stamp near a row. Proves Kookr inferred, not just rendered. */
async function showInferenceStamp(page: Page, text: string, holdMs = 600) {
  await page.evaluate((label) => {
    const stamp = document.createElement('div');
    stamp.className = 'demo-inference-stamp';
    stamp.textContent = label;
    stamp.style.cssText = `
      position: fixed; top: 220px; right: 64px; z-index: 99997;
      background: rgba(45, 212, 191, 0.14); color: #2dd4bf;
      padding: 6px 14px; border-radius: 6px;
      font: 600 13px/1.4 'JetBrains Mono', monospace;
      border: 1px solid rgba(45, 212, 191, 0.5);
      opacity: 0; transition: opacity 0.18s;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    `;
    document.body.appendChild(stamp);
    requestAnimationFrame(() => { stamp.style.opacity = '1'; });
  }, text);
  await page.waitForTimeout(holdMs);
  await page.evaluate(() => {
    document.querySelectorAll('.demo-inference-stamp').forEach((el) => {
      (el as HTMLElement).style.opacity = '0';
      setTimeout(() => el.remove(), 220);
    });
  });
}

/** "~14 min reclaimed today" badge that appears after snoozing. */
async function showTimeReclaimedBadge(page: Page, holdMs = 1400) {
  await page.evaluate(() => {
    const badge = document.createElement('div');
    badge.id = 'demo-time-reclaimed';
    badge.textContent = '~14 min reclaimed today';
    // Fixed position bottom-left so it's visible regardless of which row got
    // snoozed (the snoozed row's DOM position can be unstable mid-animation).
    badge.style.cssText = `
      position: fixed; bottom: 96px; left: 96px; z-index: 99997;
      background: rgba(244, 195, 65, 0.18); color: #f4c341;
      padding: 10px 20px; border-radius: 8px;
      font: 600 18px/1.3 -apple-system, sans-serif;
      border: 1.5px solid rgba(244, 195, 65, 0.55);
      opacity: 0; transition: opacity 0.25s;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
    `;
    document.body.appendChild(badge);
    requestAnimationFrame(() => { badge.style.opacity = '1'; });
  });
  await page.waitForTimeout(holdMs);
  await page.evaluate(() => {
    const el = document.getElementById('demo-time-reclaimed');
    if (el) {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }
  });
}

/** Overlay added to the completion digest panel: "Manual supervision avoided" row + footnote. */
async function showSupervisionAvoidedOverlay(page: Page, taskDurationLabel: string, checks: number, minutes: number) {
  await page.evaluate(({ duration, checkCount, mins }) => {
    // Find the completion digest panel — looks for the bullets list root.
    const digest = document.querySelector('.detail-digest, .completion-digest, .digest, .task-detail-completion');
    const anchor = digest ?? document.body;
    const row = document.createElement('div');
    row.id = 'demo-supervision-row';
    row.style.cssText = `
      margin-top: 10px; padding: 10px 14px;
      background: rgba(45, 212, 191, 0.08);
      border: 1px solid rgba(45, 212, 191, 0.35);
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      color: #dfe4f0;
    `;
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <span style="font-weight:600;color:#2dd4bf;font-size:14px;">Manual supervision avoided</span>
        <span style="color:#dfe4f0;font-size:14px;">~${mins} min <span style="color:#8b94aa;font-size:12px;">(≈ ${checkCount} checks at 30s cadence)</span></span>
      </div>
      <div style="font-size:11px;color:#6b7388;margin-top:6px;">
        *Estimate: 30s manual-check cadence × ${duration} task duration. Demo overlay; not yet a product feature.
      </div>
    `;
    if (digest) {
      anchor.appendChild(row);
    } else {
      // Fallback: pin to BOTTOM-CENTER of viewport so it sits over the
      // detail panel cleanly and never overlaps the top-right CI/alert toasts
      // that share that corner (which made it read like a red error frame
      // in the v1 capture).
      row.style.cssText += `
        position: fixed; bottom: 132px; left: 50%; transform: translateX(-50%);
        z-index: 99997; min-width: 460px; max-width: 540px;
        background: rgba(45, 212, 191, 0.14);
        border: 1.5px solid rgba(45, 212, 191, 0.55);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55);
      `;
      document.body.appendChild(row);
    }
  }, { duration: taskDurationLabel, checkCount: checks, mins: minutes });
}

async function clearSupervisionAvoidedOverlay(page: Page) {
  await page.evaluate(() => {
    document.getElementById('demo-supervision-row')?.remove();
  });
}

/** Full-frame closing card with Kookr wordmark, pills, URL, install line, fork link. */
async function showClosingCard(page: Page) {
  await page.evaluate(() => {
    const card = document.createElement('div');
    card.id = 'demo-closing-card';
    card.style.cssText = `
      position: fixed; inset: 0; z-index: 99996;
      background: #0b0d12;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 36px; padding: 48px;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      opacity: 0; transition: opacity 0.6s;
    `;
    card.innerHTML = `
      <video autoplay muted loop playsinline
             style="width: 200px; height: 300px; display: block; object-fit: contain;"
             src="/demo-assets/kookr-logo.mp4"></video>
      <div style="display:flex;gap:16px;">
        <span style="padding:10px 22px;border-radius:999px;border:1px solid rgba(45,212,191,0.5);color:#2dd4bf;font-weight:600;font-size:18px;">Local-first</span>
        <span style="padding:10px 22px;border-radius:999px;border:1px solid rgba(45,212,191,0.5);color:#2dd4bf;font-weight:600;font-size:18px;">Attention router</span>
        <span style="padding:10px 22px;border-radius:999px;border:1px solid rgba(45,212,191,0.5);color:#2dd4bf;font-weight:600;font-size:18px;">Multi-project</span>
      </div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:22px;color:#dfe4f0;font-weight:600;">
        github.com/kookr-ai/kookr
      </div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:14px;color:#b3bccc;text-align:center;line-height:1.7;">
        git clone &amp;&amp; pnpm install<br/>
        &amp;&amp; pnpm prod:setup &amp;&amp; pnpm prod:update
      </div>
      <div style="font-size:16px;color:#b3bccc;text-align:center;margin-top:14px;line-height:1.6;">
        Codex CLI via <span style="color:#2dd4bf;font-weight:600;">jeanibarz/codex · feat/claude-compat</span>
      </div>
      <div style="font-size:13px;color:#8b94aa;text-align:center;">
        Apache 2.0 · No telemetry · State under ~/.kookr/
      </div>
    `;
    document.body.appendChild(card);
    requestAnimationFrame(() => { card.style.opacity = '1'; });
  });
}

async function hideClosingCard(page: Page) {
  await page.evaluate(() => {
    const card = document.getElementById('demo-closing-card');
    if (card) {
      card.style.opacity = '0';
      setTimeout(() => card.remove(), 600);
    }
  });
}

// ---------------------------------------------------------------------------
// Event injection helpers (mirrors e2e/kookr.spec.ts)
// ---------------------------------------------------------------------------

async function resetServer(ctx: BrowserContext) {
  const request = ctx.request;
  await request.post(`${BASE}/api/test/reset`);
}

async function getLatestTmuxName(request: APIRequestContext): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await request.get(`${BASE}/api/tasks`);
    const tasks = (await res.json()) as Array<{
      status: string;
      sessions: Array<{ tmuxSession: string }>;
    }>;
    const inProgress = tasks.filter((t) => t.status === 'inProgress');
    const last = inProgress[inProgress.length - 1];
    if (last?.sessions?.length > 0) {
      return last.sessions[last.sessions.length - 1].tmuxSession;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timed out waiting for inProgress task with sessions');
}

async function getTaskId(request: APIRequestContext, index = 0): Promise<string> {
  const res = await request.get(`${BASE}/api/tasks`);
  const tasks = (await res.json()) as Array<{ id: string }>;
  return tasks[index].id;
}

async function injectEvent(
  request: APIRequestContext,
  tmuxName: string,
  event: Record<string, unknown>,
) {
  await request.post(`${BASE}/api/test/inject-event`, {
    data: { tmuxName, event },
  });
}

async function injectSessionStart(request: APIRequestContext, tmuxName: string, cwd = '/home/dev/webapp') {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd,
    hook_event_name: 'SessionStart',
  });
}

async function injectStopEvent(
  request: APIRequestContext,
  tmuxName: string,
  message = 'I need your input to proceed.',
) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/dev/webapp',
    hook_event_name: 'Stop',
    stop_hook_active: true,
    last_assistant_message: message,
  });
}

async function injectPermissionEvent(
  request: APIRequestContext,
  tmuxName: string,
  toolName = 'Bash',
  command = 'rm -rf node_modules && npm install',
) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/dev/webapp',
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: { command },
    permission_mode: 'default',
  });
}

async function injectToolUse(
  request: APIRequestContext,
  tmuxName: string,
  toolName = 'Read',
) {
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/dev/webapp',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
  });
}

async function injectMergeConflict(
  request: APIRequestContext,
  tmuxName: string,
) {
  // Inject a Bash tool result containing merge conflict markers
  await injectEvent(request, tmuxName, {
    session_id: `sess-${Date.now()}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/home/dev/webapp',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_result: 'Auto-merging src/auth.ts\nCONFLICT (content): Merge conflict in src/auth.ts\nAutomatic merge failed; fix conflicts and then commit the result.',
  });
}

async function setTerminalContent(
  request: APIRequestContext,
  tmuxName: string,
  text: string,
  opts?: { mode?: 'instant' | 'streaming'; lineDelayMs?: number; loop?: boolean },
) {
  await request.post(`${BASE}/api/test/set-terminal-content`, {
    data: {
      tmuxName,
      content: { text, mode: opts?.mode ?? 'streaming', lineDelayMs: opts?.lineDelayMs ?? 150, loop: opts?.loop ?? false },
    },
  });
}

async function setProjectId(
  request: APIRequestContext,
  taskId: string,
  projectId: string,
) {
  await request.post(`${BASE}/api/test/set-project-id`, {
    data: { taskId, projectId },
  });
}

async function seedProjectConfigs(request: APIRequestContext) {
  await request.post(`${BASE}/api/test/set-project-config`, {
    data: { project: 'acme/webapp', dailyPrLimit: 5, weeklyPrLimit: 20, notes: 'Main web application' },
  });
  await request.post(`${BASE}/api/test/set-project-config`, {
    data: { project: 'acme/api-service', dailyPrLimit: 3, weeklyPrLimit: 10, notes: 'Backend API service' },
  });
}

async function broadcastProjectSummaries(request: APIRequestContext) {
  await request.post(`${BASE}/api/test/broadcast-project-summaries`);
}

async function broadcastSuggestion(
  request: APIRequestContext,
  agentId: string,
  suggestions: string[],
  quickActions: Array<{ label: string; value: string; shortcut?: string }> = [],
) {
  await request.post(`${BASE}/api/test/broadcast-suggestion`, {
    data: { agentId, suggestions, quickActions },
  });
}

/** Create real playbook files on disk so listPlaybooks discovers them. */
async function createPlaybookFiles(request: APIRequestContext, cwd: string) {
  await request.post(`${BASE}/api/test/create-playbook-files`, {
    data: {
      cwd,
      playbooks: [
        {
          filename: 'implement-issue.md',
          content: [
            '---',
            'name: Implement GitHub Issue',
            'description: Pick up a GitHub issue — investigate, implement, test, and open a PR',
            'parameters:',
            '  - name: issue',
            '    description: Issue URL or number',
            '    required: true',
            'checklist:',
            '  - Reproduce or understand the issue',
            '  - Write failing test',
            '  - Implement the fix or feature',
            '  - All tests pass',
            '  - Open PR with description',
            '---',
            'Implement the GitHub issue: {{issue}}. Start by reading the issue, then write a failing test, implement the solution, and open a PR.',
          ].join('\n'),
        },
        {
          filename: 'test-quality-audit.md',
          content: [
            '---',
            'name: Test Quality Audit',
            'description: Audit test coverage and quality for a module — find gaps, remove flaky tests',
            'parameters:',
            '  - name: scope',
            '    description: Module to audit',
            '    required: true',
            '    type: select',
            '    options:',
            '      - label: Auth module',
            '        value: src/auth/',
            '      - label: API routes',
            '        value: src/routes/',
            '      - label: Frontend components',
            '        value: src/frontend/',
            '      - label: Full codebase',
            '        value: src/',
            'checklist:',
            '  - Map current test coverage',
            '  - Identify untested code paths',
            '  - Fix or flag flaky tests',
            '  - Add missing edge case tests',
            '---',
            'Audit test quality in {{scope}}. Find coverage gaps, flaky tests, and weak assertions.',
          ].join('\n'),
        },
        {
          filename: 'security-review.md',
          content: [
            '---',
            'name: Security Review',
            'description: Review code for OWASP top 10 vulnerabilities and security best practices',
            'parameters:',
            '  - name: area',
            '    description: Focus area',
            '    required: false',
            '    default: full',
            '    type: select',
            '    options:',
            '      - label: Full codebase',
            '        value: full',
            '      - label: Authentication & sessions',
            '        value: auth',
            '      - label: API endpoints',
            '        value: api',
            '      - label: Data validation',
            '        value: validation',
            '---',
            'Security review focused on {{area}}. Check for OWASP top 10.',
          ].join('\n'),
        },
        {
          filename: 'pr-review-fix.md',
          content: [
            '---',
            'name: PR Review & Fix',
            'description: Address review comments on an open PR — fix issues, respond to feedback',
            'parameters:',
            '  - name: prUrl',
            '    description: Pull request URL',
            '    required: true',
            'checklist:',
            '  - Read all review comments',
            '  - Implement requested changes',
            '  - Respond to each thread',
            '  - Push and re-request review',
            '---',
            'Address the review comments on {{prUrl}}.',
          ].join('\n'),
        },
      ],
    },
  });
}

async function completeTaskWithDigest(
  request: APIRequestContext,
  taskId: string,
  digest: { bullets: string[]; filesChanged: string[]; testSummary?: string },
) {
  await request.post(`${BASE}/api/test/complete-task/${taskId}`);
  await request.post(`${BASE}/api/test/set-completion-digest/${taskId}`, { data: digest });
}

/**
 * Seed a task directly via the live POST /api/tasks endpoint. Bypasses the
 * launch-dialog UI ceremony so the recording can pre-populate the dashboard
 * with five agents in <2s and start the scenario from a settled state.
 */
async function seedAgent(
  request: APIRequestContext,
  opts: { prompt: string; cwd: string; agentType?: 'claude-code' | 'codex-cli'; projectId?: string },
): Promise<string> {
  const res = await request.post(`${BASE}/api/tasks`, {
    data: {
      prompt: opts.prompt,
      cwd: opts.cwd,
      agentType: opts.agentType ?? 'claude-code',
    },
  });
  if (!res.ok()) throw new Error(`seedAgent failed: ${res.status()} ${await res.text()}`);
  const task = (await res.json()) as { id: string };
  const renameRes = await request.patch(`${BASE}/api/tasks/${task.id}/name`, {
    data: { name: opts.prompt },
  });
  if (!renameRes.ok()) {
    throw new Error(`seedAgent rename failed: ${renameRes.status()} ${await renameRes.text()}`);
  }
  if (opts.projectId) {
    await request.post(`${BASE}/api/test/set-project-id`, {
      data: { taskId: task.id, projectId: opts.projectId },
    });
  }
  // Override agentType after creation. The adapter routing has already picked
  // the default (claude-code) launcher — we only mutate the rendered badge.
  if (opts.agentType === 'codex-cli') {
    await request.post(`${BASE}/api/test/set-agent-type`, {
      data: { taskId: task.id, agentType: 'codex-cli' },
    });
  }
  return task.id;
}

async function launchViaUI(page: Page, prompt: string, cwd: string) {
  await page.locator('.btn-launch').click();
  await page.waitForTimeout(300);
  // Type the prompt slowly enough to read
  await page.locator('.dialog textarea').pressSequentially(prompt, { delay: 25 });
  await page.waitForTimeout(400);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.pressSequentially(cwd, { delay: 20 });
  await page.waitForTimeout(500);
  await page.locator('.dialog .btn-primary').click();
  await page.locator('.dialog').waitFor({ state: 'hidden' });
}

async function launchViaQuickLaunch(page: Page, prompt: string) {
  await showKeystroke(page, 'Alt+L');
  await page.keyboard.press('Alt+l');
  const qlInput = page.locator('.quick-launch-input');
  await qlInput.waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  await qlInput.pressSequentially(prompt, { delay: 30 });
  await page.waitForTimeout(400);
  await showKeystroke(page, 'Enter');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// TTS narration
// ---------------------------------------------------------------------------

const TTS_URL = process.env.KOOKR_TTS_URL ?? '';
const TTS_VOICE = process.env.TTS_VOICE ?? '/app/voices/matilda.mp3';

/** Narration scripts — v3 (critic-informed). */
const NARRATIONS: Record<string, string> = {
  // Act 0: Cold open + hook
  intro_logo: 'Running five coding agents sounds like leverage, until your job becomes checking five terminals.',
  cold_open: 'Some are making progress. Some are blocked. One needs a decision right now.',
  hook: 'Kookr turns that noise into one attention queue. It tells you where your review time matters next.',

  // Act 1: Multi-project, multi-provider
  projects_webapp: 'First, the webapp project stays isolated, so you can inspect auth and login work without mixing contexts.',
  projects_api: 'Then switch to API work and you only see backend tasks: pagination, rate limits, and service changes.',
  projects_all: 'Or return to all projects when you want global supervision across every running agent.',
  providers_mixed: 'Claude Code and Codex CLI land in the same workflow. Different runtimes, one supervision surface.',

  // Act 2: Anomaly detection
  permission_block: 'This is the everyday win: a permission prompt is no longer buried in a terminal.',
  permission_allow: 'Kookr surfaces the exact command, the exact agent, and the next action to unblock it.',

  // Act 3: Cross-project triage
  two_alerts: 'Now two interruptions compete: Codex needs product judgment, while Claude hit a merge conflict.',
  ai_suggest: 'Kookr keeps the agent context attached and drafts plausible replies. You still decide; it removes the copy-paste and terminal archaeology.',
  snooze_other: 'Not every interruption deserves the next five minutes. Snooze the merge conflict and keep the active decision in front of you.',

  // Act 4: GitHub awareness
  pr_opened: 'The handoff does not stop when an agent opens a pull request. Kookr keeps review context attached to the agent that caused it.',
  ci_failed: 'When CI fails, it re-enters the same attention queue, next to terminal prompts and product decisions.',

  // Act 5: Completion + cost + time saved
  agent_done: 'When an agent finishes, Kookr gives you the digest: what changed, what passed, and what it cost.',
  time_saved: 'The point is not another dashboard. It is avoiding another manual check-in loop.',

  // Act 6: Closing
  closing: 'Kookr is local-first and open source: an attention router for developers running parallel AI coding agents.',
  repo_url: 'Ready to step up your multi-agent game? Try Kookr at github.com slash kookr-ai slash kookr. Apache two-point-zero.',
};

interface AudioClip {
  key: string;
  path: string;
  durationMs: number;
}

/** Synthesize a narration clip via the TTS service. Returns the WAV file path. */
async function synthesize(ttsUrl: string, text: string, outPath: string, voice = TTS_VOICE): Promise<number> {
  const res = await fetch(`${ttsUrl}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });

  if (!res.ok) {
    throw new Error(`TTS synthesis failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { audioBase64: string; durationMs: number };
  const wavBuffer = Buffer.from(data.audioBase64, 'base64');
  writeFileSync(outPath, wavBuffer);
  return data.durationMs;
}

/** Pre-generate all narration clips. Returns a map of key -> AudioClip. */
async function generateNarrationClips(ttsUrl: string, audioDir: string): Promise<Map<string, AudioClip>> {
  const clips = new Map<string, AudioClip>();

  console.log('[tts] Generating narration audio clips...');
  for (const [key, text] of Object.entries(NARRATIONS)) {
    const path = join(audioDir, `${key}.wav`);
    try {
      const durationMs = await synthesize(ttsUrl, text, path);
      clips.set(key, { key, path, durationMs });
      console.log(`[tts]   ${key}: ${(durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      console.warn(`[tts]   ${key}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`[tts] Generated ${clips.size}/${Object.keys(NARRATIONS).length} clips`);
  return clips;
}

/** Track when each narration plays during the recording. */
class TimestampTracker {
  private recordingStartMs = 0;
  private entries: Array<{ key: string; offsetMs: number }> = [];

  start(): void {
    this.recordingStartMs = Date.now();
  }

  mark(key: string): void {
    this.entries.push({ key, offsetMs: Date.now() - this.recordingStartMs });
  }

  getEntries(): Array<{ key: string; offsetMs: number }> {
    return this.entries;
  }
}

/**
 * Compute how long to hold a caption. When TTS audio is available, the hold
 * time is the audio duration + padding so the video stays in sync with speech.
 * Falls back to `defaultMs` when no audio clip exists for the key.
 */
function holdTime(clips: Map<string, AudioClip>, key: string, defaultMs: number, paddingMs = 500): number {
  const clip = clips.get(key);
  if (!clip) return defaultMs;
  return Math.max(defaultMs, clip.durationMs + paddingMs);
}

/** Merge audio clips into a video at specified timestamps using ffmpeg. */
async function mergeAudioIntoVideo(
  videoPath: string,
  outputPath: string,
  clips: Map<string, AudioClip>,
  timestamps: Array<{ key: string; offsetMs: number }>,
): Promise<void> {
  // Filter to clips that exist and have timestamps
  const validEntries = timestamps.filter((t) => clips.has(t.key));
  if (validEntries.length === 0) {
    console.log('[ffmpeg] No audio clips to merge — copying video as-is');
    const { copyFileSync } = await import('node:fs');
    copyFileSync(videoPath, outputPath);
    return;
  }

  // Build ffmpeg command with adelay filters
  // Input 0: video, Inputs 1..N: audio clips
  const args: string[] = ['-y', '-i', videoPath];

  for (const entry of validEntries) {
    args.push('-i', clips.get(entry.key)!.path);
  }

  // Build filter_complex: delay each audio clip and mix them
  const filterParts: string[] = [];
  const mixInputs: string[] = [];

  for (let i = 0; i < validEntries.length; i++) {
    const inputIdx = i + 1; // 0 is video
    const delayMs = Math.max(0, Math.round(validEntries[i].offsetMs));
    filterParts.push(
      `[${inputIdx}:a]silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB,adelay=${delayMs}|${delayMs}[a${i}]`,
    );
    mixInputs.push(`[a${i}]`);
  }

  filterParts.push(`${mixInputs.join('')}amix=inputs=${validEntries.length}:duration=longest:normalize=0[aout]`);

  args.push(
    '-filter_complex', filterParts.join(';'),
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'libopus',
    '-shortest',
    outputPath,
  );

  console.log(`[ffmpeg] Merging ${validEntries.length} audio clips into video...`);

  try {
    await execFileAsync('ffmpeg', args, { timeout: 60_000 });
    console.log(`[ffmpeg] Output saved: ${outputPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ffmpeg merge failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Main recording flow — 7 acts
// ---------------------------------------------------------------------------

async function record() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // --- Preflight: verify color-emoji font + Chromium can render it.
  // Fails fast with an actionable message so we never spin up TTS Docker
  // and Playwright just to produce a video full of tofu boxes.
  console.log('[preflight] Verifying color-emoji rendering...');
  await preflight();
  console.log('[preflight] OK — emoji renders as a colored glyph.');

  // --- TTS setup (optional) ---
  let ttsManager: TTSManager | null = null;
  let ttsUrl = TTS_URL;
  let audioClips = new Map<string, AudioClip>();
  const audioDir = mkdtempSync(join(tmpdir(), 'kookr-demo-audio-'));
  const tracker = new TimestampTracker();

  if (!ttsUrl && process.env.KOOKR_TTS === 'true') {
    // Auto-start TTS Docker container
    console.log('[tts] Starting TTS service...');
    try {
      ttsManager = await startTTS({
        ttsDir: join(__dirname, '..', 'tts'),
        port: parseInt(process.env.KOOKR_TTS_PORT ?? '8004', 10),
        voice: TTS_VOICE,
      });
      ttsUrl = ttsManager.url;
    } catch (err) {
      console.warn(`[tts] TTS startup failed: ${err instanceof Error ? err.message : String(err)}`);
      console.warn('[tts] Recording without narration audio');
    }
  }

  if (ttsUrl) {
    audioClips = await generateNarrationClips(ttsUrl, audioDir);
  } else {
    console.log('[tts] No TTS URL — recording silent video. Set KOOKR_TTS_URL or KOOKR_TTS=true for narration.');
  }

  // --- Server + browser setup ---
  console.log('Starting demo server...');
  const server = await startServer();

  console.log('Launching browser with video recording...');
  const browser = await chromium.launch();

  // Use a temp dir for Playwright's video, then move the final file
  const videoTmpDir = mkdtempSync(join(tmpdir(), 'kookr-demo-video-'));

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    recordVideo: { dir: videoTmpDir, size: VIEWPORT },
  });
  await context.addInitScript(() => {
    window.localStorage.setItem('kookr:onboarding:seen-v1', 'true');
    // Hide the dashboard at startup so the recording shows a clean dark
    // frame until the imperative intro overlay is mounted. The intro overlay
    // sets its own visibility:visible and overrides this.
    const style = document.createElement('style');
    style.id = 'demo-startup-curtain';
    style.textContent = `
      html, body { background: #0b0d12 !important; }
      body > *:not(#demo-intro-logo):not(style):not(script) { visibility: hidden !important; }
    `;
    document.documentElement.appendChild(style);
  });

  // Serve the animated Kookr logo from the repo to the recorded page. Used
  // by the intro screen and the closing card. Keeps the asset out of the
  // frontend bundle while letting the <video> element load it normally.
  const logoPath = resolve(__dirname, '..', 'assets', 'branding', 'kookr-ai-logo-animated.mp4');
  await context.route('**/demo-assets/kookr-logo.mp4', async (route) => {
    await route.fulfill({ path: logoPath, contentType: 'video/mp4' });
  });

  const page = await context.newPage();
  const request = context.request;

  try {
    // Reset and navigate
    await resetServer(context);
    tracker.start();
    await page.goto(BASE);
    await page.locator('.logo').waitFor({ state: 'visible' });

    // Mount the intro logo overlay IMMEDIATELY after navigation so the rest
    // of the setup (seeding agents, injecting indicators) happens behind it.
    // The addInitScript curtain has been hiding the dashboard since first
    // paint, so the recording never shows the dashboard before this overlay.
    await showIntroLogoScreen(page);
    await showCaption(page, NARRATIONS.intro_logo);
    const introLogoStartedAt = Date.now();
    tracker.mark('intro_logo');

    // Seed project configs so the sidebar appears
    await seedProjectConfigs(request);

    // Inject click ripple and keystroke badge visual indicators
    await injectInteractionIndicators(page);

    console.log('Recording started. Running demo scenario...');

    // =====================================================================
    // PRE-SEED: launch 5 agents directly via API (no UI ceremony).
    // The cold-open grid in Act 0 covers any race, so this can run fast.
    // Agent #4 is set to agentType='codex-cli' so the provider badge shows
    // Codex CLI alongside Claude agents.
    // =====================================================================
    const taskId1 = await seedAgent(request, {
      prompt: 'Fix JWT token refresh in auth.ts',
      cwd: '/home/dev/webapp',
      projectId: 'acme/webapp',
    });
    const taskId2 = await seedAgent(request, {
      prompt: 'Add pagination to /users endpoint',
      cwd: '/home/dev/api',
      projectId: 'acme/api-service',
    });
    const taskId3 = await seedAgent(request, {
      prompt: 'Implement login redirect fix (#87)',
      cwd: '/home/dev/webapp',
      projectId: 'acme/webapp',
    });
    const taskId4 = await seedAgent(request, {
      prompt: 'Add rate limiting to pagination endpoint',
      cwd: '/home/dev/api',
      projectId: 'acme/api-service',
      agentType: 'codex-cli',
    });
    const taskId5 = await seedAgent(request, {
      prompt: 'Refactor auth middleware to async/await',
      cwd: '/home/dev/webapp',
      projectId: 'acme/webapp',
    });

    // Map taskId -> tmux name (order matches launch order)
    const tasksRes = await request.get(`${BASE}/api/tasks`);
    const allTasks = (await tasksRes.json()) as Array<{ id: string; sessions: Array<{ tmuxSession: string }> }>;
    const tmuxByTaskId = new Map(allTasks.map(t => [t.id, t.sessions[0]?.tmuxSession ?? '']));
    const tmux1 = tmuxByTaskId.get(taskId1) ?? '';
    const tmux2 = tmuxByTaskId.get(taskId2) ?? '';
    const tmux3 = tmuxByTaskId.get(taskId3) ?? '';
    const tmux4 = tmuxByTaskId.get(taskId4) ?? '';
    const tmux5 = tmuxByTaskId.get(taskId5) ?? '';

    // Stream terminal content for visual life
    await setTerminalContent(request, tmux1, jwtFixContent(), { mode: 'instant' });
    await setTerminalContent(request, tmux2, paginationContent(), { mode: 'streaming', lineDelayMs: 380, loop: false });
    await setTerminalContent(request, tmux3, cacheRefactorContent(), { mode: 'instant' });
    await setTerminalContent(request, tmux4, rateLimitContent(), { mode: 'instant' });
    await setTerminalContent(request, tmux5, authRefactorContent(), { mode: 'instant' });

    // Mark all as running with PreToolUse
    await injectSessionStart(request, tmux1, '/home/dev/webapp');
    await injectSessionStart(request, tmux2, '/home/dev/api');
    await injectSessionStart(request, tmux3, '/home/dev/webapp');
    await injectSessionStart(request, tmux4, '/home/dev/api');
    await injectSessionStart(request, tmux5, '/home/dev/webapp');
    await injectToolUse(request, tmux1, 'Read');
    await injectToolUse(request, tmux2, 'Edit');
    await injectToolUse(request, tmux3, 'Grep');
    await injectToolUse(request, tmux4, 'Read');
    await injectToolUse(request, tmux5, 'Edit');

    await broadcastProjectSummaries(request);

    // Seed realistic cost data for top-bar
    await request.post(`${BASE}/api/test/set-spend`, {
      data: {
        lifetimeSpendUsd: 1.47,
        tasks: [
          { taskId: taskId1, costUsd: 0.18, inputTokens: 12400, outputTokens: 3200 },
          { taskId: taskId2, costUsd: 0.42, inputTokens: 28000, outputTokens: 6100 },
          { taskId: taskId3, costUsd: 0.15, inputTokens: 9800, outputTokens: 2400 },
          { taskId: taskId4, costUsd: 0.31, inputTokens: 21000, outputTokens: 4500 },
          { taskId: taskId5, costUsd: 0.41, inputTokens: 27000, outputTokens: 5800 },
        ],
      },
    });
    await page.waitForTimeout(800);

    // =====================================================================
    // ACT 0 — Intro logo + cold open + hook (0:00–~0:18)
    // =====================================================================
    // Intro logo is already mounted (above, right after page.goto). Hold until
    // the intro narration has finished; setup work happens behind the logo.
    const introLogoHoldMs = holdTime(audioClips, 'intro_logo', 5500, 700);
    await page.waitForTimeout(Math.max(0, introLogoHoldMs - (Date.now() - introLogoStartedAt)));

    // Prepare the cold-open grid BEHIND the intro screen, then fade the
    // intro out so the grid is revealed without flashing the dashboard.
    await showColdOpenGrid(page);
    await hideIntroLogoScreen(page, 700);
    await page.waitForTimeout(400);

    // Render caption FIRST, then mark so audio fires when visuals are
    // already on screen (avoids 200ms of audio over an empty frame).
    await showCaption(page, NARRATIONS.cold_open);
    tracker.mark('cold_open');
    await page.waitForTimeout(holdTime(audioClips, 'cold_open', 3500));
    await hideCaption(page);
    await fadeOutColdOpenGrid(page, 500);
    await page.waitForTimeout(1200);

    await showCaption(page, NARRATIONS.hook);
    tracker.mark('hook');
    await page.waitForTimeout(holdTime(audioClips, 'hook', 5200));
    await hideCaption(page);
    await page.waitForTimeout(500);

    // =====================================================================
    // ACT 1 — Multi-project, multi-provider landscape (0:11–0:38)
    // =====================================================================
    const webappChip = page.getByTestId('project-icon-acme/webapp');
    const apiChip = page.getByTestId('project-icon-acme/api-service');
    const allProjectsChip = page.getByTestId('project-icon-all');

    await webappChip.waitFor({ state: 'visible', timeout: 5000 });
    await apiChip.waitFor({ state: 'visible', timeout: 5000 });
    await allProjectsChip.waitFor({ state: 'visible', timeout: 5000 });

    await showCaption(page, NARRATIONS.projects_webapp);
    tracker.mark('projects_webapp');
    await webappChip.hover();
    await page.waitForTimeout(700);
    await webappChip.click();
    await page.waitForTimeout(Math.max(0, holdTime(audioClips, 'projects_webapp', 6500) - 700));

    await showCaption(page, NARRATIONS.projects_api);
    tracker.mark('projects_api');
    await apiChip.hover();
    await page.waitForTimeout(500);
    await apiChip.click();
    await page.waitForTimeout(Math.max(0, holdTime(audioClips, 'projects_api', 6000) - 500));

    await showCaption(page, NARRATIONS.projects_all);
    tracker.mark('projects_all');
    await allProjectsChip.hover();
    await page.waitForTimeout(500);
    await allProjectsChip.click();
    await page.waitForTimeout(Math.max(0, holdTime(audioClips, 'projects_all', 5200) - 500));
    await hideCaption(page);
    await page.waitForTimeout(400);

    await showCaption(page, NARRATIONS.providers_mixed);
    tracker.mark('providers_mixed');
    await page.waitForTimeout(holdTime(audioClips, 'providers_mixed', 5600));
    await hideCaption(page);
    await page.waitForTimeout(500);
    // Codex CLI fork detail intentionally deferred to the closing card —
    // it's an implementation detail, not a headline feature.

    // =====================================================================
    // ACT 2 — Anomaly detection in action (0:38–0:58)
    // =====================================================================
    // Inject the permission event + wait for the card to render BEFORE
    // marking, so the audio "Permission blocked on the webapp agent..."
    // fires when the permission card is already visible.
    await injectPermissionEvent(request, tmux1, 'Bash', 'npm test --coverage');
    await page.locator('.finding-card').filter({ hasText: 'Fix JWT token refresh in auth.ts' }).first().waitFor({ state: 'visible', timeout: 5000 });
    await showInferenceStamp(page, 'rule F2.4 · PermissionRequest → severity=warning', 700);
    await showCaption(page, NARRATIONS.permission_block);
    tracker.mark('permission_block');
    await page.waitForTimeout(holdTime(audioClips, 'permission_block', 5600));
    await hideCaption(page);
    await page.waitForTimeout(300);

    await selectFindingByText(page, 'Fix JWT token refresh in auth.ts');
    await page.waitForTimeout(800);

    await broadcastSuggestion(request, tmux1, [], [
      { label: 'Allow', value: 'yes', shortcut: '1' },
      { label: 'Deny', value: 'no', shortcut: '2' },
    ]);
    await page.waitForTimeout(800);

    await showCaption(page, NARRATIONS.permission_allow);
    tracker.mark('permission_allow');
    const permissionAllowTotal = holdTime(audioClips, 'permission_allow', 6200);
    const permissionAllowStartedAt = Date.now();
    await page.waitForTimeout(3200);
    await showKeystroke(page, '1');
    await page.locator('.btn-quick-action', { hasText: 'Allow' }).click();
    await page.locator('.sent-overlay').waitFor({ state: 'visible', timeout: 3000 });
    await page.waitForTimeout(900);
    await page.waitForTimeout(Math.max(0, permissionAllowTotal - (Date.now() - permissionAllowStartedAt)));
    await hideCaption(page);
    await page.waitForTimeout(400);

    // =====================================================================
    // ACT 3 — Cross-project triage (0:58–1:30)
    // =====================================================================
    await injectStopEvent(
      request,
      tmux4,
      'Rate-limit storage choice needed before I wire the middleware. Constraints: single local instance today, low traffic, but likely multi-instance later. Should I ship in-memory TTL now with a Redis storage interface, or add Redis immediately?',
    );
    await setTerminalContent(request, tmux3, mergeConflictContent(), { mode: 'instant' });
    await injectStopEvent(
      request,
      tmux3,
      "I hit a merge conflict in src/auth.ts. The local branch sets JWT expiry to 1h but main has 24h. Which should I keep?",
    );
    await page.waitForTimeout(900);

    await showCaption(page, NARRATIONS.two_alerts);
    tracker.mark('two_alerts');
    await page.waitForTimeout(holdTime(audioClips, 'two_alerts', 5600));
    await hideCaption(page);
    await page.waitForTimeout(300);

    await selectFindingByText(page, 'Add rate limiting to pagination endpoint');
    await page.waitForTimeout(800);

    await broadcastSuggestion(request, tmux4, [
      'Use in-memory TTL for this PR. Add the storage interface now so Redis can replace it when we deploy multiple instances.',
      'Use Redis immediately if this service will run more than one instance in the next sprint.',
      'Ship in-memory TTL behind a config flag and add a follow-up issue for Redis before horizontal scaling.',
    ], [
      {
        label: 'In-memory TTL + adapter',
        value: 'Use in-memory TTL for this PR. Please keep the storage boundary explicit so Redis can replace it before multi-instance deploys.',
        shortcut: '1',
      },
      {
        label: 'Redis now',
        value: 'Use Redis now if this service will run multiple instances in the next sprint; otherwise keep the PR smaller with in-memory TTL.',
        shortcut: '2',
      },
    ]);
    await page.waitForTimeout(1200);

    await showCaption(page, NARRATIONS.ai_suggest);
    tracker.mark('ai_suggest');
    const aiSuggestTotal = holdTime(audioClips, 'ai_suggest', 8800);
    await page.waitForTimeout(aiSuggestTotal);
    const aiBtn = page.locator('.btn-quick-action.ai-suggestion').first();
    await aiBtn.waitFor({ state: 'visible', timeout: 5000 });
    await aiBtn.click();
    await page.locator('.sent-overlay').waitFor({ state: 'visible', timeout: 3000 });
    await hideCaption(page);
    await page.waitForTimeout(300);

    // Re-surface the merge conflict for snoozing
    await injectStopEvent(
      request,
      tmux3,
      "I hit a merge conflict in src/auth.ts. The local branch sets JWT expiry to 1h but main has 24h. Which should I keep?",
    );
    await page.waitForTimeout(600);
    await broadcastSuggestion(request, tmux3, [], []);
    await broadcastSuggestion(request, tmux4, [], []);

    await selectFindingByText(page, 'Implement login redirect fix (#87)');
    await page.waitForTimeout(1200);

    await showCaption(page, NARRATIONS.snooze_other);
    tracker.mark('snooze_other');
    const snoozeTotal = holdTime(audioClips, 'snooze_other', 7600);
    const snoozeStartedAt = Date.now();
    await page.waitForTimeout(2200);
    await showKeystroke(page, 'Alt+S');
    await page.keyboard.press('Alt+s');
    const snoozeDialog = page.locator('.snooze-dialog');
    await snoozeDialog.waitFor({ state: 'visible', timeout: 3000 });
    if (await snoozeDialog.isVisible()) {
      await page.waitForTimeout(2200);
      await showKeystroke(page, '2  (1h)');
      await page.keyboard.press('2');
      await page.waitForTimeout(900);
    }
    await showTimeReclaimedBadge(page, 1800);
    await page.waitForTimeout(Math.max(0, snoozeTotal - (Date.now() - snoozeStartedAt)));
    await hideCaption(page);
    await page.waitForTimeout(400);

    await page.screenshot({ path: join(OUTPUT_DIR, 'kookr-demo-screenshot.png') });

    // =====================================================================
    // ACT 4 — GitHub awareness (1:30–1:53)
    // =====================================================================
    const paginationRow = page.locator('.healthy-row').filter({ hasText: 'Add pagination to /users endpoint' }).first();
    await paginationRow.waitFor({ state: 'visible', timeout: 5000 });
    await paginationRow.click();
    await page.waitForTimeout(1500);

    await request.post(`${BASE}/api/test/broadcast-github`, {
      data: {
        taskId: taskId2,
        prs: [{
          ref: {
            type: 'pr',
            owner: 'acme',
            repo: 'api-service',
            number: 142,
            url: 'https://github.com/acme/api-service/pull/142',
            detectedAt: new Date().toISOString(),
            detectedFrom: tmux2,
            taskId: taskId2,
          },
          title: 'feat: add pagination to /users endpoint',
          status: 'open',
          author: 'claude-agent',
          branch: 'feat/pagination',
          baseBranch: 'main',
          reviewDecision: 'changes_requested',
          reviewers: [{ login: 'alice', state: 'changes_requested' }],
          unresolvedThreads: [{
            id: 'thread-1',
            isResolved: false,
            author: 'alice',
            body: 'Needs an index on the cursor column for performance.',
            path: 'src/routes/users.ts',
            line: 87,
            createdAt: new Date().toISOString(),
          }],
          totalComments: 3,
          checks: [
            { name: 'CI / build', status: 'completed', conclusion: 'success' },
            { name: 'CI / lint', status: 'completed', conclusion: 'failure' },
          ],
          lastFetchedAt: new Date().toISOString(),
        }],
        issues: [],
        changes: [],
      },
    });

    const githubTab = page.locator('.pane-tab').filter({ hasText: 'GitHub' });
    await githubTab.waitFor({ state: 'visible', timeout: 5000 });
    await githubTab.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUTPUT_DIR, 'kookr-demo-triage.png') });

    await showCaption(page, NARRATIONS.pr_opened);
    tracker.mark('pr_opened');
    await page.waitForTimeout(holdTime(audioClips, 'pr_opened', 7600));
    await hideCaption(page);

    await request.post(`${BASE}/api/test/broadcast-alert`, {
      data: {
        agentId: tmux2,
        summary: 'PR acme/api-service#142: CI check "lint" failed',
        severity: 'warning',
      },
    });
    await page.waitForTimeout(1000);

    await showCaption(page, NARRATIONS.ci_failed);
    tracker.mark('ci_failed');
    await page.waitForTimeout(holdTime(audioClips, 'ci_failed', 6400));
    await hideCaption(page);
    await page.waitForTimeout(400);

    // =====================================================================
    // ACT 5 — Completion + cost + supervision avoided (1:53–2:18)
    // =====================================================================
    await completeTaskWithDigest(request, taskId5, {
      bullets: [
        'Refactored auth middleware to async/await pattern',
        'Added typed AuthError and TokenExpiredError classes',
        'Updated 3 test files — all 28 tests passing',
      ],
      filesChanged: ['middleware.ts (+18 −2)', 'types.ts (+12 −0)', 'middleware.test.ts (+42 −0)', 'types.test.ts (+18 −0)'],
      testSummary: '28 passed, 0 failed',
    });
    await page.waitForTimeout(800);

    const completedRow = page.locator('.completed-row').filter({ hasText: 'Refactor auth middleware to async/await' }).first();
    if (!(await completedRow.isVisible({ timeout: 1000 }).catch(() => false))) {
      const completedHeader = page.locator('.section-header').filter({ hasText: 'Completed' }).first();
      await completedHeader.waitFor({ state: 'visible', timeout: 5000 });
      await completedHeader.click();
      await page.waitForTimeout(400);
    }
    await selectCompletedRowByText(page, 'Refactor auth middleware to async/await');
    await page.waitForTimeout(1200);

    await showCaption(page, NARRATIONS.agent_done);
    tracker.mark('agent_done');
    await page.waitForTimeout(holdTime(audioClips, 'agent_done', 7000));
    await hideCaption(page);

    await showSupervisionAvoidedOverlay(page, '8m 12s', 16, 8);
    await showCaption(page, NARRATIONS.time_saved);
    tracker.mark('time_saved');
    await page.waitForTimeout(holdTime(audioClips, 'time_saved', 5200));
    await hideCaption(page);
    await clearSupervisionAvoidedOverlay(page);
    await page.waitForTimeout(400);

    // =====================================================================
    // ACT 6 — Closing card (2:18–2:33)
    // =====================================================================
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(800);
    await showClosingCard(page);
    await page.waitForTimeout(800);

    await showCaption(page, NARRATIONS.closing);
    tracker.mark('closing');
    await page.waitForTimeout(holdTime(audioClips, 'closing', 6200));
    await hideCaption(page);
    await page.waitForTimeout(400);

    await showCaption(page, NARRATIONS.repo_url);
    tracker.mark('repo_url');
    await page.waitForTimeout(holdTime(audioClips, 'repo_url', 6000));
    await hideCaption(page);
    await hideClosingCard(page);
    await page.waitForTimeout(700);

    console.log('Scenario complete. Saving video...');
  } finally {
    // Close context to finalize video
    const videoPage = page.video();
    await context.close();

    // Move the video to output directory
    const silentPath = join(OUTPUT_DIR, audioClips.size > 0 ? 'kookr-demo-silent.webm' : 'kookr-demo.webm');
    if (videoPage) {
      await videoPage.saveAs(silentPath);
      console.log(`Video saved: ${silentPath}`);
    }
    await browser.close();

    // Merge audio if we have clips
    const finalPath = join(OUTPUT_DIR, 'kookr-demo.webm');
    if (audioClips.size > 0 && existsSync(silentPath)) {
      try {
        await mergeAudioIntoVideo(silentPath, finalPath, audioClips, tracker.getEntries());
        // Remove the silent intermediate file
        try { rmSync(silentPath); } catch { /* ignore */ }
      } catch (err) {
        console.warn(`[ffmpeg] Audio merge failed: ${err instanceof Error ? err.message : String(err)}`);
        console.warn('[ffmpeg] Silent video preserved at:', silentPath);
        // Rename silent to final so there's always an output
        try { renameSync(silentPath, finalPath); } catch { /* ignore */ }
      }
    }

    // 4K H.264 upscale for LinkedIn release asset
    if (existsSync(finalPath)) {
      const k4Path = join(OUTPUT_DIR, 'kookr-demo-4k.mp4');
      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-y', '-i', finalPath,
            '-vf', 'scale=3840:2160:flags=lanczos',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
            // Re-encode audio to AAC (not libopus → libopus): in ffmpeg 4.4,
            // double-opus encoding silently truncated the trailing ~10s of
            // narration on this pipeline. AAC also has better LinkedIn/X
            // compatibility for the mp4 container.
            '-c:a', 'aac', '-b:a', '192k',
            k4Path,
          ],
          { timeout: 600_000 },
        );
        console.log(`[ffmpeg] 4K upscale saved: ${k4Path}`);
      } catch (err) {
        console.warn(`[ffmpeg] 4K upscale failed: ${err instanceof Error ? err.message : String(err)}`);
        console.warn('[ffmpeg] 1080p output preserved at:', finalPath);
      }
    }

    // Cleanup temp dirs
    try { rmSync(videoTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(audioDir, { recursive: true, force: true }); } catch { /* ignore */ }

    // Stop TTS container if we started it
    if (ttsManager) {
      await ttsManager.stop();
    }

    // Kill server
    server.kill('SIGTERM');
    console.log('Done.');
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
record().catch((err) => {
  console.error('Demo recording failed:', err);
  process.exit(1);
});
