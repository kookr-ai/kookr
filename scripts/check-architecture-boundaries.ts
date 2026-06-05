import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

const ROOT = process.cwd();
const CORE_ROOT = join(ROOT, 'src/core');

export interface Violation {
  file: string;
  reason: string;
}

export async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }

  return files;
}

export function checkCoreOpenRouterBoundary(file: string): Violation[] {
  const source = readFileSync(file, 'utf8');
  const fileName = basename(file).toLowerCase();
  const violations: Violation[] = [];

  if (fileName.includes('openrouter')) {
    violations.push({ file, reason: 'OpenRouter implementation file is under src/core' });
  }

  const forbiddenTransportMarkers = [
    'OpenRouterLlmClient',
    'openrouter.ai',
    'chat/completions',
    'KOOKR_OPENROUTER_API_KEY',
    'OPENROUTER_API_KEY',
    'fetch(',
  ];
  for (const marker of forbiddenTransportMarkers) {
    if (source.includes(marker)) {
      violations.push({ file, reason: `OpenRouter/provider transport marker "${marker}" appears in src/core` });
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const files = await listTypeScriptFiles(CORE_ROOT);
  const violations = files.flatMap(checkCoreOpenRouterBoundary);

  if (violations.length > 0) {
    console.error('Architecture boundary violations:');
    for (const violation of violations) {
      console.error(`  ${relative(ROOT, violation.file)}: ${violation.reason}`);
    }
    process.exit(1);
  }

  console.log(`Architecture boundary check passed (${files.length} core files).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
