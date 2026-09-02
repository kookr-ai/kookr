import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Route-mount parity verifier.
 *
 * Asserts that every exported Hono route registrar (a `register*Routes`
 * function declared under `src/server`) is actually mounted — i.e. imported
 * into and invoked from the mount module `src/server/routes.ts` — or listed in
 * {@link UNMOUNTED_REGISTRARS} with a reason.
 *
 * Motivation (issue #2815): the sibling `documented-api-route-verifier.ts`
 * proves each registered route is *documented*, but a registrar that is
 * exported yet never wired into `createRoutes` still passes that gate and ships
 * as a silent 404. This verifier closes that gap.
 *
 * Robustness over a name-only heuristic: a registrar is judged "mounted" only
 * when the mount module both imports its identifier (as a named import, alias
 * resolved back to the export) AND contains a call expression for the local
 * binding (comments are stripped before scanning). Matching a bare occurrence of
 * the module filename — or of the registrar name anywhere in the file — is
 * deliberately avoided, so a stale import or a mention in prose cannot mask an
 * actually-unmounted registrar.
 *
 * Known idiom limits (shared with `documented-api-route-verifier.ts`): mount
 * detection reads named imports (`import { x }`, `import Default, { x }`), not
 * namespace imports (`import * as r; r.registerFooRoutes(...)`); and comment
 * stripping is textual, so a `//` or `/* *\/` sequence *inside a string or regex
 * literal* in the mount module can confuse it. `src/server/routes.ts` uses
 * neither today. If a future refactor adopts one, mount it and add the registrar
 * to {@link UNMOUNTED_REGISTRARS} with a reason rather than fighting a spurious
 * red — the allowlist is the escape hatch for idioms the scanner can't resolve.
 */

const DEFAULT_SOURCE_ROOTS = ['src/server'];
const DEFAULT_MOUNT_MODULE = 'src/server/routes.ts';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'coverage', '__tests__']);
const TEST_FILE_SUFFIXES = [
  '.test.ts',
  '.test.tsx',
  '.test.js',
  '.test.mjs',
  '.spec.ts',
  '.spec.tsx',
];

/** Registrar identifiers must look like `registerXxxRoutes`. */
const REGISTRAR_NAME = /^register[A-Za-z0-9]*Routes$/;

/**
 * Route registrars that are intentionally NOT mounted in
 * `src/server/routes.ts`. Keys are the exported function identifiers; values are
 * the reason they are exempt (conditional wiring elsewhere, a separate bind, or
 * a fixture/experimental surface not reachable through the main app).
 *
 * Empty at introduction (issue #2815): every current `register*Routes` export is
 * mounted in `createRoutes`. Adding a NEW registrar that is deliberately left
 * unmounted requires an entry here with a reason; prefer mounting it.
 */
export const UNMOUNTED_REGISTRARS: ReadonlyMap<string, string> = new Map<string, string>([]);

export interface RegistrarRef {
  /** Exported identifier, e.g. `registerAdminRoutes`. */
  name: string;
  /** Repo-relative source file the registrar is declared in. */
  file: string;
}

export interface RouteMountIssue {
  registrar: string;
  message: string;
}

export interface RouteMountVerificationResult {
  /** All discovered exported registrar identifiers, sorted. */
  registrars: string[];
  /** Registrars mounted in the mount module, sorted. */
  mounted: string[];
  issues: RouteMountIssue[];
  checked: number;
}

export interface VerifyRouteMountOptions {
  sourceRoots?: string[];
  mountModule?: string;
  unmountedAllowlist?: ReadonlyMap<string, string>;
}

export interface RouteMountDriftInput {
  registrars: Iterable<RegistrarRef>;
  mounted: Iterable<string>;
  unmountedAllowlist?: ReadonlyMap<string, string>;
}

/**
 * Strip line (`// ...`) and block (`/* ... *\/`) comments so a registrar
 * name mentioned only in a comment cannot be mistaken for a real mount, and a
 * registrar declaration inside a comment cannot be mistaken for a real export.
 */
export function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Find exported route registrars declared in a single source file.
 * Supports `export function registerFooRoutes(...)`,
 * `export async function registerFooRoutes(...)`, and
 * `export const registerFooRoutes = (...) => ...`.
 */
export function extractExportedRegistrars(content: string, file: string): RegistrarRef[] {
  const source = stripComments(content);
  const refs: RegistrarRef[] = [];
  const seen = new Set<string>();
  const patterns = [
    /export\s+(?:async\s+)?function\s+(register[A-Za-z0-9]*Routes)\b/g,
    /export\s+const\s+(register[A-Za-z0-9]*Routes)\s*=/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (!REGISTRAR_NAME.test(name) || seen.has(name)) continue;
      seen.add(name);
      refs.push({ name, file });
    }
  }
  return refs;
}

/**
 * Named imports of the mount module, as a map from the local binding (what a
 * call site references) to the original exported name. For `import { a, b as c }`
 * the map is `{ a: 'a', c: 'b' }`. Keeping the original name lets a registrar
 * mounted under an alias still resolve back to its exported identifier.
 */
export function extractImportedNames(content: string): Map<string, string> {
  const source = stripComments(content);
  const bindings = new Map<string, string>();
  // Allows an optional default binding before the braces (`import D, { x }`).
  const importBlock =
    /import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;
  for (const match of source.matchAll(importBlock)) {
    for (const raw of match[1].split(',')) {
      const part = raw.trim().replace(/^type\s+/, '').trim();
      if (!part) continue;
      // `original as local` → local binding aliased to original; else both equal.
      const asMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (asMatch) {
        bindings.set(asMatch[2], asMatch[1]);
      } else if (/^[A-Za-z_$][\w$]*$/.test(part)) {
        bindings.set(part, part);
      }
    }
  }
  return bindings;
}

/** Identifiers that appear as call expressions (`name(`) in the mount module. */
export function extractCalledNames(content: string): Set<string> {
  const source = stripComments(content);
  const names = new Set<string>();
  const call = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of source.matchAll(call)) {
    names.add(match[1]);
  }
  return names;
}

/**
 * A registrar is mounted when the mount module both imports its identifier and
 * invokes it. Requiring the import binds the call to a real symbol (not a
 * same-named local), and requiring the call rules out an unused/stale import.
 */
export function extractMountedRegistrars(mountModuleContent: string): Set<string> {
  const imported = extractImportedNames(mountModuleContent);
  const called = extractCalledNames(mountModuleContent);
  const mounted = new Set<string>();
  for (const [local, original] of imported) {
    // Match on the exported name (so an aliased mount still resolves back to it)
    // but require the local binding to be the one actually invoked.
    if (REGISTRAR_NAME.test(original) && called.has(local)) mounted.add(original);
  }
  return mounted;
}

export function computeRouteMountDrift(
  input: RouteMountDriftInput,
): RouteMountVerificationResult {
  const registrars = [...input.registrars];
  const registrarNames = new Set(registrars.map((r) => r.name));
  const mounted = new Set(input.mounted);
  const allowlist = input.unmountedAllowlist ?? UNMOUNTED_REGISTRARS;

  const issues: RouteMountIssue[] = [];

  for (const { name, file } of [...registrars].sort((a, b) => a.name.localeCompare(b.name))) {
    if (mounted.has(name)) continue;
    if (allowlist.has(name)) continue;
    issues.push({
      registrar: name,
      message: `exported in ${file} but not mounted in the app; mount it in the route module or add it to UNMOUNTED_REGISTRARS with a reason`,
    });
  }

  // Hygiene: an allowlisted registrar that is in fact mounted is a stale
  // exemption; one that no longer exists as an export is a dangling entry.
  for (const name of [...allowlist.keys()].sort()) {
    if (mounted.has(name)) {
      issues.push({
        registrar: name,
        message: `listed in UNMOUNTED_REGISTRARS but is actually mounted; remove it from the allowlist`,
      });
    } else if (!registrarNames.has(name)) {
      issues.push({
        registrar: name,
        message: `listed in UNMOUNTED_REGISTRARS but no matching registrar export exists; remove the stale allowlist entry`,
      });
    }
  }

  return {
    registrars: [...registrarNames].sort(),
    mounted: [...mounted].sort(),
    issues,
    checked: registrarNames.size,
  };
}

export function verifyRouteMounts(
  repoRoot: string,
  options: VerifyRouteMountOptions = {},
): RouteMountVerificationResult {
  const sourceRoots = options.sourceRoots ?? DEFAULT_SOURCE_ROOTS;
  const mountModule = options.mountModule ?? DEFAULT_MOUNT_MODULE;

  const files = collectSourceFiles(repoRoot, sourceRoots);
  const registrars: RegistrarRef[] = [];
  for (const file of files) {
    const content = readFileSync(join(repoRoot, file), 'utf8');
    registrars.push(...extractExportedRegistrars(content, file));
  }

  const mountPath = join(repoRoot, mountModule);
  const mounted = existsSync(mountPath)
    ? extractMountedRegistrars(readFileSync(mountPath, 'utf8'))
    : new Set<string>();

  return computeRouteMountDrift({
    registrars,
    mounted,
    unmountedAllowlist: options.unmountedAllowlist ?? UNMOUNTED_REGISTRARS,
  });
}

function collectSourceFiles(repoRoot: string, roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const absoluteRoot = join(repoRoot, root);
    if (!existsSync(absoluteRoot)) continue;
    if (statSync(absoluteRoot).isFile()) {
      if (isSourceFile(root)) files.push(root);
      continue;
    }
    collectSourceFilesInDir(repoRoot, root, files);
  }
  return files.sort();
}

function collectSourceFilesInDir(repoRoot: string, dir: string, files: string[]): void {
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collectSourceFilesInDir(repoRoot, join(dir, entry.name), files);
    } else if (entry.isFile()) {
      const file = join(dir, entry.name);
      if (isSourceFile(file)) files.push(file);
    }
  }
}

function isSourceFile(file: string): boolean {
  if (TEST_FILE_SUFFIXES.some((suffix) => file.endsWith(suffix))) return false;
  const dot = file.lastIndexOf('.');
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.has(file.slice(dot));
}
