import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Architecture guard for issue #1826: dashboard components must not own HTTP
 * transport directly. They call typed endpoint functions from `../api`, which
 * are the only code allowed to touch `fetch`. This test fails if a raw `fetch(`
 * call reappears in any component, keeping the data-access boundary from
 * eroding the way it did before the client was introduced.
 */
const COMPONENTS_DIR = fileURLToPath(new URL('../components', import.meta.url));

// A `fetch(` call not preceded by an identifier char or `.` — so `apiFetch(`
// and `x.fetch(` do not match, but a bare `fetch(` / ` fetch(` / `=fetch(` does.
const RAW_FETCH = /(^|[^A-Za-z0-9_.])fetch\s*\(/;

function componentFiles(): string[] {
  return readdirSync(COMPONENTS_DIR, { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((entry) => entry.endsWith('.tsx') && !entry.endsWith('.test.tsx'));
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

  test('no component calls fetch() directly', () => {
    const offenders: string[] = [];
    for (const rel of componentFiles()) {
      const source = readFileSync(`${COMPONENTS_DIR}/${rel}`, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (RAW_FETCH.test(line)) offenders.push(`components/${rel}:${index + 1}`);
      });
    }
    expect(offenders, `Route these through src/frontend/api instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});
