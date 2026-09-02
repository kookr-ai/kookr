import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Architecture guard for issue #1826: dashboard UI code must not own HTTP
 * transport directly. Components and the application root (`App.tsx`, which owns
 * bootstrap wiring) call typed endpoint functions from `../api`, which are the
 * only code allowed to touch `fetch`. This test fails if a raw `fetch(` call
 * reappears in any of those files, keeping the data-access boundary from eroding
 * the way it did before the client was introduced (issue #2816 extended the
 * scan from components to the app root).
 */
// `new URL('..')` keeps a trailing slash; strip it so joined paths don't get a
// (harmless but sloppy) double slash like `src/frontend//App.tsx`.
const FRONTEND_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const COMPONENTS_DIR = `${FRONTEND_DIR}/components`;

// Application-root modules that own bootstrap fetches; they must route HTTP
// through src/frontend/api just like components do. Kept as an explicit list so
// the guard covers the app root without sweeping low-level client code (e.g.
// `api/client.ts`, the one allowed `fetch` owner).
const ROOT_FILES = ['App.tsx'];

// A `fetch(` call not preceded by an identifier char or `.` — so `apiFetch(`
// and `x.fetch(` do not match, but a bare `fetch(` / ` fetch(` / `=fetch(` does.
const RAW_FETCH = /(^|[^A-Za-z0-9_.])fetch\s*\(/;

/** Files the boundary applies to, each with a repo-relative display label. */
function guardedFiles(): { label: string; path: string }[] {
  const files: { label: string; path: string }[] = [];
  for (const rel of readdirSync(COMPONENTS_DIR, { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((entry) => entry.endsWith('.tsx') && !entry.endsWith('.test.tsx'))) {
    files.push({ label: `components/${rel}`, path: `${COMPONENTS_DIR}/${rel}` });
  }
  for (const rel of ROOT_FILES) {
    files.push({ label: rel, path: `${FRONTEND_DIR}/${rel}` });
  }
  return files;
}

describe('data-access boundary', () => {
  // Positive control: pin the matcher's behavior so a future refactor that
  // silently breaks RAW_FETCH can't leave the boundary test green-but-blind.
  test('RAW_FETCH matches a raw call and skips the allowed forms', () => {
    expect(RAW_FETCH.test('  const r = fetch(url)')).toBe(true);
    expect(RAW_FETCH.test('await fetch (url)')).toBe(true);
    expect(RAW_FETCH.test('const r = apiFetch(url)')).toBe(false);
    expect(RAW_FETCH.test('client.fetch(url)')).toBe(false);
    expect(RAW_FETCH.test("if (typeof fetch !== 'function')")).toBe(false);
  });

  test('no component or app-root module calls fetch() directly', () => {
    const offenders: string[] = [];
    for (const { label, path } of guardedFiles()) {
      const source = readFileSync(path, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (RAW_FETCH.test(line)) offenders.push(`${label}:${index + 1}`);
      });
    }
    expect(offenders, `Route these through src/frontend/api instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});
