import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// TypeScript 7's stable package root (`import … from 'typescript'`) only exports
// version metadata. Parsing/AST helpers live under the unstable subpaths — using
// the root entry yields `TypeError: Cannot read properties of undefined
// (reading 'Latest')` when code touches `ts.ScriptTarget` / `createSourceFile`.
// See https://github.com/kookr-ai/kookr/issues/1438.
import * as ts from 'typescript/unstable/ast';
import { API, type Snapshot } from 'typescript/unstable/sync';

const SOURCE_ROOTS = ['src/server', 'src/core', 'src/adapters', 'src/frontend'];
const ALLOWED_DYNAMIC_IMPORT_FILES = [
  'src/server/index.ts',
  'src/server/remote-relay-runtime.ts',
];

export interface RemoteImportBoundaryViolation {
  file: string;
  line: number;
  message: string;
}

export interface RemoteImportBoundaryResult {
  root: string;
  fileCount: number;
  violations: RemoteImportBoundaryViolation[];
}

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function isRemoteImport(specifier: string, file: string, root: string): boolean {
  if (specifier === 'src/remote' || specifier.startsWith('src/remote/')) return true;
  if (!specifier.startsWith('.')) return false;
  const target = resolve(file, '..', specifier);
  const remoteRoot = join(root, 'src/remote');
  return target === remoteRoot || target.startsWith(`${remoteRoot}/`);
}

function lineOf(source: ts.SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}

function isStringLiteralLike(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function requireSourceFile(snapshot: Snapshot, file: string): ts.SourceFile {
  const project = snapshot.getDefaultProjectForFile(file);
  if (!project) {
    throw new Error(
      `TypeScript 7 API could not assign a project for ${file}. `
      + `Import boundary checks must use typescript/unstable/* — the package root export is version-only and cannot parse sources.`,
    );
  }
  const source = project.program.getSourceFile(file);
  if (!source) {
    throw new Error(
      `TypeScript 7 API did not produce an AST for ${file}. `
      + `This usually means the checker resolved the version-only 'typescript' package root instead of typescript/unstable/sync.`,
    );
  }
  return source;
}

function checkFile(
  file: string,
  root: string,
  allowedDynamicImportFiles: Set<string>,
  source: ts.SourceFile,
): RemoteImportBoundaryViolation[] {
  const violations: RemoteImportBoundaryViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const isTypeOnly = node.importClause?.isTypeOnly === true;
      if (!isTypeOnly && isRemoteImport(specifier, file, root)) {
        violations.push({
          file,
          line: lineOf(source, node.getStart(source)),
          message: `runtime import from ${specifier}`,
        });
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const isTypeOnly = node.isTypeOnly === true;
      if (!isTypeOnly && isRemoteImport(specifier, file, root)) {
        violations.push({
          file,
          line: lineOf(source, node.getStart(source)),
          message: `runtime export from ${specifier}`,
        });
      }
    }

    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && isStringLiteralLike(node.arguments[0])
      && isRemoteImport(node.arguments[0].text, file, root)
      && !allowedDynamicImportFiles.has(file)
    ) {
      violations.push({
        file,
        line: lineOf(source, node.getStart(source)),
        message: `dynamic import from ${node.arguments[0].text} outside src/server/index.ts`,
      });
    }

    node.forEachChild(visit);
  };

  visit(source);
  return violations;
}

export async function checkRemoteImportBoundaries(root = process.cwd()): Promise<RemoteImportBoundaryResult> {
  const resolvedRoot = resolve(root);
  const allowedDynamicImportFiles = new Set(
    ALLOWED_DYNAMIC_IMPORT_FILES.map((file) => join(resolvedRoot, file)),
  );
  // Always hand absolute paths to the TypeScript 7 API — relative DocumentIdentifiers
  // can fail to map onto a project under isolated fixture roots (CI temp dirs).
  const files = (await Promise.all(
    SOURCE_ROOTS.map((sourceRoot) => listTypeScriptFiles(join(resolvedRoot, sourceRoot))),
  )).flat().map((file) => resolve(file));

  if (files.length === 0) {
    return { root: resolvedRoot, fileCount: 0, violations: [] };
  }

  const api = new API({ cwd: resolvedRoot });
  const snapshot = api.updateSnapshot({ openFiles: files });
  try {
    const violations = files.flatMap((file) => {
      const source = requireSourceFile(snapshot, file);
      return checkFile(file, resolvedRoot, allowedDynamicImportFiles, source);
    });

    return {
      root: resolvedRoot,
      fileCount: files.length,
      violations,
    };
  } finally {
    snapshot.dispose();
    api.close();
  }
}

async function main(): Promise<void> {
  const result = await checkRemoteImportBoundaries();

  if (result.violations.length > 0) {
    console.error('Remote import boundary violations:');
    for (const v of result.violations) {
      console.error(`  ${relative(result.root, v.file)}:${v.line} ${v.message}`);
    }
    process.exit(1);
  }

  console.log(`Remote import boundary check passed (${result.fileCount} files).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
