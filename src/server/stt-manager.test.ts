import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STT_STARTUP_TIMEOUT_MS,
  parseSTTDevice,
  parseSTTHealthTimeoutMs,
  resolveDevice,
} from './stt-manager.js';

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
