import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectCommandOutcomes } from '../kookr-command-outcome.js';

describe('kookr command outcome', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `kookr-command-outcome-${Date.now()}-${Math.random()}`);
    await mkdir(join(dir, 'sessions', 's1'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns local interaction-log commands when remote audit.jsonl does not exist', async () => {
    await writeFile(join(dir, 'sessions', 's1', 'interactions.jsonl'), `${JSON.stringify({
      type: 'user_input',
      agentId: 's1',
      content: 'continue',
      timestamp: '2026-05-15T19:00:00.000Z',
    })}\n`, 'utf8');

    await expect(collectCommandOutcomes({ kookrDir: dir })).resolves.toMatchObject([
      { source: 'local', action: 'presetReply', outcome: 'accepted', agentId: 's1' },
    ]);
  });
});
