import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Playbook } from './playbook.js';
import { parsePlaybook, PlaybookParseError } from './playbook-parser.js';

const PLAYBOOKS_DIR = '.kookr/playbooks';

/**
 * Discover playbooks in a project directory by scanning .kookr/playbooks/*.md.
 * Returns an empty array if the directory does not exist.
 * Skips files that fail to parse (logs a warning).
 */
export async function discoverPlaybooks(cwd: string): Promise<Playbook[]> {
  const dir = join(cwd, PLAYBOOKS_DIR);

  let entries: string[];
  try {
    const dirEntries = await readdir(dir);
    entries = dirEntries.filter((e) => e.endsWith('.md')).sort();
  } catch {
    // Directory does not exist — no playbooks
    return [];
  }

  const playbooks: Playbook[] = [];

  for (const filename of entries) {
    try {
      const content = await readFile(join(dir, filename), 'utf-8');
      const playbook = parsePlaybook(content, filename, cwd);
      playbooks.push(playbook);
    } catch (err) {
      if (err instanceof PlaybookParseError) {
        console.warn(`Skipping invalid playbook ${filename}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  return playbooks;
}
