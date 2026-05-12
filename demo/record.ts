/**
 * Demo recording script V2 — produces a ~90-120s .webm video showcasing
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
 *   pnpm demo:record                    # Silent video (no TTS needed)
 *   KOOKR_TTS_URL=http://localhost:8004 pnpm demo:record   # With narration
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

// ---------------------------------------------------------------------------
// v3 demo overlays — cold-open grid, provider tooltip, inference stamp,
// time-reclaimed badge, supervision-avoided digest row. All pure DOM.
// ---------------------------------------------------------------------------

/** 2x2 fake-tmux grid that anchors the "before" pain in Act 0. */
async function showColdOpenGrid(page: Page) {
  await page.evaluate(() => {
    const root = document.createElement('div');
    root.id = 'demo-cold-open';
    root.style.cssText = `
      position: fixed; inset: 0; z-index: 99996;
      display: grid; grid-template: 1fr 1fr / 1fr 1fr;
      background: #0b0d12; gap: 4px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 18px;
      transition: opacity 0.5s, transform 0.5s;
    `;
    const panes = [
      { color: '#dfe4f0', body: '$ claude code\n> Should I proceed with this approach?\nContinue? [y/n]_' },
      { color: '#ff6b6b', body: 'FAIL test/auth.spec.ts > token refresh\n  TypeError: jwt.verify is not a function\n  at Object.<anonymous> (auth.ts:42)\n  at Module._compile (node:internal/modules/cjs/loader)' },
      { color: '#48d597', body: '[14:22:11] streaming output...\n[14:22:11] partial result OK\n[14:22:12] retry 3/5...\n[14:22:13] retry 4/5...' },
      { color: '#dfe4f0', body: '$ codex exec --task "add pagination"\n# (waiting on permission prompt)\n_' },
    ];
    for (const p of panes) {
      const pane = document.createElement('pre');
      pane.style.cssText = `
        background: #14171f; color: ${p.color}; padding: 40px;
        margin: 0; white-space: pre-wrap; overflow: hidden;
        border: 1px solid #232838; border-radius: 8px;
        line-height: 1.5;
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
    const digest = document.querySelector('.completion-digest, .digest, .task-detail-completion');
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
        position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
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
      <div style="font-size: 64px; font-weight: 700; color: #dfe4f0; letter-spacing: -1px;">
        Kookr
      </div>
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
      <div style="font-size:13px;color:#8b94aa;text-align:center;margin-top:8px;">
        Codex CLI via <span style="color:#dfe4f0;">jeanibarz/codex · feat/claude-compat</span><br/>
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

/** Narration scripts — v3 (critic-informed). See docs/rfc/demo-video-v3-drafts/script-v2.md. */
const NARRATIONS: Record<string, string> = {
  // Act 0: Cold open + hook
  cold_open: 'Five AI agents in five terminals. Which one needs you?',
  hook: 'Kookr tells you which one. Instantly.',

  // Act 1: Multi-project, multi-provider
  projects_open: 'Two projects, side by side. Webapp on the left, API service on the right.',
  providers_mixed: 'Claude Code and Codex CLI agents — same queue, same triage.',
  codex_fork: 'Codex compatibility runs on a maintained fork. Link below.',

  // Act 2: Anomaly detection
  permission_block: 'Permission blocked on the webapp agent. Kookr routes your attention there.',
  permission_allow: 'One key to allow. The queue rolls forward.',

  // Act 3: Cross-project triage
  two_alerts: 'A question on the Codex agent. A merge conflict on Claude. Both surfaced.',
  ai_suggest: 'AI drafts a response. Approve, edit, or write your own.',
  snooze_other: 'The merge conflict can wait. Snooze it and keep moving.',

  // Act 4: GitHub awareness
  pr_opened: 'An agent just opened a pull request.',
  ci_failed: 'CI failed. Same attention queue. Same triage.',

  // Act 5: Completion + cost + time saved
  agent_done: "Agent finished. Files changed, tests run, cost — and the supervision time you didn't spend.",

  // Act 6: Closing
  closing: 'Local-first. Attention router. Multi-project. Claude Code and Codex CLI.',
  repo_url: 'github.com slash kookr-ai slash kookr. Apache two-point-zero.',
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
    filterParts.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs}[a${i}]`);
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
  });
  const page = await context.newPage();
  const request = context.request;

  try {
    // Reset and navigate
    await resetServer(context);
    await page.goto(BASE);
    await page.locator('.logo').waitFor({ state: 'visible' });

    // Seed project configs so the sidebar appears
    await seedProjectConfigs(request);

    // Inject click ripple and keystroke badge visual indicators
    await injectInteractionIndicators(page);

    console.log('Recording started. Running demo scenario...');
    tracker.start();

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
    await setTerminalContent(request, tmux2, paginationContent(), { mode: 'streaming', lineDelayMs: 60, loop: true });
    await setTerminalContent(request, tmux3, cacheRefactorContent(), { mode: 'instant' });
    await setTerminalContent(request, tmux4, rateLimitContent(), { mode: 'instant' });
    await setTerminalContent(request, tmux5, authRefactorContent(), { mode: 'streaming', lineDelayMs: 80, loop: true });

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
    // ACT 0 — Cold open + hook (0:00–0:11)
    // =====================================================================
    tracker.mark('cold_open');
    await showColdOpenGrid(page);
    await showCaption(page, '5 AI agents in 5 terminals. Which one needs you?');
    await page.waitForTimeout(holdTime(audioClips, 'cold_open', 3500));
    await hideCaption(page);
    await fadeOutColdOpenGrid(page, 500);
    await page.waitForTimeout(700);

    tracker.mark('hook');
    await showCaption(page, 'Kookr tells you which one. Instantly.');
    await page.waitForTimeout(holdTime(audioClips, 'hook', 3200));
    await hideCaption(page);
    await page.waitForTimeout(500);

    // =====================================================================
    // ACT 1 — Multi-project, multi-provider landscape (0:11–0:38)
    // =====================================================================
    tracker.mark('projects_open');
    await showCaption(page, 'Two projects. One queue. Both runtimes.');

    // Hover + click the webapp project chip if present
    const webappChip = page.locator('.project-chip, .project-pill, .sidebar-project').filter({ hasText: 'webapp' }).first();
    if (await webappChip.isVisible({ timeout: 2000 }).catch(() => false)) {
      await webappChip.hover().catch(() => {});
      await page.waitForTimeout(800);
      await webappChip.click().catch(() => {});
      await page.waitForTimeout(1500);
      const allChip = page.locator('.project-chip, .project-pill, button').filter({ hasText: /^All$/ }).first();
      if (await allChip.isVisible({ timeout: 800 }).catch(() => false)) {
        await allChip.click().catch(() => {});
      }
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(Math.max(0, holdTime(audioClips, 'projects_open', 4500) - 3700));
    await hideCaption(page);
    await page.waitForTimeout(400);

    tracker.mark('providers_mixed');
    await showCaption(page, 'Claude Code + Codex CLI. Same dashboard.');
    await page.waitForTimeout(holdTime(audioClips, 'providers_mixed', 4500));
    await hideCaption(page);
    await page.waitForTimeout(400);

    tracker.mark('codex_fork');
    await showCaption(page, 'Codex CLI — patched for missing hooks.');
    await showProviderTooltip(page, holdTime(audioClips, 'codex_fork', 4500));
    await hideCaption(page);
    await page.waitForTimeout(500);

    // =====================================================================
    // ACT 2 — Anomaly detection in action (0:38–0:58)
    // =====================================================================
    tracker.mark('permission_block');
    await injectPermissionEvent(request, tmux1, 'Bash', 'npm test --coverage');
    await page.locator('.finding-card').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await showInferenceStamp(page, 'rule F2.4 · PermissionRequest → severity=warning', 700);
    await showCaption(page, 'Permission blocked. Attention routed.');
    await page.waitForTimeout(holdTime(audioClips, 'permission_block', 4500));
    await hideCaption(page);
    await page.waitForTimeout(300);

    await page.locator('.finding-card').first().click().catch(() => {});
    await page.waitForTimeout(1000);

    await broadcastSuggestion(request, tmux1, [], [
      { label: 'Allow', value: 'yes', shortcut: '1' },
      { label: 'Deny', value: 'no', shortcut: '2' },
    ]);
    await page.waitForTimeout(800);

    tracker.mark('permission_allow');
    await showCaption(page, 'One key. Allow. Keep moving.');
    await page.waitForTimeout(holdTime(audioClips, 'permission_allow', 1700));
    await showKeystroke(page, '1');
    await page.locator('.btn-quick-action', { hasText: 'Allow' }).click().catch(() => {});
    await page.locator('.sent-overlay').waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await hideCaption(page);
    await page.waitForTimeout(400);

    // =====================================================================
    // ACT 3 — Cross-project triage (0:58–1:30)
    // =====================================================================
    await injectStopEvent(
      request,
      tmux4,
      'Should I use Redis or in-memory for rate limit storage? Redis scales beyond one instance; in-memory is fine until ~1k req/min.',
    );
    await setTerminalContent(request, tmux3, mergeConflictContent(), { mode: 'instant' });
    await injectStopEvent(
      request,
      tmux3,
      "I hit a merge conflict in src/auth.ts. The local branch sets JWT expiry to 1h but main has 24h. Which should I keep?",
    );
    await page.waitForTimeout(900);

    tracker.mark('two_alerts');
    await showCaption(page, 'Codex question + Claude merge conflict.');
    await page.waitForTimeout(holdTime(audioClips, 'two_alerts', 4000));
    await hideCaption(page);
    await page.waitForTimeout(300);

    await page.locator('.finding-card').first().click().catch(() => {});
    await page.waitForTimeout(1200);

    await broadcastSuggestion(request, tmux4, [
      'Use in-memory with TTL — Redis can wait until 1k req/min',
      'Use Redis from the start — simpler scaling story later',
      'Use in-memory with a feature flag to switch to Redis',
    ], [
      { label: 'In-memory', value: 'in-memory', shortcut: '1' },
      { label: 'Redis', value: 'redis', shortcut: '2' },
    ]);
    await page.waitForTimeout(1200);

    tracker.mark('ai_suggest');
    await showCaption(page, 'AI drafts a reply. Approve or edit.');
    await page.waitForTimeout(holdTime(audioClips, 'ai_suggest', 4000));

    const aiBtn = page.locator('.btn-quick-action.ai-suggestion').first();
    if (await aiBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await aiBtn.click().catch(() => {});
    }
    await page.locator('.sent-overlay').waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);
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

    const conflictCard = page.locator('.finding-card').first();
    await conflictCard.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    await conflictCard.click().catch(() => {});
    await page.waitForTimeout(800);

    tracker.mark('snooze_other');
    await showCaption(page, 'Snooze the other. Keep moving.');
    await showKeystroke(page, 'Alt+S');
    await page.keyboard.press('Alt+s');
    const snoozeDialog = page.locator('.snooze-dialog');
    await snoozeDialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    if (await snoozeDialog.isVisible()) {
      await page.waitForTimeout(1200);
      await showKeystroke(page, '2  (1h)');
      await page.keyboard.press('2');
      await page.waitForTimeout(1200);
    }
    await showTimeReclaimedBadge(page, 1500);
    await page.waitForTimeout(Math.max(0, holdTime(audioClips, 'snooze_other', 2800) - 1500));
    await hideCaption(page);
    await page.waitForTimeout(400);

    await page.screenshot({ path: join(OUTPUT_DIR, 'kookr-demo-screenshot.png') });

    // =====================================================================
    // ACT 4 — GitHub awareness (1:30–1:53)
    // =====================================================================
    const healthyRow2 = page.locator('.healthy-row').first();
    if (await healthyRow2.isVisible({ timeout: 1500 }).catch(() => false)) {
      await healthyRow2.click().catch(() => {});
    }
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

    tracker.mark('pr_opened');
    await showCaption(page, 'Agent opened a PR. Kookr tracks it.');
    await page.waitForTimeout(holdTime(audioClips, 'pr_opened', 4500));

    const githubTab = page.locator('.pane-tab').filter({ hasText: 'GitHub' });
    if (await githubTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await hideCaption(page);
      await githubTab.click().catch(() => {});
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: join(OUTPUT_DIR, 'kookr-demo-triage.png') });

    await request.post(`${BASE}/api/test/broadcast-alert`, {
      data: {
        agentId: tmux2,
        summary: 'PR acme/api-service#142: CI check "lint" failed',
        severity: 'warning',
      },
    });
    await page.waitForTimeout(1000);

    tracker.mark('ci_failed');
    await showCaption(page, 'CI failed. Same queue. Same triage.');
    await page.waitForTimeout(holdTime(audioClips, 'ci_failed', 4500));
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

    const completedHeader = page.locator('.section-header').filter({ hasText: 'Completed' });
    if (await completedHeader.isVisible({ timeout: 2000 }).catch(() => false)) {
      await completedHeader.click().catch(() => {});
      await page.waitForTimeout(400);
    }
    const completedRow = page.locator('.completed-row').first();
    if (await completedRow.isVisible({ timeout: 2000 }).catch(() => false)) {
      await completedRow.click().catch(() => {});
      await page.waitForTimeout(1200);
    }

    await showSupervisionAvoidedOverlay(page, '8m 12s', 16, 8);
    tracker.mark('agent_done');
    await showCaption(page, 'Done. Files, tests, cost — and time saved.');
    await page.waitForTimeout(holdTime(audioClips, 'agent_done', 6500));
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

    tracker.mark('closing');
    await showCaption(page, 'Local-first. Attention router. Multi-project.');
    await page.waitForTimeout(holdTime(audioClips, 'closing', 5500));
    await hideCaption(page);
    await page.waitForTimeout(400);

    tracker.mark('repo_url');
    await showCaption(page, 'github.com/kookr-ai/kookr · Apache 2.0');
    await page.waitForTimeout(holdTime(audioClips, 'repo_url', 5500));
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
