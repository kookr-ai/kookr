import { describe, expect, it } from 'vitest';
import { DEFAULT_STT_STARTUP_TIMEOUT_MS, parseSTTHealthTimeoutMs } from './stt-manager.js';

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
