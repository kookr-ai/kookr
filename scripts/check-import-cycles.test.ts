import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API, Snapshot } from 'typescript/unstable/sync';

import { checkImportCycles, findCycles } from './check-import-cycles';

const repoRoot = process.cwd();

async function withFixture(files: Record<string, string>, run: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'kookr-import-cycles-'));
  try {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, contents, 'utf8');
    }
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('import cycle gate', () => {
  it('reports zero cycles for the real src/ graph', async () => {
    const result = await checkImportCycles(repoRoot);
    expect(result.fileCount).toBeGreaterThan(0);
    // Guard against a vacuous pass: broken extraction (zero edges) would also
    // report zero cycles over a positive file count.
    expect(result.edgeCount).toBeGreaterThan(0);
    expect(result.cycles.map((c) => c.files.join(' -> '))).toEqual([]);
  }, 30_000);

  it('detects a direct two-file cycle', async () => {
    await withFixture(
      {
        'src/core/a.ts': "import { b } from './b.js';\nexport const a = () => b;\n",
        'src/core/b.ts': "import { a } from './a.js';\nexport const b = () => a;\n",
      },
      async (root) => {
        const result = await checkImportCycles(root);
        expect(result.cycles).toHaveLength(1);
        expect(result.cycles[0].files).toEqual(
          expect.arrayContaining(['src/core/a.ts', 'src/core/b.ts']),
        );
        // A cycle is reported closed back to its first member.
        const chain = result.cycles[0].files;
        expect(chain[0]).toBe(chain[chain.length - 1]);
      },
    );
  });

  it('detects a longer cycle spanning three files', async () => {
    await withFixture(
      {
        'src/core/a.ts': "import './b.js';\n",
        'src/core/b.ts': "import './c.js';\n",
        'src/core/c.ts': "import './a.js';\n",
      },
      async (root) => {
        const result = await checkImportCycles(root);
        expect(result.cycles).toHaveLength(1);
        expect(new Set(result.cycles[0].files)).toEqual(
          new Set(['src/core/a.ts', 'src/core/b.ts', 'src/core/c.ts']),
        );
      },
    );
  });

  it('detects a cycle through a mixed `import { X, type Y }` runtime edge', async () => {
    await withFixture(
      {
        // The `type Y` specifier is inline, but the statement is a runtime
        // import (X is a value), so a -> b is a real load-time edge.
        'src/core/a.ts': "import { B, type BT } from './b.js';\nexport const a = new B();\nexport type AT = BT;\n",
        'src/core/b.ts': "import { a } from './a.js';\nexport class B {}\nexport type BT = typeof a;\n",
      },
      async (root) => {
        const result = await checkImportCycles(root);
        expect(result.cycles).toHaveLength(1);
      },
    );
  });

  it('detects a cycle formed by multi-line runtime imports', async () => {
    await withFixture(
      {
        'src/core/a.ts': "import {\n  b,\n} from './b.js';\nexport const a = () => b;\n",
        'src/core/b.ts': "import {\n  a,\n} from './a.js';\nexport const b = () => a;\n",
      },
      async (root) => {
        const result = await checkImportCycles(root);
        expect(result.cycles).toHaveLength(1);
      },
    );
  });

  it('does not treat a dynamic import() back-edge as a load-time cycle', async () => {
    await withFixture(
      {
        // Static a -> b, dynamic b -> a. The dynamic import is deferred, so
        // there is no load-order cycle. This also guards the false-positive
        // class where a type-position `import('./a.js').T` looks like a runtime
        // dynamic import.
        'src/core/a.ts': "import { b } from './b.js';\nexport const a = () => b;\n",
        'src/core/b.ts': "export const b = async () => (await import('./a.js')).a;\nexport type AT = import('./a.js').A;\n",
      },
      async (root) => {
        const result = await checkImportCycles(root);
        expect(result.cycles).toEqual([]);
      },
    );
  });

  it('does not flag a type-only back-edge as a runtime cycle', async () => {
    await withFixture(
      {
        // Runtime edge a -> b, but b only imports a's type: no runtime cycle.
        'src/core/a.ts': "import { B } from './b.js';\nexport type A = { b: B };\nexport const a = new B();\n",
        'src/core/b.ts': "import type { A } from './a.js';\nexport class B { a?: A; }\n",
      },
      async (root) => {
        const result = await checkImportCycles(root);
        expect(result.cycles).toEqual([]);
      },
    );
  });

  it('ignores test files and __fixtures__ leaves', async () => {
    await withFixture(
      {
        'src/core/a.test.ts': "import './b.test.js';\n",
        'src/core/b.test.ts': "import './a.test.js';\n",
        'src/core/__fixtures__/x.ts': "import './y.js';\n",
        'src/core/__fixtures__/y.ts': "import './x.js';\n",
      },
      async (root) => {
        const result = await checkImportCycles(root);
        expect(result.fileCount).toBe(0);
        expect(result.cycles).toEqual([]);
      },
    );
  });

  it('resolves directory specifiers to index files', async () => {
    await withFixture(
      {
        'src/core/a.ts': "import './pkg/index.js';\n",
        'src/core/pkg/index.ts': "import '../a.js';\n",
      },
      async (root) => {
        const result = await checkImportCycles(root);
        expect(result.cycles).toHaveLength(1);
      },
    );
  });

  it('flags a self-import as a cycle', () => {
    // Construct the graph directly — findCycles must treat a self-edge as a cycle.
    const graph = {
      files: ['/x/self.ts'],
      adjacency: new Map([['/x/self.ts', new Set(['/x/self.ts'])]]),
      edgeCount: 1,
    };
    expect(findCycles(graph)).toEqual([['/x/self.ts']]);
  });

  it('detects a self-import through the public checker', async () => {
    await withFixture({ 'src/self.ts': "import './self.js';" }, async (root) => {
      const result = await checkImportCycles(root);
      expect(result.edgeCount).toBe(1);
      expect(result.cycles).toEqual([{ files: ['src/self.ts', 'src/self.ts'] }]);
    });
  });

  it.each([
    "// import './b.js';",
    "/*\nimport './b.js';\nexport * from './b.js';\n*/",
    "const example = `\nimport './b.js';\nexport * from './b.js';\n`;",
    "const example = `prefix ${1}\nimport './b.js';\n${`nested`}\nexport * from './b.js';\n`;",
    "const example = \"import './b.js';\";",
  ])('ignores import-looking text: %s', async (source) => {
    await withFixture({ 'src/a.ts': source, 'src/b.ts': '' }, async (root) => {
      const result = await checkImportCycles(root);
      expect(result.fileCount).toBe(2);
      expect(result.edgeCount).toBe(0);
      expect(result.cycles).toEqual([]);
    });
  });

  it.each([
    "import { B } from './b.js';",
    "import B from './b.js';",
    "import * as B from './b.js';",
    "import './b.js';",
    "export { B } from './b.js';",
    "export * from './b.js';",
    "export * as B from './b.js';",
    "import { B, type BT } from './b.js';",
    "import { type B } from './b.js';",
    "export { type B } from './b.js';",
    "import {} from './b.js';",
    "export {} from './b.js';",
    "const x = 1; import{B}from'./b.js'; export{B}from'./b.js';",
    "import /* explanation */ { B } from './b.js';",
    "import type from './b.js';",
  ])('retains static declarations and deduplicates edges: %s', async (source) => {
    await withFixture(
      { 'src/a.ts': source, 'src/b.ts': "import './a.js';" },
      async (root) => {
        const result = await checkImportCycles(root);
        expect(result.edgeCount).toBe(2);
        expect(result.cycles).toHaveLength(1);
      },
    );
  });

  it.each([
    "import type { B } from './b.js';",
    "import\ntype { B } from './b.js';",
    "import type {\n B,\n} from './b.js';",
    "export type { B } from './b.js';",
    "export\ntype { B } from './b.js';",
    "export type * from './b.js';",
    "export type * as B from './b.js';",
    "const lazy = () => import('./b.js');",
    "const dep = require('./b.js');",
    "type Q = import('./b.js').Q;",
    "import defer * as B from './b.js';",
    "import { B } from 'bare-package';",
  ])('excludes type-only, deferred and package imports: %s', async (source) => {
    await withFixture({ 'src/a.ts': source, 'src/b.ts': '' }, async (root) => {
      expect((await checkImportCycles(root)).edgeCount).toBe(0);
    });
  });

  it('parses TSX under an isolated custom source root', async () => {
    await withFixture(
      {
        'app/a.tsx': "import './b.jsx'; export const A = () => <pre>\nimport './a.jsx';\n</pre>;",
        'app/b.tsx': "export { A } from './a.jsx';",
      },
      async (root) => {
        const result = await checkImportCycles(root, ['app']);
        expect(result.fileCount).toBe(2);
        expect(result.edgeCount).toBe(2);
        expect(new Set(result.cycles[0].files)).toEqual(new Set(['app/a.tsx', 'app/b.tsx']));
      },
    );
  });
});

// Exercise the real parser session while observing its resource boundary.
// Failures must reject the gate and still release the child process.
describe('parser lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens one batch and disposes it after extracting all files', async () => {
    const update = vi.spyOn(API.prototype, 'updateSnapshot');
    const dispose = vi.spyOn(Snapshot.prototype, 'dispose');
    const close = vi.spyOn(API.prototype, 'close');
    await withFixture(
      { 'src/a.ts': "import './b.js';", 'src/b.ts': '' },
      async (root) => {
        expect((await checkImportCycles(root)).edgeCount).toBe(1);
        expect(update).toHaveBeenCalledExactlyOnceWith({
          openFiles: [join(root, 'src/a.ts'), join(root, 'src/b.ts')],
        });
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
      },
    );
  });

  it('closes the parser when snapshot creation fails', async () => {
    vi.spyOn(API.prototype, 'updateSnapshot').mockImplementation(() => {
      throw new Error('snapshot failed');
    });
    const close = vi.spyOn(API.prototype, 'close');
    await withFixture({ 'src/a.ts': '' }, async (root) => {
      await expect(checkImportCycles(root)).rejects.toThrow('snapshot failed');
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects missing source ASTs and releases the snapshot and parser', async () => {
    vi.spyOn(Snapshot.prototype, 'getDefaultProjectForFile').mockReturnValue(undefined);
    const dispose = vi.spyOn(Snapshot.prototype, 'dispose');
    const close = vi.spyOn(API.prototype, 'close');
    await withFixture({ 'src/a.ts': '' }, async (root) => {
      await expect(checkImportCycles(root)).rejects.toThrow(/AST.*a\.ts/);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
