import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';

const frontendDir = dirname(fileURLToPath(import.meta.url));

describe('frontend stylesheet loading', () => {
  test('keeps the full dashboard stylesheet off the initial render path', () => {
    const source = readFileSync(join(frontendDir, 'App.tsx'), 'utf8');

    expect(source).toContain("import './critical.css'");
    expect(source).toContain("import('./styles.css')");
    expect(source).not.toContain("import './styles.css'");
  });

  test('keeps the render-blocking bootstrap stylesheet small', () => {
    const criticalCss = statSync(join(frontendDir, 'critical.css'));

    expect(criticalCss.size).toBeLessThanOrEqual(30_000);
  });
});
