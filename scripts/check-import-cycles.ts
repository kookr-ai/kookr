import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Locks in the codebase's zero-import-cycle property (kookr#1829). A CI gate
// here is the cheapest way to stop AI-induced drift from silently
// reintroducing a circular runtime dependency — the single healthiest
// structural signal in the graph.
//
// Why a native detector instead of `madge --circular` (the issue's suggested
// tool): the repo already ships two hand-rolled boundary checkers
// (check-remote-import-boundaries.ts, check-architecture-boundaries.ts) wired
// through vitest, and deliberately keeps its dependency surface small (see the
// dependency-review workflow). A ~120-line native Tarjan pass matches that
// convention exactly, adds zero dependencies, and runs in <200ms over the
// whole graph.
//
// The gate models the STATIC MODULE-LOAD graph — the edges evaluated eagerly
// when a module is loaded, which are the only ones that can cause load-order
// fragility:
//
//   * static imports          `import … from './x.js'`
//   * side-effect imports     `import './x.js'`
//   * static re-exports       `export … from './x.js'`
//
// Two edge kinds are deliberately excluded:
//
//   * Type-only imports/exports (`import type`, `export type`) — erased by the
//     compiler, so they can never form a runtime cycle. This matches the
//     baseline the architecture audit measured (madge + Tarjan both reported
//     zero): two files today form a type-only back-edge (monitor ↔
//     monitor-agent-state, schedule ↔ schedule-rollup) that is intentional.
//
//   * Dynamic `import()` and `require()` — these load lazily/deferred, so a
//     static a→b plus a dynamic b→a is NOT a load-order cycle. Dynamic import
//     is in fact the standard mechanism for BREAKING a static cycle (see the
//     sanctioned dynamic import in src/server/index.ts that crosses the remote
//     runtime boundary); counting it would flag the intentional break. It also
//     avoids a false-positive class: TypeScript type-position dynamic imports
//     (`x: import('./y.js').T`) and JSDoc `{@link import('./y.js')}` are
//     type-only but syntactically identical to a runtime `import()`.

const DEFAULT_ROOTS = ['src'];

// Directories/files that are leaves of the production graph, excluded so the
// gate stays focused on shippable runtime code: test/spec files, their
// fixtures, and build output.
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '__tests__', '__fixtures__']);
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;
const SOURCE_FILE_RE = /\.(ts|tsx)$/;

export interface ImportCycle {
  /** Files forming the cycle, in repo-relative form, closed back to the first. */
  files: string[];
}

export interface ImportCyclesResult {
  root: string;
  fileCount: number;
  edgeCount: number;
  cycles: ImportCycle[];
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });

  const files: string[] = [];
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(path));
    } else if (SOURCE_FILE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

// The two static load-time forms. Both anchor `import`/`export` at line start
// (after leading whitespace) so a `//`-commented statement — whose `//` breaks
// the anchor — is never mistaken for a real edge. `[^'";]*?` spans newlines, so
// multi-line `import { … } from '…'` is captured. `import()` / `require()` are
// intentionally NOT matched (see the header: deferred, and syntactically shared
// with type-position dynamic imports).
const STATIC_IMPORT_RE = /(?:^|\n)\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const REEXPORT_RE = /(?:^|\n)\s*export\s+(?:\*(?:\s+as\s+[A-Za-z0-9_$]+)?|\{[^}]*\}|[A-Za-z0-9_$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+['"]([^'"]+)['"]/g;

// Type-only statements (`import type …`, `export type …`) are erased at runtime.
// Dropping whole lines that START with them keeps the inline mixed form
// (`import { X, type Y } from …`, a real runtime edge via X) intact. A multi-line
// `import type { … } from '…'` leaves no residual line matching an `import … from`
// shape, so the whole statement is removed.
const TYPE_ONLY_STATEMENT_RE = /^\s*(?:import|export)\s+type\b/;

/** Extract every static (load-time) relative module specifier in `source`. */
export function runtimeSpecifiers(source: string): string[] {
  const loadTime = source
    .split('\n')
    .filter((line) => !TYPE_ONLY_STATEMENT_RE.test(line))
    .join('\n');

  const specs: string[] = [];
  for (const re of [STATIC_IMPORT_RE, REEXPORT_RE]) {
    re.lastIndex = 0;
    for (const match of loadTime.matchAll(re)) {
      if (match[1].startsWith('.')) specs.push(match[1]);
    }
  }
  return specs;
}

/**
 * Resolve a relative specifier to a file in `fileSet`, mirroring NodeNext:
 * `.js`/`.jsx`/`.mjs`/`.cjs` specifiers map onto their `.ts`/`.tsx` sources,
 * and extensionless directory specifiers fall back to `index.ts`/`.tsx`.
 * Returns null for anything outside the set (bare packages, `.css`, `.json`).
 */
function resolveSpecifier(specifier: string, fromFile: string, fileSet: Set<string>): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const noExt = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  const candidates = [
    `${noExt}.ts`, `${noExt}.tsx`,
    `${base}.ts`, `${base}.tsx`,
    join(noExt, 'index.ts'), join(noExt, 'index.tsx'),
    join(base, 'index.ts'), join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

export interface ImportGraph {
  files: string[];
  adjacency: Map<string, Set<string>>;
  edgeCount: number;
}

/** Build the static load-time import graph over `files` (absolute paths). */
export async function buildImportGraph(files: string[]): Promise<ImportGraph> {
  const fileSet = new Set(files);
  const adjacency = new Map<string, Set<string>>();
  for (const file of files) adjacency.set(file, new Set());

  let edgeCount = 0;
  await Promise.all(files.map(async (file) => {
    const source = await readFile(file, 'utf8');
    const neighbours = adjacency.get(file)!;
    for (const specifier of runtimeSpecifiers(source)) {
      const target = resolveSpecifier(specifier, file, fileSet);
      if (target && target !== file && !neighbours.has(target)) {
        neighbours.add(target);
        edgeCount++;
      }
    }
  }));

  return { files, adjacency, edgeCount };
}

/**
 * Strongly-connected components with more than one member (i.e. cycles), found
 * via an iterative Tarjan pass (iterative so a deep import chain cannot blow
 * the call stack). A self-import counts as a cycle too.
 */
export function findCycles(graph: ImportGraph): string[][] {
  const { adjacency } = graph;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  for (const start of adjacency.keys()) {
    if (index.has(start)) continue;

    // Each work frame is [node, nextSuccessorIndex].
    const work: Array<[string, number]> = [[start, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const node = frame[0];

      if (frame[1] === 0) {
        index.set(node, counter);
        lowlink.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
      }

      const successors = [...adjacency.get(node)!];
      if (frame[1] < successors.length) {
        const next = successors[frame[1]];
        frame[1]++;
        if (!index.has(next)) {
          work.push([next, 0]);
        } else if (onStack.has(next)) {
          lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!));
        }
        continue;
      }

      // All successors processed — close out the node.
      if (lowlink.get(node) === index.get(node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== node);
        const selfLoop = component.length === 1 && adjacency.get(node)!.has(node);
        if (component.length > 1 || selfLoop) cycles.push(component);
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowlink.set(parent[0], Math.min(lowlink.get(parent[0])!, lowlink.get(node)!));
      }
    }
  }

  return cycles;
}

export async function checkImportCycles(
  root: string = process.cwd(),
  roots: string[] = DEFAULT_ROOTS,
): Promise<ImportCyclesResult> {
  const resolvedRoot = resolve(root);
  const files = (await Promise.all(
    roots.map((sourceRoot) => listSourceFiles(join(resolvedRoot, sourceRoot))),
  )).flat().map((file) => resolve(file)).sort();

  const graph = await buildImportGraph(files);
  const cycles = findCycles(graph).map((component) => ({
    files: [...component, component[0]].map((file) => relative(resolvedRoot, file)),
  }));

  return {
    root: resolvedRoot,
    fileCount: files.length,
    edgeCount: graph.edgeCount,
    cycles,
  };
}

async function main(): Promise<void> {
  const result = await checkImportCycles();

  if (result.cycles.length > 0) {
    console.error(`Import cycle check FAILED — ${result.cycles.length} circular dependency chain(s) found:`);
    for (const cycle of result.cycles) {
      console.error(`  ${cycle.files.join(' -> ')}`);
    }
    console.error('\nRuntime import cycles couple modules and cause load-order fragility.');
    console.error('Break the cycle by extracting shared code, or make the back-edge `import type` if it is type-only.');
    process.exit(1);
  }

  console.log(`Import cycle check passed (${result.fileCount} files, ${result.edgeCount} load-time edges, 0 cycles).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
