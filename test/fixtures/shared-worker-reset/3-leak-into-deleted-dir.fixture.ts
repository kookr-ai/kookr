// Leaks the same state, but ends in a directory it then deletes, so
// process.cwd() throws when the reset reads it. 4-victim checks the reset
// still moves back to the start directory.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { logFixtureFile } from './fixture-log.js';
import { leakTimersEnvAndModules } from './leak-state.js';

logFixtureFile(__filename);

it('leaks state and a deleted working directory into the next file', () => {
  leakTimersEnvAndModules('3-leak-into-deleted-dir');
  const doomed = mkdtempSync(join(tmpdir(), 'kookr-swr-deleted-cwd-'));
  // No process.cwd() call between these two lines: Node caches the cwd after
  // a call, and a cached value would hide the deletion from the reset.
  process.chdir(doomed);
  rmSync(doomed, { recursive: true, force: true });
});
