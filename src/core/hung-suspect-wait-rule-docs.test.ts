import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HUNG_SUSPECT_TTL_MS, MAX_HUNG_SUSPECT_TTL_MS } from './hung-suspect-ttl.js';

/**
 * Issue #4140: agents that wait on background work must be told that Kookr
 * terminates a task silent past `hungSuspectTtlMinutes`. The minute values are
 * derived from the code constants, so a changed default fails here until the
 * wording is updated.
 */
const FILES = [
  'plugin/skills/autonomous-watch-loop/SKILL.md',
  'plugin/skills/independent-merge-review/SKILL.md',
  'plugin/playbooks/task-supervisor.md',
];

const defaultMin = DEFAULT_HUNG_SUSPECT_TTL_MS / 60_000;
const maxMin = MAX_HUNG_SUSPECT_TTL_MS / 60_000;

describe('hung-suspect silence limit wording (issue #4140)', () => {
  it.each(FILES)('%s states the setting, its default and maximum, the exemption and the advice', (file) => {
    const text = readFileSync(join(process.cwd(), file), 'utf-8');
    expect(text).toContain('`hungSuspectTtlMinutes`');
    expect(text).toMatch(new RegExp(`${defaultMin}\\s+minutes\\s+by\\s+default,\\s+${maxMin}\\s+at\\s+most`));
    expect(text).toMatch(/open,\s+unmerged\s+pull\s+request\s+is\s+exempt/);
    expect(text).toMatch(/under\s+about\s+ten\s+minutes/);
    expect(text).toMatch(/(result|verdict|finds)\s+to\s+a\s+file/);
  });
});
