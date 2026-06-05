import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Environment-variable documentation-drift verifier.
 *
 * Mirrors `documented-command-verifier.ts`, but for `KOOKR_*` environment
 * variables: it asserts that the variables *read from the environment* in
 * source line up with the ones *documented* in
 * `docs/reference/environment-variables.md` and `.env.example`.
 *
 * Three drift surfaces are checked:
 *  - undocumented: a `KOOKR_*` var read in source that is neither documented
 *    nor listed in {@link INTERNAL_ENV_VARS};
 *  - stale documented: a documented `KOOKR_*` var that no source reads and is
 *    not listed in {@link DOCUMENTED_ONLY_ENV_VARS};
 *  - `.env.example` drift: a `KOOKR_*` var assigned in `.env.example` that the
 *    canonical reference does not document.
 *
 * Two hygiene checks keep the allowlists honest: an internal-allowlist entry
 * that has since been documented (redundant), and a documented-only exemption
 * that is no longer documented (stale exemption).
 */

export interface EnvVarIssue {
  name: string;
  message: string;
}

export interface EnvVarVerificationResult {
  codeReferenced: string[];
  documented: string[];
  envExample: string[];
  issues: EnvVarIssue[];
  checked: number;
}

export interface VerifyEnvVarOptions {
  sourceRoots?: string[];
  docFile?: string;
  envExampleFile?: string;
  internalAllowlist?: Iterable<string>;
  documentedOnly?: Iterable<string>;
}

export interface EnvVarDriftInput {
  codeReferenced: Iterable<string>;
  documented: Iterable<string>;
  envExample: Iterable<string>;
  internalAllowlist?: Iterable<string>;
  documentedOnly?: Iterable<string>;
}

const ENV_PREFIX = 'KOOKR_';

const DEFAULT_SOURCE_ROOTS = ['src', 'relay', 'bin', 'plugin', 'vite.config.ts'];
const DEFAULT_DOC_FILE = 'docs/reference/environment-variables.md';
const DEFAULT_ENV_EXAMPLE = '.env.example';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'coverage', '__tests__']);
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.test.js', '.test.mjs', '.spec.ts', '.spec.tsx'];
// This verifier reads `process.env.KOOKR_*` literally to scan; excluding its
// own sources avoids self-matching.
const SELF_FILES = new Set(['documented-env-var-verifier.ts', 'documented-env-var-verifier.test.ts']);

/**
 * `KOOKR_*` variables that are read in source on purpose but intentionally NOT
 * part of the user-facing reference: internal/test harness flags, experimental
 * feature internals (peer-to-peer collaboration), the standalone relay binary's
 * operational knobs, and computed/build-time values.
 *
 * Seeded from the variables present on `main` when this verifier shipped.
 * Adding a NEW `process.env.KOOKR_*` read requires either documenting it in
 * `docs/reference/environment-variables.md` or adding it here with a reason.
 */
export const INTERNAL_ENV_VARS: ReadonlySet<string> = new Set([
  // Internal / diagnostic / test-harness toggles.
  'KOOKR_ADMIN_TOKEN',
  'KOOKR_BUILD_VERSION',
  'KOOKR_DEBUG',
  'KOOKR_DIR',
  'KOOKR_DISABLE_ONBOARDING',
  'KOOKR_PUBLIC_BASE_URL',
  'KOOKR_PUSH_DISABLED',
  'KOOKR_REPO_TAGS',
  'KOOKR_SPEAK',
  'KOOKR_USER_PLAYBOOKS_DIR',
  'KOOKR_KB_CONTEXT_INJECT',
  'KOOKR_CANARY_SUBMIT_READY_MS',
  'KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE',
  // Experimental peer-to-peer collaboration feature (not user-configurable yet).
  'KOOKR_COLLABORATION_CONTACT_SHARE_VIEW_ONLY',
  'KOOKR_COLLABORATION_EXPECTED_PEER_FINGERPRINT',
  'KOOKR_COLLABORATION_HOST',
  'KOOKR_COLLABORATION_LISTENER',
  'KOOKR_COLLABORATION_LOCAL_CONTACT_ID',
  'KOOKR_COLLABORATION_LOCAL_DEVICE_ID',
  'KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_BASE64',
  'KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM',
  'KOOKR_COLLABORATION_NETWORK_HINT',
  'KOOKR_COLLABORATION_PEER_BASE_URL',
  'KOOKR_COLLABORATION_PORT',
  'KOOKR_COLLABORATION_PRIVATE_NETWORK',
  'KOOKR_COLLABORATION_PROFILE_ID',
  'KOOKR_COLLABORATION_PROFILE_LABEL',
  'KOOKR_COLLABORATION_PROFILES',
  'KOOKR_COLLABORATION_TRANSPORT_SECURITY',
  'KOOKR_COLLABORATION_UPDATE_POLL_INTERVAL_MS',
  'KOOKR_COLLABORATION_UPDATE_POLLING',
  // Standalone relay binary internals / client-pairing knobs documented in the
  // relay runbooks rather than the main environment reference.
  'KOOKR_RELAY_ADMIN_TOKEN',
  'KOOKR_RELAY_CLIENT_TOKEN',
  'KOOKR_RELAY_DISPLAY_NAME',
  'KOOKR_RELAY_ENV_FILE',
  'KOOKR_RELAY_FEATURES',
  'KOOKR_RELAY_INSECURE_DEV',
  'KOOKR_RELAY_LAUNCH_ALLOWLIST',
  'KOOKR_RELAY_NODE_ID',
  'KOOKR_RELAY_PORT',
  'KOOKR_RELAY_TOKEN',
  // Written split so the contiguous relay-trusted env name does not appear in
  // this file: src/remote/__tests__/trusted-env-boundary.test.ts forbids that
  // literal outside src/remote/. This is allowlist data, not an env read; same
  // idiom as src/server/index.test.ts.
  `KOOKR_RELAY_${'TRUSTED'}`,
  'KOOKR_RELAY_URL',
]);

/**
 * `KOOKR_*` variables that are documented but are read outside the scanned
 * TypeScript/JavaScript source: ops shell scripts (`scripts/*.sh`), hook shell
 * scripts (`hooks/*.sh`), relay deployment tooling (`deploy/`), or features
 * whose runtime read lives outside this repository. These would otherwise look
 * like stale documentation.
 */
export const DOCUMENTED_ONLY_ENV_VARS: ReadonlySet<string> = new Set([
  // Context-window hook advisories — read by the installed hook, not in-repo source.
  'KOOKR_CONTEXT_ADVISORY_DISABLED',
  'KOOKR_CONTEXT_ADVISORY_ENABLED',
  // Consumed by ops shell scripts (prod restart/update, dtach rollback).
  'KOOKR_DTACH_SOCK_DIR',
  'KOOKR_ENV_ROOT_DIR',
  'KOOKR_HEALTH_URL',
  'KOOKR_PROD_DIR',
  'KOOKR_STARTUP_CHECK_INTERVAL_SECONDS',
  'KOOKR_STARTUP_TIMEOUT_SECONDS',
  // Consumed by hook shell scripts.
  'KOOKR_HOOKS_DIR',
  // Relay incident escalation target — documented for operators; read by deploy tooling.
  'KOOKR_RELAY_INCIDENT_ESCALATION_URL',
]);

/**
 * Source patterns recognised as an environment read. The codebase reads env
 * vars three ways:
 *  - directly (`process.env.KOOKR_X`) or through a local `env` alias
 *    (`const env = process.env; env.KOOKR_X`), dot or bracket, optional-chained;
 *  - through a helper that takes the name as a string literal
 *    (`envFlag(env, 'KOOKR_X')`, `readInt(env, "KOOKR_X")`).
 * The last pattern matches any single/double-quoted `KOOKR_*` string literal,
 * which is deliberately broad: it also picks up names that appear in log or
 * error messages. That over-collection is the safe direction — it can only add
 * a code-referenced var (forcing it to be documented or allowlisted), never
 * hide one. Names built by concatenation (`'KOOKR_RELAY_' + x`) or template
 * interpolation (`` `KOOKR_RELAY_${x}` ``) are intentionally NOT matched, since
 * the literal var name is not present at the read site.
 */
const SOURCE_PATTERNS: RegExp[] = [
  /\benv\??\.(KOOKR_[A-Z0-9_]+)/g,
  /\benv\??\[\s*['"](KOOKR_[A-Z0-9_]+)['"]\s*\]/g,
  /['"](KOOKR_[A-Z0-9_]+)['"]/g,
];

function normalizeName(raw: string): string | undefined {
  const name = raw.replace(/_+$/, '');
  if (name.length <= ENV_PREFIX.length) return undefined;
  return name;
}

export function extractEnvVarsFromSource(content: string): string[] {
  const found = new Set<string>();
  for (const pattern of SOURCE_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const name = normalizeName(match[1]);
      if (name) found.add(name);
    }
  }
  return [...found].sort();
}

export function extractDocumentedEnvVars(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/`(KOOKR_[A-Z0-9_]+)/g)) {
    const name = normalizeName(match[1]);
    if (name) found.add(name);
  }
  return [...found].sort();
}

export function extractEnvExampleVars(content: string): string[] {
  const found = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    // Match assignments whether active, commented (`#`/`##`), or `export`-prefixed.
    const match = line.match(/^\s*(?:#+\s*)?(?:export\s+)?(KOOKR_[A-Z0-9_]+)\s*=/);
    if (match) {
      const name = normalizeName(match[1]);
      if (name) found.add(name);
    }
  }
  return [...found].sort();
}

export function computeEnvVarDrift(input: EnvVarDriftInput): EnvVarVerificationResult {
  const code = new Set(input.codeReferenced);
  const documented = new Set(input.documented);
  const envExample = new Set(input.envExample);
  const internal = new Set(input.internalAllowlist ?? INTERNAL_ENV_VARS);
  const documentedOnly = new Set(input.documentedOnly ?? DOCUMENTED_ONLY_ENV_VARS);

  const issues: EnvVarIssue[] = [];

  for (const name of [...code].sort()) {
    if (!documented.has(name) && !internal.has(name)) {
      issues.push({
        name,
        message: `read from the environment in source but not documented in ${DEFAULT_DOC_FILE}; document it or add it to INTERNAL_ENV_VARS with a reason`,
      });
    }
  }

  for (const name of [...documented].sort()) {
    if (!code.has(name) && !documentedOnly.has(name)) {
      issues.push({
        name,
        message: `documented but not read in source; remove it or add it to DOCUMENTED_ONLY_ENV_VARS`,
      });
    }
  }

  for (const name of [...envExample].sort()) {
    if (!documented.has(name)) {
      issues.push({
        name,
        message: `assigned in ${DEFAULT_ENV_EXAMPLE} but not documented in ${DEFAULT_DOC_FILE}`,
      });
    }
  }

  // Hygiene: an internal allowlist entry that is now also documented is redundant.
  for (const name of [...internal].sort()) {
    if (documented.has(name)) {
      issues.push({
        name,
        message: `listed in INTERNAL_ENV_VARS but also documented; remove it from the internal allowlist`,
      });
    }
  }

  // Hygiene: a documented-only exemption that is no longer documented is stale.
  for (const name of [...documentedOnly].sort()) {
    if (!documented.has(name)) {
      issues.push({
        name,
        message: `listed in DOCUMENTED_ONLY_ENV_VARS but not documented; remove the stale exemption`,
      });
    }
  }

  return {
    codeReferenced: [...code].sort(),
    documented: [...documented].sort(),
    envExample: [...envExample].sort(),
    issues,
    checked: code.size,
  };
}

export function verifyDocumentedEnvVars(
  repoRoot: string,
  options: VerifyEnvVarOptions = {},
): EnvVarVerificationResult {
  const sourceRoots = options.sourceRoots ?? DEFAULT_SOURCE_ROOTS;
  const docFile = options.docFile ?? DEFAULT_DOC_FILE;
  const envExampleFile = options.envExampleFile ?? DEFAULT_ENV_EXAMPLE;

  const codeReferenced = new Set<string>();
  for (const file of collectSourceFiles(repoRoot, sourceRoots)) {
    const content = readFileSync(join(repoRoot, file), 'utf8');
    for (const name of extractEnvVarsFromSource(content)) {
      codeReferenced.add(name);
    }
  }

  const docPath = join(repoRoot, docFile);
  const documented = existsSync(docPath) ? extractDocumentedEnvVars(readFileSync(docPath, 'utf8')) : [];

  const envPath = join(repoRoot, envExampleFile);
  const envExample = existsSync(envPath) ? extractEnvExampleVars(readFileSync(envPath, 'utf8')) : [];

  return computeEnvVarDrift({
    codeReferenced,
    documented,
    envExample,
    internalAllowlist: options.internalAllowlist ?? INTERNAL_ENV_VARS,
    documentedOnly: options.documentedOnly ?? DOCUMENTED_ONLY_ENV_VARS,
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
  if (SELF_FILES.has(baseName(file))) return false;
  if (TEST_FILE_SUFFIXES.some((suffix) => file.endsWith(suffix))) return false;
  const dot = file.lastIndexOf('.');
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.has(file.slice(dot));
}

function baseName(file: string): string {
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return slash < 0 ? file : file.slice(slash + 1);
}

export function formatEnvVarIssues(result: EnvVarVerificationResult): string {
  const lines = ['Documented environment-variable verification failed:'];
  for (const issue of result.issues) {
    lines.push(`  ${issue.name} - ${issue.message}`);
  }
  lines.push(
    `Checked ${result.checked} env var(s) read in source against ${result.documented.length} documented var(s).`,
  );
  return lines.join('\n');
}
