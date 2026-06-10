#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import { isMap, parseDocument } from 'yaml';

interface SkillIssue {
  file: string;
  message: string;
}

const args = process.argv.slice(2);
// --strict escalates warnings to errors. Until the reference backlog is fixed
// or waived, warnings report without failing the run (RFC plugin-skill-improvements,
// T1-guard: the gate must never be enabled while known-broken refs remain).
const strict = args.includes('--strict');
const unknownFlags = args.filter((arg) => arg.startsWith('--') && arg !== '--strict');
if (unknownFlags.length > 0) {
  // A misspelled --strict must not silently degrade the gate to warn mode.
  console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`);
  process.exit(2);
}
const positional = args.filter((arg) => !arg.startsWith('--'));
const repoRoot = positional[0] ?? process.cwd();
const skillRoots = ['.claude/skills', 'plugin/skills'];
const playbookRoots = ['plugin/playbooks'];
// Known-bad literals that make shipped content non-portable (R4): content under
// plugin/ must work for any marketplace user, not one specific GitHub account.
const hardcodedUsernames = ['jeanibarz'];
const lineCountWarningThreshold = 500;
const errors: SkillIssue[] = [];
const warnings: SkillIssue[] = [];
const seenWarnings = new Set<string>();

function warn(issue: SkillIssue): void {
  const key = `${issue.file}\u0000${issue.message}`;
  if (seenWarnings.has(key)) return;
  seenWarnings.add(key);
  warnings.push(issue);
}

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

// Library-claim staleness check (RFC plugin-skill-improvements, Phase 4): a
// shipped skill whose code blocks import a package the project doesn't depend
// on is teaching a stack the project doesn't run (how the Pino drift slipped
// in). Deliberate examples are waived with <!-- lint-allow-library: name -->.
const packageDependencies = loadPackageDependencies();
// Placeholder scopes used by illustrative snippets, never real claims.
const placeholderImportPattern = /^(@myapp\/|@pkg\/|@your|my-|example|your-)/;

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
  console.error(`Skill validation warnings (${warnings.length})${strict ? ' — failing due to --strict' : ''}:`);
  for (const warning of warnings) {
    console.error(`  ${relative(repoRoot, warning.file)}: ${warning.message}`);
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
    warn({
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
      warn({ file, message: `referenced path does not exist: ${span}` });
    }
  }

  if (isShipped(file)) {
    checkLibraryClaims(file, content);
    for (const username of hardcodedUsernames) {
      if (content.includes(username)) {
        warn({
          file,
          message: `hardcoded username "${username}" in shipped content; derive it (e.g. \`gh api user --jq .login\`)`,
        });
      }
    }
  }
}

function loadPackageDependencies(): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (builtinModules.includes(name)) return null;
  if (placeholderImportPattern.test(name)) return null;
  return name;
}

function checkLibraryClaims(file: string, content: string): void {
  const waived = new Set(
    [...content.matchAll(/<!--\s*lint-allow-library:\s*([a-z0-9@\/, .-]+?)\s*-->/gi)]
      .flatMap((m) => m[1].split(',').map((name) => name.trim())),
  );
  const fenced = extractFencedCodeBlocks(content);
  const imports = [
    ...fenced.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"\n]+)['"]/gm),
    ...fenced.matchAll(/require\(\s*['"]([^'"\n]+)['"]\s*\)/g),
  ];
  const flagged = new Set<string>();
  for (const match of imports) {
    const name = packageNameOf(match[1]);
    if (!name || waived.has(name) || packageDependencies.has(name) || flagged.has(name)) continue;
    flagged.add(name);
    warn({
      file,
      message: `code block imports "${name}" but it is not a package.json dependency — stale library claim? (waive a deliberate example with <!-- lint-allow-library: ${name} -->)`,
    });
  }
}

function checkReference(file: string, target: string, kind: string): void {
  if (isShipped(file)) {
    if (pluginTargets.has(target)) return;
    if (localTargets.has(target) || localTargets.has(`kookr-${target}`)) {
      warn({
        file,
        message: `${kind} "${target}" resolves only to the repo-local .claude/ tree — cross-tier dependency; promote it into plugin/ or remove the reference`,
      });
      return;
    }
    warn({ file, message: `${kind} "${target}" does not resolve on the shipped surface (plugin/)` });
    return;
  }

  // Same-directory self-reference (a skill never needs to list itself, but tolerate it).
  if (basename(dirname(file)) === target) return;
  if (pluginTargets.has(target) || localTargets.has(target)) return;
  warn({ file, message: `${kind} "${target}" does not resolve (checked .claude/ and plugin/)` });
}

function isShipped(file: string): boolean {
  return relative(repoRoot, file).startsWith('plugin/');
}

function relatedEntries(related: unknown): string[] {
  if (Array.isArray(related)) {
    return related
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof related === 'string') {
    return related
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function extractFencedCodeBlocks(content: string): string {
  const lines: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const line of content.split('\n')) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) {
      const marker = match[1][0];
      if (!fence) {
        fence = { marker, length: match[1].length };
        continue;
      }
      if (fence.marker === marker && match[1].length >= fence.length) {
        fence = null;
        continue;
      }
      continue;
    }
    if (fence) lines.push(line);
  }
  return lines.join('\n');
}

function stripFencedCodeBlocks(content: string): string {
  const lines: string[] = [];
  // A fence closes only on its own marker kind at >= the opening length,
  // so a ``` line inside a ~~~ block stays fenced (CommonMark behavior).
  let fence: { marker: string; length: number } | null = null;
  for (const line of content.split('\n')) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) {
      const marker = match[1][0];
      if (!fence) {
        fence = { marker, length: match[1].length };
        continue;
      }
      if (fence.marker === marker && match[1].length >= fence.length) {
        fence = null;
        continue;
      }
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines.join('\n');
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
