import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const remoteRoot = join(root, 'src/remote');
const probe = join(root, 'scripts/remote-load-purity-probe.ts');

function listRemoteModules(dir = remoteRoot): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const modules: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== '__fixtures__') {
        modules.push(...listRemoteModules(path));
      }
      continue;
    }
    if (
      entry.isFile()
      && entry.name.endsWith('.ts')
      && !entry.name.endsWith('.test.ts')
      && !entry.name.endsWith('.spec.ts')
      && statSync(path).size > 0
    ) {
      modules.push(path);
    }
  }
  return modules.sort();
}

describe('src/remote module-load purity', () => {
  it('has a load-purity gate even before remote modules exist', () => {
    expect(Array.isArray(listRemoteModules())).toBe(true);
  });

  it('loads each remote module without top-level local-only side effects', () => {
    const modules = listRemoteModules();
    for (const mod of modules) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', probe, mod], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          KOOKR_RELAY_URL: '',
        },
      });
      expect(result.status, `${mod}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    }
  });
});
