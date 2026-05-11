import { describe, expect, it } from 'vitest';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getToolkitSymlinkStatus } from './toolkit-symlink-status.js';

async function writeAssetListScript(root: string): Promise<string> {
  const scriptsDir = join(root, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  const script = join(scriptsDir, 'install-hooks.sh');
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--print-global-assets" ]; then
  printf '%s\\t%s\\t%s\\n' 'oss-stale-scout-gate.sh' 'hooks/oss-stale-scout-gate.sh' '.claude/hooks/oss-stale-scout-gate.sh'
  printf '%s\\t%s\\t%s\\n' 'pr-workflow-gate.sh' 'hooks/pr-workflow-gate.sh' '.claude/hooks/pr-workflow-gate.sh'
  printf '%s\\t%s\\t%s\\n' 'oss-contribution-gate.sh' 'hooks/oss-contribution-gate.sh' '.claude/hooks/oss-contribution-gate.sh'
  printf '%s\\t%s\\t%s\\n' 'post-merge-keyword-scan.sh' 'hooks/post-merge-keyword-scan.sh' '.claude/hooks/post-merge-keyword-scan.sh'
  printf '%s\\t%s\\t%s\\n' 'pre-pr-review' 'plugin/skills/pre-pr-review' '.claude/skills/pre-pr-review'
  printf '%s\\t%s\\t%s\\n' 'pr-contribution-excellence' 'plugin/skills/pr-contribution-excellence' '.claude/skills/pr-contribution-excellence'
  printf '%s\\t%s\\t%s\\n' 'reviewer-specialists' 'plugin/reviewer-specialists' '.claude/reviewer-specialists'
  exit 0
fi
exit 64
`);
  await chmod(script, 0o755);
  return script;
}

async function makeToolkitTree(root: string): Promise<void> {
  await mkdir(join(root, 'hooks'), { recursive: true });
  await mkdir(join(root, 'plugin', 'skills', 'pre-pr-review'), { recursive: true });
  await mkdir(join(root, 'plugin', 'skills', 'pr-contribution-excellence'), { recursive: true });
  await mkdir(join(root, 'plugin', 'reviewer-specialists'), { recursive: true });
  await writeFile(join(root, 'hooks', 'oss-stale-scout-gate.sh'), '');
  await writeFile(join(root, 'hooks', 'pr-workflow-gate.sh'), '');
  await writeFile(join(root, 'hooks', 'oss-contribution-gate.sh'), '');
  await writeFile(join(root, 'hooks', 'post-merge-keyword-scan.sh'), '');
}

async function linkToolkitHome(home: string, root: string): Promise<void> {
  await mkdir(join(home, '.claude', 'hooks'), { recursive: true });
  await mkdir(join(home, '.claude', 'skills'), { recursive: true });
  await symlink(join(root, 'hooks', 'oss-stale-scout-gate.sh'), join(home, '.claude', 'hooks', 'oss-stale-scout-gate.sh'));
  await symlink(join(root, 'hooks', 'pr-workflow-gate.sh'), join(home, '.claude', 'hooks', 'pr-workflow-gate.sh'));
  await symlink(join(root, 'hooks', 'oss-contribution-gate.sh'), join(home, '.claude', 'hooks', 'oss-contribution-gate.sh'));
  await symlink(join(root, 'hooks', 'post-merge-keyword-scan.sh'), join(home, '.claude', 'hooks', 'post-merge-keyword-scan.sh'));
  await symlink(join(root, 'plugin', 'skills', 'pre-pr-review'), join(home, '.claude', 'skills', 'pre-pr-review'));
  await symlink(join(root, 'plugin', 'skills', 'pr-contribution-excellence'), join(home, '.claude', 'skills', 'pr-contribution-excellence'));
  await symlink(join(root, 'plugin', 'reviewer-specialists'), join(home, '.claude', 'reviewer-specialists'));
}

describe('getToolkitSymlinkStatus', () => {
  it('reports a healthy install when user-global links point at the expected root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kookr-toolkit-root-'));
    const home = await mkdtemp(join(tmpdir(), 'kookr-toolkit-home-'));
    const installHooksScript = await writeAssetListScript(root);
    await makeToolkitTree(root);
    await linkToolkitHome(home, root);

    const status = await getToolkitSymlinkStatus({ expectedRoot: root, homeDir: home, installHooksScript });

    expect(status.stale).toBe(false);
    expect(status.checkedCount).toBe(7);
    expect(status.staleCount).toBe(0);
    expect(status.links.every((link) => link.status === 'ok')).toBe(true);
  });

  it('reports stale links when they point at an older root', async () => {
    const expectedRoot = await mkdtemp(join(tmpdir(), 'kookr-toolkit-expected-'));
    const oldRoot = await mkdtemp(join(tmpdir(), 'kookr-toolkit-old-'));
    const home = await mkdtemp(join(tmpdir(), 'kookr-toolkit-home-'));
    const installHooksScript = await writeAssetListScript(expectedRoot);
    await makeToolkitTree(expectedRoot);
    await makeToolkitTree(oldRoot);
    await linkToolkitHome(home, oldRoot);

    const status = await getToolkitSymlinkStatus({ expectedRoot, homeDir: home, installHooksScript });

    expect(status.stale).toBe(true);
    expect(status.staleCount).toBe(7);
    expect(status.links.every((link) => link.status === 'mismatch')).toBe(true);
  });

  it('treats real files and missing links as stale state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kookr-toolkit-root-'));
    const home = await mkdtemp(join(tmpdir(), 'kookr-toolkit-home-'));
    const installHooksScript = await writeAssetListScript(root);
    await makeToolkitTree(root);
    await mkdir(join(home, '.claude', 'hooks'), { recursive: true });
    await writeFile(join(home, '.claude', 'hooks', 'pr-workflow-gate.sh'), 'custom');

    const status = await getToolkitSymlinkStatus({ expectedRoot: root, homeDir: home, installHooksScript });

    expect(status.stale).toBe(true);
    expect(status.staleCount).toBe(7);
    expect(status.links.find((link) => link.name === 'pr-workflow-gate.sh')?.status).toBe('not-symlink');
  });

  it('treats links to missing expected targets as stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kookr-toolkit-root-'));
    const home = await mkdtemp(join(tmpdir(), 'kookr-toolkit-home-'));
    const installHooksScript = await writeAssetListScript(root);
    await makeToolkitTree(root);
    await linkToolkitHome(home, root);
    await rm(join(root, 'plugin', 'skills', 'pre-pr-review'), { recursive: true, force: true });

    const status = await getToolkitSymlinkStatus({ expectedRoot: root, homeDir: home, installHooksScript });

    expect(status.stale).toBe(true);
    expect(status.links.find((link) => link.name === 'pre-pr-review')?.status).toBe('target-missing');
  });
});
