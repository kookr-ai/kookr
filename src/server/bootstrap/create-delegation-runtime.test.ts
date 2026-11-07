import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readHermesDelegationConfigPathFromEnv, readHermesDelegationOptInFromEnv } from '../config.js';
import { createDelegationRuntime } from './create-delegation-runtime.js';

let dir: string;
let logs: string[];
const cleanups: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegation-boot-'));
  logs = [];
});
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  rmSync(dir, { recursive: true, force: true });
});

const TOKEN_A = 'token-aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'token-bbbbbbbbbbbbbbbbbbbbbbbb';

function writeConfig(over: Record<string, unknown> = {}, workerOver: Record<string, unknown> = {}): string {
  writeFileSync(join(dir, 'a.tok'), TOKEN_A);
  writeFileSync(join(dir, 'b.tok'), TOKEN_B);
  const file = join(dir, 'delegation.json');
  writeFileSync(
    file,
    JSON.stringify({
      snapshotsRoot: 'snapshots',
      projects: { proj: { repoDir: 'repo', githubRepo: 'o/n' } },
      workers: [
        { name: 'a', url: 'http://127.0.0.1:19001', tokenFile: 'a.tok', projects: ['proj'], operatorAttestedLeaf: true, workspaceMode: 'ro', ...workerOver },
        { name: 'b', url: 'http://127.0.0.1:19002', tokenFile: 'b.tok', projects: ['proj'], operatorAttestedLeaf: true, workspaceMode: 'ro' },
      ],
      ...over,
    }),
  );
  return file;
}

const run = async (env: NodeJS.ProcessEnv) => {
  const rt = await createDelegationRuntime({ kookrDir: dir, env, log: (l) => logs.push(l) });
  cleanups.push(() => rt.stop());
  return rt;
};
const decisionLog = () => logs.map((l) => JSON.parse(l)).find((l) => l.event === 'startup_decision');

describe('env readers', () => {
  test('flag defaults off; config path defaults to <kookrDir>/delegation.json', () => {
    expect(readHermesDelegationOptInFromEnv({})).toBe(false);
    expect(readHermesDelegationOptInFromEnv({ KOOKR_HERMES_DELEGATION: '1' })).toBe(true);
    expect(readHermesDelegationOptInFromEnv({ KOOKR_HERMES_DELEGATION: 'off' })).toBe(false);
    expect(readHermesDelegationConfigPathFromEnv('/k', {})).toBe('/k/delegation.json');
    expect(readHermesDelegationConfigPathFromEnv('/k/', { KOOKR_HERMES_DELEGATION_CONFIG: ' /x/y.json ' })).toBe('/x/y.json');
  });
});

describe('createDelegationRuntime (ships dark, fails closed)', () => {
  test('flag off -> no service, decision logged', async () => {
    writeConfig();
    const rt = await run({});
    expect(rt.service).toBeUndefined();
    expect(rt.decision).toMatchObject({ enabled: false, missing: ['KOOKR_HERMES_DELEGATION'] });
    expect(rt.disabled).toMatchObject({ reason: 'flag_off' });
    expect(decisionLog()).toMatchObject({ enabled: false });
  });

  test('flag on but config file missing -> no service, names the file', async () => {
    const rt = await run({ KOOKR_HERMES_DELEGATION: '1' });
    expect(rt.service).toBeUndefined();
    expect(rt.decision.missing).toEqual([join(dir, 'delegation.json')]);
    expect(rt.decision.reason).toMatch(/ENOENT/);
    expect(rt.disabled?.reason).toBe('no_config');
  });

  test('flag on, config is not JSON -> no service', async () => {
    writeFileSync(join(dir, 'delegation.json'), '{{');
    const rt = await run({ KOOKR_HERMES_DELEGATION: '1' });
    expect(rt.service).toBeUndefined();
    expect(rt.decision.reason).toMatch(/not valid JSON/);
    expect(rt.disabled?.reason).toBe('invalid_config');
  });

  test('flag on, config invalid -> no service, names the offending fields only', async () => {
    writeConfig({}, { replyTimeoutSec: 5 });
    const rt = await run({ KOOKR_HERMES_DELEGATION: '1' });
    expect(rt.service).toBeUndefined();
    expect(rt.decision.missing.join('\n')).toContain('workers.0.replyTimeoutSec');
    expect(rt.disabled?.reason).toBe('invalid_config');
  });

  test('flag on, registry invalid (shared token, default token) -> no service, no token in any log', async () => {
    writeConfig();
    writeFileSync(join(dir, 'b.tok'), TOKEN_A); // shared with worker a
    let rt = await run({ KOOKR_HERMES_DELEGATION: '1' });
    expect(rt.service).toBeUndefined();
    expect(rt.decision.missing.join('\n')).toMatch(/distinct token/);
    const weak = 'weak-test-token-0123456789';
    writeConfig({ weakTokenHashes: [createHash('sha256').update(weak).digest('hex')] });
    writeFileSync(join(dir, 'a.tok'), weak);
    rt = await run({ KOOKR_HERMES_DELEGATION: '1' });
    expect(rt.service).toBeUndefined();
    expect(rt.decision.missing.join('\n')).toMatch(/weak or retired/);
    expect(logs.join('\n')).not.toContain(TOKEN_A);
    expect(logs.join('\n')).not.toContain(weak);
  });

  test('a non-loopback worker URL is refused unless allow-listed', async () => {
    writeConfig({}, { url: 'http://10.9.8.7:9900' });
    expect((await run({ KOOKR_HERMES_DELEGATION: '1' })).service).toBeUndefined();
    writeConfig({ allowedHosts: ['10.9.8.7'] }, { url: 'http://10.9.8.7:9900' });
    expect((await run({ KOOKR_HERMES_DELEGATION: '1' })).service).toBeDefined();
  });

  test('flag on + valid config -> service started; relative paths resolve against the config file', async () => {
    writeConfig();
    const rt = await run({ KOOKR_HERMES_DELEGATION: '1' });
    expect(rt.service).toBeDefined();
    expect(rt.service!.disabledInfo).toBeUndefined();
    expect(rt.decision).toEqual({ enabled: true, reason: 'enabled', missing: [] });
    expect(logs.join('\n')).not.toContain(TOKEN_A);
    expect(logs.join('\n')).not.toContain(TOKEN_B);
  });

  test('ordered disable survives a config file that parses but no longer validates (last known value is kept)', async () => {
    const file = writeConfig({ acceptingNewDelegations: false });
    const rt = await run({ KOOKR_HERMES_DELEGATION: '1' });
    expect(await rt.service!.isAccepting()).toBe(false);
    // Valid JSON, but it fails the schema (no workers): must NOT read as "accepting".
    writeFileSync(file, JSON.stringify({ snapshotsRoot: 'snapshots', projects: {}, workers: [] }));
    expect(await rt.service!.isAccepting()).toBe(false);
    writeFileSync(file, '{ not json');
    expect(await rt.service!.isAccepting()).toBe(false);
  });

  test('KOOKR_HERMES_DELEGATION_CONFIG overrides the default location', async () => {
    const file = writeConfig();
    const moved = join(dir, 'elsewhere.json');
    writeFileSync(moved, readFileSync(file));
    rmSync(file);
    const rt = await run({ KOOKR_HERMES_DELEGATION: '1', KOOKR_HERMES_DELEGATION_CONFIG: moved });
    expect(rt.service).toBeDefined();
  });

  test('a corrupt delegations.json keeps the service object (routes answer delegation_disabled) but reports disabled', async () => {
    writeConfig();
    writeFileSync(join(dir, 'delegations.json'), 'corrupt!');
    const rt = await run({ KOOKR_HERMES_DELEGATION: '1' });
    expect(rt.service?.disabledInfo).toMatchObject({ reason: 'store_unparseable', file: join(dir, 'delegations.json') });
    expect(rt.decision).toMatchObject({ enabled: false, missing: [join(dir, 'delegations.json')] });
  });
});
