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
import { mkdtempSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 4803;
const BASE = `http://127.0.0.1:${PORT}`;
const OUTPUT_DIR = resolve(__dirname, 'output');
const VIEWPORT = { width: 1280, height: 720 };

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

/** Narration scripts — spoken text for each caption moment. */
const NARRATIONS: Record<string, string> = {
  // Act 1: Cold start + Playbook launch
  intro: 'Kookr. Supervise multiple AI coding agents from one dashboard.',
  manual_launch: 'Launch agents with a task description and working directory.',
  playbook_launch: 'Or use playbooks — reusable task templates with parameters.',
  quick_launch: 'Quick launch for one-offs. Five agents, two projects.',

  // Act 2: Agents working + cost
  agents_working: 'All agents working autonomously. Cost tracked in real time.',

  // Act 3: Quick actions (split into two clips for sync)
  permission: 'Permission block. Kookr detects it instantly.',
  allow: 'One keypress to allow. Back to all clear.',

  // Act 4: Multi-finding + AI suggestions + snooze
  two_findings: 'Two findings in the queue. A question and a merge conflict.',
  ai_suggest: 'AI suggests responses. Pick one or type your own.',
  snooze: 'Not urgent? Snooze it for later.',

  // Act 5: GitHub PR
  github_pr: 'Agent two opened a pull request. Kookr tracks it automatically.',
  github_ci: 'CI failed. Routed through the attention queue, just like agent anomalies.',

  // Act 6: Completion
  completed: 'Agent finished. Summary of what it did, what it cost.',

  // Act 7: Closing
  closing: 'Kookr. Route your attention to the agent that needs you most.',
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
    recordVideo: { dir: videoTmpDir, size: VIEWPORT },
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

    // Disable achievements client-side to prevent toasts
    await page.evaluate(() => {
      localStorage.setItem('kookr-achievements-enabled', 'false');
    });
    // Hide elements with emojis that don't render in headless Chromium (no emoji font)
    // Trophy button, mic buttons, sound toggle — all use Unicode emojis
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = `
        .btn-trophy { display: none !important; }
        .btn-voice { display: none !important; }
        .btn-sound { display: none !important; }
        .achievement-toasts { display: none !important; }
      `;
      document.head.appendChild(style);
    });

    // Inject click ripple and keystroke badge visual indicators
    await injectInteractionIndicators(page);

    console.log('Recording started. Running demo scenario...');
    tracker.start();

    // =====================================================================
    // ACT 1: Cold start + Playbook launch (0:00-0:20)
    // =====================================================================
    tracker.mark('intro');
    await showCaption(page, 'Kookr — supervise multiple AI coding agents from one dashboard');
    await page.waitForTimeout(holdTime(audioClips, 'intro', 3500));
    await hideCaption(page);
    await page.waitForTimeout(500);

    // --- Launch Agent 1 via Launch Dialog (manual) ---
    tracker.mark('manual_launch');
    await showCaption(page, 'Launch agents with a task description and working directory');
    await launchViaUI(page, 'Fix JWT token refresh in auth.ts', '/home/dev/webapp');
    const tmux1 = await getLatestTmuxName(request);
    await setTerminalContent(request, tmux1, jwtFixContent(), { mode: 'instant' });
    await injectSessionStart(request, tmux1, '/home/dev/webapp');
    await injectToolUse(request, tmux1, 'Read');
    const taskId1 = await getTaskId(request, 0);
    await setProjectId(request, taskId1, 'acme/webapp');

    // --- Launch Agent 2 via Launch Dialog (manual) ---
    await hideCaption(page);
    await launchViaUI(page, 'Add pagination to /users endpoint', '/home/dev/api');
    const tmux2 = await getLatestTmuxName(request);
    await setTerminalContent(request, tmux2, paginationContent(), { mode: 'streaming', lineDelayMs: 60, loop: true });
    await injectSessionStart(request, tmux2, '/home/dev/api');
    await injectToolUse(request, tmux2, 'Edit');
    const taskId2 = await getTaskId(request, 1);
    await setProjectId(request, taskId2, 'acme/api-service');

    // --- Seed playbook files on disk so listPlaybooks discovers them ---
    // Use /tmp paths that we can actually write to (fake CWDs don't exist on disk)
    await createPlaybookFiles(request, '/tmp/demo-webapp');
    await createPlaybookFiles(request, '/tmp/demo-api');
    await page.locator('.btn-launch').click();
    await page.waitForTimeout(300);

    // Set the CWD to the temp path where playbook files exist BEFORE switching to Playbooks tab
    const dialogCwdInput = page.locator('.dialog input[type="text"]').first();
    await dialogCwdInput.clear();
    await dialogCwdInput.fill('/tmp/demo-webapp');
    await page.waitForTimeout(200);

    // Switch to Playbooks tab — this sends listPlaybooks with the CWD from the input
    const playbooksTab = page.locator('.dialog .tab-btn:has-text("Playbooks"), .dialog button:has-text("Playbooks")');
    if (await playbooksTab.isVisible()) {
      await playbooksTab.click();
      await page.waitForTimeout(1000);

      // Narrate when the playbook list is first visible
      await hideCaption(page);
      tracker.mark('playbook_launch');
      await showCaption(page, 'Playbooks — reusable task templates with parameters');

      // Hold the playbook list visible so the viewer can see all 4 available playbooks
      await page.waitForTimeout(holdTime(audioClips, 'playbook_launch', 3000));

      // Click "Implement GitHub Issue" playbook
      const issuePlaybook = page.locator('.playbook-card:has-text("Implement GitHub Issue"), .playbook-item:has-text("Implement GitHub Issue")').first();
      if (await issuePlaybook.isVisible()) {
        await issuePlaybook.click();
        await page.waitForTimeout(800);

        // Fill in the issue parameter — type slowly for visual effect
        const paramInput = page.locator('.dialog input[type="text"]').first();
        if (await paramInput.isVisible()) {
          await paramInput.pressSequentially('https://github.com/acme/webapp/issues/87', { delay: 30 });
          await page.waitForTimeout(600);
        }
      }
    }

    await hideCaption(page);
    await page.waitForTimeout(300);

    // Launch from playbook (or fall back to manual if playbook UI didn't render)
    const launchPlaybookBtn = page.locator('.dialog .btn-primary:has-text("Launch")');
    if (await launchPlaybookBtn.isVisible()) {
      await launchPlaybookBtn.click();
      await page.locator('.dialog').waitFor({ state: 'hidden' }).catch(() => {});
    } else {
      // Fallback: close dialog and launch manually
      await page.keyboard.press('Escape');
      await launchViaUI(page, 'Fix login redirect bug (#87)', '/home/dev/webapp');
    }
    await page.waitForTimeout(300);

    const tmux3 = await getLatestTmuxName(request);
    await setTerminalContent(request, tmux3, cacheRefactorContent(), { mode: 'instant' });
    await injectSessionStart(request, tmux3, '/home/dev/webapp');
    await injectToolUse(request, tmux3, 'Grep');
    const taskId3 = await getTaskId(request, 2);
    await setProjectId(request, taskId3, 'acme/webapp');

    await hideCaption(page);
    await page.waitForTimeout(300);

    // --- Launch Agent 4 via Quick Launch (Alt+L) ---
    await launchViaQuickLaunch(page, 'Add rate limiting to pagination endpoint');
    const tmux4 = await getLatestTmuxName(request);
    await setTerminalContent(request, tmux4, rateLimitContent(), { mode: 'instant' });
    await injectSessionStart(request, tmux4, '/home/dev/api');
    await injectToolUse(request, tmux4, 'Read');
    const taskId4 = await getTaskId(request, 3);
    await setProjectId(request, taskId4, 'acme/api-service');

    // --- Launch Agent 5 via Quick Launch ---
    await launchViaQuickLaunch(page, 'Refactor auth middleware to async/await');
    const tmux5 = await getLatestTmuxName(request);
    await setTerminalContent(request, tmux5, authRefactorContent(), { mode: 'streaming', lineDelayMs: 80, loop: true });
    await injectSessionStart(request, tmux5, '/home/dev/webapp');
    await injectToolUse(request, tmux5, 'Edit');
    const taskId5 = await getTaskId(request, 4);
    await setProjectId(request, taskId5, 'acme/webapp');

    // Broadcast project summaries so sidebar shows badges
    await broadcastProjectSummaries(request);

    // Inject realistic cost data so the TopBar spend counter is visible
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

    tracker.mark('quick_launch');
    await showCaption(page, '5 agents launched across 2 projects — playbooks for repeatable tasks, quick launch for one-offs');
    await page.waitForTimeout(holdTime(audioClips, 'quick_launch', 3500));

    // =====================================================================
    // ACT 2: Agents working + cost awareness (0:20-0:30)
    // =====================================================================
    await hideCaption(page);
    await page.waitForTimeout(500);

    // Click a healthy agent to show its streaming terminal
    const healthyRows = page.locator('.healthy-row');
    const healthyCount = await healthyRows.count();
    if (healthyCount > 0) {
      await healthyRows.first().click();
      await page.waitForTimeout(2000); // Let terminal content stream
    }

    tracker.mark('agents_working');
    await showCaption(page, 'All agents working autonomously — cost tracked in real time');
    await page.waitForTimeout(holdTime(audioClips, 'agents_working', 3500));

    // =====================================================================
    // ACT 3: First finding — Quick actions (0:30-0:50)
    // =====================================================================
    await hideCaption(page);
    await page.waitForTimeout(500);

    // Agent 1: Permission blocked
    await injectPermissionEvent(request, tmux1, 'Bash', 'npm test --coverage');
    await page.locator('.finding-card').first().waitFor({ state: 'visible' });

    tracker.mark('permission');
    await showCaption(page, 'Permission block — Kookr detects it instantly');
    await page.waitForTimeout(holdTime(audioClips, 'permission', 2500));
    await hideCaption(page);
    await page.waitForTimeout(300);

    // Navigate to the finding — click the card directly for reliability
    await page.locator('.finding-card').first().click();
    await page.waitForTimeout(1500);

    // Broadcast quick actions for the permission block
    await broadcastSuggestion(request, tmux1, [], [
      { label: 'Allow', value: 'yes', shortcut: '1' },
      { label: 'Deny', value: 'no', shortcut: '2' },
    ]);
    await page.waitForTimeout(1000);

    // Now that buttons are visible, narrate and press "1"
    tracker.mark('allow');
    await showCaption(page, 'One keypress to allow — no typing needed');
    await page.waitForTimeout(holdTime(audioClips, 'allow', 1500));
    await showKeystroke(page, '1');
    await page.keyboard.press('1');

    // Wait for sent overlay
    await page.locator('.sent-overlay').waitFor({ state: 'visible' }).catch(() => {});
    await page.waitForTimeout(2000);

    // =====================================================================
    // ACT 4: Multiple findings + AI suggestions + snooze (0:50-1:10)
    // =====================================================================
    await hideCaption(page);
    await page.waitForTimeout(500);

    // Agent 4: Needs input (stop event with a question)
    await injectStopEvent(
      request,
      tmux4,
      'Should I add rate limiting to the pagination endpoint? I\'d recommend 100 req/min to match the /users limit.',
    );
    await page.locator('.finding-card').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(800);

    // Agent 3: Hit a merge conflict and stopped to ask for help
    await setTerminalContent(request, tmux3, mergeConflictContent(), { mode: 'instant' });
    await injectStopEvent(
      request,
      tmux3,
      'I hit a merge conflict in src/auth.ts. The local branch sets JWT expiry to 1h but main has 24h. Which should I keep?',
    );
    await page.waitForTimeout(1000);

    tracker.mark('two_findings');
    await showCaption(page, 'Two findings — a question and a merge conflict');
    await page.waitForTimeout(holdTime(audioClips, 'two_findings', 3000));
    await hideCaption(page);
    await page.waitForTimeout(300);

    // Navigate to the needs_input finding — click it directly
    await page.locator('.finding-card').first().click();
    await page.waitForTimeout(1500);

    // Broadcast AI suggestions for this agent
    await broadcastSuggestion(request, tmux4, [
      'Yes, add rate limiting with 100 req/min default',
      'Skip rate limiting — internal endpoint only',
      'Add rate limiting but use 50 req/min for safety',
    ], [
      { label: 'Yes', value: 'yes', shortcut: 'y' },
      { label: 'No', value: 'no', shortcut: 'n' },
    ]);
    await page.waitForTimeout(1500);

    tracker.mark('ai_suggest');
    await showCaption(page, 'AI suggests responses — pick one or type your own');
    await page.waitForTimeout(holdTime(audioClips, 'ai_suggest', 3000));

    // Click the first AI suggestion (or fallback to typing)
    const suggestionBtn = page.locator('.btn-quick-action.ai-suggestion').first();
    if (await suggestionBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await suggestionBtn.click();
    } else {
      // Fallback: type and send
      const responseInput = page.locator('.response-row input');
      if (await responseInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await responseInput.click();
        await responseInput.pressSequentially('Yes, add rate limiting with 100 req/min', { delay: 30 });
        await page.locator('.btn-primary:has-text("Send")').first().click();
      }
    }

    // Wait for sent overlay
    await page.locator('.sent-overlay').waitFor({ state: 'visible' }).catch(() => {});
    await page.waitForTimeout(2000);
    await hideCaption(page);
    await page.waitForTimeout(500);

    // Re-inject agent 3's stop event to ensure its finding is in the queue for snoozing
    // (the previous finding may have been cleared during the respond cycle)
    await injectStopEvent(
      request,
      tmux3,
      'I hit a merge conflict in src/auth.ts. The local branch sets JWT expiry to 1h but main has 24h. Which should I keep?',
    );
    await page.waitForTimeout(800);

    // The finding card should now be visible
    const secondFinding = page.locator('.finding-card').first();
    await secondFinding.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    await showCaption(page, 'Auto-advanced to the next finding');
    await secondFinding.click();
    await page.waitForTimeout(2000);
    await hideCaption(page);
    await page.waitForTimeout(300);

    // Snooze the merge conflict — not urgent
    // Navigate to the finding first so it's selected in the detail panel
    const findingToSnooze = page.locator('.finding-card').first();
    if (await findingToSnooze.isVisible({ timeout: 2000 }).catch(() => false)) {
      await findingToSnooze.click();
      await page.waitForTimeout(1000);
    }

    // Clear any lingering quick action suggestions so number keys don't conflict with snooze dialog
    await broadcastSuggestion(request, tmux3, [], []);
    await broadcastSuggestion(request, tmux4, [], []);
    await page.waitForTimeout(300);

    tracker.mark('snooze');
    await showCaption(page, 'Not urgent? Snooze it for later');
    await page.waitForTimeout(holdTime(audioClips, 'snooze', 2000));

    // Open the snooze dialog
    await showKeystroke(page, 'Alt+S');
    await page.keyboard.press('Alt+s');

    // Wait for snooze dialog to appear and hold it on screen
    const snoozeDialog = page.locator('.snooze-dialog');
    await snoozeDialog.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    if (await snoozeDialog.isVisible()) {
      await page.waitForTimeout(2500);
      await showKeystroke(page, '2  (1h)');
      await page.waitForTimeout(300);
      await page.keyboard.press('2');
      await page.waitForTimeout(1500);
    } else {
      // Snooze dialog didn't open (no finding selected) — snooze via API directly
      await request.post(`${BASE}/api/test/broadcast-alert`, {
        data: { agentId: tmux3, summary: 'Snoozed for 1 hour', severity: 'info' },
      });
      // Use WebSocket to send snooze message directly
      await page.evaluate((agentId) => {
        const ws = (window as unknown as { __kookrWs?: WebSocket }).__kookrWs;
        if (ws) ws.send(JSON.stringify({ type: 'snooze', agentId, durationMs: 3600000 }));
      }, tmux3);
      await page.waitForTimeout(1500);
    }

    // Deselect and collapse healthy to reveal snoozed section
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Collapse the healthy section by clicking its header
    await page.evaluate(() => {
      const headers = document.querySelectorAll('.section-header');
      for (const h of headers) {
        if (h.textContent?.includes('Healthy')) {
          (h as HTMLElement).click();
          break;
        }
      }
    });
    await page.waitForTimeout(800);

    const snoozedSection = page.locator('.snoozed-section, .snoozed-label');
    await snoozedSection.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await hideCaption(page);
    await showCaption(page, 'Snoozed — task reappears after 1 hour');
    await page.waitForTimeout(3000);

    // Re-expand healthy for remaining acts
    await page.evaluate(() => {
      const headers = document.querySelectorAll('.section-header');
      for (const h of headers) {
        if (h.textContent?.includes('Healthy')) {
          (h as HTMLElement).click();
          break;
        }
      }
    });
    await page.waitForTimeout(300);

    // Capture screenshot at this interesting state
    await page.screenshot({ path: join(OUTPUT_DIR, 'kookr-demo-screenshot.png') });
    console.log('Screenshot saved: demo/output/kookr-demo-screenshot.png');

    // =====================================================================
    // ACT 5: GitHub PR awareness (1:10-1:30)
    // =====================================================================
    await hideCaption(page);
    await page.waitForTimeout(500);

    // Click Agent 2 (pagination, healthy + streaming)
    if (healthyCount >= 2) {
      await healthyRows.nth(0).click();
    }
    await page.waitForTimeout(2000);

    // Broadcast PR data for Agent 2
    await request.post(`${BASE}/api/test/broadcast-github`, {
      data: {
        taskId: taskId2,
        prs: [{
          ref: {
            type: 'pr',
            owner: 'acme',
            repo: 'api-service',
            number: 42,
            url: 'https://github.com/acme/api-service/pull/42',
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

    tracker.mark('github_pr');
    await showCaption(page, 'Agent 2 opened a PR — Kookr tracks it automatically');
    await page.waitForTimeout(holdTime(audioClips, 'github_pr', 3500));

    // Switch to GitHub tab
    const githubTab = page.locator('.pane-tab:has-text("GitHub")');
    await githubTab.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if (await githubTab.isVisible()) {
      await hideCaption(page);
      await githubTab.click();
      await page.waitForTimeout(1000);
    }

    // Capture screenshot of GitHub panel
    await page.screenshot({ path: join(OUTPUT_DIR, 'kookr-demo-triage.png') });
    console.log('Screenshot saved: demo/output/kookr-demo-triage.png');

    // CI failure alert through attention queue
    await request.post(`${BASE}/api/test/broadcast-alert`, {
      data: {
        agentId: tmux2,
        summary: 'PR acme/api-service#42: CI check "lint" failed',
        severity: 'warning',
      },
    });

    await page.waitForTimeout(1500);
    tracker.mark('github_ci');
    await showCaption(page, 'CI failed — routed through the attention queue, just like agent anomalies');
    await page.waitForTimeout(holdTime(audioClips, 'github_ci', 4000));

    // =====================================================================
    // ACT 6: Agent completes + completion digest (1:30-1:40)
    // =====================================================================
    await hideCaption(page);
    await page.waitForTimeout(500);

    // Complete Agent 5 (auth middleware refactor)
    await completeTaskWithDigest(request, taskId5, {
      bullets: [
        'Refactored auth middleware to async/await pattern',
        'Added typed AuthError and TokenExpiredError classes',
        'Updated 3 test files — all 7 tests passing',
      ],
      filesChanged: ['middleware.ts', 'types.ts', 'middleware.test.ts', 'types.test.ts'],
      testSummary: '7 passed, 0 failed',
    });
    await page.waitForTimeout(1000);

    // Click the completed task to show its digest
    // First expand the completed section if collapsed
    const completedHeader = page.locator('.section-header:has-text("Completed")');
    if (await completedHeader.isVisible({ timeout: 2000 }).catch(() => false)) {
      await completedHeader.click();
      await page.waitForTimeout(500);
    }
    const completedRow = page.locator('.completed-row').first();
    if (await completedRow.isVisible({ timeout: 2000 }).catch(() => false)) {
      await completedRow.click();
      await page.waitForTimeout(1000);
    }

    tracker.mark('completed');
    await showCaption(page, 'Agent finished — summary of what it did and what it cost');
    await page.waitForTimeout(holdTime(audioClips, 'completed', 3500));

    // =====================================================================
    // ACT 7: Closing — the full picture (1:40-1:55)
    // =====================================================================
    await hideCaption(page);
    await page.waitForTimeout(500);

    // Deselect to show the full dashboard
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);

    tracker.mark('closing');
    await showCaption(page, 'Kookr — route your attention to the agent that needs you most');
    await page.waitForTimeout(holdTime(audioClips, 'closing', 4000));
    await hideCaption(page);
    await page.waitForTimeout(1000);

    console.log('Scenario complete. Saving video...');
  } finally {
    // Close context to finalize video
    const videoPage = page.video();
    await context.close();
    await browser.close();

    // Move the video to output directory
    const silentPath = join(OUTPUT_DIR, audioClips.size > 0 ? 'kookr-demo-silent.webm' : 'kookr-demo.webm');
    if (videoPage) {
      const videoPath = await videoPage.path();
      if (videoPath) {
        try {
          renameSync(videoPath, silentPath);
        } catch {
          const { copyFileSync } = await import('node:fs');
          copyFileSync(videoPath, silentPath);
        }
        console.log(`Video saved: ${silentPath}`);
      }
    }

    // Merge audio if we have clips
    if (audioClips.size > 0 && existsSync(silentPath)) {
      const finalPath = join(OUTPUT_DIR, 'kookr-demo.webm');
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
