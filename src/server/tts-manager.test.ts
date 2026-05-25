import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
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

describe('startTTS', () => {
  it('defaults to the bundled Matilda voice and probes synthesis before returning ready', async () => {
    const manager = await startTTS({
      ttsDir: '/repo/tts',
      port: 8004,
      device: 'cpu',
    });

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8004/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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

  it('uses the GPU compose overlay for startup and shutdown when device is gpu', async () => {
    const manager = await startTTS({
      ttsDir: '/repo/tts',
      port: 8004,
      voice: '/app/voices/matilda.mp3',
      device: 'gpu',
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
      await startTTS({
        ttsDir,
        port: 8004,
        device: 'cpu',
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

      await startTTS({
        ttsDir,
        port: 8004,
        device: 'cpu',
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

  it('rebuilds when the TTS web server file changes', async () => {
    const ttsDir = await createTTSFixture();

    try {
      await startTTS({
        ttsDir,
        port: 8004,
        device: 'cpu',
      });
      execFileMock.mockClear();

      await writeFile(join(ttsDir, 'src', 'server.py'), 'print("changed")\n');

      await startTTS({
        ttsDir,
        port: 8004,
        device: 'cpu',
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
      await startTTS({
        ttsDir,
        port: 8004,
        device: 'cpu',
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
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response('voice missing', { status: 500 })),
    );

    await expect(startTTS({
      ttsDir: '/repo/tts',
      port: 8004,
      voice: '/app/voices/matilda.mp3',
      device: 'cpu',
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
});
