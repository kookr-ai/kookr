// Spawn-time context pack for issue-implementation child tasks.
//
// Motivation (issue #1306): every child task spawned by the
// `parallel-issue-batch` playbook cold-reads the same static skill files and
// re-derives the issue → candidate-file mapping the orchestrator already knows.
// That cold retrieval was measured at ~32% of a child's tokens. A *context
// pack* front-loads that shared knowledge as a warm-start digest.
//
// Design contract — the pack is a FLOOR, not a CEILING:
//   - Candidate file lists are explicitly non-exhaustive HINTS, never an
//     authoritative/closed set. Children must stay free to explore beyond them.
//   - Packed facts (file lists, skill excerpts, orchestrator summaries) can be
//     stale or wrong. They are hints to verify, never a gate on real work.
//   - Nothing here replaces the agent's own exploration; it only removes the
//     boilerplate re-retrieval that adds no signal.
//
// Skill digests are generated once and cached, keyed by the source skill file's
// content hash, so an unchanged skill is never re-digested and a changed skill
// invalidates its cache entry automatically.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONTEXT_PACK_VERSION = 1 as const;

/**
 * Bumped whenever {@link digestSkillMarkdown}'s output for a fixed input
 * changes. Folded into the cache key so an algorithm change invalidates every
 * cached digest even when the source SKILL.md is unchanged.
 */
export const DIGEST_FORMAT_VERSION = 1 as const;

/** Max characters kept from a skill body when building its digest excerpt. */
export const DEFAULT_SKILL_EXCERPT_BUDGET = 1600;

/** A pre-digested excerpt of one static skill, cached by source content hash. */
export interface SkillDigest {
  /** Skill directory name, e.g. `git-commit-discipline`. */
  name: string;
  /** SHA-256 of the source SKILL.md contents; the cache invalidation key. */
  hash: string;
  /** Frontmatter `description`, when present. */
  description: string;
  /** Condensed, load-bearing excerpt of the skill body. */
  excerpt: string;
  /** Whether this digest came from cache (true) or was freshly generated. */
  cached: boolean;
}

export interface ContextPackInput {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  /** Parsed acceptance-criteria lines. Auto-derived from the body when omitted. */
  acceptanceCriteria?: string[];
  /** Candidate file paths — explicitly NON-EXHAUSTIVE hints. */
  candidateFiles: string[];
  baseBranch: string;
  baseCommit: string;
  repoFullName: string;
  skills: SkillDigest[];
}

export interface ContextPack {
  version: typeof CONTEXT_PACK_VERSION;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  acceptanceCriteria: string[];
  candidateFiles: string[];
  baseBranch: string;
  baseCommit: string;
  repoFullName: string;
  skills: SkillDigest[];
}

/** Minimal fs surface, injectable so tests never touch the real disk. */
export interface ContextPackFs {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readFileSync: typeof readFileSync;
  writeFileSync: typeof writeFileSync;
}

const NODE_FS: ContextPackFs = { existsSync, mkdirSync, readFileSync, writeFileSync };

// ---------- acceptance-criteria parsing ----------

/**
 * Extract acceptance-criteria checklist lines (`- [ ]` / `- [x]`) from an issue
 * body. Returns the human-readable text with the checkbox marker stripped.
 */
export function parseAcceptanceCriteria(body: string): string[] {
  const out: string[] = [];
  for (const rawLine of String(body ?? '').split('\n')) {
    const match = rawLine.match(/^\s*[-*]\s+\[[ xX]\]\s+(.*\S)\s*$/);
    if (match) out.push(match[1]);
  }
  return out;
}

// ---------- skill digesting ----------

interface Frontmatter {
  description: string;
  bodyStart: number; // index into `lines` where the body begins
}

function readFrontmatter(lines: string[]): Frontmatter {
  if (lines[0]?.trim() !== '---') return { description: '', bodyStart: 0 };
  let description = '';
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { description, bodyStart: i + 1 };
    }
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (m) description = m[1].trim().replace(/^["']|["']$/g, '');
  }
  // Unterminated frontmatter: treat the whole thing as body.
  return { description, bodyStart: 0 };
}

/**
 * Produce a deterministic, condensed excerpt of a skill's markdown.
 *
 * Strategy: drop the YAML frontmatter and the leading H1 title, collapse blank
 * runs, and keep the body up to a character budget. This front-loads the
 * load-bearing rules/checklist (which skills put near the top) without shipping
 * the whole file. Deterministic so the cache key is purely the source hash.
 */
export function digestSkillMarkdown(
  markdown: string,
  budget: number = DEFAULT_SKILL_EXCERPT_BUDGET,
): { description: string; excerpt: string } {
  const lines = String(markdown ?? '').split('\n');
  const { description, bodyStart } = readFrontmatter(lines);

  const body: string[] = [];
  let blankRun = 0;
  let seenContent = false;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    // Skip the leading H1 title — its content is captured by `description`.
    if (!seenContent && /^#\s/.test(line)) continue;
    if (line.trim() === '') {
      if (!seenContent) continue; // trim leading blanks
      blankRun++;
      if (blankRun > 1) continue; // collapse blank runs
      body.push('');
      continue;
    }
    blankRun = 0;
    seenContent = true;
    body.push(line);
  }

  let excerpt = body.join('\n').replace(/\s+$/, '');
  if (excerpt.length > budget) {
    excerpt = `${excerpt.slice(0, budget).replace(/\s+\S*$/, '')}\n\n… (excerpt truncated — read the full skill for detail)`;
  }
  return { description, excerpt };
}

/**
 * Digest cache keyed by the source skill file's content hash. A digest is
 * generated once and reused; changing the skill file changes its hash and
 * invalidates the entry automatically.
 */
export class SkillDigestCache {
  private readonly cacheDir: string;
  private readonly fs: ContextPackFs;
  private readonly budget: number;

  constructor(opts: { cacheDir?: string; fs?: ContextPackFs; budget?: number } = {}) {
    this.cacheDir = opts.cacheDir ?? defaultCacheDir();
    this.fs = opts.fs ?? NODE_FS;
    this.budget = opts.budget ?? DEFAULT_SKILL_EXCERPT_BUDGET;
  }

  /**
   * Return the digest for `name`, reading the cache when the source is
   * unchanged and regenerating (and rewriting the cache) when it has changed.
   */
  getDigest(name: string, sourcePath: string): SkillDigest {
    const source = this.fs.readFileSync(sourcePath, 'utf8').toString();
    // Key on the source content AND the parameters that shape the excerpt, so a
    // budget change or a digest-algorithm bump invalidates unchanged skills too.
    const hash = createHash('sha256')
      .update(`v${DIGEST_FORMAT_VERSION}:b${this.budget}:`)
      .update(source)
      .digest('hex');
    const cacheFile = join(this.cacheDir, `${sanitizeName(name)}.json`);

    if (this.fs.existsSync(cacheFile)) {
      try {
        const cached: unknown = JSON.parse(this.fs.readFileSync(cacheFile, 'utf8').toString());
        if (
          typeof cached === 'object' &&
          cached !== null &&
          (cached as { hash?: unknown }).hash === hash &&
          typeof (cached as { excerpt?: unknown }).excerpt === 'string'
        ) {
          const entry = cached as { description?: unknown; excerpt: string };
          return {
            name,
            hash,
            description: String(entry.description ?? ''),
            excerpt: entry.excerpt,
            cached: true,
          };
        }
      } catch {
        // Corrupt cache entry — fall through and regenerate.
      }
    }

    const { description, excerpt } = digestSkillMarkdown(source, this.budget);
    const digest: SkillDigest = { name, hash, description, excerpt, cached: false };
    this.writeCache(cacheFile, { hash, description, excerpt });
    return digest;
  }

  private writeCache(cacheFile: string, payload: { hash: string; description: string; excerpt: string }): void {
    try {
      if (!this.fs.existsSync(this.cacheDir)) {
        this.fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      this.fs.writeFileSync(cacheFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch {
      // A cache write failure must never break pack generation — the digest is
      // still returned to the caller; only reuse across runs is lost.
    }
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Default on-disk location for the skill-digest cache. Callers that need a
 * different location pass `cacheDir` to {@link SkillDigestCache} (surfaced as
 * `--cache-dir` on the CLI) rather than via an env var.
 */
export function defaultCacheDir(): string {
  return join(homedir(), '.kookr', 'skill-digests');
}

// ---------- pack assembly ----------

export function buildContextPack(input: ContextPackInput): ContextPack {
  const acceptanceCriteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria
      : parseAcceptanceCriteria(input.issueBody);
  return {
    version: CONTEXT_PACK_VERSION,
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    issueBody: input.issueBody,
    acceptanceCriteria,
    candidateFiles: [...input.candidateFiles],
    baseBranch: input.baseBranch,
    baseCommit: input.baseCommit,
    repoFullName: input.repoFullName,
    skills: input.skills,
  };
}

// ---------- rendering ----------

const FLOOR_NOT_CEILING = [
  '> **This pack is a floor, not a ceiling.** Everything below is a *warm-start hint* to save',
  '> cold retrieval — not an authoritative or closed set. Packed facts (file lists, skill',
  '> excerpts, summaries) can be stale or wrong; treat them as hints to verify, never as facts',
  '> to gate work on. You are expected to explore beyond this pack, and nothing here should be',
  '> read as "the pack says X, so stop looking."',
].join('\n');

function renderCriteria(criteria: string[]): string {
  if (criteria.length === 0) return '_No explicit acceptance-criteria checklist found in the issue body._';
  return criteria.map((c) => `- [ ] ${c}`).join('\n');
}

function renderCandidateFiles(files: string[]): string {
  const header =
    'Candidate files — **non-exhaustive hints**, not a complete or verified list. ' +
    'Confirm each against the current tree and expect to touch files not listed here:';
  if (files.length === 0) return `${header}\n\n_None supplied — start from the issue and explore._`;
  return `${header}\n\n${files.map((f) => `- \`${f}\``).join('\n')}`;
}

function renderSkillDigests(skills: SkillDigest[]): string {
  if (skills.length === 0) return '';
  const blocks = skills.map((s) => {
    const desc = s.description ? `\n_${s.description}_\n` : '\n';
    return `### Skill digest: \`${s.name}\`${desc}\n${s.excerpt}`;
  });
  return [
    '## Pre-digested skill excerpts',
    '',
    'Condensed excerpts of the static skills a child otherwise re-reads cold. Read the full',
    'skill file when you need detail beyond the excerpt.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/** Render the pack a child issue-implementation task receives at spawn time. */
export function renderContextPack(pack: ContextPack): string {
  const sections = [
    `## Context Pack — issue #${pack.issueNumber} (warm-start hints)`,
    '',
    FLOOR_NOT_CEILING,
    '',
    '### Issue',
    `- **Repo:** ${pack.repoFullName}`,
    `- **Title:** ${pack.issueTitle}`,
    `- **Base branch:** \`${pack.baseBranch}\``,
    `- **Base commit:** \`${pack.baseCommit}\``,
    '',
    '<details><summary>Issue body</summary>',
    '',
    pack.issueBody.trim() || '_(empty)_',
    '',
    '</details>',
    '',
    '### Acceptance criteria',
    renderCriteria(pack.acceptanceCriteria),
    '',
    '### Candidate files',
    renderCandidateFiles(pack.candidateFiles),
  ];
  const digests = renderSkillDigests(pack.skills);
  if (digests) {
    sections.push('', digests);
  }
  return `${sections.join('\n')}\n`;
}

/**
 * Render the pack a pre-PR review specialist receives: the same shared context
 * (so it need not re-explore the repo cold) plus the staged diff that is the
 * actual subject of review.
 */
export function renderReviewPack(pack: ContextPack, opts: { stagedDiff: string }): string {
  const diff = opts.stagedDiff.trim();
  const sections = [
    `## Review Pack — issue #${pack.issueNumber}`,
    '',
    '> Shared context so you need not re-read the repo cold. The **staged diff** below is the',
    '> subject of review; the pack is background. Pack hints can be stale — review the diff on',
    '> its own merits, not against "what the pack expected".',
    '',
    '### Issue',
    `- **Repo:** ${pack.repoFullName}`,
    `- **Title:** ${pack.issueTitle}`,
    `- **Base:** \`${pack.baseBranch}\` @ \`${pack.baseCommit}\``,
    '',
    '### Acceptance criteria',
    renderCriteria(pack.acceptanceCriteria),
    '',
    renderSkillDigests(pack.skills) || '_No skill digests attached._',
    '',
    '## Staged diff (subject of review)',
    '',
    '```diff',
    diff || '(no staged changes)',
    '```',
  ];
  return `${sections.join('\n')}\n`;
}
