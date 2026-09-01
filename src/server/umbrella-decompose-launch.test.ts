import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveUmbrellaDecomposeLaunch, UMBRELLA_DECOMPOSE_PLAYBOOK_PATH } from './umbrella-decompose-launch.js';

/**
 * Direct tests for the plugin-tier resolution the idle-refinery runner depends
 * on (issue #2144). The runner's own tests mock this resolver, so its real
 * behavior — resolve the bundled playbook, derive criteria from the checklist,
 * and return null (not throw) when unresolvable — is only pinned here.
 */
describe('resolveUmbrellaDecomposeLaunch', () => {
  const repoRoot = join(import.meta.dirname, '..', '..');
  const pluginDir = join(repoRoot, 'plugin');
  let prevPluginDir: string | undefined;

  beforeEach(() => {
    prevPluginDir = process.env.KOOKR_PLUGIN_DIR;
  });
  afterEach(() => {
    if (prevPluginDir === undefined) delete process.env.KOOKR_PLUGIN_DIR;
    else process.env.KOOKR_PLUGIN_DIR = prevPluginDir;
  });

  it('resolves the bundled plugin-tier playbook into launch inputs', async () => {
    process.env.KOOKR_PLUGIN_DIR = pluginDir;
    const launch = await resolveUmbrellaDecomposeLaunch(repoRoot);
    expect(launch).not.toBeNull();
    expect(launch!.playbookId).toBe(UMBRELLA_DECOMPOSE_PLAYBOOK_PATH);
    expect(launch!.playbookSource).toEqual({
      id: UMBRELLA_DECOMPOSE_PLAYBOOK_PATH,
      scope: 'plugin',
      sourceCwd: join(pluginDir, 'playbooks'),
      sourceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(launch!.playbookParameterValues).toEqual({});
    expect(launch!.name).toBe('Umbrella Decompose');
    // Body is the real playbook prose, no leftover {{placeholders}}.
    expect(launch!.prompt).toContain('supply refinery');
    expect(launch!.prompt).not.toMatch(/\{\{[^}]+\}\}/);
    // Criteria is derived from the playbook checklist.
    expect(launch!.criteria).toContain('human-sanctioned umbrella');
  });

  it('returns null (does not throw) when the working directory does not exist', async () => {
    process.env.KOOKR_PLUGIN_DIR = pluginDir;
    expect(await resolveUmbrellaDecomposeLaunch(join(repoRoot, 'no', 'such', 'dir'))).toBeNull();
  });

  it('returns null when the plugin tier is unresolvable (hermetic mode)', async () => {
    process.env.KOOKR_PLUGIN_DIR = '';
    expect(await resolveUmbrellaDecomposeLaunch(repoRoot)).toBeNull();
  });
});
