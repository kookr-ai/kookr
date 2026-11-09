import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildKookrPluginSource, type ClaudeHooksConfig } from './kookr-plugin-source.js';

async function load(hookCommand: string, dir: string) {
  const file = join(dir, 'kookr.mjs');
  writeFileSync(file, buildKookrPluginSource({ hookCommand, sessionId: 'sess-1', cwd: '/work' }));
  const mod = (await import(pathToFileURL(file).href)) as { Kookr: (c: unknown) => Promise<Record<string, (...a: any[]) => Promise<void>>> };
  return mod.Kookr({});
}

describe('kookr opencode plugin', () => {
  it('emits Claude-shaped hook JSONL for a simulated session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-plugin-'));
    const out = join(dir, 'out.jsonl');
    const hooks = await load(`cat >> '${out}'; echo >> '${out}'`, dir);
    await hooks['chat.message']!({}, { parts: [{ type: 'text', text: 'do it' }] });
    await hooks['tool.execute.before']!({ tool: 'bash', callID: 'c1' }, { args: { command: 'echo hi' } });
    await hooks['tool.execute.after']!({ tool: 'bash', callID: 'c1' }, { output: 'hi' });
    await hooks['tool.execute.before']!({ tool: 'webfetch', callID: 'c2' }, { args: { url: 'x' } });
    await hooks.event!({ event: { type: 'message.part.delta' } });
    await hooks.event!({ event: { type: 'session.idle' } });
    await hooks.event!({ event: { type: 'session.idle' } });
    await hooks.event!({ event: { type: 'session.error' } });

    const recs = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(recs.map((r) => r.hook_event_name)).toEqual([
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreToolUse', 'Stop', 'StopFailure',
    ]);
    expect(recs[0]).toMatchObject({ session_id: 'sess-1', cwd: '/work', source: 'startup', transcript_path: '' });
    expect(recs[1].prompt).toBe('do it');
    expect(recs[2]).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'echo hi' } });
    expect(recs[3]).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: 'hi' });
    expect(recs[4].tool_name).toBe('Webfetch');
  });

  it('never throws and writes diagnostics when the hook command fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-plugin-'));
    const dbg = join(dir, 'dbg.log');
    process.env.KOOKR_OPENCODE_PLUGIN_DEBUG = dbg;
    try {
      const hooks = await load('exit 1', dir);
      await expect(hooks['tool.execute.before']!({ tool: 'bash' }, undefined)).resolves.toBeUndefined();
      await expect(hooks.event!({ event: undefined })).resolves.toBeUndefined();
      expect(existsSync(dbg)).toBe(true);
    } finally {
      delete process.env.KOOKR_OPENCODE_PLUGIN_DEBUG;
    }
  });
});

type Hooks = Record<string, (...a: any[]) => Promise<void>>;

async function loadRunner(claudeHooks: ClaudeHooksConfig, ctx: unknown = {}): Promise<{ hooks: Hooks; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'kookr-runner-'));
  const file = join(dir, 'kookr.mjs');
  writeFileSync(file, buildKookrPluginSource({ hookCommand: 'cat >/dev/null', sessionId: 's', cwd: dir, claudeHooks }));
  const mod = (await import(pathToFileURL(file).href)) as { Kookr: (c: unknown) => Promise<Hooks> };
  return { hooks: await mod.Kookr(ctx), dir };
}

function script(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe('claude hook runner', () => {
  it('PreToolUse: matcher filtering, exit 2 blocks with stderr, other codes fail open, env expands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-h-'));
    const deny = script(dir, 'deny.sh', 'echo "no rm: $MYVAR $CLAUDE_PROJECT_DIR" >&2; exit 2');
    const fail1 = script(dir, 'f1.sh', 'exit 1');
    const { hooks } = await loadRunner({
      env: { MYVAR: 'ok' },
      hooks: { PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: fail1 }, { type: 'command', command: deny }] },
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: deny }] },
        { hooks: [{ type: 'command', command: '/nonexistent/cmd' }] },
      ] },
    });
    await expect(hooks['tool.execute.before']!({ tool: 'bash' }, { args: { command: 'rm x' } })).rejects.toThrow(/no rm: ok /);
    await expect(hooks['tool.execute.before']!({ tool: 'read' }, { args: {} })).resolves.toBeUndefined();
    await expect(hooks['tool.execute.before']!({ tool: 'write' }, { args: {} })).rejects.toThrow(/no rm/);
  });

  it('SessionStart stdout is injected via system transform', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-h-'));
    const s = script(dir, 'ctx.sh', 'echo SECRET-WORD');
    const { hooks } = await loadRunner({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: s }] }] } });
    const out = { system: ['base'] as string[] };
    await hooks['experimental.chat.system.transform']!({}, out);
    expect(out.system).toEqual(['base', 'SECRET-WORD']);
  });

  it('Stop exit 2 re-prompts with stderr, sets stop_hook_active, and caps at 4', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-h-'));
    const log = join(dir, 'stop.log');
    const s = script(dir, 'stop.sh', `cat >> '${log}'; echo >> '${log}'; echo "keep going" >&2; exit 2`);
    const prompts: any[] = [];
    const ctx = { client: { session: { prompt: async (a: unknown) => { prompts.push(a); } } } };
    const { hooks } = await loadRunner({ hooks: { Stop: [{ hooks: [{ type: 'command', command: s }] }] } }, ctx);
    for (let i = 0; i < 6; i++) await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toEqual({ path: { id: 'ses_1' }, body: { parts: [{ type: 'text', text: 'keep going' }] } });
    const recs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(recs[0].stop_hook_active).toBe(false);
    expect(recs[1].stop_hook_active).toBe(true);
  });

  it('a block by a kookr-owned once-only Stop hook does not mark the next Stop as a stop-hook re-entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-h-'));
    const log = join(dir, 'stop.log');
    const state = join(dir, 'blocked-once');
    // Named like the real gate so the plugin recognises it; blocks the first Stop only.
    const gate = script(dir, 'kookr-opencode-gate.sh',
      `cat >> '${log}'; echo >> '${log}'; if [ -e '${state}' ]; then exit 0; fi; touch '${state}'; echo "missing commit" >&2; exit 2`);
    const prompts: any[] = [];
    const ctx = { client: { session: { prompt: async (a: unknown) => { prompts.push(a); } } } };
    const { hooks } = await loadRunner({ hooks: { Stop: [{ hooks: [{ type: 'command', command: gate }] }] } }, ctx);
    for (let i = 0; i < 2; i++) await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    expect(prompts).toHaveLength(1);
    const recs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(recs.map((r) => r.stop_hook_active)).toEqual([false, false]);
  });

  it('fails open on timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-h-'));
    const slow = script(dir, 'slow.sh', 'sleep 5; exit 2');
    const { hooks } = await loadRunner({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: slow, timeout: 1 }] }] } });
    await expect(hooks['tool.execute.before']!({ tool: 'bash' }, { args: {} })).resolves.toBeUndefined();
  }, 10000);
});

describe('claude hook runner: Stop JSON decision protocol', () => {
  it('treats exit 0 + {"decision":"block"} stdout (kookr-stop-nudge) as a re-prompt, ignores plain stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-h-'));
    const nudge = script(dir, 'nudge.sh', `echo '{"decision":"block","reason":"signal completion"}'`);
    const plain = script(dir, 'plain.sh', 'echo just text');
    const prompts: any[] = [];
    const ctx = { client: { session: { prompt: async (a: unknown) => { prompts.push(a); } } } };
    const { hooks } = await loadRunner({ hooks: { Stop: [{ hooks: [{ type: 'command', command: plain }, { type: 'command', command: nudge }] }] } }, ctx);
    await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    expect(prompts).toEqual([{ path: { id: 'ses_1' }, body: { parts: [{ type: 'text', text: 'signal completion' }] } }]);
  });
});
