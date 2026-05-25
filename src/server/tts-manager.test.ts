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
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, '', '');
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
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
});
