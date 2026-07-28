import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleValidator } from './schedule-validator.js';
import { ScheduleValidationError, type Schedule } from '../core/schedule.js';
import type { PlaybookScope } from '../core/playbook.js';

const PLAYBOOK = (name: string) => `---
name: ${name}
description: A test playbook
parameters: []
checklist:
  - Step 1
---

Do the ${name} thing.
`;

const INVALID_PATH_ERROR = 'Playbook path must stay inside the selected playbooks directory';

describe('ScheduleValidator (tier-aware resolution)', () => {
  let root: string;
  let projectCwd: string;
  let userDir: string;
  let pluginRoot: string;
  let validator: ScheduleValidator;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sched-validator-'));
    projectCwd = join(root, 'project');
    userDir = join(root, 'user-playbooks');
    pluginRoot = join(root, 'plugin');

    await mkdir(join(projectCwd, '.kookr', 'playbooks'), { recursive: true });
    await mkdir(userDir, { recursive: true });
    await mkdir(join(pluginRoot, 'playbooks'), { recursive: true });
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), '{"name":"kookr-toolkit"}');

    await writeFile(join(projectCwd, '.kookr', 'playbooks', 'proj.md'), PLAYBOOK('Project Playbook'));
    await writeFile(join(userDir, 'usr.md'), PLAYBOOK('User Playbook'));
    await writeFile(join(pluginRoot, 'playbooks', 'plug.md'), PLAYBOOK('Plugin Playbook'));

    process.env.KOOKR_USER_PLAYBOOKS_DIR = userDir;
    process.env.KOOKR_PLUGIN_DIR = pluginRoot;
    validator = new ScheduleValidator();
  });

  afterEach(async () => {
    delete process.env.KOOKR_USER_PLAYBOOKS_DIR;
    delete process.env.KOOKR_PLUGIN_DIR;
    await rm(root, { recursive: true, force: true });
  });

  function makeSchedule(overrides: Partial<Schedule> & { playbook: Schedule['playbook'] }): Schedule {
    return {
      id: 'sched-1',
      name: 'Test',
      enabled: true,
      cron: '0 9 * * *',
      cwd: projectCwd,
      agentType: 'claude-code',
      executionLedger: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('resolveLaunch', () => {
    it('resolves a project-scoped playbook', async () => {
      const launch = await validator.resolveLaunch(makeSchedule({
        playbook: { path: 'proj.md', parameters: {}, scope: 'project' },
      }));
      expect(launch.prompt).toContain('Project Playbook thing');
      expect(launch.playbookId).toBe('proj.md');
    });

    it('resolves a user-scoped playbook whose cwd lacks the file', async () => {
      const launch = await validator.resolveLaunch(makeSchedule({
        playbook: { path: 'usr.md', parameters: {}, scope: 'user' },
      }));
      expect(launch.prompt).toContain('User Playbook thing');
      expect(launch.playbookId).toBe('usr.md');
    });

    it('resolves a plugin-scoped playbook whose cwd lacks the file', async () => {
      const launch = await validator.resolveLaunch(makeSchedule({
        playbook: { path: 'plug.md', parameters: {}, scope: 'plugin' },
      }));
      expect(launch.prompt).toContain('Plugin Playbook thing');
      expect(launch.playbookId).toBe('plug.md');
    });

    it('legacy schedule (no scope) resolves from the project tier only', async () => {
      const launch = await validator.resolveLaunch(makeSchedule({
        playbook: { path: 'proj.md', parameters: {} },
      }));
      expect(launch.prompt).toContain('Project Playbook thing');
    });

    it('legacy schedule does NOT resolve a same-named plugin file', async () => {
      // plug.md lives only in the plugin tier; a legacy (project) schedule misses.
      await expect(validator.resolveLaunch(makeSchedule({
        playbook: { path: 'plug.md', parameters: {} },
      }))).rejects.toMatchObject({ fieldErrors: { playbook: 'Playbook not found' } });
    });

    it('a deleted pinned-tier file fails missing_playbook with NO cross-tier substitution', async () => {
      // proj.md exists in project but NOT plugin; pin plugin → must fail loudly.
      await expect(validator.resolveLaunch(makeSchedule({
        playbook: { path: 'proj.md', parameters: {}, scope: 'plugin' },
      }))).rejects.toMatchObject({
        message: expect.stringContaining('plugin tier'),
        fieldErrors: { playbook: 'Playbook not found' },
      });
    });

    it('rejects a path that escapes the pinned tier', async () => {
      await writeFile(join(projectCwd, 'escape.md'), PLAYBOOK('Escaped Playbook'));

      await expect(validator.resolveLaunch(makeSchedule({
        playbook: { path: '../../escape.md', parameters: {}, scope: 'project' },
      }))).rejects.toMatchObject({
        name: 'ScheduleValidationError',
        fieldErrors: { playbook: INVALID_PATH_ERROR },
      });
    });

    it('rejects an absolute playbook path before reading it', async () => {
      const escaped = join(root, 'absolute.md');
      await writeFile(escaped, PLAYBOOK('Absolute Playbook'));

      await expect(validator.resolveLaunch(makeSchedule({
        playbook: { path: escaped, parameters: {}, scope: 'project' },
      }))).rejects.toMatchObject({
        name: 'ScheduleValidationError',
        fieldErrors: { playbook: INVALID_PATH_ERROR },
      });
    });

    it('rejects a scoped playbook symlink that resolves outside the playbooks directory', async () => {
      const escaped = join(root, 'outside.md');
      await writeFile(escaped, PLAYBOOK('Outside Playbook'));
      await symlink(escaped, join(projectCwd, '.kookr', 'playbooks', 'linked.md'));

      await expect(validator.resolveLaunch(makeSchedule({
        playbook: { path: 'linked.md', parameters: {}, scope: 'project' },
      }))).rejects.toMatchObject({
        name: 'ScheduleValidationError',
        fieldErrors: { playbook: INVALID_PATH_ERROR },
      });
    });

    it('playbookId stays the bare filename regardless of scope', async () => {
      const launch = await validator.resolveLaunch(makeSchedule({
        playbook: { path: 'plug.md', parameters: {}, scope: 'plugin' },
      }));
      expect(launch.playbookId).toBe('plug.md');
    });
  });

  describe('validate / runtime parity (R6)', () => {
    it('validateCreate accepts a plugin-scoped playbook; runtime resolves the same tier', async () => {
      await expect(validator.validateCreate({
        name: 'Plug',
        cron: '0 9 * * *',
        cwd: projectCwd,
        playbook: { path: 'plug.md', parameters: {}, scope: 'plugin' },
      })).resolves.toBeUndefined();
    });

    it('validateDefinitionUpdate omitting scope resolves the pinned scope (parity)', async () => {
      const existing = makeSchedule({ playbook: { path: 'plug.md', parameters: {}, scope: 'plugin' } });
      // Patch only the cron — no scope. Must still validate against the plugin tier.
      await expect(validator.validateDefinitionUpdate(existing, { cron: '0 10 * * *' }))
        .resolves.toBeUndefined();
    });

    it('validateCreate of a plugin file with default (project) scope fails', async () => {
      await expect(validator.validateCreate({
        name: 'Bad',
        cron: '0 9 * * *',
        cwd: projectCwd,
        playbook: { path: 'plug.md', parameters: {} },
      })).rejects.toMatchObject({ fieldErrors: { playbook: 'Playbook not found' } });
    });

    it('validateCreate rejects traversal before resolving a playbook', async () => {
      await writeFile(join(projectCwd, 'escape.md'), PLAYBOOK('Escaped Create Playbook'));

      await expect(validator.validateCreate({
        name: 'Traversal',
        cron: '0 9 * * *',
        cwd: projectCwd,
        playbook: { path: '../../escape.md', parameters: {} },
      })).rejects.toMatchObject({
        name: 'ScheduleValidationError',
        fieldErrors: { playbook: INVALID_PATH_ERROR },
      });
    });

    it('validateDefinitionUpdate rejects an absolute playbook path', async () => {
      const escaped = join(root, 'absolute-update.md');
      await writeFile(escaped, PLAYBOOK('Absolute Update Playbook'));
      const existing = makeSchedule({ playbook: { path: 'proj.md', parameters: {}, scope: 'project' } });

      await expect(validator.validateDefinitionUpdate(existing, {
        playbook: { path: escaped, parameters: {} },
      })).rejects.toMatchObject({
        name: 'ScheduleValidationError',
        fieldErrors: { playbook: INVALID_PATH_ERROR },
      });
    });

    it('tolerates an unknown scope value gracefully (unresolvable, not a hard throw)', async () => {
      // A newer client persisted an unrecognised scope; validation must report
      // it as a field error, not throw an unexpected error type.
      await expect(validator.validateCreate({
        name: 'Future',
        cron: '0 9 * * *',
        cwd: projectCwd,
        playbook: { path: 'plug.md', parameters: {}, scope: 'future-tier' as PlaybookScope },
      })).rejects.toMatchObject({
        name: 'ScheduleValidationError',
        fieldErrors: { playbook: 'Playbook not found' },
      });
    });
  });

  describe('effort and model pins (#1518)', () => {
    it('accepts claude-code Fable at max', async () => {
      await expect(validator.validateCreate({
        name: 'Reflect',
        cron: '0 9 * * *',
        cwd: projectCwd,
        agentType: 'claude-code',
        effort: 'max',
        model: 'claude-fable-5',
        playbook: { path: 'proj.md', parameters: {}, scope: 'project' },
      })).resolves.toBeUndefined();
    });

    it('rejects invalid effort for the agent', async () => {
      await expect(validator.validateCreate({
        name: 'Bad effort',
        cron: '0 9 * * *',
        cwd: projectCwd,
        agentType: 'claude-code',
        effort: 'ultra',
        playbook: { path: 'proj.md', parameters: {}, scope: 'project' },
      })).rejects.toMatchObject({
        name: 'ScheduleValidationError',
        fieldErrors: { effort: expect.stringMatching(/low|medium|high/) },
      });
    });

    it('rejects invalid model for claude-code', async () => {
      await expect(validator.validateCreate({
        name: 'Bad model',
        cron: '0 9 * * *',
        cwd: projectCwd,
        agentType: 'claude-code',
        model: 'gpt-5.6-sol',
        playbook: { path: 'proj.md', parameters: {}, scope: 'project' },
      })).rejects.toMatchObject({
        name: 'ScheduleValidationError',
        fieldErrors: { model: expect.stringMatching(/claude-fable-5|Must be one of/) },
      });
    });

    it('rejects model pin for round-robin agent selection', async () => {
      await expect(validator.validateCreate({
        name: 'RR model',
        cron: '0 9 * * *',
        cwd: projectCwd,
        agentType: 'round-robin',
        model: 'claude-fable-5',
        playbook: { path: 'proj.md', parameters: {}, scope: 'project' },
      })).rejects.toMatchObject({
        name: 'ScheduleValidationError',
        fieldErrors: { model: expect.stringMatching(/round-robin/) },
      });
    });

    it('rejects model pin for codex-cli (empty allowlist)', async () => {
      await expect(validator.validateCreate({
        name: 'Codex model',
        cron: '0 9 * * *',
        cwd: projectCwd,
        agentType: 'codex-cli',
        model: 'claude-fable-5',
        playbook: { path: 'proj.md', parameters: {}, scope: 'project' },
      })).rejects.toMatchObject({
        name: 'ScheduleValidationError',
        fieldErrors: { model: expect.stringMatching(/does not accept/) },
      });
    });
  });
});
