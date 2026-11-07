import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoUpdateService, type AutoUpdateOps, type AutoUpdateInspection } from './auto-update-service.js';
import { AutoUpdateStore } from './auto-update-store.js';
import { AutoUpdateAuditStore } from './auto-update-audit-store.js';
import { PluginMutationService } from './mutation-service.js';
import { ClaudeSettingsStore, defaultScopeFiles } from '../../core/claude-settings/settings-store.js';
import type { IdlePredicateTaskView } from '../../core/plugin-auto-update/idle-predicate.js';
import type { AutoUpdateSnapshotMeta } from '../../shared/contracts/plugins.js';

const ID = 'a@mkt';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

function meta(overrides: Partial<AutoUpdateSnapshotMeta> = {}): AutoUpdateSnapshotMeta {
  return {
    pluginId: ID,
    installPath: '/install/a',
    snapshotPath: '/snap/a',
    fromVersion: '1.0.0',
    takenAt: '2026-03-03T00:00:00.000Z',
    retainUntil: FUTURE,
    ...overrides,
  };
}

class FakeOps implements AutoUpdateOps {
  inspectResult: AutoUpdateInspection = { installedVersion: '1.0.0', availableVersion: '2.0.0', behind: true, installPath: '/install/a' };
  updateError: Error | null = null;
  verifyResult = true;
  snapshotResult: AutoUpdateSnapshotMeta | null = meta();
  restoreResult: { ok: boolean; snapshotPath?: string } = { ok: true };
  epoch = 0;
  calls: string[] = [];
  discarded: string[] = [];
  async inspect(): Promise<AutoUpdateInspection> { this.calls.push('inspect'); return this.inspectResult; }
  async update(): Promise<void> { this.calls.push('update'); if (this.updateError) throw this.updateError; }
  async verify(): Promise<boolean> { this.calls.push('verify'); return this.verifyResult; }
  async snapshot(): Promise<AutoUpdateSnapshotMeta | null> { this.calls.push('snapshot'); return this.snapshotResult; }
  async restore(): Promise<{ ok: boolean; snapshotPath?: string }> { this.calls.push('restore'); return this.restoreResult; }
  async discard(path: string): Promise<void> { this.calls.push('discard'); this.discarded.push(path); }
  async bumpEpoch(): Promise<number> { this.calls.push('bump'); return ++this.epoch; }
}

describe('AutoUpdateService', () => {
  let dir: string;
  let home: string;
  let store: AutoUpdateStore;
  let audit: AutoUpdateAuditStore;
  let mutation: PluginMutationService;
  let settings: ClaudeSettingsStore;
  let ops: FakeOps;
  let tasks: IdlePredicateTaskView[];

  function makeService(opts: { applyEnabled?: boolean; readInstalled?: () => Promise<Map<string, string | null>> } = {}) {
    return new AutoUpdateService({
      store,
      audit,
      mutation,
      settings,
      ops,
      getTasks: () => tasks,
      readInstalledVersions: opts.readInstalled ?? (async () => new Map([[ID, ops.inspectResult.installedVersion]])),
      applyEnabled: opts.applyEnabled ?? true,
      now: () => new Date('2026-03-03T00:00:00.000Z'),
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-aus-'));
    home = mkdtempSync(join(tmpdir(), 'kookr-aus-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    store = new AutoUpdateStore(dir);
    audit = new AutoUpdateAuditStore(dir);
    mutation = new PluginMutationService();
    settings = new ClaudeSettingsStore(defaultScopeFiles(dir, home));
    ops = new FakeOps();
    tasks = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test('setPolicy apply-when-idle writes autoUpdate:false, reverts on return to off', async () => {
    const view = await makeService().setPolicy(ID, 'apply-when-idle');
    expect(view.policy).toBe('apply-when-idle');
    expect(await settings.readAutoUpdate('mkt')).toBe(false);

    await makeService().setPolicy(ID, 'off');
    expect(await settings.readAutoUpdate('mkt')).toBeUndefined();
  });

  test('ownership provenance: never clobbers the operator own explicit autoUpdate flag', async () => {
    // Operator deliberately set autoUpdate:true for the marketplace beforehand.
    await settings.writeAutoUpdate('mkt', true, { scope: 'user', withLock: (fn) => fn() });
    const svc = makeService();
    await svc.setPolicy(ID, 'apply-when-idle');
    expect(await settings.readAutoUpdate('mkt')).toBe(false); // Kookr pins false while it owns it
    await svc.setPolicy(ID, 'off');
    expect(await settings.readAutoUpdate('mkt')).toBe(true); // restored to the operator's OWN value, not removed
  });

  test('verify failure reverts the autoUpdate flag when the plugin leaves apply-when-idle', async () => {
    const svc = makeService();
    await svc.setPolicy(ID, 'apply-when-idle'); // writes autoUpdate:false, records ownership (prev absent)
    expect(await settings.readAutoUpdate('mkt')).toBe(false);
    ops.verifyResult = false;
    ops.restoreResult = { ok: true };
    const d = await svc.evaluatePlugin(ID);
    expect(d.state).toBe('rolled-back');
    expect((await store.read()).policies[ID]).toBe('notify');
    // Dropped out of apply-when-idle ⇒ the native autoUpdate key is reverted (back to absent).
    expect(await settings.readAutoUpdate('mkt')).toBeUndefined();
  });

  test('autoUpdate:false is retained while any plugin in the marketplace is apply-when-idle', async () => {
    const svc = makeService();
    await svc.setPolicy('a@mkt', 'apply-when-idle');
    await svc.setPolicy('b@mkt', 'apply-when-idle');
    await svc.setPolicy('a@mkt', 'off'); // b@mkt still apply-when-idle
    expect(await settings.readAutoUpdate('mkt')).toBe(false);
    await svc.setPolicy('b@mkt', 'off');
    expect(await settings.readAutoUpdate('mkt')).toBeUndefined();
  });

  test('policy off ⇒ skipped/policy-off (no apply)', async () => {
    const d = await makeService().evaluatePlugin(ID, { manual: true });
    expect(d.state).toBe('skipped');
    expect(d.reason).toBe('policy-off');
    expect(ops.calls).not.toContain('update');
  });

  test('behind=null ⇒ check-failed', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    ops.inspectResult = { installedVersion: '1.0.0', availableVersion: null, behind: null, installPath: '/install/a' };
    const d = await makeService().evaluatePlugin(ID);
    expect(d.state).toBe('skipped');
    expect(d.reason).toBe('check-failed');
  });

  test('not behind ⇒ no-update', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    ops.inspectResult = { installedVersion: '2.0.0', availableVersion: '2.0.0', behind: false, installPath: '/install/a' };
    const d = await makeService().evaluatePlugin(ID);
    expect(d.reason).toBe('no-update');
    expect(ops.calls).not.toContain('update');
  });

  test('busy task ⇒ skipped/busy with the holder ids', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    tasks = [{ id: 't-unknown', isTerminal: false, loadout: undefined }];
    const d = await makeService().evaluatePlugin(ID);
    expect(d.reason).toBe('busy');
    expect(d.busyTaskIds).toEqual(['t-unknown']);
    expect(ops.calls).not.toContain('update');
  });

  test('idle + verify ok ⇒ applied, epoch bumped, observed + snapshot retained', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    const d = await makeService().evaluatePlugin(ID);
    expect(d.state).toBe('applied');
    expect(ops.calls).toEqual(['inspect', 'snapshot', 'update', 'verify', 'bump']);
    const data = await store.read();
    expect(data.observed[ID]).toBe('2.0.0');
    expect(data.snapshots[ID]).toBeDefined();
    expect(data.banners[ID]).toBeUndefined();
    expect((await audit.lastFor(ID))?.state).toBe('applied');
  });

  test('apply error ⇒ failed and the partial update is restored', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    ops.updateError = new Error('update blew up');
    const d = await makeService().evaluatePlugin(ID);
    expect(d.state).toBe('failed');
    expect(d.detail).toContain('update blew up');
    expect(ops.calls).toContain('restore');
    expect(ops.calls).not.toContain('bump');
  });

  test('verify fails, rollback ok ⇒ rolled-back, policy dropped to notify, banner raised', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    ops.verifyResult = false;
    ops.restoreResult = { ok: true };
    const d = await makeService().evaluatePlugin(ID);
    expect(d.state).toBe('rolled-back');
    const data = await store.read();
    expect(data.policies[ID]).toBe('notify');
    expect(data.banners[ID].kind).toBe('verify-failed');
    expect(ops.calls).toContain('restore');
  });

  test('verify fails, rollback fails ⇒ rollback-failed banner names the snapshot', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    ops.verifyResult = false;
    ops.restoreResult = { ok: false, snapshotPath: '/snap/a' };
    const d = await makeService().evaluatePlugin(ID);
    expect(d.state).toBe('rollback-failed');
    const data = await store.read();
    expect(data.policies[ID]).toBe('notify');
    expect(data.banners[ID].kind).toBe('rollback-failed');
    expect(data.banners[ID].snapshotPath).toBe('/snap/a');
  });

  test('verify fails with no snapshot ⇒ verify-failed, dropped to notify', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    ops.verifyResult = false;
    ops.snapshotResult = null;
    const d = await makeService().evaluatePlugin(ID);
    expect(d.state).toBe('verify-failed');
    expect(ops.calls).not.toContain('restore');
    expect((await store.read()).policies[ID]).toBe('notify');
  });

  test('apply gate off ⇒ non-manual skipped, manual still applies', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    const auto = await makeService({ applyEnabled: false }).evaluatePlugin(ID, { manual: false });
    expect(auto.state).toBe('skipped');
    expect(auto.reason).toBe('policy-off');
    const manual = await makeService({ applyEnabled: false }).evaluatePlugin(ID, { manual: true });
    expect(manual.state).toBe('applied');
  });

  test('operator rollback restores snapshot, bumps epoch, raises post-session banner', async () => {
    await store.update((d) => { d.snapshots[ID] = meta(); });
    const d = await makeService().rollback(ID);
    expect(d.state).toBe('rolled-back');
    expect(ops.calls).toContain('bump');
    expect((await store.read()).banners[ID].kind).toBe('post-session');
  });

  test('operator rollback with no snapshot ⇒ failed decision', async () => {
    const d = await makeService().rollback(ID);
    expect(d.state).toBe('failed');
    expect(d.detail).toContain('no retained snapshot');
  });

  test('runSweep evaluates apply-when-idle plugins, detects external changes, prunes expired snapshots', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    await store.update((d) => {
      d.observed['other@mkt'] = '1.0.0';
      d.snapshots['stale@mkt'] = meta({ pluginId: 'stale@mkt', retainUntil: PAST });
    });
    const readInstalled = async () => new Map<string, string | null>([[ID, '1.0.0'], ['other@mkt', '9.9.9']]);
    const result = await makeService({ readInstalled }).runSweep();
    expect(result.decisions.length).toBe(1); // only the apply-when-idle plugin
    expect(result.externalChanges).toBe(1); // other@mkt moved 1.0.0 -> 9.9.9
    const data = await store.read();
    expect(data.snapshots['stale@mkt']).toBeUndefined(); // pruned
    expect(data.observed['other@mkt']).toBe('9.9.9'); // baseline updated
    expect(ops.discarded).toContain('/snap/a'); // the EXPIRED snapshot dir is cleaned up
  });

  test('a fresh apply discards the OLD (superseded) snapshot dir, keeps the new', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    await store.update((d) => { d.snapshots[ID] = meta({ snapshotPath: '/snap/OLD' }); });
    ops.snapshotResult = meta({ snapshotPath: '/snap/NEW' });
    await makeService().evaluatePlugin(ID);
    expect(ops.discarded).toContain('/snap/OLD'); // the OLD dir is discarded...
    expect(ops.discarded).not.toContain('/snap/NEW'); // ...never the one just taken
    expect((await store.read()).snapshots[ID].snapshotPath).toBe('/snap/NEW');
  });

  test('every evaluation appends an audit decision', async () => {
    await store.setPolicy(ID, 'apply-when-idle');
    ops.inspectResult = { installedVersion: '2.0.0', availableVersion: '2.0.0', behind: false, installPath: '/install/a' };
    await makeService().evaluatePlugin(ID);
    await makeService().evaluatePlugin(ID);
    const recent = await audit.recent(10);
    expect(recent.length).toBe(2);
    expect(recent.every((d) => d.reason === 'no-update')).toBe(true);
  });

  test('getSurface includes stored + fleet plugins with their decisions', async () => {
    await store.setPolicy(ID, 'notify');
    const surface = await makeService().getSurface([ID, 'b@mkt']);
    expect(surface.applyEnabled).toBe(true);
    const a = surface.plugins.find((p) => p.pluginId === ID);
    expect(a?.policy).toBe('notify');
    expect(surface.plugins.find((p) => p.pluginId === 'b@mkt')?.policy).toBe('off');
  });
});
