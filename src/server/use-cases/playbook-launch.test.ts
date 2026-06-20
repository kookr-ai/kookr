import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { preparePlaybookLaunch, preparePlaybookLaunchWithMetadata } from './playbook-launch.js';

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_WORK_TREE',
  ]) {
    delete env[key];
  }
  return env;
}

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
        agentType: 'claude-code',
      });

      expect(launch).toEqual(expect.objectContaining({
        prompt: `Deploy to prod after reading ${join(cwd, 'docs', 'deploy-checklist.md')}`,
        cwd,
        name: 'Deploy',
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

  it('passes playbook launch dependencies through to LaunchOpts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'kb-task.md'), `---
name: KB Task
dependencies: [kb]
---

Use the KB.
`);

      const launch = await preparePlaybookLaunch({
        cwd,
        playbookPath: 'kb-task.md',
        parameterValues: {},
      });

      expect(launch.dependencies).toEqual(['kb']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('validates autonomous evolution config before launch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'autonomous-evolution.md'), `---
name: Autonomous Evolution
parameters:
  - name: projectCwd
    required: false
    default: ""
  - name: targetScore
    required: false
    default: ""
    gatedBy: evolution-config
---
Run evolution in {{projectCwd}} toward {{targetScore}}.
`);

      await expect(preparePlaybookLaunch({
        cwd,
        playbookPath: 'autonomous-evolution.md',
        parameterValues: { targetScore: '2.0' },
      })).rejects.toThrow(/requires a valid \.kookr\/evolution\/config\.json/i);

      await mkdir(join(cwd, '.kookr', 'evolution'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'evolution', 'config.json'), JSON.stringify({
        schemaVersion: 'kookr-evolution-config.v1',
        evaluate: './evaluate.sh',
        artifact: 'strategy.json',
      }));

      const launch = await preparePlaybookLaunch({
        cwd,
        playbookPath: 'autonomous-evolution.md',
        parameterValues: { targetScore: '2.0' },
      });

      expect(launch.prompt).toBe('Run evolution in  toward 2.0.');
      expect(launch.playbookParameterValues).toEqual({ targetScore: '2.0' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('surfaces malformed autonomous evolution config errors before launch', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await mkdir(join(cwd, '.kookr', 'evolution'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'evolution', 'config.json'), '{not json');
      await writeFile(join(cwd, '.kookr', 'playbooks', 'autonomous-evolution.md'), `---
name: Autonomous Evolution
parameters:
  - name: targetScore
    required: false
    default: ""
    gatedBy: evolution-config
---
Run evolution toward {{targetScore}}.
`);

      await expect(preparePlaybookLaunch({
        cwd,
        playbookPath: 'autonomous-evolution.md',
        parameterValues: { targetScore: '2.0' },
      })).rejects.toThrow(/Malformed \.kookr\/evolution\/config\.json/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('validates autonomous evolution config from the projectCwd parameter', async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), 'playbook-source-'));
    const projectCwd = await mkdtemp(join(tmpdir(), 'evolution-project-'));
    try {
      await mkdir(join(sourceCwd, '.kookr', 'playbooks'), { recursive: true });
      await mkdir(join(projectCwd, '.kookr', 'evolution'), { recursive: true });
      await writeFile(join(projectCwd, '.kookr', 'evolution', 'config.json'), JSON.stringify({
        schemaVersion: 'kookr-evolution-config.v1',
        evaluate: './evaluate.sh',
        artifact: 'strategy.json',
      }));
      await writeFile(join(sourceCwd, '.kookr', 'playbooks', 'autonomous-evolution.md'), `---
name: Autonomous Evolution
parameters:
  - name: projectCwd
    required: false
    default: ""
  - name: patience
    required: false
    default: ""
    gatedBy: evolution-config
---
Run evolution in {{projectCwd}} with patience {{patience}}.
`);

      const launch = await preparePlaybookLaunch({
        cwd: sourceCwd,
        playbookPath: 'autonomous-evolution.md',
        parameterValues: { projectCwd, patience: '5' },
      });

      expect(launch.prompt).toBe(`Run evolution in ${projectCwd} with patience 5.`);
    } finally {
      await rm(sourceCwd, { recursive: true, force: true });
      await rm(projectCwd, { recursive: true, force: true });
    }
  });

  it('resolves deliveryPreAuthorized to a server-internal delivery policy', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'ship.md'), `---
name: Ship
deliveryPreAuthorized: true
---

Ship it.
`);

      const prepared = await preparePlaybookLaunchWithMetadata({
        cwd,
        playbookPath: 'ship.md',
        parameterValues: {},
      });

      expect(prepared.deliveryPolicy).toBe('pre-authorized');
      expect(prepared.launchOpts).not.toHaveProperty('deliveryPreAuthorized');
      expect(prepared.launchOpts).not.toHaveProperty('deliveryPolicy');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('defaults playbook launches to ask-first delivery policy', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'ask.md'), `---
name: Ask
---

Ask first.
`);

      const prepared = await preparePlaybookLaunchWithMetadata({
        cwd,
        playbookPath: 'ask.md',
        parameterValues: {},
      });

      expect(prepared.deliveryPolicy).toBe('ask-first');
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

  it('fills blank git-remote default parameters from the launch cwd remote', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      const env = cleanGitEnv();
      execFileSync('git', ['init', '--initial-branch=main'], { cwd, env });
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/Widget.git'], { cwd, env });
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'ideas.md'), `---
name: Ideas
parameters:
  - name: repoFullName
    required: false
    defaultFrom: git-remote
---

Repo {{repoFullName}}
`);

      const launch = await preparePlaybookLaunch({
        cwd,
        playbookPath: 'ideas.md',
        parameterValues: { repoFullName: '' },
      });

      expect(launch.prompt).toBe('Repo acme/widget');
      expect(launch.projectId).toBe('github.com/acme/widget');
      expect(launch.playbookParameterValues).toEqual({ repoFullName: 'acme/widget' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps an explicit parameter value when git-remote default is available', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      const env = cleanGitEnv();
      execFileSync('git', ['init', '--initial-branch=main'], { cwd, env });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], { cwd, env });
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'ideas.md'), `---
name: Ideas
parameters:
  - name: repoFullName
    required: false
    defaultFrom: git-remote
---

Repo {{repoFullName}}
`);

      const launch = await preparePlaybookLaunch({
        cwd,
        playbookPath: 'ideas.md',
        parameterValues: { repoFullName: 'other/project' },
      });

      expect(launch.prompt).toBe('Repo other/project');
      expect(launch.projectId).toBe('github.com/other/project');
      expect(launch.playbookParameterValues).toEqual({ repoFullName: 'other/project' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reads the playbook from source cwd and launches in target cwd', async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), 'playbook-source-'));
    const targetCwd = await mkdtemp(join(tmpdir(), 'playbook-target-'));
    try {
      await mkdir(join(sourceCwd, '.kookr', 'playbooks'), { recursive: true });
      await mkdir(join(targetCwd, 'docs'), { recursive: true });
      await writeFile(join(targetCwd, 'docs', 'target-note.md'), 'target file');
      await writeFile(join(sourceCwd, '.kookr', 'playbooks', 'quality.md'), `---
name: Quality
checklist:
  - Improve tests
---

Review docs/target-note.md
`);

      const launch = await preparePlaybookLaunch({
        playbookSourceCwd: sourceCwd,
        taskTargetCwd: targetCwd,
        projectId: `local/${basename(targetCwd)}`,
        playbookPath: 'quality.md',
        parameterValues: {},
      });

      expect(launch.cwd).toBe(targetCwd);
      expect(launch.prompt).toBe(`Review ${join(targetCwd, 'docs', 'target-note.md')}`);
      expect(launch.projectId).toBe(`local/${basename(targetCwd)}`);
      expect(launch.criteria).toContain('Improve tests');
    } finally {
      await rm(sourceCwd, { recursive: true, force: true });
      await rm(targetCwd, { recursive: true, force: true });
    }
  });

  it('rejects explicit projectId when it conflicts with target cwd identity', async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), 'playbook-source-'));
    const targetCwd = await mkdtemp(join(tmpdir(), 'playbook-target-'));
    try {
      await mkdir(join(sourceCwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(sourceCwd, '.kookr', 'playbooks', 'quality.md'), `---
name: Quality
---

Review tests.
`);

      await expect(preparePlaybookLaunch({
        playbookSourceCwd: sourceCwd,
        taskTargetCwd: targetCwd,
        projectId: 'github.com/acme/wrong',
        playbookPath: 'quality.md',
        parameterValues: {},
      })).rejects.toThrow(/projectId.*does not match/i);
    } finally {
      await rm(sourceCwd, { recursive: true, force: true });
      await rm(targetCwd, { recursive: true, force: true });
    }
  });

  it('rejects explicit projectId when tracked-project param matches but target cwd does not', async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), 'playbook-source-'));
    const targetCwd = await mkdtemp(join(tmpdir(), 'playbook-target-'));
    try {
      await mkdir(join(sourceCwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(sourceCwd, '.kookr', 'playbooks', 'oss.md'), `---
name: OSS Task
parameters:
  - name: repoFullName
    required: true
    type: select
    source: tracked-projects
---

Work on {{repoFullName}}.
`);

      await expect(preparePlaybookLaunch({
        playbookSourceCwd: sourceCwd,
        taskTargetCwd: targetCwd,
        projectId: 'github.com/grafana/grafana',
        playbookPath: 'oss.md',
        parameterValues: { repoFullName: 'grafana/grafana' },
      })).rejects.toThrow(/projectId.*does not match target cwd project/i);
    } finally {
      await rm(sourceCwd, { recursive: true, force: true });
      await rm(targetCwd, { recursive: true, force: true });
    }
  });

  it('preserves legacy cwd behavior when frontmatter cwd pins execution', async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), 'playbook-source-'));
    const pinnedCwd = await mkdtemp(join(tmpdir(), 'playbook-pinned-'));
    try {
      await mkdir(join(sourceCwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(sourceCwd, '.kookr', 'playbooks', 'pinned.md'), `---
name: Pinned
cwd: ${pinnedCwd}
---

Run pinned.
`);

      const launch = await preparePlaybookLaunch({
        cwd: sourceCwd,
        playbookPath: 'pinned.md',
        parameterValues: {},
      });

      expect(launch.cwd).toBe(pinnedCwd);
    } finally {
      await rm(sourceCwd, { recursive: true, force: true });
      await rm(pinnedCwd, { recursive: true, force: true });
    }
  });

  it('rejects explicit target override when frontmatter cwd pins another execution target', async () => {
    const sourceCwd = await mkdtemp(join(tmpdir(), 'playbook-source-'));
    const pinnedCwd = await mkdtemp(join(tmpdir(), 'playbook-pinned-'));
    const targetCwd = await mkdtemp(join(tmpdir(), 'playbook-target-'));
    try {
      await mkdir(join(sourceCwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(sourceCwd, '.kookr', 'playbooks', 'pinned.md'), `---
name: Pinned
cwd: ${pinnedCwd}
---

Run pinned.
`);

      await expect(preparePlaybookLaunch({
        playbookSourceCwd: sourceCwd,
        taskTargetCwd: targetCwd,
        playbookPath: 'pinned.md',
        parameterValues: {},
      })).rejects.toThrow(/pins working directory/i);
    } finally {
      await rm(sourceCwd, { recursive: true, force: true });
      await rm(pinnedCwd, { recursive: true, force: true });
      await rm(targetCwd, { recursive: true, force: true });
    }
  });

  it('expands $HOME in playbook cwd metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'playbook-launch-'));
    try {
      await mkdir(join(cwd, '.kookr', 'playbooks'), { recursive: true });
      await writeFile(join(cwd, '.kookr', 'playbooks', 'home-cwd.md'), `---
name: Home CWD Task
cwd: $HOME
---

Work from home.
`);

      const launch = await preparePlaybookLaunch({
        cwd,
        playbookPath: 'home-cwd.md',
        parameterValues: {},
      });

      expect(launch.cwd).toBe(homedir());
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

  it('reads from user dir when scope=user, runs in dialog cwd', async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), 'playbook-project-'));
    const userDir = await mkdtemp(join(tmpdir(), 'kookr-user-'));
    const previous = process.env.KOOKR_USER_PLAYBOOKS_DIR;
    process.env.KOOKR_USER_PLAYBOOKS_DIR = userDir;
    try {
      await writeFile(join(userDir, 'audit.md'), `---
name: Audit
description: Run an audit
parameters:
  - name: repo
    required: true
---

Audit ${'{{repo}}'}.
`);

      const launch = await preparePlaybookLaunch({
        cwd: projectCwd,
        playbookPath: 'audit.md',
        parameterValues: { repo: 'foo' },
        scope: 'user',
      });

      // Reads file from userDir, but the task still runs in projectCwd
      // (no `cwd:` override in the playbook).
      expect(launch.cwd).toBe(projectCwd);
      expect(launch.name).toBe('Audit');
      expect(launch.prompt).toBe('Audit foo.');
    } finally {
      if (previous === undefined) delete process.env.KOOKR_USER_PLAYBOOKS_DIR;
      else process.env.KOOKR_USER_PLAYBOOKS_DIR = previous;
      await rm(projectCwd, { recursive: true, force: true });
      await rm(userDir, { recursive: true, force: true });
    }
  });

  it('reads from plugin dir when scope=plugin, runs in dialog cwd', async () => {
    const projectCwd = await mkdtemp(join(tmpdir(), 'playbook-project-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'kookr-plugin-'));
    const previous = process.env.KOOKR_PLUGIN_DIR;
    try {
      // Build a minimal plugin tree
      await mkdir(join(pluginRoot, 'plugin', '.claude-plugin'), { recursive: true });
      await writeFile(
        join(pluginRoot, 'plugin', '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'fake', version: '0.0.0' }),
      );
      const playbooksDir = join(pluginRoot, 'plugin', 'playbooks');
      await mkdir(playbooksDir, { recursive: true });
      await writeFile(join(playbooksDir, 'oss-bug-fix.md'), `---
name: OSS Bug Fix
---

Generic body.
`);
      process.env.KOOKR_PLUGIN_DIR = join(pluginRoot, 'plugin');

      const launch = await preparePlaybookLaunch({
        cwd: projectCwd,
        playbookPath: 'oss-bug-fix.md',
        parameterValues: {},
        scope: 'plugin',
      });

      expect(launch.cwd).toBe(projectCwd);
      expect(launch.name).toBe('OSS Bug Fix');
    } finally {
      if (previous === undefined) delete process.env.KOOKR_PLUGIN_DIR;
      else process.env.KOOKR_PLUGIN_DIR = previous;
      await rm(projectCwd, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('rejects path traversal for scope=user as well', async () => {
    const userDir = await mkdtemp(join(tmpdir(), 'kookr-user-'));
    const previous = process.env.KOOKR_USER_PLAYBOOKS_DIR;
    process.env.KOOKR_USER_PLAYBOOKS_DIR = userDir;
    try {
      await expect(preparePlaybookLaunch({
        cwd: '/tmp/project',
        playbookPath: '../escape.md',
        parameterValues: {},
        scope: 'user',
      })).rejects.toThrow('Invalid playbook path');
    } finally {
      if (previous === undefined) delete process.env.KOOKR_USER_PLAYBOOKS_DIR;
      else process.env.KOOKR_USER_PLAYBOOKS_DIR = previous;
      await rm(userDir, { recursive: true, force: true });
    }
  });
});
