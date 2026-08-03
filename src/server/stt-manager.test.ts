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
  DEFAULT_STT_STARTUP_TIMEOUT_MS,
  evaluateSTTReuseOnce,
  parseSTTDevice,
  parseSTTHealthTimeoutMs,
  resolveDevice,
  startSTT,
} from './stt-manager.js';

beforeEach(() => {
  vi.stubEnv('KOOKR_STT_DEVICE', '');
  vi.stubEnv('WHISPER_MODEL', '');
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, '', '');
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok', backend: 'whisper', model_loaded: false, model_name: 'parakeet-tdt-0.6b-v3' }), {
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

async function createSTTFixture(): Promise<string> {
  const sttDir = await mkdtemp(join(tmpdir(), 'kookr-stt-test-'));
  await mkdir(join(sttDir, 'src'));
  await writeFile(join(sttDir, 'Dockerfile'), 'FROM node:22\n');
  await writeFile(join(sttDir, 'docker-compose.yml'), 'services:\n  kookr-stt:\n    build: .\n');
  await writeFile(join(sttDir, 'docker-compose.gpu.yml'), 'services:\n  kookr-stt: {}\n');
  await writeFile(join(sttDir, 'package.json'), '{"name":"stt"}\n');
  await writeFile(join(sttDir, 'src', 'server.js'), 'console.log("stt")\n');
  return sttDir;
}

describe('parseSTTHealthTimeoutMs', () => {
  it('defaults to 600 seconds for first-run model downloads', () => {
    expect(parseSTTHealthTimeoutMs(undefined)).toBe(DEFAULT_STT_STARTUP_TIMEOUT_MS);
    expect(DEFAULT_STT_STARTUP_TIMEOUT_MS).toBe(600_000);
  });

  it('honors KOOKR_STT_HEALTH_TIMEOUT_S values', () => {
    expect(parseSTTHealthTimeoutMs('900')).toBe(900_000);
    expect(parseSTTHealthTimeoutMs('0.5')).toBe(500);
  });

  it('ignores invalid timeout values', () => {
    expect(parseSTTHealthTimeoutMs('0')).toBe(DEFAULT_STT_STARTUP_TIMEOUT_MS);
    expect(parseSTTHealthTimeoutMs('-1')).toBe(DEFAULT_STT_STARTUP_TIMEOUT_MS);
    expect(parseSTTHealthTimeoutMs('nope')).toBe(DEFAULT_STT_STARTUP_TIMEOUT_MS);
  });
});

describe('parseSTTDevice', () => {
  it('defaults to auto when unset', () => {
    expect(parseSTTDevice(undefined)).toBe('auto');
    expect(parseSTTDevice('')).toBe('auto');
  });

  it('accepts auto, cpu, gpu (case-insensitive, trimmed)', () => {
    expect(parseSTTDevice('auto')).toBe('auto');
    expect(parseSTTDevice('cpu')).toBe('cpu');
    expect(parseSTTDevice('gpu')).toBe('gpu');
    expect(parseSTTDevice('  GPU  ')).toBe('gpu');
    expect(parseSTTDevice('Cpu')).toBe('cpu');
  });

  it('falls back to auto for unknown values', () => {
    expect(parseSTTDevice('cuda')).toBe('auto');
    expect(parseSTTDevice('nvidia')).toBe('auto');
  });
});

describe('resolveDevice', () => {
  it('passes through explicit cpu and gpu without probing', async () => {
    const probe = async () => {
      throw new Error('should not be called');
    };
    expect(await resolveDevice('cpu', probe)).toBe('cpu');
    expect(await resolveDevice('gpu', probe)).toBe('gpu');
  });

  it('resolves auto to gpu when the probe finds an nvidia runtime', async () => {
    expect(await resolveDevice('auto', async () => true)).toBe('gpu');
  });

  it('resolves auto to cpu when the probe finds no nvidia runtime', async () => {
    expect(await resolveDevice('auto', async () => false)).toBe('cpu');
  });
});

describe('evaluateSTTReuseOnce (R11)', () => {
  it('accepts live Whisper health shape without model_loaded or model_name match', async () => {
    // Live prod shape: model_loaded:false, model_name is Parakeet version, backend:whisper
    const result = await evaluateSTTReuseOnce(8003, 'large-v3', async () => null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('ok');
      expect(result.backend).toBe('whisper');
      expect(result.inspectSkipped).toBe(true);
    }
  });

  it('rejects wrong backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ status: 'ok', backend: 'wasm' }), { status: 200 }),
      ),
    );
    const result = await evaluateSTTReuseOnce(8003, 'base', async () => null);
    expect(result).toEqual({ ok: false, reason: 'identity-mismatch' });
  });

  it('rejects when inspect reports a different Whisper model', async () => {
    const result = await evaluateSTTReuseOnce(8003, 'large-v3', async () => 'base');
    expect(result).toEqual({ ok: false, reason: 'identity-mismatch' });
  });

  it('accepts when inspect model matches expected', async () => {
    const result = await evaluateSTTReuseOnce(8003, 'large-v3', async () => 'large-v3');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inspectedModel).toBe('large-v3');
      expect(result.inspectSkipped).toBe(false);
    }
  });

  it('rejects non-JSON 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    );
    const result = await evaluateSTTReuseOnce(8003, 'base', async () => null);
    expect(result).toEqual({ ok: false, reason: 'unparseable' });
  });
});

describe('startSTT reuse + build stamp', () => {
  it('healthy reuse path invokes zero docker commands', async () => {
    const manager = await startSTT({
      sttDir: '/repo/stt',
      port: 8003,
      device: 'cpu',
      whisperModel: 'base',
      // Inject no-op inspect so reuse proves zero docker (R11 docs-only path).
      inspectWhisperModel: async () => null,
      reuseAttempts: 1,
    });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(manager.url).toBe('ws://localhost:8003');
  });

  it('does not require model_loaded true or model_name === WHISPER_MODEL for reuse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: 'ok',
            model_loaded: false,
            model_name: 'parakeet-tdt-0.6b-v3',
            backend: 'whisper',
          }),
          { status: 200 },
        ),
      ),
    );

    await startSTT({
      sttDir: '/repo/stt',
      port: 8003,
      device: 'cpu',
      whisperModel: 'large-v3', // deliberately different from model_name
      inspectWhisperModel: async () => null,
      reuseAttempts: 1,
    });

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('cold start without prior stamp uses --build; failed health still downs', async () => {
    const sttDir = await createSTTFixture();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('connection refused');
        }),
      );

      await expect(
        startSTT({
          sttDir,
          port: 8003,
          device: 'cpu',
          whisperModel: 'base',
          startupTimeoutMs: 50,
          reuseAttempts: 1,
          reuseBackoffMs: 1,
          inspectWhisperModel: async () => null,
        }),
      ).rejects.toThrow(/did not become healthy/);

      const dockerCalls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
      expect(dockerCalls.some((c) => c.includes('up') && c.includes('--build'))).toBe(true);
      expect(dockerCalls.some((c) => c.includes('down'))).toBe(true);
    } finally {
      await rm(sttDir, { recursive: true, force: true });
    }
  });

  it('skips docker rebuilds after the STT image inputs are already built', async () => {
    const sttDir = await createSTTFixture();
    try {
      // First start: no stamp → build; make health fail then... actually we need
      // health to succeed after up for stamp write. Use: reuse fails, up succeeds, health ok.
      let fetchCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          fetchCount += 1;
          // First call(s) for reuse fail; after compose up, health succeeds.
          if (fetchCount <= 1) {
            throw new Error('not up yet');
          }
          return new Response(
            JSON.stringify({ status: 'ok', backend: 'whisper' }),
            { status: 200 },
          );
        }),
      );

      await startSTT({
        sttDir,
        port: 8003,
        device: 'cpu',
        whisperModel: 'base',
        reuseAttempts: 1,
        inspectWhisperModel: async () => null,
      });

      expect(execFileMock).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['up', '-d', '--build']),
        expect.anything(),
        expect.any(Function),
      );

      execFileMock.mockClear();
      fetchCount = 0;
      // Second start with unchanged stamp: reuse fails (fetch throws once), then up without --build
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          fetchCount += 1;
          if (fetchCount <= 1) throw new Error('not up');
          return new Response(
            JSON.stringify({ status: 'ok', backend: 'whisper' }),
            { status: 200 },
          );
        }),
      );

      await startSTT({
        sttDir,
        port: 8003,
        device: 'cpu',
        whisperModel: 'base',
        reuseAttempts: 1,
        inspectWhisperModel: async () => null,
      });

      const upCall = execFileMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('up'),
      );
      expect(upCall).toBeDefined();
      expect(upCall![1] as string[]).not.toContain('--build');
    } finally {
      await rm(sttDir, { recursive: true, force: true });
    }
  });

  it('uses GPU compose overlay for cold start and stop', async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCount += 1;
        if (fetchCount <= 1) throw new Error('down');
        return new Response(JSON.stringify({ status: 'ok', backend: 'whisper' }), { status: 200 });
      }),
    );

    const manager = await startSTT({
      sttDir: '/repo/stt',
      port: 8003,
      device: 'gpu',
      whisperModel: 'large-v3',
      reuseAttempts: 1,
      inspectWhisperModel: async () => null,
    });

    expect(execFileMock).toHaveBeenCalledWith(
      'docker',
      [
        'compose',
        '-f',
        '/repo/stt/docker-compose.yml',
        '-f',
        '/repo/stt/docker-compose.gpu.yml',
        'up',
        '-d',
        '--build',
      ],
      expect.objectContaining({ timeout: 120_000 }),
      expect.any(Function),
    );

    await manager.stop();

    expect(execFileMock).toHaveBeenLastCalledWith(
      'docker',
      [
        'compose',
        '-f',
        '/repo/stt/docker-compose.yml',
        '-f',
        '/repo/stt/docker-compose.gpu.yml',
        'down',
      ],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function),
    );
  });
});
