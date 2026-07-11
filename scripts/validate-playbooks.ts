#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  findUnknownFrontmatterKeys,
  parsePlaybook,
  PlaybookParseError,
} from '../src/core/playbook-parser.js';

// Bundled playbooks are only ever run through the real parser at
// launch/discovery time, and discovery *silently drops* a broken playbook with
// a `console.warn` (src/core/playbook-discovery.ts). A refactor that breaks a
// shipped playbook makes it vanish from the browser for marketplace users with
// nothing failing at push time. This gate runs the real `parsePlaybook` over
// every bundled playbook so a parse regression fails CI/pre-push, and warns on
// unrecognized frontmatter keys (typos like `checkist:` that silently drop a
// field). Modelled on scripts/validate-skills.ts.

export interface PlaybookIssue {
  file: string;
  message: string;
}

export interface PlaybookValidationResult {
  root: string;
  errors: PlaybookIssue[];
  warnings: PlaybookIssue[];
}

// The shipped, marketplace-visible playbooks. Mirrors `playbookRoots` in
// scripts/validate-skills.ts. `.claude/playbooks/` is a dev-tree doc location
// that discovery never loads (runtime tiers are `.kookr/playbooks` + the plugin
// dir), so it is out of scope here. Missing directories are treated as empty.
const PLAYBOOK_ROOTS = ['plugin/playbooks'];

export function validatePlaybooks(repoRoot: string = process.cwd()): PlaybookValidationResult {
  const errors: PlaybookIssue[] = [];
  const warnings: PlaybookIssue[] = [];

  for (const root of PLAYBOOK_ROOTS) {
    for (const file of collectMarkdownFiles(join(repoRoot, root))) {
      validatePlaybookFile(file, repoRoot, errors, warnings);
    }
  }

  return { root: repoRoot, errors, warnings };
}

function validatePlaybookFile(
  file: string,
  repoRoot: string,
  errors: PlaybookIssue[],
  warnings: PlaybookIssue[],
): void {
  const relativePath = relative(repoRoot, file);
  const content = readFileSync(file, 'utf8');

  try {
    // The exact parse discovery runs — a failure here is what would silently
    // hide the playbook from marketplace users at runtime.
    parsePlaybook(content, relativePath, repoRoot);
  } catch (err) {
    if (err instanceof PlaybookParseError) {
      errors.push({ file, message: err.message });
    } else {
      errors.push({ file, message: `unexpected error: ${(err as Error).message}` });
    }
    return;
  }

  // Only meaningful once the frontmatter parses; parse errors already reported.
  for (const key of findUnknownFrontmatterKeys(content)) {
    warnings.push({
      file,
      message: `unrecognized frontmatter key "${key}" — the parser silently ignores it; check for a typo`,
    });
  }
}

function collectMarkdownFiles(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function main(): void {
  const args = process.argv.slice(2);
  // --strict escalates warnings to errors, mirroring validate-skills.ts.
  const strict = args.includes('--strict');
  const unknownFlags = args.filter((arg) => arg.startsWith('--') && arg !== '--strict');
  if (unknownFlags.length > 0) {
    // A misspelled --strict must not silently degrade the gate to warn mode.
    console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`);
    process.exit(2);
  }
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const repoRoot = positional[0] ?? process.cwd();

  const { errors, warnings } = validatePlaybooks(repoRoot);

  if (warnings.length > 0) {
    console.error(
      `Playbook validation warnings (${warnings.length})${strict ? ' — failing due to --strict' : ''}:`,
    );
    for (const warning of warnings) {
      console.error(`  ${relative(repoRoot, warning.file)}: ${warning.message}`);
    }
  }

  if (errors.length > 0 || (strict && warnings.length > 0)) {
    if (errors.length > 0) {
      console.error('Playbook validation failed:');
      for (const error of errors) {
        console.error(`  ${relative(repoRoot, error.file)}: ${error.message}`);
      }
    }
    process.exit(1);
  }

  console.log('Playbook validation passed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
