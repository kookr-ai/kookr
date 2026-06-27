/**
 * Canary test: validates that mock hook events match real Claude Code behavior.
 *
 * Launches a real Claude Code instance with Haiku model, captures the hook
 * events it emits, and validates their shapes against mock fixtures.
 *
 * Run:  CANARY=1 npx playwright test e2e/canary.spec.ts
 * Cost: ~$0.001 per run (Haiku, trivial task)
 * Requires: claude CLI, ANTHROPIC_API_KEY (or authenticated session)
 *
 * This test is skipped by default. Run it:
 *  - After upgrading the Claude Code CLI
 *  - Weekly in CI as a scheduled job
 *  - When hook parsing breaks unexpectedly
 */
import { test, expect } from './fixtures.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  REQUIRED_HOOK_FIELDS,
  EVENT_SHAPE,
  MOCKED_EVENT_TYPES,
} from './fixtures/mock-events.js';
import { parseHookEvent } from '../src/core/hook-parser.js';

// Skip entire suite unless CANARY=1
const CANARY = process.env.CANARY === '1';

test.describe('Claude Code canary — mock accuracy validation', () => {
  test.skip(!CANARY, 'Set CANARY=1 to run canary tests against real Claude Code');

  // Shared state across tests in this suite
  let tempDir: string;
  let hookFile: string;
  let hookLines: string[];

  // Real Claude Code + Haiku can take up to 90s to complete
  test.beforeAll(async ({ }, testInfo) => {
    testInfo.setTimeout(120_000);
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-canary-'));
    const hooksDir = join(tempDir, 'hooks');
    const settingsDir = join(tempDir, 'settings');
    const projectDir = join(tempDir, 'project');
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(settingsDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    // Create a file for Claude to read (ensures PreToolUse/PostToolUse events)
    writeFileSync(join(projectDir, 'hello.txt'), 'Hello from canary test!\n');

    const runId = `kookr-canary-${Date.now()}`;
    hookFile = join(hooksDir, `${runId}.jsonl`);

    // Generate settings — pipe all hook events to a JSONL file
    const hookCommand = `cat >> ${hookFile}`;
    const settings = {
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }],
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }],
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }],
        PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }],
      },
    };

    const settingsPath = join(settingsDir, `${runId}.json`);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Run Claude Code in print mode so the temporary workspace does not block
    // on the interactive trust prompt. Hooks still fire in this mode.
    const prompt = `Read the file ${join(projectDir, 'hello.txt')} and tell me what it says. Be brief.`;
    try {
      execFileSync('claude', [
        '-p',
        '--model', 'haiku',
        '--dangerously-skip-permissions',
        '--settings', settingsPath,
        prompt,
      ], { cwd: projectDir, timeout: 90_000, stdio: 'pipe' });
    } catch (err) {
      throw new Error(`Failed to run Claude canary: ${err}`);
    }

    // Read captured hook events
    if (existsSync(hookFile)) {
      hookLines = readFileSync(hookFile, 'utf-8').trim().split('\n').filter(Boolean);
    } else {
      hookLines = [];
    }
  });

  test.afterAll(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('Claude Code emitted hook events', () => {
    expect(hookLines.length).toBeGreaterThan(0);
  });

  test('every event has required base fields', () => {
    for (const line of hookLines) {
      const event = JSON.parse(line);
      for (const field of REQUIRED_HOOK_FIELDS) {
        expect(event, `Missing field "${field}" in ${event.hook_event_name} event`).toHaveProperty(field);
      }
    }
  });

  test('SessionStart event matches expected shape', () => {
    const events = hookLines.map((l) => JSON.parse(l));
    const sessionStart = events.find((e) => e.hook_event_name === 'SessionStart');

    expect(sessionStart, 'No SessionStart event found').toBeDefined();
    for (const field of EVENT_SHAPE.SessionStart) {
      expect(sessionStart).toHaveProperty(field);
    }
    expect(typeof sessionStart.session_id).toBe('string');
    expect(sessionStart.session_id.length).toBeGreaterThan(0);
  });

  test('tool events have tool_name field', () => {
    const events = hookLines.map((l) => JSON.parse(l));
    const toolEvents = events.filter((e) =>
      ['PreToolUse', 'PostToolUse'].includes(e.hook_event_name),
    );

    expect(toolEvents.length, 'No tool events found — Claude should have used Read tool').toBeGreaterThan(0);
    for (const event of toolEvents) {
      expect(event).toHaveProperty('tool_name');
      expect(typeof event.tool_name).toBe('string');
    }
  });

  test('Stop event has expected fields', () => {
    const events = hookLines.map((l) => JSON.parse(l));
    const stopEvent = events.find((e) => e.hook_event_name === 'Stop');

    // Stop should fire after Claude finishes responding
    if (stopEvent) {
      for (const field of EVENT_SHAPE.Stop) {
        expect(stopEvent).toHaveProperty(field);
      }
    }
  });

  test('all real events parse through hook-parser without errors', () => {
    for (const line of hookLines) {
      // parseHookEvent should not throw for any real event
      const event = parseHookEvent(line);
      expect(event).toHaveProperty('type');
      expect(event).toHaveProperty('sessionId');
    }
  });

  test('no unexpected event types outside our mock coverage', () => {
    const events = hookLines.map((l) => JSON.parse(l));
    const realEventTypes = [...new Set(events.map((e) => e.hook_event_name))];

    for (const eventType of realEventTypes) {
      expect(
        MOCKED_EVENT_TYPES,
        `Real Claude Code emitted "${eventType}" but we have no mock for it`,
      ).toContain(eventType);
    }
  });
});

// ---------------------------------------------------------------------------
// Tmux session options canary — removed in V8 (rfc-v8-tmux-removal.md).
// The tmux backend and its mouse-mode remediation are gone; dtach has no
// equivalent concept, so there is no mock-vs-real drift to canary.
// ---------------------------------------------------------------------------
