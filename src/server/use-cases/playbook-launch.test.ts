import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePlaybookLaunch } from './playbook-launch.js';

describe('preparePlaybookLaunch', () => {
  it('parses a playbook into launch opts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await mkdir(join(cwd, 'docs'), { recursive: true });
      await writeFile(join(cwd, 'docs', 'deploy-checklist.md'), 'ship it');
      await writeFile(join(cwd, '.kookr', 'playbooks', 'deploy.md'), `---
name: Deploy
description: Ship it
parameters:
  - name: target
    required: true
checklist:
  - Verify deploy
---

Deploy to {{target}} after reading docs/deploy-checklist.md
`);

      const launch = await preparePlaybookLaunch({
        cwd,
        playbookPath: 'deploy.md',
        parameterValues: { target: 'prod' },
        autonomy: 'autonomous',
        agentType: 'claude-code',
      });

      expect(launch).toEqual(expect.objectContaining({
        prompt: `Deploy to prod after reading ${join(cwd, 'docs', 'deploy-checklist.md')}`,
        cwd,
        name: 'Deploy',
        autonomy: 'autonomous',
        agentType: 'claude-code',
      }));
      expect(launch.criteria).toContain('Verify deploy');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('passes parameterValues through to LaunchOpts for relaunch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'analyze.md'), `---
name: Analyze
parameters:
  - name: repo
    required: true
  - name: count
    required: false
---

Analyze {{repo}} with count {{count}}
`);

      const launch = await preparePlaybookLaunch({
        cwd,
        playbookPath: 'analyze.md',
        parameterValues: { repo: 'owner/repo', count: '10' },
      });

      expect(launch.playbookParameterValues).toEqual({ repo: 'owner/repo', count: '10' });
      expect(launch.prompt).toBe('Analyze owner/repo with count 10');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('derives projectId from tracked-projects parameter', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'oss.md'), `---
name: OSS Task
parameters:
  - name: repoFullName
    required: true
    type: select
    source: tracked-projects
---

Work on {{repoFullName}}
`);

      const launch = await preparePlaybookLaunch({
        cwd,
        playbookPath: 'oss.md',
        parameterValues: { repoFullName: 'grafana/grafana' },
      });

      expect(launch.projectId).toBe('github.com/grafana/grafana');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns undefined projectId when no tracked-projects parameter exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'plain.md'), `---
name: Plain Task
parameters:
  - name: target
    required: true
---

Deploy to {{target}}
`);

      const launch = await preparePlaybookLaunch({
        cwd,
        playbookPath: 'plain.md',
        parameterValues: { target: 'prod' },
      });

      expect(launch.projectId).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects path traversal', async () => {
    await expect(preparePlaybookLaunch({
      cwd: '/tmp/project',
      playbookPath: '../escape.md',
      parameterValues: {},
    })).rejects.toThrow('Invalid playbook path');
  });
});
