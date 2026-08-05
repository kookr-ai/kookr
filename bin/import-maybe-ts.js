// Shared loader for bin/* entrypoints that fall back from dist/*.js to src/*.ts.
//
// Plain Node (type-stripping) can load a single .ts file, but relative imports
// of `.js` specifiers into other TypeScript modules fail without a resolver.
// Importing `tsx` first registers that resolver for the rest of the process.
// Prefer compiled dist when present so production installs stay tsx-free.
//
// See issue #2095 (IVL clean-clone false-red on `kookr context-pack --help`).

import { pathToFileURL } from 'node:url';

/**
 * Dynamic-import a compiled .js module, or a .ts source module via tsx.
 * @param {string} entry Absolute path to dist/.../*.js or src/.../*.ts
 * @returns {Promise<any>}
 */
export async function importMaybeTs(entry) {
  if (entry.endsWith('.ts')) {
    await import('tsx');
  }
  return import(pathToFileURL(entry).href);
}
