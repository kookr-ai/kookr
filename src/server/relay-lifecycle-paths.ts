import { homedir } from 'node:os';
import { join } from 'node:path';

import type { RelayLifecyclePaths } from './relay-lifecycle-contracts.js';

export function relayLifecyclePaths(kookrDir = join(homedir(), '.kookr')): RelayLifecyclePaths {
  return {
    kookrDir,
    pidPath: join(kookrDir, 'relay.pid'),
    logPath: join(kookrDir, 'relay.log'),
    statePath: join(kookrDir, 'relay.state.json'),
    dbPath: join(kookrDir, 'relay.sqlite'),
  };
}
