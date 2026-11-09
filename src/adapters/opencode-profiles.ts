/**
 * opencode worker profiles (RFC rfc-opencode-agent-integration §6).
 *
 * A profile is a Markdown file in `plugin/opencode-profiles/` with a small YAML
 * frontmatter block (id, description, permission, deliverable, shelves, optional
 * model) and a body that becomes the session's AGENTS.md instructions. The
 * frontmatter subset is deliberately tiny (`key: value` and one-line `[a, b]`
 * lists) and parsed strictly, so a typo fails loudly instead of silently
 * launching a worker without its delivery gate.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OpenCodeDeliverableSpec, OpenCodeProfile } from './opencode-kookr-hooks.js';

const moduleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

/** Profile id charset. Mirrored (plain JS) by `bin/kookr-spawn.js`; keep both in sync. */
export const OPENCODE_PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

const FRONTMATTER_KEYS = ['id', 'description', 'permission', 'deliverable', 'shelves', 'model'] as const;
const REQUIRED_KEYS = ['id', 'description', 'permission', 'deliverable'] as const;
const DELIVERABLE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class OpenCodeProfileError extends Error {
  readonly code: 'unknown_profile' | 'invalid_profile';
  constructor(code: OpenCodeProfileError['code'], message: string) {
    super(message);
    this.name = 'OpenCodeProfileError';
    this.code = code;
  }
}

export function isOpenCodeProfileError(err: unknown): err is OpenCodeProfileError {
  return err instanceof OpenCodeProfileError;
}

/** `<repo>/plugin/opencode-profiles` (works from src/adapters and dist/adapters); `KOOKR_OPENCODE_PROFILES_DIR` overrides. */
export function resolveOpenCodeProfilesDir(env: NodeJS.ProcessEnv = process.env, baseDir: string = moduleDir): string {
  return env.KOOKR_OPENCODE_PROFILES_DIR?.trim() || resolve(baseDir, '..', '..', 'plugin', 'opencode-profiles');
}

function invalid(source: string, message: string): never {
  throw new OpenCodeProfileError('invalid_profile', `opencode profile ${source}: ${message}`);
}

function unquote(raw: string): string {
  const m = raw.match(/^(["'])(.*)\1$/);
  return m ? m[2]! : raw;
}

function parseFrontmatterBlock(text: string, source: string): { fields: Record<string, string>; body: string } {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/);
  if (!m) invalid(source, 'missing YAML frontmatter (expected a leading `---` block)');
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (!kv) invalid(source, `unparseable frontmatter line: "${line}" (only single-line \`key: value\` is supported)`);
    const key = kv![1]!;
    if (!(FRONTMATTER_KEYS as readonly string[]).includes(key)) {
      invalid(source, `unknown frontmatter key "${key}" (allowed: ${FRONTMATTER_KEYS.join(', ')})`);
    }
    if (key in fields) invalid(source, `duplicate frontmatter key "${key}"`);
    fields[key] = kv![2]!.trim();
  }
  return { fields, body: m[2] ?? '' };
}

function parseShelves(raw: string, source: string): string[] {
  const m = raw.match(/^\[(.*)\]$/);
  if (!m) invalid(source, `shelves must be an inline list like [a, b], got "${raw}"`);
  const items = m![1]!.split(',').map((s) => unquote(s.trim())).filter((s) => s !== '');
  for (const item of items) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item)) invalid(source, `invalid shelf name "${item}"`);
  }
  return items;
}

function parseDeliverable(raw: string, source: string): OpenCodeDeliverableSpec {
  if (raw === 'none') return { kind: 'none' };
  if (raw === 'commit-and-pr-body') return { kind: 'commit-and-pr-body' };
  const file = raw.match(/^file:(.+)$/);
  if (file) {
    const name = file[1]!.trim();
    if (!DELIVERABLE_FILE_PATTERN.test(name)) invalid(source, `deliverable file name "${name}" must be a plain file name`);
    return { kind: 'file', name };
  }
  return invalid(source, `deliverable must be "none", "commit-and-pr-body" or "file:<name>", got "${raw}"`);
}

/** Parse one profile file's text. `source` is only used in error messages. */
export function parseOpenCodeProfile(text: string, source = '<profile>'): OpenCodeProfile & { id: string } {
  const { fields, body } = parseFrontmatterBlock(text, source);
  for (const key of REQUIRED_KEYS) {
    if (!fields[key]) invalid(source, `missing required frontmatter key "${key}"`);
  }
  const id = unquote(fields.id!);
  if (!OPENCODE_PROFILE_ID_PATTERN.test(id)) {
    invalid(source, `id "${id}" must match ${OPENCODE_PROFILE_ID_PATTERN}`);
  }
  const permission = fields.permission!;
  if (permission !== 'allow' && permission !== 'ask') invalid(source, `permission must be "allow" or "ask", got "${permission}"`);
  const instructions = body.trim();
  if (!instructions) invalid(source, 'body (the worker instructions) is empty');
  const model = fields.model ? unquote(fields.model) : undefined;
  return {
    id,
    description: unquote(fields.description!),
    instructions: `${instructions}\n`,
    permission: permission as 'allow' | 'ask',
    deliverable: parseDeliverable(fields.deliverable!, source),
    shelves: fields.shelves !== undefined ? parseShelves(fields.shelves, source) : [],
    ...(model ? { model } : {}),
  };
}

/** Load every `*.md` profile in `dir`, keyed by id. Throws on any invalid file or duplicate id. */
export function loadOpenCodeProfiles(dir: string = resolveOpenCodeProfilesDir()): Map<string, OpenCodeProfile & { id: string }> {
  const out = new Map<string, OpenCodeProfile & { id: string }>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const profile = parseOpenCodeProfile(readFileSync(join(dir, entry), 'utf-8'), entry);
    if (out.has(profile.id)) invalid(entry, `duplicate profile id "${profile.id}"`);
    out.set(profile.id, profile);
  }
  return out;
}

export function listOpenCodeProfileIds(dir?: string): string[] {
  return [...loadOpenCodeProfiles(dir).keys()];
}

/** Resolve a profile id; unknown ids throw a typed `unknown_profile` error listing the valid ids. */
export function resolveOpenCodeProfile(id: string, dir?: string): OpenCodeProfile & { id: string } {
  const profiles = loadOpenCodeProfiles(dir);
  const profile = profiles.get(id);
  if (!profile) {
    throw new OpenCodeProfileError(
      'unknown_profile',
      `Unknown opencode profile "${id}"; valid profiles: ${[...profiles.keys()].join(', ') || '(none installed)'}`,
    );
  }
  return profile;
}
