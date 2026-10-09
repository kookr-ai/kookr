import { describe, expect, it } from 'vitest';
import { readTranscriptCaptureConfig } from './transcript-capture-config.js';
import { DEFAULT_TRANSCRIPT_RETENTION_DAYS } from './transcript-store.js';

describe('readTranscriptCaptureConfig', () => {
  it('is disabled by default', () => {
    expect(readTranscriptCaptureConfig({})).toEqual({
      enabled: false, scope: 'off', graceMs: 15 * 60_000, maxTasksPerTick: 25,
      retentionDays: DEFAULT_TRANSCRIPT_RETENTION_DAYS,
    });
  });
  it('enables for all and own-repos', () => {
    expect(readTranscriptCaptureConfig({ KOOKR_TRANSCRIPT_CAPTURE: 'all' })).toMatchObject({ enabled: true, scope: 'all' });
    expect(readTranscriptCaptureConfig({ KOOKR_TRANSCRIPT_CAPTURE: ' Own-Repos ' })).toMatchObject({ enabled: true, scope: 'own-repos' });
  });
  it('falls back to defaults on bad values', () => {
    const c = readTranscriptCaptureConfig({
      KOOKR_TRANSCRIPT_CAPTURE: 'yes', KOOKR_TRANSCRIPT_CAPTURE_GRACE_MS: '-5',
      KOOKR_TRANSCRIPT_CAPTURE_MAX_PER_TICK: '0', KOOKR_TRANSCRIPT_RETENTION_DAYS: 'abc',
    });
    expect(c).toMatchObject({ enabled: false, scope: 'off', graceMs: 15 * 60_000, maxTasksPerTick: 25, retentionDays: DEFAULT_TRANSCRIPT_RETENTION_DAYS });
  });
  it('accepts valid numeric overrides', () => {
    expect(readTranscriptCaptureConfig({
      KOOKR_TRANSCRIPT_CAPTURE_GRACE_MS: '0', KOOKR_TRANSCRIPT_CAPTURE_MAX_PER_TICK: '3', KOOKR_TRANSCRIPT_RETENTION_DAYS: '7',
    })).toMatchObject({ graceMs: 0, maxTasksPerTick: 3, retentionDays: 7 });
  });
});
