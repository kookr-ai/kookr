import { CronExpressionParser } from 'cron-parser';

const MIN_PRACTICAL_CRON_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Compute the next run time after `after` for the given cron expression.
 * Returns null if the expression is invalid.
 */
export function nextRun(cron: string, after: Date = new Date()): Date | null {
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: after, hashSeed: cronHashSeed(cron) });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Validate a 5-field cron expression. Returns true if valid.
 */
export function isValidCron(cron: string): boolean {
  try {
    CronExpressionParser.parse(cron, { hashSeed: cronHashSeed(cron) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the smallest possible interval from the parsed time-of-day fields.
 * Returns null if the expression is invalid.
 */
export function minimumCronIntervalMs(cron: string): number | null {
  try {
    const interval = CronExpressionParser.parse(cron, { hashSeed: cronHashSeed(cron) });
    const times: number[] = [];
    for (const hour of numericValues(interval.fields.hour.values)) {
      for (const minute of numericValues(interval.fields.minute.values)) {
        for (const second of numericValues(interval.fields.second.values)) {
          times.push(hour * 60 * 60 + minute * 60 + second);
        }
      }
    }
    if (times.length === 0) return null;

    times.sort((a, b) => a - b);
    let minimumIntervalSeconds = 24 * 60 * 60;
    for (let i = 1; i < times.length; i++) {
      minimumIntervalSeconds = Math.min(minimumIntervalSeconds, times[i] - times[i - 1]);
    }
    minimumIntervalSeconds = Math.min(
      minimumIntervalSeconds,
      24 * 60 * 60 - times[times.length - 1] + times[0],
    );
    return minimumIntervalSeconds * 1000;
  } catch {
    return null;
  }
}

export function isPracticalCron(
  cron: string,
  minIntervalMs: number = MIN_PRACTICAL_CRON_INTERVAL_MS,
): boolean {
  const minimumInterval = minimumCronIntervalMs(cron);
  return minimumInterval !== null && minimumInterval >= minIntervalMs;
}

/**
 * Human-readable description of a cron expression.
 * Covers common patterns; falls back to the raw expression for exotic ones.
 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dom, month, dow] = parts;

  // Every minute
  if (cron === '* * * * *') return 'Every minute';

  // Every N minutes
  if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every ${minute.slice(2)} minutes`;
  }

  // Every N hours
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    return `Every ${hour.slice(2)} hours`;
  }

  // Daily at HH:MM
  if (dom === '*' && month === '*' && dow === '*' && !minute.includes('*') && !hour.includes('*')) {
    return `Daily at ${pad(hour)}:${pad(minute)}`;
  }

  // Weekly on a specific day
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (dom === '*' && month === '*' && !dow.includes('*') && !minute.includes('*') && !hour.includes('*')) {
    const dayIndex = dow === '7' ? 0 : Number(dow);
    const dayName = dayNames[dayIndex] ?? dow;
    return `Every ${dayName} at ${pad(hour)}:${pad(minute)}`;
  }

  // Monthly on a specific day
  if (!dom.includes('*') && month === '*' && dow === '*' && !minute.includes('*') && !hour.includes('*')) {
    return `Monthly on day ${dom} at ${pad(hour)}:${pad(minute)}`;
  }

  return cron;
}

function pad(s: string): string {
  return s.padStart(2, '0');
}

function cronHashSeed(cron: string): string {
  return cron.trim();
}

function numericValues(values: readonly (number | string)[]): number[] {
  return values.filter((value): value is number => typeof value === 'number');
}
