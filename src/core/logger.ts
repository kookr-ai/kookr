export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
}

type LogSink = (line: string, fields?: LogFields) => void;

let getRuntimeLogLevel: () => LogLevel = () => 'info';

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export function setLoggerRuntimeLevelGetter(getter: () => LogLevel): void {
  getRuntimeLogLevel = getter;
}

export function isLoggerLevelEnabled(level: LogLevel): boolean {
  return LOG_LEVEL_RANK[getRuntimeLogLevel()] >= LOG_LEVEL_RANK[level];
}

export function createLogger(subsystem: string): Logger {
  return {
    error: (message, fields) => writeLog('error', subsystem, message, fields),
    warn: (message, fields) => writeLog('warn', subsystem, message, fields),
    info: (message, fields) => writeLog('info', subsystem, message, fields),
    debug: (message, fields) => writeLog('debug', subsystem, message, fields),
  };
}

function writeLog(level: LogLevel, subsystem: string, message: string, fields?: LogFields): void {
  if (!isLoggerLevelEnabled(level)) return;

  const sink = sinkForLevel(level);
  if (isJsonFormat()) {
    sink(toJsonLine(level, subsystem, message, fields));
    return;
  }

  const line = `[${subsystem}] ${message}`;
  if (fields && Object.keys(fields).length > 0) {
    sink(line, fields);
    return;
  }
  sink(line);
}

function sinkForLevel(level: LogLevel): LogSink {
  switch (level) {
    case 'error':
      return (line, fields) => (fields === undefined ? console.error(line) : console.error(line, fields));
    case 'warn':
      return (line, fields) => (fields === undefined ? console.warn(line) : console.warn(line, fields));
    case 'info':
      return (line, fields) => (fields === undefined ? console.info(line) : console.info(line, fields));
    case 'debug':
      return (line, fields) => (fields === undefined ? console.debug(line) : console.debug(line, fields));
  }
}

function isJsonFormat(): boolean {
  return process.env.KOOKR_LOG_FORMAT?.trim().toLowerCase() === 'json';
}

function toJsonLine(
  level: LogLevel,
  subsystem: string,
  message: string,
  fields: LogFields | undefined,
): string {
  const payload = {
    ts: new Date().toISOString(),
    level,
    subsystem,
    msg: message,
    fields: fields ?? {},
  };

  try {
    return JSON.stringify(payload);
  } catch (error) {
    return JSON.stringify({
      ...payload,
      fields: {
        loggerError: 'failed-to-serialize-fields',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
