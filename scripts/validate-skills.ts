#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
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
const playbookRoots = ['plugin/playbooks'];
// Known-bad literals that make shipped content non-portable (R4): content under
// plugin/ must work for any marketplace user, not one specific GitHub account.
const hardcodedUsernames = ['jeanibarz'];
const lineCountWarningThreshold = 500;
const errors: SkillError[] = [];
const warnings: SkillError[] = [];

// Reference resolution targets, per surface. A reference *from* plugin/ must
// resolve *within* plugin/ — shipped content referencing the dev-only .claude/
// tree is broken for marketplace-installed users even when it resolves locally.
// References from .claude/ content may resolve across both surfaces.
const pluginTargets = collectTargets([
  join(repoRoot, 'plugin/skills'),
  join(repoRoot, 'plugin/agents'),
]);
const localTargets = collectTargets([
  join(repoRoot, '.claude/skills'),
  join(repoRoot, '.claude/agents'),
]);

for (const root of skillRoots) {
  for (const file of collectSkillFiles(join(repoRoot, root))) {
    validateSkill(file);
  }
}

for (const root of playbookRoots) {
  for (const file of collectMarkdownFiles(join(repoRoot, root))) {
    validateReferences(file, readFileSync(file, 'utf8'));
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

function collectMarkdownFiles(dir: string): string[] {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(dir, entry.name))
    .sort();
}

// Resolvable names on a surface: skill directory names and agent file basenames.
function collectTargets(dirs: string[]): Set<string> {
  const names = new Set<string>();
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        names.add(entry.name);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        names.add(basename(entry.name, '.md'));
      }
    }
  }
  return names;
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

  for (const target of relatedEntries(parsed?.related)) {
    checkReference(file, target, 'related:');
  }

  const lineCount = content.split('\n').length;
  if (lineCount > lineCountWarningThreshold) {
    warnings.push({
      file,
      message: `SKILL.md is ${lineCount} lines (> ${lineCountWarningThreshold}); consider splitting per token-economy guidance`,
    });
  }

  validateReferences(file, content);
}

// Checks shared between skills and playbooks: [[wiki-links]], repo-relative
// path references in inline code, and hardcoded usernames in shipped content.
function validateReferences(file: string, content: string): void {
  const body = stripFencedCodeBlocks(content);

  // Wiki-links never legitimately live in inline code — spans like
  // `related: [[foo]], [[bar]]` are syntax examples, not references.
  for (const match of body.replace(/`[^`\n]*`/g, '').matchAll(/\[\[([a-z0-9-]+)\]\]/gi)) {
    checkReference(file, match[1], 'wiki-link');
  }

  for (const match of body.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1];
    if (!/^(src|docs|scripts|e2e|plugin|relay|hooks)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/.test(span)) continue;
    if (!existsSync(join(repoRoot, span))) {
      warnings.push({ file, message: `referenced path does not exist: ${span}` });
    }
  }

  if (isShipped(file)) {
    for (const username of hardcodedUsernames) {
      if (content.includes(username)) {
        warnings.push({
          file,
          message: `hardcoded username "${username}" in shipped content; derive it (e.g. \`gh api user --jq .login\`)`,
        });
      }
    }
  }
}

function checkReference(file: string, target: string, kind: string): void {
  if (isShipped(file)) {
    if (pluginTargets.has(target)) return;
    if (localTargets.has(target) || localTargets.has(`kookr-${target}`)) {
      warnings.push({
        file,
        message: `${kind} "${target}" resolves only to the repo-local .claude/ tree — cross-tier dependency; promote it into plugin/ or remove the reference`,
      });
      return;
    }
    warnings.push({ file, message: `${kind} "${target}" does not resolve on the shipped surface (plugin/)` });
    return;
  }

  // Same-directory self-reference (a skill never needs to list itself, but tolerate it).
  if (basename(dirname(file)) === target) return;
  if (pluginTargets.has(target) || localTargets.has(target)) return;
  warnings.push({ file, message: `${kind} "${target}" does not resolve (checked .claude/ and plugin/)` });
}

function isShipped(file: string): boolean {
  return relative(repoRoot, file).startsWith('plugin/');
}

function relatedEntries(related: unknown): string[] {
  if (Array.isArray(related)) {
    return related.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
  }
  if (typeof related === 'string') {
    return related
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function stripFencedCodeBlocks(content: string): string {
  return content
    .split('\n')
    .reduce<{ inFence: boolean; lines: string[] }>(
      (state, line) => {
        if (/^\s*(```|~~~)/.test(line)) {
          return { inFence: !state.inFence, lines: state.lines };
        }
        if (!state.inFence) state.lines.push(line);
        return state;
      },
      { inFence: false, lines: [] },
    )
    .lines.join('\n');
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
