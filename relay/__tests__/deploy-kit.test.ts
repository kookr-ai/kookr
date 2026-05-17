import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('relay deployment kit', () => {
  it('ships the phase-3 operator artifacts', async () => {
    const files = [
      'deploy/relay/kookr-relay.service',
      'deploy/relay/Caddyfile.example',
      'deploy/relay/relay.env.example',
      'deploy/relay/verify.sh',
      'docs/reference/self-hosted-relay-runbook.md',
    ];

    for (const file of files) {
      await access(file, constants.R_OK);
      expect((await stat(file)).size, file).toBeGreaterThan(0);
    }
  });
});
