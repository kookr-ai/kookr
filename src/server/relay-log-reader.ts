import { readFile } from 'node:fs/promises';

import { redactRelaySecret } from './relay-secret-redaction.js';

export async function readRecentRelayLogs(logPath: string, maxLines = 80): Promise<string[]> {
  try {
    const text = await readFile(logPath, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).map(redactRelaySecret);
  } catch {
    return [];
  }
}
