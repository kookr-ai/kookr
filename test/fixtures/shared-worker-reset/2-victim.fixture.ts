import { logFixtureFile } from './fixture-log.js';
import { expectCleanState } from './expect-clean-state.js';

logFixtureFile(__filename);
expectCleanState();
