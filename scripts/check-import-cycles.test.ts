import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkImportCycles, findCycles, runtimeSpecifiers } from './check-import-cycles';

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

  it('extracts static load-time specifiers only', () => {
    const specs = runtimeSpecifiers(
      [
        "import type { A } from './type-only.js';",
        "export type { B } from './type-reexport.js';",
        "import { C } from './runtime.js';",
        "import './side-effect.js';",
        "export { D } from './runtime-reexport.js';",
        "const lazy = () => import('./dynamic.js');",
        "const dep = require('./required.js');",
        "type Q = import('./type-position.js').Q;",
        "// import { Z } from './commented.js';",
      ].join('\n'),
    );
    // Static imports, side-effect imports, and static re-exports are edges.
    expect(specs).toEqual(
      expect.arrayContaining(['./runtime.js', './side-effect.js', './runtime-reexport.js']),
    );
    // Type-only, deferred (dynamic/require), type-position, and commented forms
    // are not load-time edges.
    for (const excluded of [
      './type-only.js',
      './type-reexport.js',
      './dynamic.js',
      './required.js',
      './type-position.js',
      './commented.js',
    ]) {
      expect(specs).not.toContain(excluded);
    }
  });
});
