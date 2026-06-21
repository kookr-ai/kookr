import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillTrackedRepoDiscovery, SkillDiscoveryStateHolder, parseRepoFromReconReport } from './skill-tracked-repo-discovery.js';

describe('parseRepoFromReconReport', () => {
  test('parses frontmatter repo field', () => {
    const contents = `---
repo: grafana/grafana
date: 2026-03-29
---

# Recon Report: grafana/grafana
`;
    expect(parseRepoFromReconReport(contents)).toBe('grafana/grafana');
  });

  test('prefers frontmatter over heading when both present', () => {
    const contents = `---
repo: canonical/value
---

# Recon Report: different/heading
`;
    expect(parseRepoFromReconReport(contents)).toBe('canonical/value');
  });

  test('falls back to heading when frontmatter absent', () => {
    const contents = `# Recon Report: n8n-io/n8n

Some content.
`;
    expect(parseRepoFromReconReport(contents)).toBe('n8n-io/n8n');
  });

  test('handles repo names with hyphens and dots in both segments', () => {
    const contents = '# Recon Report: ggml-org/llama.cpp\n';
    expect(parseRepoFromReconReport(contents)).toBe('ggml-org/llama.cpp');
  });

  test('normalizes case to lowercase', () => {
    const contents = '# Recon Report: Grafana/Grafana\n';
    expect(parseRepoFromReconReport(contents)).toBe('grafana/grafana');
  });

  test('strips github.com/ prefix from slug', () => {
    const contents = `---
repo: github.com/owner/repo
---
`;
    expect(parseRepoFromReconReport(contents)).toBe('owner/repo');
  });

  test('returns null for malformed slug with too many segments', () => {
    const contents = '# Recon Report: owner/repo/extra\n';
    expect(parseRepoFromReconReport(contents)).toBeNull();
  });

  test('returns null for slug missing owner or repo', () => {
    expect(parseRepoFromReconReport('# Recon Report: owner/\n')).toBeNull();
    expect(parseRepoFromReconReport('# Recon Report: /repo\n')).toBeNull();
    expect(parseRepoFromReconReport('# Recon Report: solo\n')).toBeNull();
  });

  test('returns null when neither frontmatter nor heading present', () => {
    const contents = 'Just some markdown\n\n## Section\n';
    expect(parseRepoFromReconReport(contents)).toBeNull();
  });

  test('ignores frontmatter missing the repo field', () => {
    const contents = `---
date: 2026-03-29
---

# Recon Report: owner/repo
`;
    expect(parseRepoFromReconReport(contents)).toBe('owner/repo');
  });

  test('quoted frontmatter value is accepted', () => {
    const contents = `---
repo: "owner/repo"
---
`;
    expect(parseRepoFromReconReport(contents)).toBe('owner/repo');
  });

  test('frontmatter closing --- at EOF without trailing newline still parses', () => {
    const contents = '---\nrepo: owner/repo\n---';
    expect(parseRepoFromReconReport(contents)).toBe('owner/repo');
  });
});

describe('SkillTrackedRepoDiscovery', () => {
  let claudeDir: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'skill-disc-'));
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
  });

  function writeRecon(slug: string, contents: string): void {
    const dir = join(claudeDir, `${slug}-recon`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'recon-report.md'), contents, 'utf-8');
  }

  test('discovers repos from legacy heading reports', async () => {
    writeRecon('grafana-grafana', '# Recon Report: grafana/grafana\n');
    writeRecon('n8n-io-n8n', '# Recon Report: n8n-io/n8n\n');

    const discovery = new SkillTrackedRepoDiscovery(claudeDir);
    const result = await discovery.discover();

    expect(result.projects).toEqual([
      'github.com/grafana/grafana',
      'github.com/n8n-io/n8n',
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.scannedAt).toBeTruthy();
    expect(result.cacheStatus).toBe('scanned');
    expect(result.staleReasons).toEqual([]);
    expect(result.projectStatuses).toEqual([
      {
        project: 'github.com/grafana/grafana',
        status: 'scanned',
        reason: 'initial scan',
        source: 'grafana-grafana-recon',
      },
      {
        project: 'github.com/n8n-io/n8n',
        status: 'scanned',
        reason: 'initial scan',
        source: 'n8n-io-n8n-recon',
      },
    ]);
  });

  test('prefers frontmatter repo metadata over heading', async () => {
    writeRecon('my-slug', `---
repo: real-owner/real-repo
---

# Recon Report: wrong-owner/wrong-repo
`);
    const discovery = new SkillTrackedRepoDiscovery(claudeDir);
    const result = await discovery.discover();

    expect(result.projects).toEqual(['github.com/real-owner/real-repo']);
  });

  test('skips malformed recon reports with warnings', async () => {
    writeRecon('valid-repo', '# Recon Report: valid/repo\n');
    writeRecon('malformed', '# Not a recon report\n');
    writeRecon('empty-slug', '# Recon Report: \n');

    const discovery = new SkillTrackedRepoDiscovery(claudeDir);
    const result = await discovery.discover();

    expect(result.projects).toEqual(['github.com/valid/repo']);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('malformed-recon'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('empty-slug-recon'))).toBe(true);
  });

  test('treats missing ~/.claude as empty without error', async () => {
    const discovery = new SkillTrackedRepoDiscovery(join(claudeDir, 'does-not-exist'));
    const result = await discovery.discover();
    expect(result.projects).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('ignores directories that do not end in -recon', async () => {
    mkdirSync(join(claudeDir, 'skills'), { recursive: true });
    mkdirSync(join(claudeDir, 'hooks'), { recursive: true });
    writeRecon('real', '# Recon Report: real/repo\n');

    const discovery = new SkillTrackedRepoDiscovery(claudeDir);
    const result = await discovery.discover();
    expect(result.projects).toEqual(['github.com/real/repo']);
  });

  test('warns when recon directory has no report file', async () => {
    mkdirSync(join(claudeDir, 'empty-recon'), { recursive: true });
    const discovery = new SkillTrackedRepoDiscovery(claudeDir);
    const result = await discovery.discover();
    expect(result.projects).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('empty-recon:');
    expect(result.warnings[0]).toContain('not readable');
  });

  test('ignores a file (non-directory) whose name ends in -recon', async () => {
    writeFileSync(join(claudeDir, 'rogue-recon'), 'not a dir', 'utf-8');
    writeRecon('real', '# Recon Report: real/repo\n');

    const discovery = new SkillTrackedRepoDiscovery(claudeDir);
    const result = await discovery.discover();
    expect(result.projects).toEqual(['github.com/real/repo']);
    expect(result.warnings).toEqual([]);
  });

  test('deduplicates repos when two dirs point to the same canonical repo', async () => {
    writeRecon('dup-a', '# Recon Report: owner/repo\n');
    writeRecon('dup-b', '---\nrepo: owner/repo\n---\n');
    const discovery = new SkillTrackedRepoDiscovery(claudeDir);
    const result = await discovery.discover();
    expect(result.projects).toEqual(['github.com/owner/repo']);
  });

  test('handles real-world slug with dots in repo name', async () => {
    writeRecon('ggml-org-llama.cpp', '# Recon Report: ggml-org/llama.cpp\n');
    const discovery = new SkillTrackedRepoDiscovery(claudeDir);
    const result = await discovery.discover();
    expect(result.projects).toEqual(['github.com/ggml-org/llama.cpp']);
  });

  test('skips unchanged recon manifests after the first scan', async () => {
    writeRecon('owner-repo', '# Recon Report: owner/repo\n');
    let readCount = 0;
    const discovery = new SkillTrackedRepoDiscovery(claudeDir, {
      readReportFile: async (path) => {
        readCount++;
        return readFile(path, 'utf-8');
      },
    });

    const first = await discovery.discover();
    expect(readCount).toBe(1);

    const second = await discovery.discover();

    expect(first.cacheStatus).toBe('scanned');
    expect(readCount).toBe(1);
    expect(second.projects).toEqual(['github.com/owner/repo']);
    expect(second.cacheStatus).toBe('skipped');
    expect(second.staleReasons).toEqual([]);
    expect(second.projectStatuses).toEqual([
      {
        project: 'github.com/owner/repo',
        status: 'skipped',
        reason: 'recon manifest unchanged',
        source: 'owner-repo-recon',
      },
    ]);
  });

  test('rescans when a recon report manifest changes', async () => {
    writeRecon('owner-repo', '# Recon Report: owner/repo\n');
    const discovery = new SkillTrackedRepoDiscovery(claudeDir);
    await discovery.discover();

    writeRecon('owner-repo', '# Recon Report: changed/repo\nextra bytes\n');
    const changed = await discovery.discover();

    expect(changed.projects).toEqual(['github.com/changed/repo']);
    expect(changed.cacheStatus).toBe('scanned');
    expect(changed.staleReasons).toEqual(['recon manifest changed']);
    expect(changed.projectStatuses).toEqual([
      {
        project: 'github.com/changed/repo',
        status: 'scanned',
        reason: 'recon manifest changed',
        source: 'owner-repo-recon',
      },
    ]);
  });

  test('rescans when a recon report is deleted and removes the project', async () => {
    writeRecon('keep-repo', '# Recon Report: keep/repo\n');
    writeRecon('gone-repo', '# Recon Report: gone/repo\n');
    const discovery = new SkillTrackedRepoDiscovery(claudeDir);
    await discovery.discover();

    rmSync(join(claudeDir, 'gone-repo-recon'), { recursive: true, force: true });
    const changed = await discovery.discover();

    expect(changed.projects).toEqual(['github.com/keep/repo']);
    expect(changed.cacheStatus).toBe('scanned');
    expect(changed.staleReasons).toEqual(['recon manifest changed']);
    expect(changed.projectStatuses.map((status) => status.project)).toEqual(['github.com/keep/repo']);
  });

  test('rescans when only a recon report file is deleted and records a warning', async () => {
    writeRecon('keep-repo', '# Recon Report: keep/repo\n');
    writeRecon('gone-repo', '# Recon Report: gone/repo\n');
    const discovery = new SkillTrackedRepoDiscovery(claudeDir);
    await discovery.discover();

    rmSync(join(claudeDir, 'gone-repo-recon', 'recon-report.md'), { force: true });
    const changed = await discovery.discover();

    expect(changed.projects).toEqual(['github.com/keep/repo']);
    expect(changed.cacheStatus).toBe('scanned');
    expect(changed.staleReasons).toEqual(['recon manifest changed']);
    expect(changed.warnings).toHaveLength(1);
    expect(changed.warnings[0]).toContain('gone-repo-recon:');
    expect(changed.warnings[0]).toContain('not readable');
    expect(changed.projectStatuses.map((status) => status.project)).toEqual(['github.com/keep/repo']);
  });

  test('rescans when recon report permissions change without content changes', async () => {
    writeRecon('owner-repo', '# Recon Report: owner/repo\n');
    const reportPath = join(claudeDir, 'owner-repo-recon', 'recon-report.md');
    chmodSync(reportPath, 0o000);
    const discovery = new SkillTrackedRepoDiscovery(claudeDir);

    try {
      const unreadable = await discovery.discover();
      expect(unreadable.projects).toEqual([]);
      expect(unreadable.warnings[0]).toContain('owner-repo-recon:');
      expect(unreadable.warnings[0]).toContain('not readable');

      chmodSync(reportPath, 0o644);
      const readable = await discovery.discover();

      expect(readable.projects).toEqual(['github.com/owner/repo']);
      expect(readable.cacheStatus).toBe('scanned');
      expect(readable.staleReasons).toEqual(['recon manifest changed']);
      expect(readable.warnings).toEqual([]);
    } finally {
      chmodSync(reportPath, 0o644);
    }
  });
});

describe('SkillDiscoveryStateHolder', () => {
  let claudeDir: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'skill-state-'));
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
  });

  function writeRecon(slug: string, contents: string): void {
    const dir = join(claudeDir, `${slug}-recon`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'recon-report.md'), contents, 'utf-8');
  }

  test('initial snapshot is empty until first rescan', () => {
    const holder = new SkillDiscoveryStateHolder(new SkillTrackedRepoDiscovery(claudeDir));
    expect(holder.getProjects()).toEqual([]);
    expect(holder.getSnapshot().scannedAt).toBeUndefined();
  });

  test('rescan swaps in a new snapshot', async () => {
    writeRecon('owner-repo', '# Recon Report: owner/repo\n');
    const holder = new SkillDiscoveryStateHolder(new SkillTrackedRepoDiscovery(claudeDir));
    const snap = await holder.rescan();
    expect(snap.projects).toEqual(['github.com/owner/repo']);
    expect(snap.scannedAt).toBeTruthy();
    expect(snap.lastError).toBeUndefined();
    expect(holder.getProjects()).toEqual(['github.com/owner/repo']);
  });

  test('wholesale failure preserves previous last-known-good snapshot', async () => {
    writeRecon('keeper', '# Recon Report: keeper/repo\n');
    const throwingDiscovery: SkillTrackedRepoDiscovery = {
      discover: async () => {
        throw new Error('boom');
      },
    } as unknown as SkillTrackedRepoDiscovery;

    // Seed last-known-good with a real discovery first.
    const good = new SkillDiscoveryStateHolder(new SkillTrackedRepoDiscovery(claudeDir));
    await good.rescan();
    expect(good.getProjects()).toEqual(['github.com/keeper/repo']);

    // Swap in a failing discovery behind the scenes and rescan.
    const holder = good as unknown as { discovery: SkillTrackedRepoDiscovery };
    holder.discovery = throwingDiscovery;
    const snap = await good.rescan();

    expect(snap.projects).toEqual(['github.com/keeper/repo']);
    expect(snap.lastError).toBe('boom');
    expect(snap.cacheStatus).toBe('stale');
    expect(snap.staleReasons).toEqual(['boom']);
    expect(snap.projectStatuses).toEqual([
      {
        project: 'github.com/keeper/repo',
        status: 'stale',
        reason: 'boom',
        source: 'keeper-recon',
      },
    ]);
    expect(good.getProjects()).toEqual(['github.com/keeper/repo']);
  });

  test('new scan with malformed entries swaps in but records warnings', async () => {
    writeRecon('valid', '# Recon Report: valid/repo\n');
    writeRecon('bad', '# not a recon\n');
    const holder = new SkillDiscoveryStateHolder(new SkillTrackedRepoDiscovery(claudeDir));
    const snap = await holder.rescan();
    expect(snap.projects).toEqual(['github.com/valid/repo']);
    expect(snap.warnings.length).toBe(1);
    expect(snap.warnings[0]).toContain('bad-recon');
    expect(snap.lastError).toBeUndefined();
  });

  test('concurrent rescans share a single in-flight scan', async () => {
    let callCount = 0;
    const slowDiscovery: SkillTrackedRepoDiscovery = {
      discover: async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          projects: ['github.com/x/y'],
          warnings: [],
          scannedAt: new Date().toISOString(),
          cacheStatus: 'scanned',
          staleReasons: [],
          projectStatuses: [
            {
              project: 'github.com/x/y',
              status: 'scanned',
              reason: 'initial scan',
            },
          ],
        };
      },
    } as unknown as SkillTrackedRepoDiscovery;

    const holder = new SkillDiscoveryStateHolder(slowDiscovery);
    const [r1, r2, r3] = await Promise.all([holder.rescan(), holder.rescan(), holder.rescan()]);
    expect(callCount).toBe(1);
    expect(r1.projects).toEqual(['github.com/x/y']);
    expect(r2.projects).toEqual(['github.com/x/y']);
    expect(r3.projects).toEqual(['github.com/x/y']);
  });

  test('rescan after directory removed updates snapshot to zero repos', async () => {
    writeRecon('temp', '# Recon Report: temp/repo\n');
    const holder = new SkillDiscoveryStateHolder(new SkillTrackedRepoDiscovery(claudeDir));
    await holder.rescan();
    expect(holder.getProjects()).toEqual(['github.com/temp/repo']);

    rmSync(join(claudeDir, 'temp-recon'), { recursive: true, force: true });
    const snap = await holder.rescan();
    expect(snap.projects).toEqual([]);
    expect(holder.getProjects()).toEqual([]);
  });
});
