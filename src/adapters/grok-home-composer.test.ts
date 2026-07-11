import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { composeGrokHome, GROK_MONITORING_HOOKS_FILENAME, type GrokHomeFs } from './grok-home-composer.js';

const GROK_HOME = '/session/grok-home';
const SOURCE_GROK_HOME = '/real/home/.grok';

interface RecordedCall {
  op: keyof GrokHomeFs;
  args: unknown[];
}

interface FakeFsOptions {
  pluginEntries?: string[] | Error;
  authCopyFails?: boolean;
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
    copyFile: vi.fn(async (src: string, dest: string) => {
      record('copyFile', [src, dest]);
      if (opts.authCopyFails && src.includes('auth.json')) {
        throw new Error('ENOENT: no auth.json');
      }
    }),
    chmod: vi.fn(async (p: string, mode: number) => {
      record('chmod', [p, mode]);
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
  it('happy path: mkdir/writeFile/symlink wired, dotfiles skipped, auth seeded', async () => {
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
    expect(result.authSeeded).toBe(true);
    expect(result.hooksPath).toBe(join(GROK_HOME, 'hooks', GROK_MONITORING_HOOKS_FILENAME));
    expect(result.grokHome).toBe(GROK_HOME);

    const chmodCall = calls.find((c) => c.op === 'chmod' && (c.args[0] as string) === join(GROK_HOME, 'auth.json'));
    expect(chmodCall).toBeDefined();
    expect(chmodCall!.args[1]).toBe(0o600);
  });

  it('missing auth: copyFile rejects for auth.json -> authSeeded false, no throw', async () => {
    const { fs } = makeFakeFs({ pluginEntries: ['kookr-toolkit'], authCopyFails: true });

    const result = await composeGrokHome({
      grokHome: GROK_HOME,
      sourceGrokHome: SOURCE_GROK_HOME,
      monitoring: MONITORING,
      fs,
    });

    expect(result.authSeeded).toBe(false);
    expect(fs.chmod).not.toHaveBeenCalled();
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

  it('never writes/copies/symlinks a destination path under sourceGrokHome (real home is read-only)', async () => {
    const { fs, calls } = makeFakeFs({ pluginEntries: ['kookr-toolkit', 'userplugin'] });

    await composeGrokHome({
      grokHome: GROK_HOME,
      sourceGrokHome: SOURCE_GROK_HOME,
      monitoring: MONITORING,
      fs,
    });

    for (const call of calls) {
      if (call.op === 'mkdir' || call.op === 'writeFile' || call.op === 'symlink') {
        const destPath = call.args[call.op === 'symlink' ? 1 : 0] as string;
        expect(destPath.startsWith(SOURCE_GROK_HOME)).toBe(false);
      }
      if (call.op === 'copyFile') {
        const dest = call.args[1] as string;
        expect(dest.startsWith(SOURCE_GROK_HOME)).toBe(false);
        expect(dest.startsWith(GROK_HOME)).toBe(true);
      }
      if (call.op === 'chmod') {
        const path = call.args[0] as string;
        expect(path.startsWith(SOURCE_GROK_HOME)).toBe(false);
      }
    }

    // Sanity: the source home IS read (readdir + copyFile src), just never written.
    expect(calls.some((c) => c.op === 'readdir' && (c.args[0] as string).startsWith(SOURCE_GROK_HOME))).toBe(true);
    expect(
      calls.some((c) => c.op === 'copyFile' && (c.args[0] as string).startsWith(SOURCE_GROK_HOME)),
    ).toBe(true);
  });
});
