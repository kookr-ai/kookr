// Leaks timers, env and module state, and ends in another directory that
// still exists. 2-victim checks that all of it is put back.
import { it } from 'vitest';
import { logFixtureFile } from './fixture-log.js';
import { leakTimersEnvAndModules } from './leak-state.js';

logFixtureFile(__filename);

it('leaks state into the next file', () => {
  leakTimersEnvAndModules('1-leak-into-live-dir');
  process.chdir(process.env.SWR_LIVE_DIR!);
});
