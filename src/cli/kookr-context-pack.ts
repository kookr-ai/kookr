// `kookr context-pack` — generate a spawn-time context pack (and, optionally, a
// pre-PR review pack) from a JSON spec. Used by the parallel-issue-batch
// playbook to warm-start each child task and its review specialists instead of
// making every child cold-read the same issue context and static skills.
//
// Hook-safe by design: all substantive input (issue body, diff) comes from
// files named in the spec, never from argv, so a Claude Code Bash hook that
// scans command lines never sees the payload.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildContextPack,
  renderContextPack,
  renderReviewPack,
  SkillDigestCache,
  type SkillDigest,
} from '../core/context-pack.js';
import { resolvePluginDir } from '../core/plugin-paths.js';

/** Static skills a child issue-implementation task needs, digested by default. */
export const DEFAULT_PACK_SKILLS = [
  'git-commit-discipline',
  'pre-pr-review',
  'github-issue-workflow',
] as const;

/** Skill names are path segments; reject anything that could escape the tree. */
const SAFE_SKILL_NAME = /^[A-Za-z0-9._-]+$/;

interface PackSpec {
  issueNumber: number;
  issueTitle: string;
  issueBody?: string;
  issueBodyFile?: string;
  acceptanceCriteria?: string[];
  candidateFiles?: string[];
  baseBranch: string;
  baseCommit: string;
  repoFullName: string;
  skills?: string[];
  stagedDiffFile?: string;
}

interface ParsedArgs {
  spec: string | null;
  out: string | null;
  reviewOut: string | null;
  pluginDir: string | null;
  cacheDir: string | null;
  json: boolean;
  help: boolean;
}

const HELP = `kookr context-pack — build a spawn-time context pack from a JSON spec.

Usage:
  kookr context-pack --spec <spec.json> --out <pack.md> [--review-out <review.md>]

Options:
  --spec <path>        JSON spec describing the issue, candidate files, base
                       branch/commit, and (optionally) skills + staged diff file.
  --out <path>         Write the child-task context pack (markdown) here.
  --review-out <path>  Also write a pre-PR review pack (pack + staged diff).
                       Requires "stagedDiffFile" in the spec.
  --plugin-dir <path>  Override the kookr-toolkit plugin dir (skill source root).
  --cache-dir <path>   Override the skill-digest cache dir.
  --json               Emit one machine-readable JSON envelope on stdout.
  -h, --help           Show this help.

Spec shape (JSON):
  {
    "issueNumber": 1306,
    "issueTitle": "…",
    "issueBody": "…"            (or "issueBodyFile": "/path/body.md"),
    "candidateFiles": ["src/a.ts"],   (non-exhaustive hints)
    "acceptanceCriteria": ["…"],      (optional; else parsed from the body),
    "baseBranch": "main",
    "baseCommit": "<sha>",
    "repoFullName": "owner/repo",
    "skills": ["git-commit-discipline", "pre-pr-review", "github-issue-workflow"],
    "stagedDiffFile": "/path/diff.txt"   (optional; required for --review-out)
  }`;

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    spec: null,
    out: null,
    reviewOut: null,
    pluginDir: null,
    cacheDir: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eat = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`option ${tok} requires a value`);
      return v;
    };
    if (tok === '-h' || tok === '--help') out.help = true;
    else if (tok === '--json') out.json = true;
    else if (tok === '--spec') out.spec = eat();
    else if (tok === '--out') out.out = eat();
    else if (tok === '--review-out') out.reviewOut = eat();
    else if (tok === '--plugin-dir') out.pluginDir = eat();
    else if (tok === '--cache-dir') out.cacheDir = eat();
    else throw new Error(`unknown option: ${tok}`);
  }
  return out;
}

function requireStringArray(value: unknown, field: string): void {
  // Undefined is allowed (the field is optional); a present value must be a
  // string[]. A bare string here is the dangerous case: buildContextPack spreads
  // and .map()s it, so a JSON string would render one entry per character.
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`spec.${field} must be an array of strings`);
  }
}

function loadSpec(path: string): PackSpec {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('spec must be a JSON object');
  const spec = parsed as PackSpec;
  if (typeof spec.issueNumber !== 'number') throw new Error('spec.issueNumber must be a number');
  if (typeof spec.issueTitle !== 'string') throw new Error('spec.issueTitle must be a string');
  if (typeof spec.baseBranch !== 'string') throw new Error('spec.baseBranch must be a string');
  if (typeof spec.baseCommit !== 'string') throw new Error('spec.baseCommit must be a string');
  if (typeof spec.repoFullName !== 'string') throw new Error('spec.repoFullName must be a string');
  requireStringArray(spec.candidateFiles, 'candidateFiles');
  requireStringArray(spec.acceptanceCriteria, 'acceptanceCriteria');
  requireStringArray(spec.skills, 'skills');
  return spec;
}

function resolveBody(spec: PackSpec): string {
  if (typeof spec.issueBody === 'string') return spec.issueBody;
  if (typeof spec.issueBodyFile === 'string') return readFileSync(spec.issueBodyFile, 'utf8');
  return '';
}

/**
 * Digest each requested skill, skipping (with a warning) any whose SKILL.md is
 * not present in the resolved plugin dir. Missing skills must not abort pack
 * generation — the pack degrades to fewer digests, never to a hard failure.
 */
function collectSkillDigests(
  names: readonly string[],
  pluginDir: string | undefined,
  cache: SkillDigestCache,
  warn: (msg: string) => void,
): SkillDigest[] {
  if (!pluginDir) {
    warn('context-pack: no plugin dir resolved; skipping skill digests.');
    return [];
  }
  const digests: SkillDigest[] = [];
  for (const name of names) {
    if (!SAFE_SKILL_NAME.test(name)) {
      warn(`context-pack: skill "${name}" has an unsafe name; skipping.`);
      continue;
    }
    const sourcePath = join(pluginDir, 'skills', name, 'SKILL.md');
    try {
      digests.push(cache.getDigest(name, sourcePath));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        warn(`context-pack: skill "${name}" not found at ${sourcePath}; skipping.`);
      } else {
        warn(`context-pack: skill "${name}" could not be read (${(e as Error).message}); skipping.`);
      }
    }
  }
  return digests;
}

export interface RunContextPackDeps {
  out?: Pick<typeof console, 'log' | 'error'>;
  env?: NodeJS.ProcessEnv;
}

export async function runContextPackCli(
  argv: string[],
  { out = console, env = process.env }: RunContextPackDeps = {},
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    out.error(`kookr context-pack: ${(e as Error).message}`);
    return 2;
  }

  if (args.help) {
    out.log(HELP);
    return 0;
  }
  if (!args.spec || !args.out) {
    out.error('kookr context-pack: --spec and --out are required. Try --help.');
    return 2;
  }

  let spec: PackSpec;
  let body: string;
  try {
    spec = loadSpec(args.spec);
    body = resolveBody(spec);
  } catch (e) {
    out.error(`kookr context-pack: ${(e as Error).message}`);
    return 2;
  }

  const pluginDir = resolvePluginDir(args.pluginDir ?? undefined, env);
  const cache = new SkillDigestCache({ cacheDir: args.cacheDir ?? undefined });
  const skillNames = spec.skills && spec.skills.length > 0 ? spec.skills : DEFAULT_PACK_SKILLS;
  const skills = collectSkillDigests(skillNames, pluginDir, cache, (m) => out.error(m));

  const pack = buildContextPack({
    issueNumber: spec.issueNumber,
    issueTitle: spec.issueTitle,
    issueBody: body,
    acceptanceCriteria: spec.acceptanceCriteria,
    candidateFiles: spec.candidateFiles ?? [],
    baseBranch: spec.baseBranch,
    baseCommit: spec.baseCommit,
    repoFullName: spec.repoFullName,
    skills,
  });

  try {
    writeFileSync(args.out, renderContextPack(pack), 'utf8');
  } catch (e) {
    out.error(`kookr context-pack: could not write --out ${args.out}: ${(e as Error).message}`);
    return 2;
  }

  let reviewOut: string | null = null;
  if (args.reviewOut) {
    if (!spec.stagedDiffFile) {
      out.error('kookr context-pack: --review-out requires "stagedDiffFile" in the spec.');
      return 2;
    }
    let stagedDiff: string;
    try {
      stagedDiff = readFileSync(spec.stagedDiffFile, 'utf8');
    } catch (e) {
      out.error(`kookr context-pack: could not read stagedDiffFile ${spec.stagedDiffFile}: ${(e as Error).message}`);
      return 2;
    }
    try {
      writeFileSync(args.reviewOut, renderReviewPack(pack, { stagedDiff }), 'utf8');
      reviewOut = args.reviewOut;
    } catch (e) {
      out.error(`kookr context-pack: could not write --review-out ${args.reviewOut}: ${(e as Error).message}`);
      return 2;
    }
  }

  if (args.json) {
    out.log(
      JSON.stringify({
        ok: true,
        out: args.out,
        reviewOut,
        issueNumber: pack.issueNumber,
        candidateFileCount: pack.candidateFiles.length,
        acceptanceCriteriaCount: pack.acceptanceCriteria.length,
        skills: pack.skills.map((s) => ({ name: s.name, cached: s.cached, hash: s.hash })),
      }),
    );
  } else {
    const cachedCount = pack.skills.filter((s) => s.cached).length;
    out.log(
      `context-pack written: ${args.out}` +
        (reviewOut ? ` (+ review pack: ${reviewOut})` : '') +
        ` — ${pack.skills.length} skill digest(s), ${cachedCount} from cache`,
    );
  }
  return 0;
}
