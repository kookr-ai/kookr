import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

  // #3901: an optional parameter with no default renders as '', as it does for
  // manual and scheduled launches, instead of leaving a literal {{name}}.
  it('renders an optional parameter with no default as blank, without recording it', async () => {
    const tmpPluginDir = await mkdtemp(join(tmpdir(), 'kookr-umbrella-plugin-'));
    try {
      // A plugin dir is only valid with its manifest (pluginDirIsValid).
      await mkdir(join(tmpPluginDir, '.claude-plugin'), { recursive: true });
      await writeFile(join(tmpPluginDir, '.claude-plugin', 'plugin.json'), '{"name":"kookr-toolkit"}\n');
      await mkdir(join(tmpPluginDir, 'playbooks'), { recursive: true });
      await writeFile(join(tmpPluginDir, 'playbooks', UMBRELLA_DECOMPOSE_PLAYBOOK_PATH), [
        '---',
        'name: Umbrella Decompose',
        'parameters:',
        '  - name: focus',
        '    description: Optional focus area',
        '    required: false',
        '  - name: depth',
        '    description: Optional depth',
        '    required: false',
        '    default: shallow',
        '---',
        'Focus: [{{focus}}] Depth: [{{depth}}]',
        '',
      ].join('\n'));
      process.env.KOOKR_PLUGIN_DIR = tmpPluginDir;
      const launch = await resolveUmbrellaDecomposeLaunch(repoRoot);
      expect(launch).not.toBeNull();
      expect(launch!.prompt).toContain('Focus: [] Depth: [shallow]');
      expect(launch!.prompt).not.toMatch(/\{\{[^}]+\}\}/);
      // The blank is for interpolation only; recorded values stay defaults-only.
      expect(launch!.playbookParameterValues).toEqual({ depth: 'shallow' });
    } finally {
      await rm(tmpPluginDir, { recursive: true, force: true });
    }
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
