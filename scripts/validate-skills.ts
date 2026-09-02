#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMap, parseDocument } from 'yaml';

export interface SkillIssue {
  file: string;
  message: string;
}

export interface SkillValidationResult {
  root: string;
  errors: SkillIssue[];
  warnings: SkillIssue[];
}

const SKILL_ROOTS = ['.claude/skills', 'plugin/skills'] as const;
const PLAYBOOK_ROOTS = ['plugin/playbooks'] as const;
const PLUGIN_SKILLS_ROOT = 'plugin/skills';
const PLUGIN_AGENTS_ROOT = 'plugin/agents';
const PLUGIN_PLAYBOOKS_ROOT = 'plugin/playbooks';
const PLUGIN_README = 'plugin/README.md';
const PLUGIN_MANIFEST = 'plugin/.claude-plugin/plugin.json';
const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json';
const WHATS_INCLUDED_HEADING = "## What's included";
// Known-bad literals that make shipped content non-portable (R4): content under
// plugin/ must work for any marketplace user, not one specific GitHub account.
const HARDCODED_USERNAMES = ['jeanibarz'];
const LINE_COUNT_WARNING_THRESHOLD = 500;

export function validateSkills(repoRoot: string = process.cwd()): SkillValidationResult {
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
    join(repoRoot, PLUGIN_SKILLS_ROOT),
    join(repoRoot, PLUGIN_AGENTS_ROOT),
  ]);
  const localTargets = collectTargets([
    join(repoRoot, '.claude/skills'),
    join(repoRoot, '.claude/agents'),
  ]);

  for (const root of SKILL_ROOTS) {
    validateSkillRootShape(join(repoRoot, root), errors);
  }

  for (const root of SKILL_ROOTS) {
    for (const file of collectSkillFiles(join(repoRoot, root))) {
      validateSkill(file, repoRoot, pluginTargets, localTargets, errors, warn);
    }
  }

  for (const root of PLAYBOOK_ROOTS) {
    for (const file of collectMarkdownFiles(join(repoRoot, root))) {
      validateReferences(file, readFileSync(file, 'utf8'), repoRoot, pluginTargets, localTargets, warn);
    }
  }

  validatePluginReadmeInventory(repoRoot, errors);
  validatePluginManifestCounts(repoRoot, errors);

  return { root: repoRoot, errors, warnings };
}

function main(): void {
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

  const { errors, warnings } = validateSkills(repoRoot);

  if (warnings.length > 0) {
    console.error(
      `Skill validation warnings (${warnings.length})${strict ? ' — failing due to --strict' : ''}:`,
    );
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
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}

function validateSkillRootShape(dir: string, errors: SkillIssue[]): void {
  let entries;
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return;
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isFile()) {
      errors.push({
        file: path,
        message:
          'is a file; skill discovery looks for <dir>/SKILL.md, so this entry never loads',
      });
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (!existsSync(join(path, 'SKILL.md'))) {
      errors.push({
        file: path,
        message: 'skill directory is missing SKILL.md',
      });
    }
  }
}

function validatePluginReadmeInventory(repoRoot: string, errors: SkillIssue[]): void {
  const readmePath = join(repoRoot, PLUGIN_README);
  // Temp fixtures omit the README so shape/frontmatter tests stay isolated.
  if (!existsSync(readmePath)) return;

  const readme = readFileSync(readmePath, 'utf8');
  const section = extractWhatsIncludedSection(readme);
  if (section === null) {
    errors.push({
      file: readmePath,
      message: `missing "${WHATS_INCLUDED_HEADING}" section; shipped plugin inventory cannot be checked`,
    });
    return;
  }

  const listed = listedInventoryNames(section);
  for (const [kind, names] of shippedPluginInventory(repoRoot)) {
    for (const name of names) {
      if (listed.has(name)) continue;
      errors.push({
        file: readmePath,
        message: `What's included does not list shipped ${kind} "${name}"`,
      });
    }
  }
}

function validatePluginManifestCounts(repoRoot: string, errors: SkillIssue[]): void {
  const skillCount = collectImmediateSkillDirs(join(repoRoot, PLUGIN_SKILLS_ROOT)).length;
  const agentCount = collectMarkdownBasenames(join(repoRoot, PLUGIN_AGENTS_ROOT)).length;

  checkManifestDescriptionCounts(
    join(repoRoot, PLUGIN_MANIFEST),
    readJsonObject(join(repoRoot, PLUGIN_MANIFEST), errors)?.description,
    skillCount,
    agentCount,
    errors,
  );

  const marketplace = readJsonObject(join(repoRoot, MARKETPLACE_MANIFEST), errors);
  const plugins = marketplace && Array.isArray((marketplace as { plugins?: unknown }).plugins)
    ? ((marketplace as { plugins: unknown[] }).plugins)
    : [];
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) continue;
    checkManifestDescriptionCounts(
      join(repoRoot, MARKETPLACE_MANIFEST),
      (plugin as { description?: unknown }).description,
      skillCount,
      agentCount,
      errors,
    );
  }
}

function readJsonObject(path: string, errors: SkillIssue[]): Record<string, unknown> | null {
  // Temp fixtures omit these manifests so shape/frontmatter tests stay isolated.
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    errors.push({
      file: path,
      message: `invalid JSON: ${(err as Error).message}`,
    });
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push({ file: path, message: `${basename(path)} must be a JSON object` });
    return null;
  }
  return parsed as Record<string, unknown>;
}

function checkManifestDescriptionCounts(
  file: string,
  description: unknown,
  skillCount: number,
  agentCount: number,
  errors: SkillIssue[],
): void {
  // No advertised counts to check when a description is missing or not prose.
  if (typeof description !== 'string') return;

  const skillsMatch = description.match(/(\d+)\s+skills/);
  if (skillsMatch && Number(skillsMatch[1]) !== skillCount) {
    errors.push({
      file,
      message: `description says ${skillsMatch[1]} skills but ${PLUGIN_SKILLS_ROOT} has ${skillCount} loadable SKILL.md directories`,
    });
  }

  const agentsMatch = description.match(/(\d+)\s+review subagents/);
  if (agentsMatch && Number(agentsMatch[1]) !== agentCount) {
    errors.push({
      file,
      message: `description says ${agentsMatch[1]} review subagents but ${PLUGIN_AGENTS_ROOT} has ${agentCount} agent files`,
    });
  }
}

function extractWhatsIncludedSection(readme: string): string | null {
  const start = readme.indexOf(WHATS_INCLUDED_HEADING);
  if (start < 0) return null;
  const after = readme.slice(start + WHATS_INCLUDED_HEADING.length);
  const next = after.search(/\n## /);
  return next < 0 ? after : after.slice(0, next);
}

function listedInventoryNames(section: string): Set<string> {
  const names = new Set<string>();
  for (const match of section.matchAll(/`([^`]+)`/g)) {
    const raw = match[1];
    const brace = /^([a-z0-9-]+)\{([^}]+)\}$/i.exec(raw);
    if (brace) {
      for (const part of brace[2].split(',')) {
        const piece = part.trim();
        if (piece.length > 0) names.add(`${brace[1]}${piece}`);
      }
      continue;
    }
    if (/^[a-z0-9-]+$/i.test(raw)) names.add(raw);
  }
  return names;
}

function shippedPluginInventory(repoRoot: string): Array<['skill' | 'agent' | 'playbook', string[]]> {
  return [
    ['skill', collectImmediateSkillDirs(join(repoRoot, PLUGIN_SKILLS_ROOT))],
    ['agent', collectMarkdownBasenames(join(repoRoot, PLUGIN_AGENTS_ROOT))],
    ['playbook', collectMarkdownBasenames(join(repoRoot, PLUGIN_PLAYBOOKS_ROOT))],
  ];
}

function collectImmediateSkillDirs(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        !entry.name.startsWith('.') &&
        entry.isDirectory() &&
        existsSync(join(dir, entry.name, 'SKILL.md')),
    )
    .map((entry) => entry.name)
    .sort();
}

function collectMarkdownBasenames(dir: string): string[] {
  return collectMarkdownFiles(dir).map((file) => basename(file, '.md'));
}

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

function validateSkill(
  file: string,
  repoRoot: string,
  pluginTargets: Set<string>,
  localTargets: Set<string>,
  errors: SkillIssue[],
  warn: (issue: SkillIssue) => void,
): void {
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
    checkReference(file, target, 'related:', repoRoot, pluginTargets, localTargets, warn);
  }

  const lineCount = content.split('\n').length;
  if (lineCount > LINE_COUNT_WARNING_THRESHOLD) {
    warn({
      file,
      message: `SKILL.md is ${lineCount} lines (> ${LINE_COUNT_WARNING_THRESHOLD}); consider splitting per token-economy guidance`,
    });
  }

  validateReferences(file, content, repoRoot, pluginTargets, localTargets, warn);
}

// Checks shared between skills and playbooks: [[wiki-links]], repo-relative
// path references in inline code, and hardcoded usernames in shipped content.
function validateReferences(
  file: string,
  content: string,
  repoRoot: string,
  pluginTargets: Set<string>,
  localTargets: Set<string>,
  warn: (issue: SkillIssue) => void,
): void {
  const body = stripFencedCodeBlocks(content);

  // Wiki-links never legitimately live in inline code — spans like
  // `related: [[foo]], [[bar]]` are syntax examples, not references.
  for (const match of body.replace(/`[^`\n]*`/g, '').matchAll(/\[\[([a-z0-9-]+)\]\]/gi)) {
    checkReference(file, match[1], 'wiki-link', repoRoot, pluginTargets, localTargets, warn);
  }

  for (const match of body.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1];
    if (!/^(src|docs|scripts|e2e|plugin|relay|hooks)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/.test(span)) continue;
    if (!existsSync(join(repoRoot, span))) {
      warn({ file, message: `referenced path does not exist: ${span}` });
    }
  }

  if (isShipped(file, repoRoot)) {
    for (const username of HARDCODED_USERNAMES) {
      if (content.includes(username)) {
        warn({
          file,
          message: `hardcoded username "${username}" in shipped content; derive it (e.g. \`gh api user --jq .login\`)`,
        });
      }
    }
  }
}

function checkReference(
  file: string,
  target: string,
  kind: string,
  repoRoot: string,
  pluginTargets: Set<string>,
  localTargets: Set<string>,
  warn: (issue: SkillIssue) => void,
): void {
  if (isShipped(file, repoRoot)) {
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

function isShipped(file: string, repoRoot: string): boolean {
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
