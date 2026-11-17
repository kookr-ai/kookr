// Each fixture file appends `<pid> <file name>` to the log the driver passes
// in SWR_LOG, so the driver can check that the files ran in order and in one
// worker process. Without that check, a fixture run with a fresh process per
// file would pass without testing anything.
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

export function logFixtureFile(file: string): void {
  const logPath = process.env.SWR_LOG;
  if (!logPath) throw new Error('SWR_LOG is not set: run this file through test/shared-worker-reset.test.ts');
  appendFileSync(logPath, `${process.pid} ${basename(file)}\n`);
}
