import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The probe's cases live in a bash harness next to the library, because the
// contract under test is shell behaviour (errexit safety, PATH lookup, dotenv
// parsing). This wrapper runs that harness in `pnpm test` so a regression
// fails the suite instead of waiting for someone to run it by hand.
describe('probe-codex-plugin-dir.sh', () => {
  it('passes every case in the bash test harness', () => {
    const result = spawnSync('bash', [join(process.cwd(), 'scripts/lib/probe-codex-plugin-dir.test.sh')], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.stderr).not.toContain('FAIL');
    expect(result.status).toBe(0);
  });
});
