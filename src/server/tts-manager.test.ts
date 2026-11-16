import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import {
  evaluateTTSReuseOnce,
  parseTTSDevice,
  resolveTTSDevice,
  startTTS,
} from './tts-manager.js';

beforeEach(() => {
  vi.stubEnv('KOOKR_TTS_DEVICE', '');
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, '', '');
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function createTTSFixture(): Promise<string> {
  const ttsDir = await mkdtemp(join(tmpdir(), 'kookr-tts-test-'));
  await mkdir(join(ttsDir, 'src'));
  await mkdir(join(ttsDir, 'voices'));
  await writeFile(join(ttsDir, 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(ttsDir, 'docker-compose.yml'), 'services:\n  kookr-tts:\n    build: .\n');
  await writeFile(join(ttsDir, 'docker-compose.gpu.yml'), 'services:\n  kookr-tts: {}\n');
  await writeFile(join(ttsDir, 'src', 'server.py'), 'print("hello")\n');
  await writeFile(join(ttsDir, 'voices', 'matilda.mp3'), 'voice');
  return ttsDir;
}

describe('parseTTSDevice', () => {
  it('defaults to auto when unset', () => {
    expect(parseTTSDevice(undefined)).toBe('auto');
    expect(parseTTSDevice('')).toBe('auto');
  });

  it('accepts auto, cpu, gpu (case-insensitive, trimmed)', () => {
    expect(parseTTSDevice('auto')).toBe('auto');
    expect(parseTTSDevice('cpu')).toBe('cpu');
    expect(parseTTSDevice('gpu')).toBe('gpu');
    expect(parseTTSDevice('  GPU  ')).toBe('gpu');
    expect(parseTTSDevice('Cpu')).toBe('cpu');
  });

  it('falls back to auto for unknown values', () => {
    expect(parseTTSDevice('cuda')).toBe('auto');
    expect(parseTTSDevice('nvidia')).toBe('auto');
  });
});

describe('resolveTTSDevice', () => {
  it('passes through explicit cpu and gpu without probing', async () => {
    const probe = async () => {
      throw new Error('should not be called');
    };
    expect(await resolveTTSDevice('cpu', probe)).toBe('cpu');
    expect(await resolveTTSDevice('gpu', probe)).toBe('gpu');
  });

  it('resolves auto to gpu when the probe finds an nvidia runtime', async () => {
    expect(await resolveTTSDevice('auto', async () => true)).toBe('gpu');
  });

  it('resolves auto to cpu when the probe finds no nvidia runtime', async () => {
    expect(await resolveTTSDevice('auto', async () => false)).toBe('cpu');
  });
});

describe('evaluateTTSReuseOnce', () => {
  it('accepts minimal status:ok JSON', async () => {
    const result = await evaluateTTSReuseOnce(8004);
    expect(result).toEqual({ ok: true, status: 'ok' });
  });

  it('rejects unparseable body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })));
    const result = await evaluateTTSReuseOnce(8004);
    expect(result).toEqual({ ok: false, reason: 'unparseable' });
  });
});

describe('startTTS', () => {
  it('healthy reuse path invokes zero docker commands and skips synthesis probe', async () => {
    const manager = await startTTS({
      ttsDir: '/repo/tts',
      port: 8004,
      device: 'cpu',
      reuseAttempts: 1,
    });

    expect(execFileMock).not.toHaveBeenCalled();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8004/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // No synthesize call on reuse.
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes('/synthesize')),
    ).toBe(false);
    expect(manager.url).toBe('http://localhost:8004');
  });

  it('cold start probes synthesis before returning ready', async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        fetchCount += 1;
        const href = String(url);
        // First call is reuse health — fail so we cold-start.
        if (fetchCount === 1) {
          throw new Error('connection refused');
        }
        if (href.includes('/synthesize')) {
          return new Response('ok', { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }),
    );

    const manager = await startTTS({
      ttsDir: '/repo/tts',
      port: 8004,
      device: 'cpu',
      reuseAttempts: 1,
    });

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8004/synthesize',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'ready',
          voice: '/app/voices/matilda.mp3',
          params: { framesAfterEos: 0 },
        }),
        signal: expect.any(AbortSignal),
      }),
    );

    await manager.stop();
  });

  it('uses the GPU compose overlay for cold start and shutdown when device is gpu', async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        fetchCount += 1;
        if (fetchCount === 1) throw new Error('down');
        if (String(url).includes('/synthesize')) {
          return new Response('ok', { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }),
    );

    const manager = await startTTS({
      ttsDir: '/repo/tts',
      port: 8004,
      voice: '/app/voices/matilda.mp3',
      device: 'gpu',
      reuseAttempts: 1,
    });

    expect(execFileMock).toHaveBeenCalledWith(
      'docker',
      [
        'compose',
        '-f',
        '/repo/tts/docker-compose.yml',
        '-f',
        '/repo/tts/docker-compose.gpu.yml',
        'up',
        '-d',
        '--build',
      ],
      expect.objectContaining({ timeout: 600_000 }),
      expect.any(Function),
    );

    await manager.stop();

    expect(execFileMock).toHaveBeenLastCalledWith(
      'docker',
      [
        'compose',
        '-f',
        '/repo/tts/docker-compose.yml',
        '-f',
        '/repo/tts/docker-compose.gpu.yml',
        'down',
      ],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
  });

  it('skips docker rebuilds after the TTS image inputs are already built', async () => {
    const ttsDir = await createTTSFixture();

    try {
      // The first health check of each startTTS call (the reuse check) fails.
      let down = true;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request) => {
          if (down && String(url).includes('/health')) {
            down = false;
            throw new Error('down');
          }
          if (String(url).includes('/synthesize')) {
            return new Response('ok', { status: 200 });
          }
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }),
      );

      await startTTS({
        ttsDir,
        port: 8004,
        device: 'cpu',
        reuseAttempts: 1,
      });

      expect(execFileMock).toHaveBeenCalledWith(
        'docker',
        [
          'compose',
          '-f',
          join(ttsDir, 'docker-compose.yml'),
          'up',
          '-d',
          '--build',
        ],
        expect.objectContaining({ timeout: 600_000 }),
        expect.any(Function),
      );

      execFileMock.mockClear();
      down = true;

      await startTTS({
        ttsDir,
        port: 8004,
        device: 'cpu',
        reuseAttempts: 1,
      });

      expect(execFileMock).toHaveBeenCalledWith(
        'docker',
        [
          'compose',
          '-f',
          join(ttsDir, 'docker-compose.yml'),
          'up',
          '-d',
        ],
        expect.objectContaining({ timeout: 600_000 }),
        expect.any(Function),
      );
    } finally {
      await rm(ttsDir, { recursive: true, force: true });
    }
  });

  it('reuses a healthy service whose build inputs are unchanged, and rebuilds it once they change', async () => {
    const ttsDir = await createTTSFixture();
    const upArgs = ['compose', '-f', join(ttsDir, 'docker-compose.yml'), 'up', '-d', '--build'];
    const start = () => startTTS({ ttsDir, port: 8004, device: 'cpu', reuseAttempts: 1 });
    // Probes of the configured voice; the background warm-up of the other engine is not one.
    const synthesisProbes = () =>
      vi.mocked(fetch).mock.calls.filter(
        (c) => String(c[0]).includes('/synthesize') && String(c[1]?.body).includes('matilda'),
      ).length;

    try {
      // First start: nothing is running, so the image is built and its inputs are stamped.
      let down = true;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request) => {
          if (down && String(url).includes('/health')) {
            down = false;
            throw new Error('down');
          }
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }),
      );
      await start();
      expect(execFileMock).toHaveBeenCalledWith('docker', upArgs, expect.anything(), expect.any(Function));

      // Second start: healthy, same inputs. Reused without touching docker.
      execFileMock.mockClear();
      vi.mocked(fetch).mockClear();
      await start();
      expect(execFileMock).not.toHaveBeenCalled();
      expect(synthesisProbes()).toBe(0);

      // The service code changes while the old container is still healthy.
      await writeFile(join(ttsDir, 'src', 'server.py'), 'print("a new voice")\n');
      execFileMock.mockClear();
      vi.mocked(fetch).mockClear();
      await start();
      expect(execFileMock).toHaveBeenCalledWith('docker', upArgs, expect.anything(), expect.any(Function));
      // The rebuilt service is probed like a cold start before it is reported ready.
      expect(synthesisProbes()).toBe(1);

      // And the new inputs are stamped: the next start reuses it again.
      execFileMock.mockClear();
      await start();
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      await rm(ttsDir, { recursive: true, force: true });
    }
  });

  it('reuses a healthy service when no earlier build left a stamp', async () => {
    const ttsDir = await createTTSFixture();

    try {
      await startTTS({ ttsDir, port: 8004, device: 'cpu', reuseAttempts: 1 });

      // Nothing is known about how the running service was built, so it is left alone.
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      await rm(ttsDir, { recursive: true, force: true });
    }
  });

  it('keeps the running service when the rebuild of a stale one fails, and tries again next start', async () => {
    const ttsDir = await createTTSFixture();
    const stampPath = join(ttsDir, '.kookr-tts-build.hash');
    const start = () => startTTS({ ttsDir, port: 8004, device: 'cpu', reuseAttempts: 1 });
    const calls = (verb: string) => execFileMock.mock.calls.filter((c) => (c[1] as string[]).includes(verb)).length;

    try {
      // A stamp from an earlier build of different files: the running service is stale.
      await writeFile(stampPath, 'hash-of-older-files\n');
      execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('build')) cb(new Error('package index unreachable'), '', '');
        else cb(null, '', '');
      });

      const manager = await start();

      // The build failed before anything touched the container: it is still the one in use.
      expect(manager.url).toBe('http://localhost:8004');
      expect(calls('build')).toBe(1);
      expect(calls('up')).toBe(0);
      expect(calls('down')).toBe(0);
      // The failed build is not stamped, or the stale service would be reused from now on.
      expect((await readFile(stampPath, 'utf-8')).trim()).toBe('hash-of-older-files');

      // The next start tries again, replaces the container, and stamps the new files.
      execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '', '');
      });
      await start();
      expect(calls('build')).toBe(2);
      expect(calls('up')).toBe(1);
      expect((await readFile(stampPath, 'utf-8')).trim()).not.toBe('hash-of-older-files');
    } finally {
      await rm(ttsDir, { recursive: true, force: true });
    }
  });

  describe('rollback when a rebuilt image fails (#3656)', () => {
    const OLD_IMAGE = 'sha256:0123456789abcdef';
    const IMAGE_NAME = 'tts-kookr-tts';
    const dockerVerbs = () => execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));

    /**
     * A healthy service runs from an image built from older files. docker inspect reports
     * OLD_IMAGE; the rebuilt image fails in the way `newImage` says, and once `docker tag`
     * has pointed the name back at OLD_IMAGE the restarted service passes its checks.
     */
    function stubStaleService(newImage: 'probe-fails' | 'never-healthy', opts: { tagFails?: boolean } = {}) {
      let current: 'old' | 'new' = 'old';
      execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args[0] === 'inspect') return cb(null, { stdout: `${OLD_IMAGE} ${IMAGE_NAME}\n`, stderr: '' });
        if (args[0] === 'tag') {
          if (opts.tagFails) return cb(new Error('No such image'), '', '');
          current = 'old';
        }
        if (args.includes('up') && args.includes('--build')) current = 'new';
        cb(null, '', '');
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request) => {
          const href = String(url);
          if (current === 'new' && newImage === 'never-healthy') throw new Error('connection refused');
          if (href.includes('/synthesize') && current === 'new') {
            return new Response('model failed to load', { status: 500 });
          }
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }),
      );
    }

    it('restarts the previous image when the rebuilt one fails its voice probe, and does not retry the same files', async () => {
      const ttsDir = await createTTSFixture();
      const stampPath = join(ttsDir, '.kookr-tts-build.hash');
      const failedPath = join(ttsDir, '.kookr-tts-failed.hash');
      const start = () => startTTS({ ttsDir, port: 8004, device: 'cpu', reuseAttempts: 1 });

      try {
        await writeFile(stampPath, 'hash-of-older-files\n');
        stubStaleService('probe-fails');

        const manager = await start();

        expect(manager.url).toBe('http://localhost:8004');
        const verbs = dockerVerbs();
        const tagAt = verbs.indexOf(`tag ${OLD_IMAGE} ${IMAGE_NAME}`);
        expect(tagAt).toBeGreaterThan(verbs.findIndex((v) => v.endsWith('up -d --build')));
        expect(verbs.slice(tagAt + 1).some((v) => v.endsWith('up -d --no-build'))).toBe(true);
        // The restarted service is the old one: its stamp still says so.
        expect((await readFile(stampPath, 'utf-8')).trim()).toBe('hash-of-older-files');
        const failedHash = (await readFile(failedPath, 'utf-8')).trim();
        expect(failedHash).toMatch(/^[0-9a-f]{64}$/);

        // Next start, same files: the healthy old service is kept and nothing is rebuilt.
        execFileMock.mockClear();
        await start();
        expect(execFileMock).not.toHaveBeenCalled();

        // The files change (a fix lands): the rebuild is tried again, passes, and is stamped.
        await writeFile(join(ttsDir, 'src', 'server.py'), 'print("fixed")\n');
        execFileMock.mockReset();
        execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, '', '');
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })));
        await start();
        expect(dockerVerbs().some((v) => v.endsWith('up -d --build'))).toBe(true);
        const newStamp = (await readFile(stampPath, 'utf-8')).trim();
        expect(newStamp).not.toBe('hash-of-older-files');
        expect(newStamp).not.toBe(failedHash);
        await expect(readFile(failedPath, 'utf-8')).rejects.toThrow(/ENOENT/);
      } finally {
        await rm(ttsDir, { recursive: true, force: true });
      }
    });

    it('restarts the previous image when the rebuilt one never becomes healthy', async () => {
      const ttsDir = await createTTSFixture();
      try {
        await writeFile(join(ttsDir, '.kookr-tts-build.hash'), 'hash-of-older-files\n');
        stubStaleService('never-healthy');

        const manager = await startTTS({
          ttsDir, port: 8004, device: 'cpu', reuseAttempts: 1, startupTimeoutMs: 50,
        });

        expect(manager.url).toBe('http://localhost:8004');
        expect(dockerVerbs()).toContain(`tag ${OLD_IMAGE} ${IMAGE_NAME}`);
        expect(dockerVerbs().at(-1)).toMatch(/up -d --no-build$/);
      } finally {
        await rm(ttsDir, { recursive: true, force: true });
      }
    });

    it('takes the service down and reports both failures when the previous image cannot be restarted', async () => {
      const ttsDir = await createTTSFixture();
      try {
        await writeFile(join(ttsDir, '.kookr-tts-build.hash'), 'hash-of-older-files\n');
        stubStaleService('probe-fails', { tagFails: true });

        await expect(startTTS({ ttsDir, port: 8004, device: 'cpu', reuseAttempts: 1 })).rejects.toThrow(
          /synthesis probe failed: HTTP 500: model failed to load; restarting the previous TTS image also failed: No such image/,
        );
        expect(dockerVerbs().some((v) => v.endsWith(' down'))).toBe(true);
        expect(dockerVerbs().some((v) => v.includes('--no-build'))).toBe(false);
        // Nothing was rolled back, so the failure is not remembered: the next start retries.
        await expect(readFile(join(ttsDir, '.kookr-tts-failed.hash'), 'utf-8')).rejects.toThrow(/ENOENT/);
      } finally {
        await rm(ttsDir, { recursive: true, force: true });
      }
    });

    it('keeps the former teardown when the running image cannot be read', async () => {
      const ttsDir = await createTTSFixture();
      try {
        await writeFile(join(ttsDir, '.kookr-tts-build.hash'), 'hash-of-older-files\n');
        stubStaleService('probe-fails');
        const withImage = execFileMock.getMockImplementation()!;
        execFileMock.mockImplementation((cmd: string, args: string[], o: unknown, cb: Function) =>
          args[0] === 'inspect' ? cb(new Error('No such object: kookr-tts'), '', '') : withImage(cmd, args, o, cb),
        );

        await expect(startTTS({ ttsDir, port: 8004, device: 'cpu', reuseAttempts: 1 })).rejects.toThrow(
          '[tts] TTS service health passed but synthesis probe failed: HTTP 500: model failed to load',
        );
        expect(dockerVerbs().at(-1)).toMatch(/ down$/);
        expect(dockerVerbs().some((v) => v.startsWith('tag '))).toBe(false);
      } finally {
        await rm(ttsDir, { recursive: true, force: true });
      }
    });

    it('does not stamp a freshly built image that fails its voice probe', async () => {
      const ttsDir = await createTTSFixture();
      try {
        let down = true;
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string | URL | Request) => {
            if (down && String(url).includes('/health')) {
              down = false;
              throw new Error('down');
            }
            if (String(url).includes('/synthesize')) return new Response('boom', { status: 500 });
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
          }),
        );

        await expect(startTTS({ ttsDir, port: 8004, device: 'cpu', reuseAttempts: 1 })).rejects.toThrow(
          /synthesis probe failed/,
        );
        // Unstamped, so the next start builds again instead of reusing the failed image.
        await expect(readFile(join(ttsDir, '.kookr-tts-build.hash'), 'utf-8')).rejects.toThrow(/ENOENT/);
      } finally {
        await rm(ttsDir, { recursive: true, force: true });
      }
    });
  });

  describe('second voice engine warm-up (#3656)', () => {
    const synthesizedVoices = () =>
      vi.mocked(fetch).mock.calls
        .filter((c) => String(c[0]).includes('/synthesize'))
        .map((c) => JSON.parse(String(c[1]?.body)).voice as string);

    function stubColdStart(synthesize: (voice: string) => Response | Promise<Response>) {
      let down = true;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          const href = String(url);
          if (down && href.includes('/health')) {
            down = false;
            throw new Error('down');
          }
          if (href.includes('/synthesize')) return synthesize(JSON.parse(String(init?.body)).voice);
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }),
      );
    }

    it('loads Kokoro after a fresh start whose default voice is Matilda', async () => {
      stubColdStart(() => new Response('ok', { status: 200 }));
      await startTTS({ ttsDir: '/repo/tts', port: 8004, device: 'cpu', reuseAttempts: 1 });
      expect(synthesizedVoices()).toEqual(['/app/voices/matilda.mp3', 'af_heart']);
    });

    it('loads Pocket TTS (Matilda) after a fresh start whose default voice is a Kokoro voice', async () => {
      stubColdStart(() => new Response('ok', { status: 200 }));
      await startTTS({ ttsDir: '/repo/tts', port: 8004, voice: 'af_sky', device: 'cpu', reuseAttempts: 1 });
      expect(synthesizedVoices()).toEqual(['af_sky', '/app/voices/matilda.mp3']);
    });

    it('does not wait for the warm-up, and a failed warm-up neither fails the start nor tears down', async () => {
      let rejectWarmUp: (err: Error) => void = () => {};
      stubColdStart((voice) =>
        voice === 'af_heart'
          ? new Promise<Response>((_resolve, reject) => { rejectWarmUp = reject; })
          : new Response('ok', { status: 200 }),
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // Resolves although the warm-up request is still pending.
        const manager = await startTTS({ ttsDir: '/repo/tts', port: 8004, device: 'cpu', reuseAttempts: 1 });
        expect(manager.url).toBe('http://localhost:8004');

        rejectWarmUp(new Error('Kokoro weights missing'));
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('Kokoro weights missing')),
        );
        const verbs = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
        expect(verbs.some((v) => v.endsWith(' down'))).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('rebuilds when the TTS web server file changes', async () => {
    const ttsDir = await createTTSFixture();

    try {
      let fetchCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request) => {
          fetchCount += 1;
          if (fetchCount === 1 || fetchCount === 4) throw new Error('down');
          if (String(url).includes('/synthesize')) {
            return new Response('ok', { status: 200 });
          }
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }),
      );

      await startTTS({
        ttsDir,
        port: 8004,
        device: 'cpu',
        reuseAttempts: 1,
      });
      execFileMock.mockClear();

      await writeFile(join(ttsDir, 'src', 'server.py'), 'print("changed")\n');

      await startTTS({
        ttsDir,
        port: 8004,
        device: 'cpu',
        reuseAttempts: 1,
      });

      expect(execFileMock).toHaveBeenCalledWith(
        'docker',
        [
          'compose',
          '-f',
          join(ttsDir, 'docker-compose.yml'),
          'up',
          '-d',
          '--build',
        ],
        expect.objectContaining({ timeout: 600_000 }),
        expect.any(Function),
      );
    } finally {
      await rm(ttsDir, { recursive: true, force: true });
    }
  });

  it('rebuilds when the TTS compose build definition changes', async () => {
    const ttsDir = await createTTSFixture();

    try {
      let fetchCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request) => {
          fetchCount += 1;
          if (fetchCount === 1 || fetchCount === 4) throw new Error('down');
          if (String(url).includes('/synthesize')) {
            return new Response('ok', { status: 200 });
          }
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }),
      );

      await startTTS({
        ttsDir,
        port: 8004,
        device: 'cpu',
        reuseAttempts: 1,
      });
      execFileMock.mockClear();

      await writeFile(
        join(ttsDir, 'docker-compose.yml'),
        'services:\n  kookr-tts:\n    build:\n      context: .\n      dockerfile: Dockerfile\n',
      );

      await startTTS({
        ttsDir,
        port: 8004,
        device: 'cpu',
        reuseAttempts: 1,
      });

      expect(execFileMock).toHaveBeenCalledWith(
        'docker',
        [
          'compose',
          '-f',
          join(ttsDir, 'docker-compose.yml'),
          'up',
          '-d',
          '--build',
        ],
        expect.objectContaining({ timeout: 600_000 }),
        expect.any(Function),
      );
    } finally {
      await rm(ttsDir, { recursive: true, force: true });
    }
  });

  it('tears down and rejects when health passes but configured voice synthesis fails', async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        fetchCount += 1;
        if (fetchCount === 1) throw new Error('down'); // fail reuse
        if (String(url).includes('/synthesize')) {
          return new Response('voice missing', { status: 500 });
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }),
    );

    await expect(startTTS({
      ttsDir: '/repo/tts',
      port: 8004,
      voice: '/app/voices/matilda.mp3',
      device: 'cpu',
      reuseAttempts: 1,
    })).rejects.toThrow(
      '[tts] TTS service health passed but synthesis probe failed: HTTP 500: voice missing',
    );

    expect(execFileMock).toHaveBeenLastCalledWith(
      'docker',
      [
        'compose',
        '-f',
        '/repo/tts/docker-compose.yml',
        'down',
      ],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
  });

  it('failed cold-start health timeout still compose-downs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    await expect(
      startTTS({
        ttsDir: '/repo/tts',
        port: 8004,
        device: 'cpu',
        reuseAttempts: 1,
        startupTimeoutMs: 50,
      }),
    ).rejects.toThrow(/did not become healthy/);

    const dockerCalls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(dockerCalls.some((c) => c.includes('down'))).toBe(true);
  });
});
