#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isMap, parseDocument } from 'yaml';

interface SkillError {
  file: string;
  message: string;
}

const args = process.argv.slice(2);
// --strict escalates warnings to errors. Until the reference backlog is fixed
// or waived, warnings report without failing the run (RFC plugin-skill-improvements,
// T1-guard: the gate must never be enabled while known-broken refs remain).
const strict = args.includes('--strict');
const positional = args.filter((arg) => !arg.startsWith('--'));
const repoRoot = positional[0] ?? process.cwd();
const skillRoots = ['.claude/skills', 'plugin/skills'];
const errors: SkillError[] = [];
const warnings: SkillError[] = [];

for (const root of skillRoots) {
  for (const file of collectSkillFiles(join(repoRoot, root))) {
    validateSkill(file);
  }
}

if (warnings.length > 0) {
  const stream = strict ? console.error : console.warn;
  stream(`Skill validation warnings (${warnings.length})${strict ? ' — failing due to --strict' : ''}:`);
  for (const warning of warnings) {
    stream(`  ${relative(repoRoot, warning.file)}: ${warning.message}`);
  }
}

if (errors.length > 0 || (strict && warnings.length > 0)) {
  if (errors.length > 0) {
    console.error('Skill validation failed:');
    for (const error of errors) {
      console.error(`  ${relative(repoRoot, error.file)}: ${error.message}`);
    }
  }
  process.exit(1);
}

console.log('Skill validation passed.');

function collectSkillFiles(dir: string): string[] {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSkillFiles(path));
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      files.push(path);
    }
  }
  return files.sort();
}

function validateSkill(file: string): void {
  const content = readFileSync(file, 'utf8');
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter.ok) {
    errors.push({ file, message: frontmatter.reason });
    return;
  }

  const doc = parseDocument(frontmatter.value, { prettyErrors: false });
  if (doc.errors.length > 0) {
    errors.push({ file, message: `invalid YAML frontmatter: ${doc.errors[0].message}` });
    return;
  }
  if (!isMap(doc.contents)) {
    errors.push({ file, message: 'frontmatter must be a YAML mapping' });
    return;
  }

  const parsed = doc.toJS();
  if (!isNonEmptyString(parsed?.name)) {
    errors.push({ file, message: 'frontmatter field `name` must be a non-empty string' });
  }
  if (!isNonEmptyString(parsed?.description)) {
    errors.push({ file, message: 'frontmatter field `description` must be a non-empty string' });
  }
}

function extractFrontmatter(content: string): { ok: true; value: string } | { ok: false; reason: string } {
  const newline = content.startsWith('---\r\n') ? '\r\n' : '\n';
  if (!content.startsWith(`---${newline}`)) {
    return { ok: false, reason: 'file must start with YAML frontmatter delimiter `---`' };
  }

  const lines = content.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      return { ok: true, value: lines.slice(1, index).join('\n') };
    }
  }

  return { ok: false, reason: 'frontmatter is missing closing `---` delimiter' };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
