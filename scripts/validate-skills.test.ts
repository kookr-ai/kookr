import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateSkills } from './validate-skills';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/validate-skills.ts');
const tsxLoader = import.meta.resolve('tsx');

const GOOD_SKILL = `---
name: sample-skill
description: A skill that parses cleanly.
---

# Sample Skill

Body content.
`;

function makeRepo(files: Record<string, string | null>): string {
  const root = mkdtempSync(join(tmpdir(), 'kookr-validate-skills-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const abs = join(root, relativePath);
    if (content === null) {
      mkdirSync(abs, { recursive: true });
      continue;
    }
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

describe('validate-skills', () => {
  it('passes on the real shipped skill set', () => {
    const { errors } = validateSkills(repoRoot);
    expect(errors, errors.map((e) => `${e.file}: ${e.message}`).join('\n')).toEqual([]);
  });

  it('loads github-labels as a SKILL.md directory, not a bare file', () => {
    const dir = join(repoRoot, 'plugin/skills/github-labels');
    const skill = join(dir, 'SKILL.md');
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(existsSync(skill)).toBe(true);
  });

  it('reports a bare file sitting where a skill directory should be', () => {
    const root = makeRepo({
      'plugin/skills/github-labels': GOOD_SKILL,
    });
    try {
      const { errors } = validateSkills(root);
      expect(errors.some((issue) => issue.message.includes('is a file'))).toBe(true);
      expect(errors[0]?.file).toContain('plugin/skills/github-labels');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a skill directory missing SKILL.md', () => {
    const root = makeRepo({ 'plugin/skills/empty-skill': null });
    try {
      const { errors } = validateSkills(root);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('missing SKILL.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a shipped skill omitted from plugin/README.md What\'s included', () => {
    const root = makeRepo({
      'plugin/skills/sample-skill/SKILL.md': GOOD_SKILL,
      'plugin/README.md': `# Plugin\n\n## What's included\n\n**Workflow:** \`other-skill\`.\n\n## Install\n\nDone.\n`,
    });
    try {
      const { errors } = validateSkills(root);
      expect(errors.some((issue) => issue.message.includes('sample-skill'))).toBe(true);
      expect(errors.some((issue) => issue.message.includes("What's included"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a shipped playbook omitted from plugin/README.md What\'s included', () => {
    const root = makeRepo({
      'plugin/playbooks/issue-triage.md': `---
name: Issue Triage
description: Triage issues.
checklist:
  - Step
---

# Issue Triage
`,
      'plugin/README.md': `# Plugin\n\n## What's included\n\n**Workflow:** \`sample-skill\`.\n`,
    });
    try {
      const { errors } = validateSkills(root);
      expect(errors.some((issue) => issue.message.includes('issue-triage'))).toBe(true);
      expect(errors.some((issue) => issue.message.includes('playbook'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a shipped review subagent omitted from plugin/README.md What\'s included', () => {
    const root = makeRepo({
      'plugin/agents/boundary-critic.md': '# Boundary critic\n',
      'plugin/README.md': `# Plugin\n\n## What's included\n\n**Workflow:** \`sample-skill\`.\n`,
    });
    try {
      const { errors } = validateSkills(root);
      expect(errors.some((issue) => issue.message.includes('boundary-critic'))).toBe(true);
      expect(errors.some((issue) => issue.message.includes('agent'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats brace-expanded README names as listed', () => {
    const root = makeRepo({
      'plugin/skills/oss-pr-critic/SKILL.md': `---
name: oss-pr-critic
description: Critic skill.
---

# Critic
`,
      'plugin/skills/oss-pr-plan/SKILL.md': `---
name: oss-pr-plan
description: Plan skill.
---

# Plan
`,
      'plugin/README.md': `# Plugin\n\n## What's included\n\n**OSS:** \`oss-pr-{critic,plan}\`.\n`,
    });
    try {
      const { errors } = validateSkills(root);
      expect(errors, errors.map((e) => e.message).join('\n')).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a plugin.json skill count that matches loadable skills', () => {
    const root = makeRepo({
      'plugin/skills/sample-skill/SKILL.md': GOOD_SKILL,
      'plugin/.claude-plugin/plugin.json': JSON.stringify({
        name: 'kookr-toolkit',
        version: '0.0.1',
        description: '1 skills and 0 review subagents for tests.',
      }),
    });
    try {
      const { errors } = validateSkills(root);
      expect(errors.filter((issue) => issue.file.endsWith('plugin.json'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a plugin.json skill count that drifted from disk', () => {
    const root = makeRepo({
      'plugin/skills/sample-skill/SKILL.md': GOOD_SKILL,
      'plugin/.claude-plugin/plugin.json': JSON.stringify({
        name: 'kookr-toolkit',
        version: '0.0.1',
        description: '64 skills and 19 review subagents for tests.',
      }),
    });
    try {
      const { errors } = validateSkills(root);
      const countError = errors.find((issue) => issue.message.includes('64 skills'));
      expect(countError).toBeDefined();
      expect(countError?.message).toContain('1 loadable SKILL.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CLI exits 0 on a well-formed skill directory', () => {
    const root = makeRepo({
      'plugin/skills/sample-skill/SKILL.md': GOOD_SKILL,
    });
    try {
      const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, root], {
        encoding: 'utf8',
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Skill validation passed.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CLI exits 1 on a bare skill file', () => {
    const root = makeRepo({
      'plugin/skills/github-labels': GOOD_SKILL,
    });
    try {
      const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, root], {
        encoding: 'utf8',
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('Skill validation failed:');
      expect(result.stderr).toContain('is a file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CLI exits 2 on an unknown flag', () => {
    const result = spawnSync(process.execPath, ['--import', tsxLoader, scriptPath, '--bogus'], {
      encoding: 'utf8',
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown flag(s): --bogus');
  });
});
