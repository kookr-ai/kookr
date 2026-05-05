import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

interface EnsureCodexWorkspaceTrustedOptions {
  configPath?: string;
}

export async function ensureCodexWorkspaceTrusted(
  cwd: string,
  options?: EnsureCodexWorkspaceTrustedOptions,
): Promise<void> {
  const configPath = options?.configPath ?? getDefaultCodexConfigPath();

  let existing = '';
  try {
    existing = await readFile(configPath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  const updated = upsertCodexTrustEntry(existing, cwd);
  if (updated === existing) {
    return;
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, updated, 'utf-8');
}

export function upsertCodexTrustEntry(content: string, cwd: string): string {
  const sectionHeader = `[projects."${escapeTomlBasicString(cwd)}"]`;
  const lines = content === '' ? [] : content.split('\n');
  const sectionIndex = lines.findIndex((line) => line.trim() === sectionHeader);

  if (sectionIndex >= 0) {
    const sectionEnd = findNextTableIndex(lines, sectionIndex + 1);
    const sectionLines = lines.slice(sectionIndex + 1, sectionEnd);
    if (sectionLines.some((line) => /^\s*trust_level\s*=/.test(line))) {
      return content;
    }

    lines.splice(sectionIndex + 1, 0, 'trust_level = "trusted"');
    return lines.join('\n');
  }

  const suffix = [
    sectionHeader,
    'trust_level = "trusted"',
  ].join('\n');

  if (content.trim() === '') {
    return `${suffix}\n`;
  }

  const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${separator}${suffix}\n`;
}

function findNextTableIndex(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (/^\s*\[.*\]\s*$/.test(lines[index])) {
      return index;
    }
  }
  return lines.length;
}

function getDefaultCodexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

function escapeTomlBasicString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
