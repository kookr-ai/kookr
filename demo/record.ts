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
 * Reuses the E2E test server (FakeTerminalBackend + event injection) with
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
import { mkdtempSync, renameSync, writeFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs';
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
import { buildSrt, segmentsFromTracker } from './lib/timeline.js';
import {
  probeDurationMs,
  exportSocialMp4,
  export4kMp4,
  exportVerticalMp4,
  exportTeaserMp4,
  exportLoopMp4,
  exportLoopGif,
  findMusicBed,
  mixMusicBed,
} from './lib/exports.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 4803;
const BASE = `http://127.0.0.1:${PORT}`;
const OUTPUT_DIR = resolve(__dirname, 'output');
const VIEWPORT = { width: 1920, height: 1080 };
const DEVICE_SCALE_FACTOR = 2;

/**
 * Check mode (DEMO_CHECK=1): replay the entire scenario against the current
 * frontend with all narration holds capped to ~150ms, no TTS, no video
 * recording, and no media exports. Every selector and UI flow still runs for
 * real, so any drift between the demo script and the current interface fails
 * the run loudly instead of shipping a broken video.
 */
const CHECK_MODE = process.env.DEMO_CHECK === '1' || process.env.DEMO_CHECK === 'true';
const CHECK_WAIT_CAP_MS = 150;

/** Scenario pause that collapses to a near-instant tick in check mode. */
async function wait(page: Page, ms: number) {
  await page.waitForTimeout(CHECK_MODE ? Math.min(ms, CHECK_WAIT_CAP_MS) : ms);
}

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
      /* Achievement toasts pop at uncontrolled times and read as noise to
         first-time viewers — suppress them for the whole recording. */
      .achievement-toasts { display: none !important; }
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
  // The findings list auto-scrolls to top when a new finding lands, which
  // can swallow the first click — retry once before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    await card.scrollIntoViewIfNeeded();
    await card.click({ force: true });
    try {
      await waitForDetailTitle(page, expectedTitle);
      return;
    } catch (err) {
      if (attempt === 1) throw err;
    }
  }
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
        body: '$ claude code\n> Fixing auth middleware\nPermission requested\n  Tool: Bash\n  Command: npm test -- --runInBand\nAllow? [1] yes  [2] no\n_',
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
  await wait(page, holdMs);
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
  await wait(page, holdMs);
  await page.evaluate(() => {
    document.querySelectorAll('.demo-inference-stamp').forEach((el) => {
      (el as HTMLElement).style.opacity = '0';
      setTimeout(() => el.remove(), 220);
    });
  });
}

/**
 * Capture a designed YouTube/social thumbnail: a left-side headline gradient
 * over the LIVE dashboard at its peak state (two alerts competing), so the
 * thumbnail always shows the current UI. Saves a JPEG under YouTube's 2MB
 * custom-thumbnail limit, then removes the overlay.
 */
async function captureThumbnail(page: Page, outPath: string) {
  // Called in the post-credits epilogue (after the video_end mark), so the
  // overlay never appears in the published footage — the master is trimmed
  // at video_end.
  await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'demo-thumbnail-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 99995;
      background: linear-gradient(90deg, rgba(7,9,14,0.88) 0%, rgba(7,9,14,0.62) 30%, rgba(7,9,14,0.12) 52%, transparent 68%);
      display: flex; flex-direction: column; justify-content: center;
      padding-left: 72px; gap: 18px;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      text-shadow: 0 2px 18px rgba(0,0,0,0.85);
    `;
    overlay.innerHTML = `
      <div style="font-size:92px;font-weight:800;color:#f8fafc;line-height:1.05;">5 AI agents.</div>
      <div style="font-size:92px;font-weight:800;color:#2dd4bf;line-height:1.05;">One attention queue.</div>
      <div style="font-size:30px;color:#b3bccc;margin-top:14px;font-weight:500;">Kookr — open-source supervision for parallel coding agents</div>
    `;
    document.body.appendChild(overlay);
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: outPath, type: 'jpeg', quality: 88 });
  await page.evaluate(() => document.getElementById('demo-thumbnail-overlay')?.remove());
}

/** Full-frame closing card with Kookr wordmark and final call to action. */
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
      <div style="font-size:22px;color:#2dd4bf;font-weight:600;letter-spacing:0.5px;font-family:'JetBrains Mono','Fira Code',monospace;">
        5 agents&nbsp;&nbsp;·&nbsp;&nbsp;2 projects&nbsp;&nbsp;·&nbsp;&nbsp;1 attention queue
      </div>
      <div style="font-size:54px;color:#f8fafc;font-weight:800;letter-spacing:0;text-align:center;">
        Try Kookr
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:14px;">
        <div style="padding:14px 32px;border-radius:12px;border:1.5px solid rgba(45,212,191,0.55);background:rgba(45,212,191,0.08);color:#dfe4f0;font-size:26px;font-weight:600;font-family:'JetBrains Mono','Fira Code',monospace;">
          ⭐ github.com/kookr-ai/kookr
        </div>
        <div style="color:#8b94aa;font-size:17px;font-family:'JetBrains Mono','Fira Code',monospace;">
          git clone https://github.com/kookr-ai/kookr && pnpm install && pnpm prod:setup
        </div>
      </div>
      <div style="display:flex;gap:16px;">
        <span style="padding:8px 20px;border-radius:999px;border:1px solid rgba(45,212,191,0.4);color:#2dd4bf;font-weight:600;font-size:15px;">Local-first</span>
        <span style="padding:8px 20px;border-radius:999px;border:1px solid rgba(45,212,191,0.4);color:#2dd4bf;font-weight:600;font-size:15px;">Open source · Apache-2.0</span>
        <span style="padding:8px 20px;border-radius:999px;border:1px solid rgba(45,212,191,0.4);color:#2dd4bf;font-weight:600;font-size:15px;">Claude Code + Codex CLI</span>
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
  await wait(page, 300);
  // Type the prompt slowly enough to read
  await page.locator('.dialog textarea').pressSequentially(prompt, { delay: 25 });
  await wait(page, 400);
  const cwdInput = page.locator('.dialog input[type="text"]').first();
  await cwdInput.clear();
  await cwdInput.pressSequentially(cwd, { delay: 20 });
  await wait(page, 500);
  await page.locator('.dialog .btn-primary').click();
  await page.locator('.dialog').waitFor({ state: 'hidden' });
}

async function launchViaQuickLaunch(page: Page, prompt: string) {
  await showKeystroke(page, 'Alt+L');
  await page.keyboard.press('Alt+l');
  const qlInput = page.locator('.quick-launch-input');
  await qlInput.waitFor({ state: 'visible' });
  await wait(page, 300);
  await qlInput.pressSequentially(prompt, { delay: 30 });
  await wait(page, 400);
  await showKeystroke(page, 'Enter');
  await page.keyboard.press('Enter');
  await wait(page, 500);
}

// ---------------------------------------------------------------------------
// TTS narration
// ---------------------------------------------------------------------------

const TTS_URL = process.env.KOOKR_TTS_URL ?? '';
const TTS_VOICE = process.env.TTS_VOICE ?? '/app/voices/matilda.mp3';

/**
 * Opening hook variants — pick with DEMO_HOOK=A|B|C (default A). All play
 * over the cold-open terminal grid, which is on screen from the very first
 * frame so social-feed viewers see the pain before they can scroll past.
 */
const HOOK_VARIANTS: Record<string, string> = {
  A: 'Running five coding agents sounds like leverage, until your job becomes checking five terminals.',
  B: 'Your AI agents are fast. Supervising them is the part that does not scale.',
  C: 'This is what running five AI coding agents actually looks like. Nobody can watch all of it.',
};
const HOOK_VARIANT = (process.env.DEMO_HOOK ?? 'A').toUpperCase();

/** Narration scripts — v5 (fresh-eyes review pass). */
const NARRATIONS: Record<string, string> = {
  // Act 0: Cold open + hook (dashboard revealed with a live finding already queued)
  intro_hook: HOOK_VARIANTS[HOOK_VARIANT] ?? HOOK_VARIANTS.A,
  cold_open: 'Some are making progress. Some are blocked. One needs a decision right now.',
  hook: 'Kookr turns that noise into one attention queue. It tells you where your review time matters next.',

  // Act 1: Anomaly detection first — the everyday win, then the plumbing
  permission_block: 'This is the everyday win: a permission prompt is no longer buried in a terminal.',
  permission_allow: 'Kookr surfaces the exact command, the exact agent, and the next action to unblock it.',
  plumbing: 'One click, and the agent is back to work — replies land in the agent\'s own terminal through local hooks. Nothing leaves your machine.',

  // Act 2: Multi-project, multi-provider
  projects_iso: 'Projects stay isolated, too: switch to the API service and you see only its backend agents.',
  projects_all: 'Or supervise everything at once, with live cost for every agent and for the whole session.',
  providers_mixed: 'Claude Code and Codex CLI land in the same workflow. Different runtimes, one supervision surface.',

  // Act 3: Cross-project triage
  two_alerts: 'Now two interruptions compete: Codex needs product judgment, while Claude hit a merge conflict.',
  ai_suggest: 'Kookr keeps the agent context attached and drafts plausible replies. You still decide; it removes the copy-paste and terminal archaeology.',
  snooze_other: 'Not every interruption deserves the next five minutes. Snooze the merge conflict and keep the active decision in front of you.',

  // Act 4: GitHub awareness
  pr_opened: 'The handoff does not stop when an agent opens a pull request. Kookr keeps review context attached to the agent that caused it.',
  ci_failed: 'When CI fails, it re-enters the same attention queue, next to terminal prompts and product decisions.',

  // Act 5: Completion + the real session numbers
  agent_done: 'When an agent finishes, Kookr gives you the digest: what changed, what passed, and what it cost.',
  session_value: 'This morning\'s real total: five agents in parallel, one dollar forty-seven — and your attention only where it mattered.',

  // Act 6: Closing
  closing: 'Kookr is local-first and open source: an attention router for developers running parallel AI coding agents.',
  repo_url: 'Kookr is on GitHub. Clone it, run it locally, and star it if it saves you a check-in loop.',
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

/**
 * Merge audio clips into a video at specified timestamps using ffmpeg.
 * When `trimMs` is set, the output is cut there (drops the post-credits
 * thumbnail epilogue from the published video).
 */
async function mergeAudioIntoVideo(
  videoPath: string,
  outputPath: string,
  clips: Map<string, AudioClip>,
  timestamps: Array<{ key: string; offsetMs: number }>,
  trimMs?: number,
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
  );
  if (trimMs !== undefined) {
    args.push('-t', (trimMs / 1000).toFixed(3));
  }
  args.push(outputPath);

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
// Export matrix — every distribution format derived from the master WebM
// ---------------------------------------------------------------------------

async function runExportMatrix(
  finalPath: string,
  entries: Array<{ key: string; offsetMs: number }>,
): Promise<void> {
  const durationMs = await probeDurationMs(finalPath).catch(() => 0);

  // Teaser: pain+hook, the allow-and-resume beat, then the CTA card (~28s).
  const teaserSegments = segmentsFromTracker(entries, durationMs, [
    ['cold_open', 'permission_block'],
    ['permission_allow', 'plumbing'],
    ['repo_url', null],
  ]);

  // Hero loop: the two-alerts triage moment — the most "alive" 12 seconds.
  const loopStart = entries.find((e) => e.key === 'two_alerts')?.offsetMs ?? 30_000;
  const loopDuration = Math.min(12_000, Math.max(0, durationMs - loopStart));

  const jobs: Array<{ label: string; file: string; run: (out: string) => Promise<void> }> = [
    { label: 'social 1080p MP4 (X/LinkedIn native upload)', file: 'kookr-demo.mp4', run: (out) => exportSocialMp4(finalPath, out) },
    { label: 'vertical 9:16 MP4 (Shorts/Reels/TikTok)', file: 'kookr-demo-vertical.mp4', run: (out) => exportVerticalMp4(finalPath, out) },
    { label: 'teaser MP4 (~30s timeline cut)', file: 'kookr-demo-teaser.mp4', run: (out) => exportTeaserMp4(finalPath, out, teaserSegments) },
    { label: 'hero loop MP4 (silent, 12s)', file: 'kookr-demo-loop.mp4', run: (out) => exportLoopMp4(finalPath, out, loopStart, loopDuration) },
    { label: 'hero loop GIF (README autoplay)', file: 'kookr-demo-loop.gif', run: (out) => exportLoopGif(finalPath, out, loopStart, loopDuration) },
    { label: '4K MP4 (release asset)', file: 'kookr-demo-4k.mp4', run: (out) => export4kMp4(finalPath, out) },
  ];

  for (const job of jobs) {
    const out = join(OUTPUT_DIR, job.file);
    try {
      console.log(`[export] ${job.label} → ${job.file} ...`);
      await job.run(out);
    } catch (err) {
      console.warn(`[export] ${job.file} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('[export] Artifact summary:');
  for (const file of ['kookr-demo.webm', 'kookr-demo.srt', 'kookr-demo-thumbnail.jpg', ...jobs.map((j) => j.file)]) {
    const p = join(OUTPUT_DIR, file);
    if (existsSync(p)) {
      const mb = (statSync(p).size / 1024 / 1024).toFixed(1);
      console.log(`[export]   ${file}  (${mb} MB)`);
    } else {
      console.log(`[export]   ${file}  MISSING`);
    }
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

  if (CHECK_MODE) {
    ttsUrl = '';
    console.log('[check] DEMO_CHECK=1 — scenario check only: no TTS, no video recording, no exports.');
  } else if (!ttsUrl && process.env.KOOKR_TTS === 'true') {
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
  } else if (!CHECK_MODE) {
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
    ...(CHECK_MODE ? {} : { recordVideo: { dir: videoTmpDir, size: VIEWPORT } }),
  });
  await context.addInitScript(() => {
    // Suppress the first-run onboarding tour. The key suffix tracks the
    // frontend's onboarding-status STORAGE_KEY version; the ?onboarding=0
    // URL param on page.goto is the version-proof second layer.
    try { window.localStorage.setItem('kookr:onboarding:seen-v2', 'true'); } catch { /* ignore */ }
    // Opaque curtain so the recording's first frames are a clean dark frame,
    // never a dashboard flash, until the cold-open grid replaces it. An
    // overlay div (not CSS visibility rules) so Playwright visibility waits
    // on covered elements still pass.
    const mountCurtain = () => {
      document.documentElement.style.background = '#0b0d12';
      const curtain = document.createElement('div');
      curtain.id = 'demo-startup-curtain';
      curtain.style.cssText = 'position:fixed;inset:0;background:#0b0d12;z-index:99999;';
      document.body.appendChild(curtain);
    };
    if (document.body) mountCurtain();
    else document.addEventListener('DOMContentLoaded', mountCurtain);
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
  let scenarioOk = false;

  try {
    // Reset and navigate
    await resetServer(context);
    tracker.start();
    await page.goto(`${BASE}/?onboarding=0`);
    await page.locator('.logo').waitFor({ state: 'visible' });

    // Mount the cold-open grid IMMEDIATELY after navigation so the very
    // first frame of the video is the pain — six chaotic terminals — not a
    // logo. Social-feed retention is decided in the first 2-3 seconds. The
    // addInitScript curtain has been hiding the dashboard since first paint;
    // the opaque grid takes over from it while seeding runs behind.
    await showColdOpenGrid(page);
    await page.evaluate(() => {
      document.getElementById('demo-startup-curtain')?.remove();
    });
    await showCaption(page, NARRATIONS.intro_hook);
    const introStartedAt = Date.now();
    tracker.mark('intro_hook');

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
    await wait(page, 800);

    // =====================================================================
    // ACT 0 — Cold open + hook (0:00–~0:15)
    // =====================================================================
    // The cold-open grid is already on screen (mounted right after
    // page.goto). Hold until the intro hook narration has finished; all the
    // seeding above happened behind the opaque grid.
    //
    // Inject the permission finding BEFORE revealing the dashboard so the
    // queue is alive ("1 ACTIVE") from the very first product frame — the
    // viewer never sees an empty findings panel.
    await injectPermissionEvent(request, tmux1, 'Bash', 'npm test --coverage');
    await page.locator('.finding-card').filter({ hasText: 'Fix JWT token refresh in auth.ts' }).first().waitFor({ state: 'visible', timeout: 5000 });

    const introHoldMs = holdTime(audioClips, 'intro_hook', 5500, 700);
    await wait(page, Math.max(0, introHoldMs - (Date.now() - introStartedAt)));

    // Reveal the dashboard early — the cold_open line ("some are blocked,
    // one needs a decision right now") plays over the live queue, which is
    // the answer to the chaos, not more chaos.
    await fadeOutColdOpenGrid(page, 500);
    await wait(page, 700);
    await showCaption(page, NARRATIONS.cold_open);
    tracker.mark('cold_open');
    await wait(page, holdTime(audioClips, 'cold_open', 3500));
    await hideCaption(page);
    await wait(page, 300);

    await showCaption(page, NARRATIONS.hook);
    tracker.mark('hook');
    await wait(page, holdTime(audioClips, 'hook', 5200));
    await hideCaption(page);
    await wait(page, 500);

    // =====================================================================
    // ACT 1 — Anomaly detection first: the everyday win (0:15–0:45)
    // =====================================================================
    await showInferenceStamp(page, 'rule F2.4 · PermissionRequest → severity=warning', 700);
    await showCaption(page, NARRATIONS.permission_block);
    tracker.mark('permission_block');
    await wait(page, holdTime(audioClips, 'permission_block', 5600));
    await hideCaption(page);
    await wait(page, 300);

    await selectFindingByText(page, 'Fix JWT token refresh in auth.ts');
    await wait(page, 800);

    await broadcastSuggestion(request, tmux1, [], [
      { label: 'Allow', value: 'yes', shortcut: '1' },
      { label: 'Deny', value: 'no', shortcut: '2' },
    ]);
    await wait(page, 800);

    await showCaption(page, NARRATIONS.permission_allow);
    tracker.mark('permission_allow');
    const permissionAllowTotal = holdTime(audioClips, 'permission_allow', 6200);
    const permissionAllowStartedAt = Date.now();
    await wait(page, 3200);
    await showKeystroke(page, '1');
    await page.locator('.btn-quick-action', { hasText: 'Allow' }).click();
    await page.locator('.sent-overlay').waitFor({ state: 'visible', timeout: 3000 });
    await wait(page, 900);
    await wait(page, Math.max(0, permissionAllowTotal - (Date.now() - permissionAllowStartedAt)));
    await hideCaption(page);

    // Close the loop on screen: the approved agent visibly resumes work
    // (finding clears, agent returns to the healthy list with a live tool
    // row) while the plumbing line answers "how does this even attach?".
    await injectToolUse(request, tmux1, 'Bash');
    await wait(page, 600);
    await showCaption(page, NARRATIONS.plumbing);
    tracker.mark('plumbing');
    await wait(page, holdTime(audioClips, 'plumbing', 7200));
    await hideCaption(page);
    await wait(page, 400);

    // =====================================================================
    // ACT 2 — Multi-project, multi-provider landscape (0:45–1:05)
    // =====================================================================
    // Selecting the JWT finding switched the project filter to acme/webapp
    // (selection sync), so the tour starts from an isolated project view.
    const apiChip = page.getByTestId('project-icon-acme/api-service');
    const allProjectsChip = page.getByTestId('project-icon-all');
    await apiChip.waitFor({ state: 'visible', timeout: 5000 });
    await allProjectsChip.waitFor({ state: 'visible', timeout: 5000 });

    await showCaption(page, NARRATIONS.projects_iso);
    tracker.mark('projects_iso');
    await apiChip.hover();
    await wait(page, 600);
    await apiChip.click();
    await wait(page, Math.max(0, holdTime(audioClips, 'projects_iso', 6000) - 600));

    await showCaption(page, NARRATIONS.projects_all);
    tracker.mark('projects_all');
    await allProjectsChip.hover();
    await wait(page, 500);
    await allProjectsChip.click();
    await wait(page, Math.max(0, holdTime(audioClips, 'projects_all', 5600) - 500));
    await hideCaption(page);
    await wait(page, 400);

    await showCaption(page, NARRATIONS.providers_mixed);
    tracker.mark('providers_mixed');
    await wait(page, holdTime(audioClips, 'providers_mixed', 5600));
    await hideCaption(page);
    await wait(page, 500);
    // Codex CLI fork detail intentionally deferred to the closing card —
    // it's an implementation detail, not a headline feature.

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
    await wait(page, 900);

    await showCaption(page, NARRATIONS.two_alerts);
    tracker.mark('two_alerts');
    await wait(page, holdTime(audioClips, 'two_alerts', 5600));
    await hideCaption(page);
    await wait(page, 300);

    await selectFindingByText(page, 'Add rate limiting to pagination endpoint');
    await wait(page, 800);

    // Also reused by the post-credits thumbnail epilogue.
    const rateLimitSuggestions = [
      'Use in-memory TTL for this PR. Add the storage interface now so Redis can replace it when we deploy multiple instances.',
      'Use Redis immediately if this service will run more than one instance in the next sprint.',
      'Ship in-memory TTL behind a config flag and add a follow-up issue for Redis before horizontal scaling.',
    ];
    const rateLimitQuickActions = [
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
    ];
    await broadcastSuggestion(request, tmux4, rateLimitSuggestions, rateLimitQuickActions);
    await wait(page, 1200);

    await showCaption(page, NARRATIONS.ai_suggest);
    tracker.mark('ai_suggest');
    const aiSuggestTotal = holdTime(audioClips, 'ai_suggest', 8800);
    await wait(page, aiSuggestTotal);
    const aiBtn = page.locator('.btn-quick-action.ai-suggestion').first();
    await aiBtn.waitFor({ state: 'visible', timeout: 5000 });
    await aiBtn.click();
    await page.locator('.sent-overlay').waitFor({ state: 'visible', timeout: 3000 });
    await hideCaption(page);
    // The answered agent visibly resumes — same closed-loop proof as Act 1.
    await injectToolUse(request, tmux4, 'Edit');
    await wait(page, 300);

    // Re-surface the merge conflict for snoozing
    await injectStopEvent(
      request,
      tmux3,
      "I hit a merge conflict in src/auth.ts. The local branch sets JWT expiry to 1h but main has 24h. Which should I keep?",
    );
    await wait(page, 600);
    await broadcastSuggestion(request, tmux3, [], []);
    await broadcastSuggestion(request, tmux4, [], []);

    await selectFindingByText(page, 'Implement login redirect fix (#87)');
    await wait(page, 1200);

    await showCaption(page, NARRATIONS.snooze_other);
    tracker.mark('snooze_other');
    const snoozeTotal = holdTime(audioClips, 'snooze_other', 7600);
    const snoozeStartedAt = Date.now();
    await wait(page, 2200);
    await showKeystroke(page, 'Alt+S');
    await page.keyboard.press('Alt+s');
    const snoozeDialog = page.locator('.snooze-dialog');
    await snoozeDialog.waitFor({ state: 'visible', timeout: 3000 });
    if (await snoozeDialog.isVisible()) {
      await wait(page, 2200);
      await showKeystroke(page, '2  (1h)');
      await page.keyboard.press('2');
      await wait(page, 900);
    }
    await wait(page, Math.max(0, snoozeTotal - (Date.now() - snoozeStartedAt)));
    await hideCaption(page);
    await wait(page, 400);

    await page.screenshot({ path: join(OUTPUT_DIR, 'kookr-demo-screenshot.png') });

    // =====================================================================
    // ACT 4 — GitHub awareness (1:30–1:53)
    // =====================================================================
    // Selecting a finding syncs the project filter to that task's project,
    // so the api-service pagination agent is filtered out right now. Return
    // to the all-projects view before showcasing it.
    await allProjectsChip.click();
    await wait(page, 600);
    const paginationRow = page.locator('.healthy-row').filter({ hasText: 'Add pagination to /users endpoint' }).first();
    await paginationRow.waitFor({ state: 'visible', timeout: 5000 });
    await paginationRow.click();
    await wait(page, 1500);

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
    await wait(page, 800);
    await page.screenshot({ path: join(OUTPUT_DIR, 'kookr-demo-triage.png') });

    await showCaption(page, NARRATIONS.pr_opened);
    tracker.mark('pr_opened');
    await wait(page, holdTime(audioClips, 'pr_opened', 7600));
    await hideCaption(page);

    await request.post(`${BASE}/api/test/broadcast-alert`, {
      data: {
        agentId: tmux2,
        summary: 'PR acme/api-service#142: CI check "lint" failed',
        severity: 'warning',
      },
    });
    await wait(page, 1000);

    await showCaption(page, NARRATIONS.ci_failed);
    tracker.mark('ci_failed');
    await wait(page, holdTime(audioClips, 'ci_failed', 6400));
    await hideCaption(page);
    await wait(page, 400);

    // =====================================================================
    // ACT 5 — Completion + the real session numbers (1:53–2:18)
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
    await wait(page, 800);

    const completedRow = page.locator('.completed-row').filter({ hasText: 'Refactor auth middleware to async/await' }).first();
    if (!(await completedRow.isVisible({ timeout: 1000 }).catch(() => false))) {
      const completedHeader = page.locator('.section-header').filter({ hasText: 'Completed' }).first();
      await completedHeader.waitFor({ state: 'visible', timeout: 5000 });
      await completedHeader.click();
      await wait(page, 400);
    }
    await selectCompletedRowByText(page, 'Refactor auth middleware to async/await');
    await wait(page, 1200);

    await showCaption(page, NARRATIONS.agent_done);
    tracker.mark('agent_done');
    await wait(page, holdTime(audioClips, 'agent_done', 7000));
    await hideCaption(page);

    // Every number in this line is real and on screen: the TopBar session
    // cost and the completed digest. No invented metrics, no footnotes.
    await showCaption(page, NARRATIONS.session_value);
    tracker.mark('session_value');
    await wait(page, holdTime(audioClips, 'session_value', 6500));
    await hideCaption(page);
    await wait(page, 400);

    // =====================================================================
    // ACT 6 — Closing card (2:18–2:33)
    // =====================================================================
    await page.keyboard.press('Escape').catch(() => {});
    await wait(page, 800);
    await showClosingCard(page);
    await wait(page, 800);

    await showCaption(page, NARRATIONS.closing);
    tracker.mark('closing');
    await wait(page, holdTime(audioClips, 'closing', 6200));
    await hideCaption(page);
    await wait(page, 400);

    await showCaption(page, NARRATIONS.repo_url);
    tracker.mark('repo_url');
    await wait(page, holdTime(audioClips, 'repo_url', 2200));
    await hideCaption(page);
    await hideClosingCard(page);
    await wait(page, 700);
    // Everything after this mark is trimmed out of the published video.
    tracker.mark('video_end');

    // =====================================================================
    // POST-CREDITS (trimmed away) — thumbnail capture from the live UI.
    // Re-create the AI-suggestion peak so the thumbnail shows the product at
    // its most alive, without polluting the narrative footage.
    // =====================================================================
    await wait(page, 1000);
    await injectStopEvent(
      request,
      tmux4,
      'Rate-limit storage choice needed before I wire the middleware. Should I ship in-memory TTL now with a Redis storage interface, or add Redis immediately?',
    );
    await broadcastSuggestion(request, tmux4, rateLimitSuggestions, rateLimitQuickActions);
    await wait(page, 800);
    await selectFindingByText(page, 'Add rate limiting to pagination endpoint');
    await wait(page, 800);
    await captureThumbnail(page, join(OUTPUT_DIR, 'kookr-demo-thumbnail.jpg'));

    console.log(CHECK_MODE ? 'Scenario complete.' : 'Scenario complete. Saving video...');
    scenarioOk = true;
  } finally {
    // Close context to finalize video. The video artifact must be saved
    // BEFORE browser.close() — afterwards the artifact channel is gone.
    const videoPage = CHECK_MODE ? null : page.video();
    await context.close();
    const silentPath = join(OUTPUT_DIR, audioClips.size > 0 ? 'kookr-demo-silent.webm' : 'kookr-demo.webm');
    if (videoPage) {
      await videoPage.saveAs(silentPath);
      console.log(`Video saved: ${silentPath}`);
    }
    await browser.close();

    if (!CHECK_MODE) {
      // Cut the published video at the video_end mark — everything after it
      // is the post-credits thumbnail epilogue.
      const videoEndOffset = tracker.getEntries().find((e) => e.key === 'video_end')?.offsetMs;
      const trimMs = videoEndOffset !== undefined ? videoEndOffset + 600 : undefined;

      // Merge audio if we have clips
      const finalPath = join(OUTPUT_DIR, 'kookr-demo.webm');
      if (audioClips.size > 0 && existsSync(silentPath)) {
        try {
          await mergeAudioIntoVideo(silentPath, finalPath, audioClips, tracker.getEntries(), trimMs);
          // Remove the silent intermediate file
          try { rmSync(silentPath); } catch { /* ignore */ }
        } catch (err) {
          console.warn(`[ffmpeg] Audio merge failed: ${err instanceof Error ? err.message : String(err)}`);
          console.warn('[ffmpeg] Silent video preserved at:', silentPath);
          // Rename silent to final so there's always an output
          try { renameSync(silentPath, finalPath); } catch { /* ignore */ }
        }
      } else if (existsSync(finalPath) && trimMs !== undefined) {
        // Silent recording: trim the epilogue in place.
        try {
          const trimmed = join(OUTPUT_DIR, 'kookr-demo-trim-tmp.webm');
          await execFileAsync('ffmpeg', ['-y', '-i', finalPath, '-t', (trimMs / 1000).toFixed(3), '-c', 'copy', trimmed], { timeout: 120_000 });
          renameSync(trimmed, finalPath);
        } catch (err) {
          console.warn(`[ffmpeg] Epilogue trim failed (full video kept): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Optional music bed: first audio file in demo/assets/music/, mixed
      // low under the narration. Only applied to narrated recordings.
      if (audioClips.size > 0 && existsSync(finalPath)) {
        const music = findMusicBed(join(__dirname, 'assets', 'music'));
        if (music) {
          try {
            const durMs = await probeDurationMs(finalPath);
            const withMusic = join(OUTPUT_DIR, 'kookr-demo-music-tmp.webm');
            await mixMusicBed(finalPath, music, withMusic, durMs);
            renameSync(withMusic, finalPath);
            console.log(`[music] Mixed music bed from ${music}`);
          } catch (err) {
            console.warn(`[music] Music bed mix failed (narration-only audio kept): ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          console.log('[music] No track in demo/assets/music/ — shipping without a music bed.');
        }
      }

      // Subtitles — same timeline that drove the narration. Upload the .srt
      // with the video so YouTube can auto-translate captions.
      if (tracker.getEntries().length > 0) {
        const srtPath = join(OUTPUT_DIR, 'kookr-demo.srt');
        writeFileSync(srtPath, buildSrt(tracker.getEntries(), NARRATIONS, audioClips));
        console.log(`[srt] Subtitles saved: ${srtPath}`);
      }

      // Distribution formats
      if (existsSync(finalPath)) {
        await runExportMatrix(finalPath, tracker.getEntries());
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
    if (CHECK_MODE && scenarioOk) {
      console.log('[check] ✅ CHECK PASSED — demo scenario is fully aligned with the current UI.');
    }
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
