import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  composeGrokHome,
  GROK_MONITORING_HOOKS_FILENAME,
  GROK_WRITING_REVIEW_NUDGE_FILENAME,
  sharedGrokAuthPath,
  type GrokHomeFs,
} from './grok-home-composer.js';

const GROK_HOME = '/session/grok-home';
const SOURCE_GROK_HOME = '/real/home/.grok';

interface RecordedCall {
  op: keyof GrokHomeFs;
  args: unknown[];
}

interface FakeFsOptions {
  pluginEntries?: string[] | Error;
  authMissing?: boolean;
}

function makeFakeFs(opts: FakeFsOptions = {}): { fs: Partial<GrokHomeFs>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const record = (op: keyof GrokHomeFs, args: unknown[]) => calls.push({ op, args });

  const fs: Partial<GrokHomeFs> = {
    mkdir: vi.fn(async (p: string, o: { recursive: true }) => {
      record('mkdir', [p, o]);
      return undefined;
    }),
    writeFile: vi.fn(async (p: string, data: string) => {
      record('writeFile', [p, data]);
    }),
    access: vi.fn(async (p: string) => {
      record('access', [p]);
      if (opts.authMissing && p.endsWith('auth.json')) {
        throw new Error('ENOENT: no auth.json');
      }
    }),
    symlink: vi.fn(async (target: string, path: string) => {
      record('symlink', [target, path]);
    }),
    readdir: vi.fn(async (p: string) => {
      record('readdir', [p]);
      if (opts.pluginEntries instanceof Error) {
        throw opts.pluginEntries;
      }
      return opts.pluginEntries ?? [];
    }),
  };

  return { fs, calls };
}

const MONITORING = {
  tmuxName: 'kookr-abc',
  hookFile: '/h/kookr-abc.jsonl',
};

describe('composeGrokHome', () => {
  it('happy path: mkdir/writeFile/symlink wired, dotfiles skipped, shared auth resolved', async () => {
    const { fs, calls } = makeFakeFs({ pluginEntries: ['kookr-toolkit', 'userplugin', '.hidden'] });

    const result = await composeGrokHome({
      grokHome: GROK_HOME,
      sourceGrokHome: SOURCE_GROK_HOME,
      monitoring: MONITORING,
      fs,
    });

    expect(fs.mkdir).toHaveBeenCalledWith(join(GROK_HOME, 'hooks'), { recursive: true });
    expect(fs.mkdir).toHaveBeenCalledWith(join(GROK_HOME, 'plugins'), { recursive: true });

    const writeCalls = calls.filter((c) => c.op === 'writeFile');
    expect(writeCalls.map((c) => c.args[0])).toEqual(
      expect.arrayContaining([
        join(GROK_HOME, 'hooks', GROK_MONITORING_HOOKS_FILENAME),
        join(GROK_HOME, 'hooks', GROK_WRITING_REVIEW_NUDGE_FILENAME),
      ]),
    );
    const nudgeWrite = writeCalls.find(
      (c) => c.args[0] === join(GROK_HOME, 'hooks', GROK_WRITING_REVIEW_NUDGE_FILENAME),
    );
    const nudgeJson = JSON.parse(nudgeWrite!.args[1] as string) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
    };
    expect(nudgeJson.hooks.PreToolUse[0]?.matcher).toBe('Bash');
    expect(nudgeJson.hooks.PreToolUse[0]?.hooks[0]?.type).toBe('command');
    expect(nudgeJson.hooks.PreToolUse[0]?.hooks[0]?.command).toMatch(/^\/bin\/bash /);
    expect(nudgeJson.hooks.PreToolUse[0]?.hooks[0]?.command).toContain('kookr-writing-review-nudge.sh');

    const symlinkTargets = calls.filter((c) => c.op === 'symlink').map((c) => c.args[1]);
    expect(symlinkTargets).toEqual([
      join(GROK_HOME, 'plugins', 'kookr-toolkit'),
      join(GROK_HOME, 'plugins', 'userplugin'),
    ]);
    expect(symlinkTargets).not.toContain(join(GROK_HOME, 'plugins', '.hidden'));

    expect(result.linkedPlugins).toEqual(['kookr-toolkit', 'userplugin']);
    expect(result.authPath).toBe(sharedGrokAuthPath(SOURCE_GROK_HOME));
    expect(result.authSeeded).toBe(true);
    expect(result.hooksPath).toBe(join(GROK_HOME, 'hooks', GROK_MONITORING_HOOKS_FILENAME));
    expect(result.grokHome).toBe(GROK_HOME);

    // Never copy auth into the session home (would clone a rotating OIDC RT).
    expect(calls.some((c) => c.op === 'access' && c.args[0] === sharedGrokAuthPath(SOURCE_GROK_HOME))).toBe(
      true,
    );
    expect(calls.some((c) => (c.args[0] as string)?.includes?.('auth.json') && c.op === 'writeFile')).toBe(
      false,
    );
    expect(
      calls.some(
        (c) =>
          c.op === 'symlink' &&
          typeof c.args[1] === 'string' &&
          (c.args[1] as string).endsWith('auth.json'),
      ),
    ).toBe(false);
  });

  it('missing auth: access rejects for auth.json -> authPath null, no throw', async () => {
    const { fs } = makeFakeFs({ pluginEntries: ['kookr-toolkit'], authMissing: true });

    const result = await composeGrokHome({
      grokHome: GROK_HOME,
      sourceGrokHome: SOURCE_GROK_HOME,
      monitoring: MONITORING,
      fs,
    });

    expect(result.authPath).toBeNull();
    expect(result.authSeeded).toBe(false);
  });

  it('missing plugins dir: readdir rejects -> linkedPlugins [], no throw', async () => {
    const { fs } = makeFakeFs({ pluginEntries: new Error('ENOENT: no plugins dir') });

    const result = await composeGrokHome({
      grokHome: GROK_HOME,
      sourceGrokHome: SOURCE_GROK_HOME,
      monitoring: MONITORING,
      fs,
    });

    expect(result.linkedPlugins).toEqual([]);
    expect(fs.symlink).not.toHaveBeenCalled();
  });

  it('never writes under sourceGrokHome for hooks/plugins composition (auth is shared, not copied)', async () => {
    const { fs, calls } = makeFakeFs({ pluginEntries: ['kookr-toolkit', 'userplugin'] });

    await composeGrokHome({
      grokHome: GROK_HOME,
      sourceGrokHome: SOURCE_GROK_HOME,
      monitoring: MONITORING,
      fs,
    });

    for (const call of calls) {
      if (call.op === 'mkdir' || call.op === 'writeFile') {
        const destPath = call.args[0] as string;
        expect(destPath.startsWith(SOURCE_GROK_HOME)).toBe(false);
      }
      if (call.op === 'symlink') {
        // Link target may live under source; destination path must stay under session home.
        const destPath = call.args[1] as string;
        expect(destPath.startsWith(SOURCE_GROK_HOME)).toBe(false);
        expect(destPath.startsWith(GROK_HOME)).toBe(true);
      }
    }

    // Source home is probed for auth + plugins; composition does not copy auth.
    expect(calls.some((c) => c.op === 'readdir' && (c.args[0] as string).startsWith(SOURCE_GROK_HOME))).toBe(
      true,
    );
    expect(calls.some((c) => c.op === 'access' && (c.args[0] as string).startsWith(SOURCE_GROK_HOME))).toBe(
      true,
    );
  });

  it('falls back to the Claude-resolved toolkit tree when ~/.grok/plugins lacks kookr-toolkit', async () => {
    const toolkitDir = '/prod/kookr/plugin';
    const { fs, calls } = makeFakeFs({ pluginEntries: ['other-plugin'] });

    const result = await composeGrokHome({
      grokHome: GROK_HOME,
      sourceGrokHome: SOURCE_GROK_HOME,
      monitoring: MONITORING,
      toolkitPluginDir: toolkitDir,
      fs,
    });

    expect(result.linkedPlugins).toEqual(['other-plugin', 'kookr-toolkit']);
    expect(calls).toContainEqual({
      op: 'symlink',
      args: [toolkitDir, join(GROK_HOME, 'plugins', 'kookr-toolkit')],
    });
  });

  it('does not double-link kookr-toolkit when ~/.grok/plugins already has it', async () => {
    const toolkitDir = '/prod/kookr/plugin';
    const { fs, calls } = makeFakeFs({ pluginEntries: ['kookr-toolkit'] });

    const result = await composeGrokHome({
      grokHome: GROK_HOME,
      sourceGrokHome: SOURCE_GROK_HOME,
      monitoring: MONITORING,
      toolkitPluginDir: toolkitDir,
      fs,
    });

    expect(result.linkedPlugins).toEqual(['kookr-toolkit']);
    const toolkitSymlinks = calls.filter(
      (c) => c.op === 'symlink' && String(c.args[1]).endsWith('kookr-toolkit'),
    );
    expect(toolkitSymlinks).toHaveLength(1);
    expect(toolkitSymlinks[0].args[0]).toBe(join(SOURCE_GROK_HOME, 'plugins', 'kookr-toolkit'));
  });
});
