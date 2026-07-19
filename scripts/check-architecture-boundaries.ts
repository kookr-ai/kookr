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

export function checkCoreLlmProviderBoundary(file: string): Violation[] {
  const source = readFileSync(file, 'utf8');
  const fileName = basename(file).toLowerCase();
  const violations: Violation[] = [];

  if (fileName.includes('openrouter')) {
    violations.push({ file, reason: 'OpenRouter implementation file is under src/core' });
  }

  const forbiddenProviderMarkers = [
    'OpenRouterLlmClient',
    'RequestyLlmClient',
    'GroqLlmClient',
    'GoogleLlmClient',
    'AnthropicLlmClient',
    'OpenAiCompatibleLlmClient',
    'groq-sdk',
    '@google/genai',
    '@anthropic-ai/sdk',
    'openrouter.ai',
    'router.requesty.ai',
    'KOOKR_OPENROUTER_API_KEY',
    'OPENROUTER_API_KEY',
    'KOOKR_REQUESTY_API_KEY',
    'REQUESTY_API_KEY',
    'GROQ_API_KEY',
    'GEMINI_API_KEY',
    'ANTHROPIC_API_KEY',
  ];
  for (const marker of forbiddenProviderMarkers) {
    if (source.includes(marker)) {
      violations.push({ file, reason: `LLM provider transport/config marker "${marker}" appears in src/core` });
    }
  }

  return violations;
}

/**
 * Core must not import outward into server/adapters/frontend/cli/remote/integrations.
 * Relative import specs like `../server/...` or deep `../../server/...` are violations.
 * Type-only imports count — compile-time layer leaks still couple core to outer packages.
 */
const CORE_OUTWARD_IMPORT_RE =
  /(?:from\s+|import\s*\(\s*)['"]((?:\.\.\/)+)(server|adapters|frontend|cli|remote|integrations|pr-checklist)(?:\/[^'"]*)?['"]/g;

export function checkCoreLayerBoundary(file: string): Violation[] {
  const source = readFileSync(file, 'utf8');
  const violations: Violation[] = [];
  for (const match of source.matchAll(CORE_OUTWARD_IMPORT_RE)) {
    const spec = match[0].includes('from')
      ? match[0].replace(/^[\s\S]*from\s+/, '').replace(/^import\s*\(\s*/, '')
      : match[0];
    const importPath = match[1] + match[2];
    violations.push({
      file,
      reason: `core imports outer layer "${importPath}" (${spec.trim()})`,
    });
  }
  return violations;
}

async function main(): Promise<void> {
  const files = await listTypeScriptFiles(CORE_ROOT);
  const violations = [
    ...files.flatMap(checkCoreLlmProviderBoundary),
    ...files.flatMap(checkCoreLayerBoundary),
  ];

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
