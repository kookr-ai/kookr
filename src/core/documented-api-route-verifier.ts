import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * HTTP route documentation-drift verifier.
 *
 * Asserts that every registered `/api/*` route (parsed from Hono
 * `app.get|post|put|patch|delete(...)` call sites under `src/server`) is either
 * mentioned in `docs/reference/api.md` or listed in {@link INTERNAL_API_ROUTES}.
 *
 * Mirrors `documented-env-var-verifier.ts`: one-way "source must be documented
 * or allowlisted" gate, plus hygiene that flags allowlist entries once they
 * become documented. Stale docs (documented but not registered) are out of
 * scope — false positives on prose/examples are the main risk there.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiRouteRef {
  method: HttpMethod;
  path: string;
}

export interface ApiRouteIssue {
  route: string;
  message: string;
}

export interface ApiRouteVerificationResult {
  registered: string[];
  documented: string[];
  issues: ApiRouteIssue[];
  checked: number;
}

export interface VerifyApiRouteOptions {
  sourceRoots?: string[];
  docFile?: string;
  internalAllowlist?: Iterable<string>;
}

export interface ApiRouteDriftInput {
  registered: Iterable<string>;
  documented: Iterable<string>;
  internalAllowlist?: Iterable<string>;
}

const DEFAULT_SOURCE_ROOTS = ['src/server'];
const DEFAULT_DOC_FILE = 'docs/reference/api.md';

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
const SELF_FILES = new Set([
  'documented-api-route-verifier.ts',
  'documented-api-route-verifier.test.ts',
]);

const HTTP_METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Registered `/api/*` routes that are intentionally not part of the user-facing
 * catalogue in `docs/reference/api.md`.
 *
 * Seeded from the gap between registered Hono handlers and api.md when this
 * verifier shipped (issue #1769). Adding a NEW `/api/*` registration requires
 * either documenting it in `docs/reference/api.md` or adding it here with a
 * reason. Prefer documenting user-facing surfaces; keep this list for
 * experimental, peer-to-peer, diagnostics-internal, or dashboard-only knobs.
 *
 * Keys are `METHOD /path` with the path template as registered in source
 * (including `:param` names as written).
 */
export const INTERNAL_API_ROUTES: ReadonlySet<string> = new Set([
  // Auth session cookie exchange (#804) — operator/browser flow, not REST catalogue.
  'GET /api/auth/session',
  'POST /api/auth/session',

  // Readiness probe used by deploy/boot gates; not a product API surface.
  'GET /api/ready',

  // TTS sidecar health (paired with documented STT health when TTS is configured).
  'GET /api/health/tts',

  // Speech / speak-summary dashboard helpers.
  'GET /api/agents/:agentId/speak/preview',
  'POST /api/agents/:agentId/speak',
  'POST /api/tasks/:taskId/speak-summary',

  // File viewer endpoints for the dashboard.
  'GET /api/files/meta',
  'GET /api/files/raw',

  // Project sidebar ordering (dashboard-only).
  'GET /api/projects/sidebar',
  'PUT /api/projects/sidebar',

  // Task graph / relation mutations (dashboard + coordinator).
  'GET /api/task-relations',
  'POST /api/task-relations',
  'PATCH /api/tasks/:id/edges',
  'PATCH /api/tasks/:id/name',
  'GET /api/tasks/:id/evolution',

  // Ralph-loop control plane (legacy/removed generic entry points still registered).
  'POST /api/tasks/ralph-loop',
  'POST /api/tasks/:id/ralph-loop',
  'GET /api/tasks/:id/ralph-loop',
  'GET /api/tasks/:id/ralph-loop/iterations',
  'GET /api/tasks/:id/ralph-loop/iterations/export',
  'PATCH /api/tasks/:id/ralph-loop/burned-targets',
  'PATCH /api/tasks/:id/ralph-loop/prompt',
  'DELETE /api/tasks/:id/ralph-loop',
  'POST /api/tasks/:id/ralph-loop/complete',
  'POST /api/tasks/:id/ralph-loop/pause',
  'POST /api/tasks/:id/ralph-loop/resume',
  'POST /api/playbooks/ralph-loop',
  'POST /api/tasks/:taskId/ralph-loop/replace-with-new',

  // Coordinator suppressions / acknowledgements (dashboard workflow).
  'POST /api/coordinator/acknowledgements',
  'POST /api/coordinator/mark-prior-done',
  'POST /api/coordinator/suppressions',

  // Issue-claim exhaustion marker (internal to claim lifecycle).
  'POST /api/issue-claims/exhausted',

  // Schedule rollups (dashboard analytics).
  'GET /api/schedules/rollups',
  'GET /api/schedules/:id/rollup',

  // Cost comparison + outcome ledger (internal analytics).
  'GET /api/cost-comparison',
  'GET /api/outcome-ledger',

  // Live friction calibration (self-reflect / experimental).
  'GET /api/live-friction-calibration',

  // Extra diagnostics not yet in the human catalogue.
  'GET /api/diagnostics/auth-throttle',
  'GET /api/diagnostics/delivery-trace',
  'GET /api/diagnostics/hook-ingestion',
  'GET /api/diagnostics/request-latencies',
  'GET /api/diagnostics/speak-cache',

  // Finding-evidence review pipeline (internal QA surface).
  'GET /api/finding-evidence-audit',
  'GET /api/finding-evidence-operations-diagnostics',
  'GET /api/finding-evidence-review-detector-proposals',
  'GET /api/finding-evidence-review-log',
  'GET /api/finding-evidence-review-sampler',
  'POST /api/finding-evidence-review',

  // Deploy plugin install/update (ops; toolkit-refresh is documented).
  'POST /api/deploy/plugin-install',
  'POST /api/deploy/plugin-update',

  // Hosted / self-hosted relay connection management (runbook-documented elsewhere).
  'GET /api/relay-connection',
  'POST /api/relay-connection/connect',
  'POST /api/relay-connection/disconnect',
  'POST /api/relay-connection/hosted/pair',
  'POST /api/relay-connection/pair',
  'POST /api/relay-connection/rotate',
  'DELETE /api/relay-connection/credentials',

  // Session-sharing recovery actions.
  'GET /api/session-sharing/recovery',
  'POST /api/session-sharing/recovery/:action',

  // Owner share / viewer-grant management (#808); setup docs elsewhere.
  'GET /api/share/csrf-token',
  'GET /api/share/task',
  'POST /api/share/task',
  'POST /api/share/task/:invitationId/grant-requests/:requestId/:decision',
  'POST /api/share/task/:invitationId/revoke',
  'GET /api/share/viewers',
  'POST /api/share/viewers',
  'POST /api/share/viewers/:id/revoke',

  // Contact-share inbox (private-network collaboration product surface).
  'GET /api/contact-share/contacts',
  'POST /api/contact-share/contacts',
  'GET /api/contact-share/inbox',
  'GET /api/contact-share/shared-tasks',
  'POST /api/contact-share/shares',
  'POST /api/contact-share/inbox/:shareId/accept',
  'POST /api/contact-share/inbox/:shareId/decrypted-invite',
  'POST /api/contact-share/inbox/:shareId/refuse',

  // Collaboration listener peer endpoints (separate bind; not main catalogue).
  'GET /api/collaboration/health',
  'GET /api/collaboration/shared-task-updates',
  'POST /api/collaboration/contact-share/decisions',
  'POST /api/collaboration/contact-share/invites',
  'POST /api/collaboration/pairing/accept',
  'POST /api/collaboration/pairing/offers',
  'POST /api/collaboration/pairing/verify',
]);

export function formatRoute(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function parseRouteKey(key: string): ApiRouteRef | undefined {
  const match = key.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)$/);
  if (!match) return undefined;
  return { method: match[1] as HttpMethod, path: match[2] };
}

/**
 * Resolve local + exported path-string constants in one source file.
 * Only absolute path-looking string literals (`/...`) are kept.
 */
export function extractPathConstants(content: string): Map<string, string> {
  const constants = new Map<string, string>();
  const pattern =
    /(?:export\s+)?(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"](\/[^'"]*)['"]/g;
  for (const match of content.matchAll(pattern)) {
    constants.set(match[1], match[2]);
  }
  return constants;
}

/**
 * Extract registered `/api/*` routes from a single TypeScript source string.
 *
 * Supported registration idioms:
 *  - `app.get('/api/foo', ...)`
 *  - `app.post("/api/foo", ...)`
 *  - `app.get(PATH_CONST, ...)` when PATH_CONST is a same-file or provided constant
 *  - `app.post(\`${PATH_CONST}/suffix\`, ...)` same-file/provided constant base
 *
 * Dynamic paths (`app.get(someFn())`, multi-part templates) are intentionally
 * not resolved — prefer documenting or allowlisting those by hand if they appear.
 */
export function extractRegisteredApiRoutes(
  content: string,
  pathConstants: ReadonlyMap<string, string> = extractPathConstants(content),
): string[] {
  const found = new Set<string>();
  const callPattern = /\bapp\.(get|post|put|patch|delete)\(\s*/g;

  for (const match of content.matchAll(callPattern)) {
    const method = match[1].toUpperCase() as HttpMethod;
    if (!HTTP_METHODS.has(method)) continue;
    const rest = content.slice(match.index! + match[0].length);

    const stringLit = rest.match(/^(['"])(\/[^'"]*)\1/);
    if (stringLit) {
      maybeAddRoute(found, method, stringLit[2]);
      continue;
    }

    const templateConst = rest.match(/^`\$\{([A-Za-z_][A-Za-z0-9_]*)\}([^`]*)`/);
    if (templateConst) {
      const base = pathConstants.get(templateConst[1]);
      if (base) maybeAddRoute(found, method, `${base}${templateConst[2]}`);
      continue;
    }

    const bareConst = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/);
    if (bareConst) {
      const base = pathConstants.get(bareConst[1]);
      if (base) maybeAddRoute(found, method, base);
    }
  }

  return [...found].sort();
}

function maybeAddRoute(found: Set<string>, method: HttpMethod, path: string): void {
  if (!path.startsWith('/api/')) return;
  // Ignore middleware-style wildcards (`/api/*`) — not concrete handlers.
  if (path.includes('*')) return;
  found.add(formatRoute(method, path));
}

/**
 * Collect `METHOD /api/...` mentions from api.md (tables, headings, prose).
 * Query strings are stripped so `GET /api/tasks?view=compact` counts as
 * documenting `GET /api/tasks`.
 */
export function extractDocumentedApiRoutes(markdown: string): string[] {
  const found = new Set<string>();
  const pattern = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s`"'<>?]+)/g;
  for (const match of markdown.matchAll(pattern)) {
    const method = match[1].toUpperCase();
    const path = match[2].replace(/[.,);:]+$/, '');
    if (path.startsWith('/api/')) {
      found.add(formatRoute(method, path));
    }
  }
  return [...found].sort();
}

export function computeApiRouteDrift(input: ApiRouteDriftInput): ApiRouteVerificationResult {
  const registered = new Set(input.registered);
  const documented = new Set(input.documented);
  const internal = new Set(input.internalAllowlist ?? INTERNAL_API_ROUTES);

  const issues: ApiRouteIssue[] = [];

  for (const route of [...registered].sort()) {
    if (!documented.has(route) && !internal.has(route)) {
      issues.push({
        route,
        message: `registered in source but not documented in ${DEFAULT_DOC_FILE}; document it or add it to INTERNAL_API_ROUTES with a reason`,
      });
    }
  }

  for (const route of [...internal].sort()) {
    if (documented.has(route)) {
      issues.push({
        route,
        message: `listed in INTERNAL_API_ROUTES but also documented; remove it from the internal allowlist`,
      });
    }
  }

  return {
    registered: [...registered].sort(),
    documented: [...documented].sort(),
    issues,
    checked: registered.size,
  };
}

export function verifyDocumentedApiRoutes(
  repoRoot: string,
  options: VerifyApiRouteOptions = {},
): ApiRouteVerificationResult {
  const sourceRoots = options.sourceRoots ?? DEFAULT_SOURCE_ROOTS;
  const docFile = options.docFile ?? DEFAULT_DOC_FILE;

  const files = collectSourceFiles(repoRoot, sourceRoots);
  const pathConstants = new Map<string, string>();
  const fileContents = new Map<string, string>();

  for (const file of files) {
    const content = readFileSync(join(repoRoot, file), 'utf8');
    fileContents.set(file, content);
    for (const [name, value] of extractPathConstants(content)) {
      // First definition wins; path constants are unique in practice.
      if (!pathConstants.has(name)) pathConstants.set(name, value);
    }
  }

  const registered = new Set<string>();
  for (const content of fileContents.values()) {
    for (const route of extractRegisteredApiRoutes(content, pathConstants)) {
      registered.add(route);
    }
  }

  const docPath = join(repoRoot, docFile);
  const documented = existsSync(docPath)
    ? extractDocumentedApiRoutes(readFileSync(docPath, 'utf8'))
    : [];

  return computeApiRouteDrift({
    registered,
    documented,
    internalAllowlist: options.internalAllowlist ?? INTERNAL_API_ROUTES,
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

export function formatApiRouteIssues(result: ApiRouteVerificationResult): string {
  const lines = ['Documented API-route verification failed:'];
  for (const issue of result.issues) {
    lines.push(`  ${issue.route} - ${issue.message}`);
  }
  lines.push(
    `Checked ${result.checked} registered /api/* route(s) against ${result.documented.length} documented route(s).`,
  );
  return lines.join('\n');
}
