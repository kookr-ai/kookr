import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  checkDefaultOn,
  DEFAULT_ON_DOC_FILE,
  formatDefaultOnIssues,
  GRANDFATHERED_DEFAULT_OFF,
  hasOffDefault,
  isKillSwitch,
  parseEnvVarRows,
  type EnvVarRow,
} from './default-on-guard.js';

function row(name: string, defaultValue: string, accepted: string, effect = 'Does a thing.'): EnvVarRow {
  return { name, defaultValue, accepted, effect, line: 1 };
}

function doc(...rows: string[]): string {
  return ['# Vars', '', '| Variable | Default | Accepted values | Effect |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

const NONE: ReadonlySet<string> = new Set();

describe('parseEnvVarRows', () => {
  it('reads four-column KOOKR_ rows, honours escaped pipes, and skips other tables', () => {
    const md = doc(
      '| `KOOKR_A` | `off` | `on` \\| `off` | Turns A on. |',
      '| `KOOKR_RISK=true` | Two-column risk row. |',
      '| `OTHER_VAR` | unset | x | y |',
    );
    expect(parseEnvVarRows(md)).toEqual([
      { name: 'KOOKR_A', defaultValue: '`off`', accepted: '`on` | `off`', effect: 'Turns A on.', line: 5 },
    ]);
  });
});

describe('hasOffDefault', () => {
  it.each([
    ['`off`', 'x'],
    ['disabled', 'x'],
    ['unset (off)', 'x'],
    ['unset (disabled)', 'x'],
    ['`0` (disabled)', 'number'],
    ['unset', '`1` to enable'],
    ['unset', '`1`/`true` to opt in'],
    ['unset', 'Exact string `true` enables'],
    ['unset', '`1` = on'],
  ])('default %s with accepted %s is off', (def, accepted) => {
    expect(hasOffDefault(row('KOOKR_X', def, accepted))).toBe(true);
  });

  it('treats an unset *_ENABLED switch as off', () => {
    expect(hasOffDefault(row('KOOKR_X_ENABLED', 'unset', '`true`, `1`, or `yes`'))).toBe(true);
  });

  it.each([
    ['on (interactive loopback)', '`0` to disable'],
    ['on for port 4800, off otherwise', '`1` to enable'],
    ['`1` (on when unset)', '`0` disables'],
    ['`4800`', 'Integer port'],
    ['unset', 'Secret string'],
    ['unset', '`true` to assert'],
  ])('default %s with accepted %s is not off', (def, accepted) => {
    expect(hasOffDefault(row('KOOKR_X', def, accepted))).toBe(false);
  });
});

describe('isKillSwitch', () => {
  it.each(['KOOKR_NUDGE_DISABLED', 'KOOKR_AUTO_REFLECT_DISABLE', 'KOOKR_DISABLE_ORIGIN_GATE', 'KOOKR_X_DISABLE_LAUNCHES', 'KOOKR_X_DRY_RUN'])(
    '%s is a kill switch by name',
    (name) => {
      expect(isKillSwitch(row(name, 'unset', '`1` to enable'))).toBe(true);
    },
  );

  it('is a kill switch when the only accepted value turns something off', () => {
    expect(isKillSwitch(row('KOOKR_GROK_HALT', 'unset', '`true` to halt'))).toBe(true);
  });

  it('is not a kill switch when the value enables the feature', () => {
    expect(isKillSwitch(row('KOOKR_FEATURE', 'unset', '`1` to enable, `0` to disable'))).toBe(false);
  });
});

describe('checkDefaultOn', () => {
  it('fails a new off-by-default feature switch with no reason', () => {
    const md = doc('| `KOOKR_NEW_FEATURE` | unset (off) | `1` to enable | Turns the new feature on. |');
    const result = checkDefaultOn(md, NONE);
    expect(result.issues).toEqual([{ name: 'KOOKR_NEW_FEATURE', line: 5, defaultValue: 'unset (off)' }]);
    expect(formatDefaultOnIssues(result)).toContain('KOOKR_NEW_FEATURE (line 5');
  });

  it.each([
    'Off by default: deletes or migrates data in the task store.',
    'Off by default: spends money on a paid speech API.',
    'Off by default: sends data to a third party (Telegram).',
    'off by default: needs a credential or service the host may not have.',
  ])('passes an off-by-default switch whose Effect says why: %s', (reason) => {
    const md = doc(`| \`KOOKR_NEW_FEATURE\` | unset (off) | \`1\` to enable | Turns it on. ${reason} |`);
    expect(checkDefaultOn(md, NONE).issues).toEqual([]);
  });

  it('does not accept a reason outside the four cases', () => {
    const md = doc('| `KOOKR_NEW_FEATURE` | unset (off) | `1` to enable | Off by default: needs more evaluation. |');
    expect(checkDefaultOn(md, NONE).issues).toHaveLength(1);
  });

  it('does not accept the reason phrase in a cell other than Effect', () => {
    const md = doc('| `KOOKR_NEW_FEATURE` | unset (off; off by default: spends money) | `1` to enable | Turns it on. |');
    expect(checkDefaultOn(md, NONE).issues).toHaveLength(1);
  });

  it('passes a kill switch and a default-on switch', () => {
    const md = doc(
      '| `KOOKR_THING_DISABLED` | unset | `1` to disable | Turns the thing off. |',
      '| `KOOKR_THING` | on | `0` to disable | Kill switch for the thing. |',
    );
    expect(checkDefaultOn(md, NONE).issues).toEqual([]);
  });

  it('passes a grandfathered switch and reports grandfathered names that are no longer off as stale', () => {
    const md = doc(
      '| `KOOKR_OLD_FEATURE` | unset (off) | `1` to enable | Old feature. |',
      '| `KOOKR_FLIPPED` | on | `0` to disable | Flipped on. |',
    );
    const result = checkDefaultOn(md, new Set(['KOOKR_OLD_FEATURE', 'KOOKR_FLIPPED', 'KOOKR_REMOVED']));
    expect(result.issues).toEqual([]);
    expect(result.stale).toEqual(['KOOKR_FLIPPED', 'KOOKR_REMOVED']);
  });

  // Stale grandfathered names are deliberately not asserted here: flipping a
  // switch on (issue #3937) must not fail this test.
  it('passes on the real environment-variables document', () => {
    const md = readFileSync(join(process.cwd(), DEFAULT_ON_DOC_FILE), 'utf8');
    expect(parseEnvVarRows(md).length).toBeGreaterThan(100);
    expect(checkDefaultOn(md).issues).toEqual([]);
  });

  it('flags the real off-by-default rows once grandfathering is removed', () => {
    const md = readFileSync(join(process.cwd(), DEFAULT_ON_DOC_FILE), 'utf8');
    const flagged = checkDefaultOn(md, NONE).issues.map((issue) => issue.name);
    // The switches issue #3936 names must be recognised as off-by-default features.
    expect(flagged).toEqual(expect.arrayContaining(['KOOKR_LUCY_OPERATOR', 'KOOKR_LUCY_LAUNCH', 'KOOKR_POST_RESUME_REFILL']));
    expect(flagged.every((name) => GRANDFATHERED_DEFAULT_OFF.has(name))).toBe(true);
  });
});
