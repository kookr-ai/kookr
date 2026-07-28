#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Contract check for issue #1561: the CI-rerun bound (max 2 attempts, then
// report-and-stop, with #1198 cross-reference for infra-red CI) must stay
// present in the delivery skill and both implement playbooks. Guidance text
// silently rots — an unrelated refactor or a "tighten the prose" edit can drop
// the bound with nothing failing, and the failure mode it prevents (an
// unbounded rerun/merge loop stranding a delivery task for hours — PR #1542 /
// task faf7902b) only resurfaces in production. This gate fails the push/CI if
// any of the three files loses the bound. Modelled on scripts/validate-playbooks.ts.

// The files that must carry the bound. Relative to the repo root.
export const TARGET_FILES = [
  '.claude/skills/kookr-pr-lifecycle/SKILL.md',
  'plugin/playbooks/implement-github-issue.md',
  'plugin/playbooks/parallel-issue-batch.md',
];

// Each target must match every pattern (case-insensitive). Together these
// assert the bound value, the report-and-stop instruction, and the #1198
// cross-reference — remove the bound block and at least one pattern fails.
export const REQUIRED_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: 'max-2-rerun bound', regex: /max 2 CI rerun attempts/i },
  { label: 'report-the-CI-state instruction', regex: /report the CI state/i },
  { label: 'never-loop / report-and-stop instruction', regex: /never loop/i },
  { label: '#1198 infra-red CI cross-reference', regex: /#1198/ },
];

export interface RerunBoundIssue {
  file: string;
  message: string;
}

export interface RerunBoundValidationResult {
  root: string;
  errors: RerunBoundIssue[];
}

export function validateRerunBound(repoRoot: string = process.cwd()): RerunBoundValidationResult {
  const errors: RerunBoundIssue[] = [];

  for (const rel of TARGET_FILES) {
    const file = join(repoRoot, rel);
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      errors.push({ file: rel, message: 'file not found — the CI-rerun bound must live here' });
      continue;
    }
    for (const { label, regex } of REQUIRED_PATTERNS) {
      if (!regex.test(content)) {
        errors.push({
          file: rel,
          message: `missing the ${label} (expected to match ${regex}). The CI-rerun bound (max 2 attempts, report-and-stop, #1198 cross-reference) must stay present — see issue #1561.`,
        });
      }
    }
  }

  return { root: repoRoot, errors };
}

function main(): void {
  const args = process.argv.slice(2);
  const unknownFlags = args.filter((arg) => arg.startsWith('--'));
  if (unknownFlags.length > 0) {
    console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`);
    process.exit(2);
  }
  const repoRoot = args[0] ?? process.cwd();

  const { errors } = validateRerunBound(repoRoot);

  if (errors.length > 0) {
    console.error('CI-rerun-bound validation failed:');
    for (const error of errors) {
      console.error(`  ${relative(repoRoot, join(repoRoot, error.file))}: ${error.message}`);
    }
    process.exit(1);
  }

  console.log('CI-rerun-bound validation passed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
