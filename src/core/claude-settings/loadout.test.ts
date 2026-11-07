import { describe, test, expect, afterEach, vi } from 'vitest';
import {
  resolveLoadout,
  renderEnabledPlugins,
  pluginLoadoutsEnabled,
  INLINE_MARKETPLACE,
} from './loadout.js';
import { emptyResolvedLoadout, isEmptyResolvedLoadout } from '../../shared/contracts/plugins.js';

describe('resolveLoadout — precedence (task-type → playbook → project, most specific wins)', () => {
  test('most specific level wins per plugin', () => {
    const { loadout, provenance } = resolveLoadout(
      {
        project: { plugins: { 'stripe@mkt': true, 'kookr-toolkit@kookr': true } },
        playbook: { plugins: { 'stripe@mkt': false } },
        'task-type': { plugins: { 'kookr-toolkit@kookr': false } },
      },
      { mode: 'normal' },
    );
    expect(loadout.enabledOverrides).toEqual({
      'stripe@mkt': false, // playbook overrides project
      'kookr-toolkit@kookr': false, // task-type overrides project
    });
    expect(provenance.winningLevel).toBe('task-type');
    expect(loadout.deniedSkills).toEqual([]); // R3a
  });

  test('a plugin decided only at project level keeps the project value', () => {
    const { loadout, provenance } = resolveLoadout(
      { project: { plugins: { 'a@m': false } }, playbook: { plugins: { 'b@m': true } } },
      { mode: 'normal' },
    );
    expect(loadout.enabledOverrides).toEqual({ 'a@m': false, 'b@m': true });
    expect(provenance.winningLevel).toBe('playbook'); // most specific contributing level
  });

  test('all-empty input resolves to an empty loadout with winningLevel none', () => {
    const { loadout, provenance } = resolveLoadout({}, { mode: 'normal' });
    expect(isEmptyResolvedLoadout(loadout)).toBe(true);
    expect(provenance.winningLevel).toBe('none');
    expect(loadout.enabledOverrides).toEqual({});
  });

  test('malformed (non-boolean) values are ignored', () => {
    const { loadout } = resolveLoadout(
      { project: { plugins: { 'a@m': 'yes' as unknown as boolean, 'b@m': true } } },
      { mode: 'normal' },
    );
    expect(loadout.enabledOverrides).toEqual({ 'b@m': true });
  });
});

describe('resolveLoadout — spawn-mode semantics (RFC F3)', () => {
  test('bypass mode emits enabledSet as the FULL allowlist of enabled ids (not a diff)', () => {
    const { loadout } = resolveLoadout(
      { project: { plugins: { 'a@m': true, 'b@m': false, 'c@m': true } } },
      { mode: 'bypass' },
    );
    expect(loadout.enabledSet).toEqual(['a@m', 'c@m']); // sorted, only the enabled ones
    expect(loadout.enabledOverrides).toEqual({ 'a@m': true, 'b@m': false, 'c@m': true });
  });

  test('normal mode does not emit enabledSet (overrides are a diff of the user scope)', () => {
    const { loadout } = resolveLoadout(
      { project: { plugins: { 'a@m': true } } },
      { mode: 'normal' },
    );
    expect(loadout.enabledSet).toBeUndefined();
  });

  test('provenance records the mode', () => {
    expect(resolveLoadout({}, { mode: 'bypass' }).provenance.mode).toBe('bypass');
    expect(resolveLoadout({}, { mode: 'normal' }).provenance.mode).toBe('normal');
  });
});

describe('renderEnabledPlugins', () => {
  test('empty loadout renders to undefined (byte-identity: the key is omitted)', () => {
    expect(renderEnabledPlugins(emptyResolvedLoadout())).toBeUndefined();
    expect(
      renderEnabledPlugins({ enabledOverrides: {}, deniedSkills: [], enabledSet: [] }),
    ).toBeUndefined();
  });

  test('marketplace plugins keep their authored id', () => {
    expect(
      renderEnabledPlugins({ enabledOverrides: { 'stripe@mkt': false }, deniedSkills: [] }),
    ).toEqual({ 'stripe@mkt': false });
  });

  test('a --plugin-dir-loaded plugin is rewritten to <name>@inline (P2 probe)', () => {
    // The budget lever only works under the @inline id, never the marketplace id.
    expect(
      renderEnabledPlugins(
        { enabledOverrides: { 'kookr-toolkit@kookr': false }, deniedSkills: [] },
        { dirLoadedPluginNames: ['kookr-toolkit'] },
      ),
    ).toEqual({ [`kookr-toolkit@${INLINE_MARKETPLACE}`]: false });
  });

  test('non-dir plugins are untouched even when a dir plugin is present', () => {
    expect(
      renderEnabledPlugins(
        { enabledOverrides: { 'kookr-toolkit@kookr': false, 'stripe@mkt': true }, deniedSkills: [] },
        { dirLoadedPluginNames: ['kookr-toolkit'] },
      ),
    ).toEqual({ 'kookr-toolkit@inline': false, 'stripe@mkt': true });
  });
});

describe('pluginLoadoutsEnabled', () => {
  afterEach(() => vi.unstubAllEnvs());

  test('default off; on only for 1/true', () => {
    expect(pluginLoadoutsEnabled({})).toBe(false);
    expect(pluginLoadoutsEnabled({ KOOKR_PLUGIN_LOADOUTS: '0' })).toBe(false);
    expect(pluginLoadoutsEnabled({ KOOKR_PLUGIN_LOADOUTS: 'false' })).toBe(false);
    expect(pluginLoadoutsEnabled({ KOOKR_PLUGIN_LOADOUTS: '1' })).toBe(true);
    expect(pluginLoadoutsEnabled({ KOOKR_PLUGIN_LOADOUTS: 'true' })).toBe(true);
  });
});
