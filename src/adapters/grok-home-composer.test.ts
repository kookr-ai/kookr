import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  composeGrokHome,
  GROK_MONITORING_HOOKS_FILENAME,
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

    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const writeCall = calls.find((c) => c.op === 'writeFile')!;
    expect(writeCall.args[0]).toBe(join(GROK_HOME, 'hooks', GROK_MONITORING_HOOKS_FILENAME));
    expect(writeCall.args[1] as string).toContain('"PreToolUse"');

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
});
