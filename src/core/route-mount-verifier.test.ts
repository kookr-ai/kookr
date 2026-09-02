import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  computeRouteMountDrift,
  extractCalledNames,
  extractExportedRegistrars,
  extractImportedNames,
  extractMountedRegistrars,
  stripComments,
  verifyRouteMounts,
  type RegistrarRef,
} from './route-mount-verifier.js';

describe('extractExportedRegistrars', () => {
  it('matches function, async function, and const arrow registrar exports', () => {
    const content = [
      'export function registerAdminRoutes(app) {}',
      'export async function registerTaskRoutes(app) {}',
      'export const registerFileRoutes = (app) => {};',
      // Not exported — internal helper.
      'function registerHelperRoutes(app) {}',
      // Not a registrar name.
      'export function registerMiddleware(app) {}',
    ].join('\n');

    expect(extractExportedRegistrars(content, 'a.ts').map((r) => r.name)).toEqual([
      'registerAdminRoutes',
      'registerTaskRoutes',
      'registerFileRoutes',
    ]);
  });

  it('ignores a registrar declared only inside a comment', () => {
    const content = [
      '// export function registerGhostRoutes(app) {}',
      '/* export function registerBlockGhostRoutes(app) {} */',
      'export function registerRealRoutes(app) {}',
    ].join('\n');

    expect(extractExportedRegistrars(content, 'a.ts').map((r) => r.name)).toEqual([
      'registerRealRoutes',
    ]);
  });

  it('records the source file for each registrar', () => {
    const refs = extractExportedRegistrars('export function registerAdminRoutes(app) {}', 'x/y.ts');
    expect(refs).toEqual([{ name: 'registerAdminRoutes', file: 'x/y.ts' }]);
  });
});

describe('extractImportedNames', () => {
  it('maps local bindings to their original export name (aliases and all)', () => {
    const content = [
      "import { registerAdminRoutes } from './admin.js';",
      "import { registerFileRoutes as mountFiles, other } from './file.js';",
      "import type { RouteDeps } from './shared.js';",
    ].join('\n');

    expect(Object.fromEntries(extractImportedNames(content))).toEqual({
      registerAdminRoutes: 'registerAdminRoutes',
      mountFiles: 'registerFileRoutes',
      other: 'other',
      RouteDeps: 'RouteDeps',
    });
  });

  it('handles a default binding preceding the named imports', () => {
    const content = "import Logger, { registerAdminRoutes } from './admin.js';";
    expect(extractImportedNames(content).get('registerAdminRoutes')).toBe('registerAdminRoutes');
  });
});

describe('extractCalledNames', () => {
  it('collects identifiers used as call expressions', () => {
    const content = 'registerAdminRoutes(app, deps);\nconst x = notCalled;\nfoo();';
    const called = extractCalledNames(content);
    expect(called.has('registerAdminRoutes')).toBe(true);
    expect(called.has('foo')).toBe(true);
    expect(called.has('notCalled')).toBe(false);
  });
});

describe('extractMountedRegistrars', () => {
  it('counts a registrar as mounted only when imported AND called', () => {
    const mountModule = [
      "import { registerAdminRoutes } from './routes/admin.js';",
      "import { registerTaskRoutes } from './routes/task.js';",
      "import { registerUnusedRoutes } from './routes/unused.js';",
      'export function createRoutes(deps) {',
      '  registerAdminRoutes(app, deps);',
      '  if (deps.tasks) registerTaskRoutes(app, deps);',
      // registerUnusedRoutes imported but never called → not mounted.
      '}',
    ].join('\n');

    expect([...extractMountedRegistrars(mountModule)].sort()).toEqual([
      'registerAdminRoutes',
      'registerTaskRoutes',
    ]);
  });

  it('does not count a registrar called but never imported (name-only mention)', () => {
    const mountModule = [
      '// registerGhostRoutes(app, deps) — described in a comment only',
      'export function createRoutes(deps) {',
      '  registerLocalRoutes(app, deps);', // called but not imported
      '}',
    ].join('\n');

    expect([...extractMountedRegistrars(mountModule)]).toEqual([]);
  });

  it('resolves an aliased mount back to the exported registrar name', () => {
    const mountModule = [
      "import { registerFileRoutes as mountFiles } from './routes/file.js';",
      'export function createRoutes(deps) {',
      '  mountFiles(app, deps);',
      '}',
    ].join('\n');

    expect([...extractMountedRegistrars(mountModule)]).toEqual(['registerFileRoutes']);
  });
});

describe('stripComments', () => {
  it('removes line and block comments', () => {
    expect(stripComments('a // b\n/* c */ d').replace(/\s+/g, ' ').trim()).toBe('a d');
  });
});

describe('computeRouteMountDrift', () => {
  const registrars: RegistrarRef[] = [
    { name: 'registerAdminRoutes', file: 'src/server/routes/admin-routes.ts' },
    { name: 'registerTaskRoutes', file: 'src/server/routes/task-routes.ts' },
  ];

  it('passes cleanly when every registrar is mounted', () => {
    const result = computeRouteMountDrift({
      registrars,
      mounted: ['registerAdminRoutes', 'registerTaskRoutes'],
      unmountedAllowlist: new Map(),
    });
    expect(result.issues).toEqual([]);
    expect(result.checked).toBe(2);
  });

  it('flags an exported-but-unmounted registrar', () => {
    const result = computeRouteMountDrift({
      registrars,
      mounted: ['registerAdminRoutes'],
      unmountedAllowlist: new Map(),
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        registrar: 'registerTaskRoutes',
        message: expect.stringContaining('not mounted'),
      }),
    ]);
  });

  it('accepts an allowlisted unmounted registrar', () => {
    const result = computeRouteMountDrift({
      registrars,
      mounted: ['registerAdminRoutes'],
      unmountedAllowlist: new Map([['registerTaskRoutes', 'separate bind']]),
    });
    expect(result.issues).toEqual([]);
  });

  it('flags a stale allowlist entry that is actually mounted', () => {
    const result = computeRouteMountDrift({
      registrars,
      mounted: ['registerAdminRoutes', 'registerTaskRoutes'],
      unmountedAllowlist: new Map([['registerTaskRoutes', 'was a separate bind']]),
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        registrar: 'registerTaskRoutes',
        message: expect.stringContaining('actually mounted'),
      }),
    ]);
  });

  it('flags a dangling allowlist entry with no matching export', () => {
    const result = computeRouteMountDrift({
      registrars,
      mounted: ['registerAdminRoutes', 'registerTaskRoutes'],
      unmountedAllowlist: new Map([['registerGoneRoutes', 'deleted last release']]),
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        registrar: 'registerGoneRoutes',
        message: expect.stringContaining('no matching registrar export'),
      }),
    ]);
  });
});

describe('verifyRouteMounts', () => {
  it('fails when a fixture registrar is exported but not mounted', () => {
    const repoRoot = createRepo({
      registrarFiles: {
        'src/server/routes/admin-routes.ts': 'export function registerAdminRoutes(app) {}\n',
        'src/server/routes/ghost-routes.ts': 'export function registerGhostRoutes(app) {}\n',
      },
      mountModule: [
        "import { registerAdminRoutes } from './routes/admin-routes.js';",
        'export function createRoutes(deps) {',
        '  registerAdminRoutes(app, deps);',
        '}',
      ].join('\n'),
    });

    const result = verifyRouteMounts(repoRoot, { unmountedAllowlist: new Map() });
    expect(result.issues).toEqual([
      expect.objectContaining({ registrar: 'registerGhostRoutes' }),
    ]);
    expect(result.checked).toBe(2);
  });

  it('passes when the fixture registrar is allowlisted', () => {
    const repoRoot = createRepo({
      registrarFiles: {
        'src/server/routes/admin-routes.ts': 'export function registerAdminRoutes(app) {}\n',
        'src/server/routes/ghost-routes.ts': 'export function registerGhostRoutes(app) {}\n',
      },
      mountModule: [
        "import { registerAdminRoutes } from './routes/admin-routes.js';",
        'registerAdminRoutes(app, deps);',
      ].join('\n'),
    });

    const result = verifyRouteMounts(repoRoot, {
      unmountedAllowlist: new Map([['registerGhostRoutes', 'fixture']]),
    });
    expect(result.issues).toEqual([]);
  });

  it('flags a dangling allowlist entry through the full verify path', () => {
    const repoRoot = createRepo({
      registrarFiles: {
        'src/server/routes/admin-routes.ts': 'export function registerAdminRoutes(app) {}\n',
      },
      mountModule: [
        "import { registerAdminRoutes } from './routes/admin-routes.js';",
        'registerAdminRoutes(app, deps);',
      ].join('\n'),
    });

    const result = verifyRouteMounts(repoRoot, {
      unmountedAllowlist: new Map([['registerGoneRoutes', 'deleted last release']]),
    });
    expect(result.issues).toEqual([
      expect.objectContaining({ registrar: 'registerGoneRoutes' }),
    ]);
  });

  it('passes against the real repository (baseline guard)', () => {
    const result = verifyRouteMounts(process.cwd());
    expect(result.issues).toEqual([]);
    // Guard against a silent false-green where discovery finds nothing.
    expect(result.checked).toBeGreaterThan(20);
  });
});

function createRepo(input: {
  registrarFiles: Record<string, string>;
  mountModule: string;
}): string {
  const repoRoot = join(
    tmpdir(),
    `kookr-route-mount-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(join(repoRoot, 'src', 'server', 'routes'), { recursive: true });
  for (const [rel, body] of Object.entries(input.registrarFiles)) {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  writeFileSync(join(repoRoot, 'src', 'server', 'routes.ts'), input.mountModule);
  return repoRoot;
}
