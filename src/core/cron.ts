import { CronExpressionParser } from 'cron-parser';

/**
 * Compute the next run time after `after` for the given cron expression.
 * Returns null if the expression is invalid.
 */
export function nextRun(cron: string, after: Date = new Date()): Date | null {
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: after });
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
    CronExpressionParser.parse(cron);
    return true;
  } catch {
    return false;
  }
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
    const dayName = dayNames[Number(dow)] ?? dow;
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
