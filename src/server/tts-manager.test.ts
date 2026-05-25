import { beforeEach, describe, expect, it, vi } from 'vitest';

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
