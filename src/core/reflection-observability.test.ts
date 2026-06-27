import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePluginDir } from './plugin-paths.js';

const repoRoot = join(import.meta.dirname, '..', '..');
const requiredSelfReflectScripts = [
  'skills/self-reflect/scripts/kookr-interaction-stats.ts',
  'skills/self-reflect/scripts/session-analyzer.ts',
];

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'kookr-reflection-observability-'));
}

function runScript(args: string[], home: string): string {
  return execFileSync('node', ['--import', 'tsx', ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex', 'sessions') },
    encoding: 'utf-8',
  });
}

describe('reflection observability scripts', () => {
  // Packaging smoke: mirror the released runtime layout where dist/core resolves
  // the toolkit from ../../plugin, then execute scripts from that resolved tree.
  test('packaged runtime plugin layout includes runnable self-reflect scripts', () => {
    const home = tempHome();
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'kookr-packaged-runtime-'));
    try {
      cpSync(join(repoRoot, 'plugin'), join(runtimeRoot, 'plugin'), { recursive: true });
      const compiledCoreDir = join(runtimeRoot, 'dist', 'core');
      mkdirSync(compiledCoreDir, { recursive: true });

      const pluginRoot = resolvePluginDir(undefined, {} as NodeJS.ProcessEnv, compiledCoreDir);
      expect(pluginRoot).toBe(join(runtimeRoot, 'plugin'));

      for (const script of requiredSelfReflectScripts) {
        expect(existsSync(join(pluginRoot!, script))).toBe(true);
      }

      const statsOutput = runScript([
        join(pluginRoot!, requiredSelfReflectScripts[0]),
        '--json',
      ], home);
      expect(JSON.parse(statsOutput)).toMatchObject({
        status: 'no_new_sessions',
        analyzed: 0,
      });

      const analyzerOutput = runScript([
        join(pluginRoot!, requiredSelfReflectScripts[1]),
        '--help',
      ], home);
      expect(analyzerOutput).toContain('Claude Code Session Analyzer');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  test('interaction stats reports crash-recovery relaunch sessions', () => {
    const home = tempHome();
    try {
      const sessionDir = join(home, '.kookr', 'sessions', '2026-06-04T19-38-55-122Z');
      mkdirSync(sessionDir, { recursive: true });
      mkdirSync(join(home, '.claude', 'session-reflections'), { recursive: true });
      writeFileSync(join(home, '.claude', 'session-reflections', 'state.json'), JSON.stringify({
        analyzed_sessions: [],
        last_run: null,
        run_count: 0,
        cumulative_stats: {},
      }));
      writeFileSync(join(sessionDir, 'interactions.jsonl'), [
        JSON.stringify({
          type: 'agent_launched',
          agentId: 'kookr-a',
          taskPrompt: 'resume one',
          timestamp: '2026-06-04T19:38:55.121Z',
        }),
        JSON.stringify({
          type: 'agent_launched',
          agentId: 'kookr-b',
          taskPrompt: 'resume two',
          timestamp: '2026-06-04T19:38:55.122Z',
        }),
        JSON.stringify({
          type: 'crash_recovery',
          relaunched: 2,
          skipped: 1,
          failed: 0,
          details: {
            relaunched: [
              { mode: 'resumed' },
              { mode: 'fresh', fallbackReason: 'agent type does not support resume' },
            ],
            skipped: [{ reason: 'already relaunched' }],
            failed: [],
          },
          timestamp: '2026-06-04T19:38:55.123Z',
        }),
      ].join('\n') + '\n');

      const output = runScript([
        'plugin/skills/self-reflect/scripts/kookr-interaction-stats.ts',
        '--json',
      ], home);
      const parsed = JSON.parse(output);
      expect(parsed.stats.crashRecoverySessions).toBe(1);
      expect(parsed.stats.crashRecoveryRelaunches).toBe(2);
      expect(parsed.stats.crashRecoveryResumed).toBe(1);
      expect(parsed.stats.crashRecoveryFresh).toBe(1);
      expect(parsed.sessions[0].sessionKind).toBe('crash_recovery');

      const textOutput = runScript(['scripts/kookr-interaction-stats.ts'], home);
      expect(textOutput).toContain('Crash recovery sessions: 1');
      expect(textOutput).toContain('Recovery relaunches:     2 (1 resumed, 1 fresh)');
      expect(textOutput).toContain('### 2026-06-04T19-38-55-122Z [crash_recovery]');
      expect(textOutput).toContain('Crash recovery: 2 relaunched (1 resumed, 1 fresh), 1 skipped, 0 failed');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('session analyzer discovers Codex rollouts by prompt and filters injected prompt noise', () => {
    const home = tempHome();
    try {
      const rolloutDir = join(home, '.codex', 'sessions', '2026', '06', '04');
      mkdirSync(rolloutDir, { recursive: true });
      mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
      const rollout = join(rolloutDir, 'rollout-2026-06-04T19-39-00-codex-kookr.jsonl');
      writeFileSync(rollout, [
        JSON.stringify({
          timestamp: '2026-06-04T19:39:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'codex-kookr',
            timestamp: '2026-06-04T19:39:00.000Z',
            cwd: '/neutral/workspace',
            cli_version: '0.125.0-test',
            source: 'cli',
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-04T19:39:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'You are currently in the main checkout `/path/to/targetrepo` on branch `main`. Do NOT commit in this checkout; use a fresh git worktree.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-04T19:40:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'please merge the PR once checks are green' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-04T19:40:00.500Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'please merge the PR once checks are green',
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-04T19:40:00.750Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'actually wait for the required checks first',
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-04T19:40:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I will check CI.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-04T19:40:01.500Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: '{"cmd":"gh pr checks"}',
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-04T19:40:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                cached_input_tokens: 2,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-04T19:40:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 100,
                output_tokens: 20,
                cached_input_tokens: 10,
              },
            },
          },
        }),
      ].join('\n') + '\n');

      const output = runScript([
        'plugin/skills/self-reflect/scripts/session-analyzer.ts',
        '-p',
        'targetrepo',
        '--user-messages',
        '-n',
        '0',
        '--since',
        '2026-06-04',
      ], home);

      expect(output).toContain('codex-ko');
      expect(output).toContain('codex-cli');
      expect(output).toContain('please merge the PR once checks are green');
      expect(output).toContain('actually wait for the required checks first');
      expect(output).not.toContain('Do NOT commit in this checkout');

      const jsonOutput = runScript([
        'plugin/skills/self-reflect/scripts/session-analyzer.ts',
        '-p',
        'targetrepo',
        '-n',
        '0',
        '--since',
        '2026-06-04',
        '--format',
        'json',
      ], home);
      const parsed = JSON.parse(jsonOutput);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].provider).toBe('codex-cli');
      expect(parsed[0].humanTurns).toBe(2);
      expect(parsed[0].assistantTurns).toBe(1);
      expect(parsed[0].humanMessages).toHaveLength(2);
      expect(parsed[0].tokens.input).toBe(100);
      expect(parsed[0].tokens.output).toBe(20);
      expect(parsed[0].tokens.cacheRead).toBe(10);
      expect(parsed[0].toolCounts.exec_command).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
