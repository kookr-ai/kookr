import { describe, expect, it } from 'vitest';

import {
  SUPERVISOR_ACTOR_HEADER,
  SUPERVISOR_AUTH_HEADER,
  UNATTRIBUTED_ACTOR_ID,
} from './supervisor-actions.js';

// The header names are a wire contract shared by the server routes and every
// supervisor client (Lucy, CLI, dashboard). Renaming one silently breaks
// attribution/auth on the other side of the wire, so pin the literals here.
describe('supervisor-actions contract', () => {
  it('pins the actor header to the documented wire literal', () => {
    expect(SUPERVISOR_ACTOR_HEADER).toBe('x-kookr-actor');
  });

  it('pins the auth header to the standard bearer header', () => {
    expect(SUPERVISOR_AUTH_HEADER).toBe('authorization');
  });

  it('records missing attribution under the documented sentinel id', () => {
    expect(UNATTRIBUTED_ACTOR_ID).toBe('unattributed');
  });
});
