// notebook-layers — the ONE place Kookr decides which memory layer a notebook
// shelf belongs to (RFC docs/rfc/rfc-notebook-memory-layers.md, D3).
//
// Background. Agents keep short lessons in "shelves" (one `<name>.md` file each,
// managed by the `nb` CLI). Memory is layered project > domain > global, and the
// layer is derived from the shelf NAME alone; nothing is stored in the file:
//
//   <situation>@<slug>   project  true only in one repo; slug = `owner-repo`
//   <situation>          domain   true in any repo (a bare name, no `@`)
//   fleet-global         global   host-wide facts, written only by promotion
//
// Rules this module owns, so no caller re-implements them:
//   * Split on the LAST `@`. `a@b@c` is base `a@b`, slug `c`; `a@@c` is base `a@`.
//   * The slug is compared case-insensitively after trimming (`nb` 0.7.0 accepts
//     `Code-Review@Kookr-AI-Kookr`).
//   * A legacy slug (an alias source in plugin/notebooks/slug-aliases.json, e.g.
//     `agent-notebook`) is the SAME repo as its canonical slug
//     (`jeanibarz-agent-notebook`); resolve it before comparing or grouping.
//
// Dependency-free on purpose (node builtins only). Importers: the K2 store scripts
// (scripts/migrate-notebook-slugs.mjs, promote-notebook-lessons.mjs,
// apply-shelf-descriptions.mjs), the SessionStart index (plugin/hooks/nb-inject.mjs)
// and the `bin/nb.js` shim's `nb add` advisory. The hook and the shim both load it
// through a guarded dynamic import and fall back to a simpler behavior if it is
// missing, so this file can never break a session start or an `nb` call.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The single host-wide shelf. Which shelf is "global" is Kookr policy, not `nb`'s. */
export const GLOBAL_SHELF = 'fleet-global';

/** `nb` rejects shelf names longer than this with `bad_args`. */
export const MAX_SHELF_NAME_LENGTH = 128;

/**
 * Legacy slug -> canonical slug, used when plugin/notebooks/slug-aliases.json is
 * missing or unreadable. A test pins it equal to the shipped file. It exists so
 * the description seed keeps skipping legacy shelves (RFC v7) even if the file
 * is later deleted after the migration.
 */
export const BUILTIN_SLUG_ALIASES = Object.freeze({ 'agent-notebook': 'jeanibarz-agent-notebook' });

const HERE = dirname(fileURLToPath(import.meta.url));
/** plugin/notebooks/slug-aliases.json, resolved from this file's location. */
export const DEFAULT_ALIASES_PATH = join(HERE, '..', '..', 'notebooks', 'slug-aliases.json');

/** Trim and lower-case a slug for comparison. Non-strings and blanks become ''. */
export function normalizeSlug(slug) {
  return typeof slug === 'string' ? slug.trim().toLowerCase() : '';
}

/**
 * The repo slug from an environment (`KOOKR_REPO_SLUG`), trimmed. An empty or
 * whitespace-only value counts as unset, so this returns `undefined`.
 */
export function repoSlugFromEnv(env = process.env) {
  const slug = typeof env.KOOKR_REPO_SLUG === 'string' ? env.KOOKR_REPO_SLUG.trim() : '';
  return slug === '' ? undefined : slug;
}

/**
 * Read a legacy->canonical slug map. Returns a `Map` keyed by the normalized
 * legacy slug whose value is the canonical slug exactly as written in the file
 * (trimmed). By default it never throws: a missing or malformed file yields the
 * built-in map. With `{ strict: true }` (used when the operator names a file with
 * `--map`) a missing, unparsable or non-object file throws instead. Malformed
 * entries (non-string, blank, self-alias) are dropped either way.
 */
export function loadSlugAliases(path = DEFAULT_ALIASES_PATH, { strict = false } = {}) {
  let raw;
  try {
    raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : undefined;
  } catch (err) {
    if (strict) throw new Error(`slug alias map ${path} cannot be parsed: ${err instanceof Error ? err.message : String(err)}`);
    raw = undefined;
  }
  if (strict && (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    // An alias map the operator named explicitly must be used or refused, never
    // silently replaced by the built-in one (that changes which shelves count as legacy).
    throw new Error(`slug alias map ${path} ${raw === undefined ? 'does not exist' : 'is not a JSON object'}`);
  }
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    raw = BUILTIN_SLUG_ALIASES;
  }
  const map = new Map();
  for (const [legacy, canonical] of Object.entries(raw)) {
    if (legacy.startsWith('_')) continue; // `_comment` style keys
    if (typeof canonical !== 'string') continue;
    const from = normalizeSlug(legacy);
    const to = canonical.trim();
    if (from === '' || to === '' || normalizeSlug(to) === from) continue;
    map.set(from, to);
  }
  return map;
}

/** True when `slug` is an alias SOURCE (a legacy short slug that has a canonical form). */
export function isLegacySlug(slug, aliases = loadSlugAliases()) {
  return aliases.has(normalizeSlug(slug));
}

/**
 * Resolve a slug to its canonical form through the alias map (one hop, so a
 * chain or cycle in the file can never loop). The result is the key to compare
 * and group repos by: normalized (trimmed, lower-case).
 */
export function canonicalSlug(slug, aliases = loadSlugAliases()) {
  const norm = normalizeSlug(slug);
  const target = aliases.get(norm);
  return target === undefined ? norm : normalizeSlug(target);
}

/**
 * Classify a shelf name.
 *
 * Returns `{ name, layer, base, slug, canonical, legacy }` where:
 *   layer     'global' | 'project' | 'domain' | 'malformed'
 *   base      the situation part (everything before the LAST `@`), or the whole name
 *   slug      the slug as written, trimmed (project only, else '')
 *   canonical normalized slug after alias resolution (project only, else '')
 *   legacy    true when the slug is an alias source (project only)
 *
 * 'malformed' means the name has an `@` but an empty base or slug (`@x`, `x@`,
 * `x@ `). It belongs to no layer, so callers must skip it rather than guess.
 */
export function classifyShelf(name, aliases = loadSlugAliases()) {
  const shelf = typeof name === 'string' ? name : '';
  if (shelf === GLOBAL_SHELF) {
    return { name: shelf, layer: 'global', base: shelf, slug: '', canonical: '', legacy: false };
  }
  const at = shelf.lastIndexOf('@');
  if (at === -1) {
    return { name: shelf, layer: 'domain', base: shelf, slug: '', canonical: '', legacy: false };
  }
  const base = shelf.slice(0, at);
  const slug = shelf.slice(at + 1).trim();
  if (base === '' || slug === '') {
    return { name: shelf, layer: 'malformed', base: shelf, slug: '', canonical: '', legacy: false };
  }
  return {
    name: shelf,
    layer: 'project',
    base,
    slug,
    canonical: canonicalSlug(slug, aliases),
    legacy: isLegacySlug(slug, aliases),
  };
}

/** `<base>@<slug>`. Callers still check {@link MAX_SHELF_NAME_LENGTH}. Used by tests. */
export function projectShelfName(base, slug) {
  return `${base}@${slug}`;
}

/** True when a `<base>@<slug>` name would exceed what `nb` accepts. */
export function exceedsShelfNameLimit(name) {
  return name.length > MAX_SHELF_NAME_LENGTH;
}
