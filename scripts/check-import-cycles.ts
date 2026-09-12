import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// TypeScript 7's package root is version-only; parsing uses these subpaths.
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

// Locks in the codebase's zero-import-cycle property (kookr#1829). A local gate
// here is the cheapest way to stop AI-induced drift from silently
// reintroducing a circular runtime dependency — the single healthiest
// structural signal in the graph.
//
// Why a native detector instead of `madge --circular` (the issue's suggested
// tool): the repo already ships two hand-rolled boundary checkers
// (check-remote-import-boundaries.ts, check-architecture-boundaries.ts) wired
// through vitest, and deliberately keeps its dependency surface small (see the
// dependency-review workflow). A ~120-line native Tarjan pass matches that
// convention without adding dependencies. One TypeScript parser session serves
// the whole graph, matching the remote import boundary checker.
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

/** Extract relative static declarations, ignoring examples in comments and strings. */
function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const specs: string[] = [];
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) {
      const phase = node.importClause?.phaseModifier;
      if (phase === ts.SyntaxKind.TypeKeyword || phase === ts.SyntaxKind.DeferKeyword) continue;
    } else if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) continue;
    } else {
      continue;
    }

    // Only declaration-level `type` removes an edge. Unmarked declarations
    // with inline `type` specifiers remain conservative load-time edges.
    const specifier = node.moduleSpecifier;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      specs.push(specifier.text);
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
export async function buildImportGraph(files: string[], root = process.cwd()): Promise<ImportGraph> {
  const fileSet = new Set(files);
  const adjacency = new Map<string, Set<string>>();
  for (const file of files) adjacency.set(file, new Set());
  if (files.length === 0) return { files, adjacency, edgeCount: 0 };

  let edgeCount = 0;
  // Open the batch once, including files outside a tsconfig (isolated fixtures
  // and TSX). Keep parser startup inside the cleanup boundary as well.
  const api = new API({ cwd: resolve(root) });
  try {
    const snapshot = api.updateSnapshot({ openFiles: files });
    try {
      for (const file of files) {
        const source = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
        if (!source) throw new Error(`TypeScript 7 API did not produce an AST for ${file}`);
        const neighbours = adjacency.get(file)!;
        for (const specifier of runtimeSpecifiers(source)) {
          const target = resolveSpecifier(specifier, file, fileSet);
          if (target && !neighbours.has(target)) {
            neighbours.add(target);
            edgeCount++;
          }
        }
      }
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }

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

  const graph = await buildImportGraph(files, resolvedRoot);
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
