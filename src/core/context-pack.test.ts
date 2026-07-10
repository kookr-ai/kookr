import { describe, expect, it } from 'vitest';

import {
  buildContextPack,
  CONTEXT_PACK_VERSION,
  digestSkillMarkdown,
  parseAcceptanceCriteria,
  renderContextPack,
  renderReviewPack,
  SkillDigestCache,
  type ContextPackFs,
  type SkillDigest,
} from './context-pack.js';

const SKILL_MD = `---
name: git-commit-discipline
description: Git commit hygiene for AI agents
keywords: git commit, atomic commit
---

# Git Commit Discipline

Rules for AI agents making git commits.

## Non-Negotiable Rules

| # | Rule |
|---|------|
| 1 | Conventional Commits |
| 2 | Atomic commits |
`;

/** In-memory fs double for cache tests — never touches the real disk. */
function makeMemFs(seed: Record<string, string> = {}): ContextPackFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  return {
    files,
    existsSync: ((p: string) => files.has(p) || dirs.has(p)) as ContextPackFs['existsSync'],
    mkdirSync: ((p: string) => {
      dirs.add(String(p));
      return undefined;
    }) as unknown as ContextPackFs['mkdirSync'],
    readFileSync: ((p: string) => {
      const v = files.get(String(p));
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    }) as unknown as ContextPackFs['readFileSync'],
    writeFileSync: ((p: string, data: string) => {
      files.set(String(p), String(data));
    }) as unknown as ContextPackFs['writeFileSync'],
  };
}

function digestFixture(name = 'git-commit-discipline'): SkillDigest {
  return { name, hash: 'abc', description: 'Git commit hygiene', excerpt: 'Rules for agents.', cached: false };
}

describe('parseAcceptanceCriteria', () => {
  it('extracts checklist lines and strips the marker', () => {
    const body = [
      '## Acceptance criteria',
      '- [ ] First thing happens',
      '- [x] Second thing done',
      '* [ ] Star-bullet criterion',
      '- not a checkbox',
      '',
    ].join('\n');
    expect(parseAcceptanceCriteria(body)).toEqual([
      'First thing happens',
      'Second thing done',
      'Star-bullet criterion',
    ]);
  });

  it('accepts uppercase [X] as a checked box', () => {
    expect(parseAcceptanceCriteria('- [X] Upper done')).toEqual(['Upper done']);
  });

  it('returns [] when there is no checklist', () => {
    expect(parseAcceptanceCriteria('Just prose, no boxes.')).toEqual([]);
  });
});

describe('digestSkillMarkdown', () => {
  it('captures the frontmatter description and drops the H1 title', () => {
    const { description, excerpt } = digestSkillMarkdown(SKILL_MD);
    expect(description).toBe('Git commit hygiene for AI agents');
    expect(excerpt).not.toContain('# Git Commit Discipline');
    expect(excerpt).toContain('Non-Negotiable Rules');
    expect(excerpt).toContain('Conventional Commits');
  });

  it('truncates near the budget with a marker', () => {
    const big = `---\ndescription: x\n---\n\n# T\n\n${'word '.repeat(2000)}`;
    const { excerpt } = digestSkillMarkdown(big, 200);
    // The kept body is pinned to the budget (± the truncation notice).
    expect(excerpt.length).toBeGreaterThan(150);
    expect(excerpt).toContain('excerpt truncated');
  });

  it('handles markdown with no frontmatter', () => {
    const { description, excerpt } = digestSkillMarkdown('# Title\n\nbody line');
    expect(description).toBe('');
    expect(excerpt).toContain('body line');
    expect(excerpt).not.toContain('# Title');
  });

  it('treats unterminated frontmatter as body', () => {
    const { description, excerpt } = digestSkillMarkdown('---\ndescription: x\nno closing fence');
    expect(description).toBe('x');
    expect(excerpt).toContain('no closing fence');
  });
});

describe('SkillDigestCache', () => {
  it('generates once then reuses when the source is unchanged', () => {
    const fs = makeMemFs({ '/skills/s/SKILL.md': SKILL_MD });
    const cache = new SkillDigestCache({ cacheDir: '/cache', fs });

    const first = cache.getDigest('s', '/skills/s/SKILL.md');
    expect(first.cached).toBe(false);
    expect(fs.files.has('/cache/s.json')).toBe(true);

    const second = cache.getDigest('s', '/skills/s/SKILL.md');
    expect(second.cached).toBe(true);
    expect(second.hash).toBe(first.hash);
    expect(second.excerpt).toBe(first.excerpt);
  });

  it('invalidates and regenerates when the skill file changes', () => {
    const fs = makeMemFs({ '/skills/s/SKILL.md': SKILL_MD });
    const cache = new SkillDigestCache({ cacheDir: '/cache', fs });

    const first = cache.getDigest('s', '/skills/s/SKILL.md');
    fs.files.set('/skills/s/SKILL.md', `${SKILL_MD}\n## New Section\nmore rules\n`);

    const second = cache.getDigest('s', '/skills/s/SKILL.md');
    expect(second.cached).toBe(false);
    expect(second.hash).not.toBe(first.hash);
    expect(second.excerpt).toContain('New Section');
  });

  it('regenerates when the cached entry is corrupt', () => {
    const fs = makeMemFs({ '/skills/s/SKILL.md': SKILL_MD, '/cache/s.json': 'not json{' });
    const cache = new SkillDigestCache({ cacheDir: '/cache', fs });
    const digest = cache.getDigest('s', '/skills/s/SKILL.md');
    expect(digest.cached).toBe(false);
  });

  it('regenerates when the cached hash matches but the shape is wrong', () => {
    const fs = makeMemFs({ '/skills/s/SKILL.md': SKILL_MD, '/cache/s.json': '{"hash":"abc"}' });
    const cache = new SkillDigestCache({ cacheDir: '/cache', fs });
    const digest = cache.getDigest('s', '/skills/s/SKILL.md');
    expect(digest.cached).toBe(false);
    expect(digest.excerpt).toContain('Non-Negotiable Rules');
  });

  it('invalidates across a budget change even when the source is unchanged', () => {
    const fs = makeMemFs({ '/skills/s/SKILL.md': SKILL_MD });
    const wide = new SkillDigestCache({ cacheDir: '/cache', fs, budget: 5000 });
    const first = wide.getDigest('s', '/skills/s/SKILL.md');
    expect(first.cached).toBe(false);

    const narrow = new SkillDigestCache({ cacheDir: '/cache', fs, budget: 50 });
    const second = narrow.getDigest('s', '/skills/s/SKILL.md');
    // Different budget → different key → must not serve the wide entry.
    expect(second.cached).toBe(false);
    expect(second.hash).not.toBe(first.hash);
  });

  it('still returns a digest when the cache write fails', () => {
    const fs = makeMemFs({ '/skills/s/SKILL.md': SKILL_MD });
    fs.writeFileSync = (() => {
      throw new Error('disk full');
    }) as unknown as ContextPackFs['writeFileSync'];
    const cache = new SkillDigestCache({ cacheDir: '/cache', fs });
    const digest = cache.getDigest('s', '/skills/s/SKILL.md');
    expect(digest.cached).toBe(false);
    expect(digest.excerpt).toContain('Non-Negotiable Rules');
  });
});

describe('buildContextPack', () => {
  it('derives acceptance criteria from the body when not supplied', () => {
    const pack = buildContextPack({
      issueNumber: 1,
      issueTitle: 'T',
      issueBody: '- [ ] Do the thing',
      candidateFiles: ['a.ts'],
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
      skills: [],
    });
    expect(pack.version).toBe(CONTEXT_PACK_VERSION);
    expect(pack.acceptanceCriteria).toEqual(['Do the thing']);
  });

  it('defensively copies candidateFiles so later input mutation is isolated', () => {
    const files = ['a.ts'];
    const pack = buildContextPack({
      issueNumber: 1,
      issueTitle: 'T',
      issueBody: '',
      candidateFiles: files,
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
      skills: [],
    });
    files.push('b.ts');
    expect(pack.candidateFiles).toEqual(['a.ts']);
  });

  it('prefers explicit acceptance criteria over parsing', () => {
    const pack = buildContextPack({
      issueNumber: 1,
      issueTitle: 'T',
      issueBody: '- [ ] Parsed one',
      acceptanceCriteria: ['Explicit one'],
      candidateFiles: [],
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
      skills: [],
    });
    expect(pack.acceptanceCriteria).toEqual(['Explicit one']);
  });
});

describe('renderContextPack', () => {
  const pack = buildContextPack({
    issueNumber: 1306,
    issueTitle: 'Give tasks a context pack',
    issueBody: 'Body text\n- [ ] Attach a pack',
    candidateFiles: ['src/core/context-pack.ts'],
    baseBranch: 'main',
    baseCommit: 'deadbeef',
    repoFullName: 'kookr-ai/kookr',
    skills: [digestFixture()],
  });

  it('frames the pack as a floor, not a ceiling', () => {
    const md = renderContextPack(pack);
    expect(md).toContain('floor, not a ceiling');
    expect(md).toContain('non-exhaustive');
    expect(md).toContain('explore beyond');
  });

  it('includes the issue, base ref, candidate hints, and skill digests', () => {
    const md = renderContextPack(pack);
    expect(md).toContain('issue #1306');
    expect(md).toContain('Give tasks a context pack');
    expect(md).toContain('`deadbeef`');
    expect(md).toContain('`src/core/context-pack.ts`');
    expect(md).toContain('git-commit-discipline');
    // The digest *body*, not just the skill name in the header.
    expect(md).toContain('Rules for agents.');
    expect(md).toContain('- [ ] Attach a pack');
  });

  it('renders placeholders for empty body, files, and criteria', () => {
    const empty = buildContextPack({
      issueNumber: 9,
      issueTitle: 'T',
      issueBody: '',
      candidateFiles: [],
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
      skills: [],
    });
    const md = renderContextPack(empty);
    expect(md).toContain('_(empty)_');
    expect(md).toContain('_None supplied — start from the issue and explore._');
    expect(md).toContain('No explicit acceptance-criteria checklist');
  });
});

describe('renderReviewPack', () => {
  const pack = buildContextPack({
    issueNumber: 1306,
    issueTitle: 'T',
    issueBody: '- [ ] c',
    candidateFiles: [],
    baseBranch: 'main',
    baseCommit: 'sha',
    repoFullName: 'o/r',
    skills: [digestFixture('pre-pr-review')],
  });

  it('embeds the staged diff as the subject of review', () => {
    const md = renderReviewPack(pack, { stagedDiff: 'diff --git a/x b/x\n+added' });
    expect(md).toContain('Staged diff (subject of review)');
    expect(md).toContain('+added');
    expect(md).toContain('pre-pr-review');
  });

  it('handles an empty diff gracefully', () => {
    const md = renderReviewPack(pack, { stagedDiff: '' });
    expect(md).toContain('(no staged changes)');
  });

  it('notes when no skill digests are attached', () => {
    const noSkills = buildContextPack({
      issueNumber: 1,
      issueTitle: 'T',
      issueBody: '',
      candidateFiles: [],
      baseBranch: 'main',
      baseCommit: 'sha',
      repoFullName: 'o/r',
      skills: [],
    });
    const md = renderReviewPack(noSkills, { stagedDiff: 'x' });
    expect(md).toContain('_No skill digests attached._');
  });
});
