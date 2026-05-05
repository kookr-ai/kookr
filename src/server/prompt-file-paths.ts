import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE_REFERENCE_PATTERN = /(^|[\s([{'"`])((?:\.\.?\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|(?:\.\.?\/)?[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+)(?=$|[\s)\]}'"`:;,.!?])/g;

export function normalizePromptFileReferences(prompt: string, cwd: string): string {
  return prompt.replace(FILE_REFERENCE_PATTERN, (match, prefix: string, candidate: string) => {
    const resolved = resolve(cwd, candidate);
    if (!existsSync(resolved)) return match;
    return `${prefix}${resolved}`;
  });
}
