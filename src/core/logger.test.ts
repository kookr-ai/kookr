import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createLogger, setLoggerRuntimeLevelGetter, type LogLevel } from './logger.js';

describe('logger', () => {
  beforeEach(() => {
    delete process.env.KOOKR_DEBUG;
    delete process.env.KOOKR_LOG_FORMAT;
    setLoggerRuntimeLevelGetter(() => 'info');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.KOOKR_DEBUG;
    delete process.env.KOOKR_LOG_FORMAT;
    setLoggerRuntimeLevelGetter(() => 'info');
  });

  test('human output preserves the subsystem prefix', () => {
    const logger = createLogger('tts');

    logger.info('voice cache warmed');

    expect(console.info).toHaveBeenCalledWith('[tts] voice cache warmed');
  });

  test('human output keeps fields as a separate console argument', () => {
    const logger = createLogger('telegram');

    logger.warn('dropped unauthorized sender', { userId: 123 });

    expect(console.warn).toHaveBeenCalledWith('[telegram] dropped unauthorized sender', { userId: 123 });
  });

  test('runtime log level gates emitted methods', () => {
    let currentLevel: LogLevel = 'warn';
    setLoggerRuntimeLevelGetter(() => currentLevel);
    const logger = createLogger('github');

    logger.error('failed');
    logger.warn('slow');
    logger.info('ready');
    logger.debug('payload');

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.info).not.toHaveBeenCalled();
    expect(console.debug).not.toHaveBeenCalled();

    currentLevel = 'debug';
    logger.debug('payload');
    expect(console.debug).toHaveBeenCalledTimes(1);
  });

  test('json format emits a single structured line', () => {
    process.env.KOOKR_LOG_FORMAT = 'json';
    setLoggerRuntimeLevelGetter(() => 'debug');
    const logger = createLogger('session');

    logger.debug('attached', { taskId: 'task-1', bytes: 42 });

    expect(console.debug).toHaveBeenCalledTimes(1);
    const [line, extra] = vi.mocked(console.debug).mock.calls[0] ?? [];
    expect(extra).toBeUndefined();
    expect(typeof line).toBe('string');

    const record = JSON.parse(line as string) as Record<string, unknown>;
    expect(record).toMatchObject({
      level: 'debug',
      subsystem: 'session',
      msg: 'attached',
      fields: { taskId: 'task-1', bytes: 42 },
    });
    expect(typeof record.ts).toBe('string');
    expect(Number.isNaN(Date.parse(record.ts as string))).toBe(false);
  });

  test('json format falls back when fields cannot be serialized', () => {
    process.env.KOOKR_LOG_FORMAT = 'json';
    const logger = createLogger('session');
    const fields: Record<string, unknown> = {};
    fields.self = fields;

    expect(() => logger.info('attached', fields)).not.toThrow();

    expect(console.info).toHaveBeenCalledTimes(1);
    const [line] = vi.mocked(console.info).mock.calls[0] ?? [];
    const record = JSON.parse(line as string) as Record<string, unknown>;
    expect(record).toMatchObject({
      level: 'info',
      subsystem: 'session',
      msg: 'attached',
      fields: { loggerError: 'failed-to-serialize-fields' },
    });
  });
});
