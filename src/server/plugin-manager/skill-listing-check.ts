/**
 * The per-task check (RFC "Plugins for the Kookr fleet", section 2): after a
 * task's first turn, read the `skill_listing` record of its transcript and mark
 * each plugin the task was given `no_skills_seen` when no skill carries that
 * plugin's `<name>:` prefix.
 *
 * Interactive sessions expose no plugin list (hook payloads carry none and the
 * transcript has no init record), so this is the one signal of what a running
 * agent actually loaded. Its limits: it sees skills only, so a plugin that
 * ships only subagents, hooks or an LSP server cannot be confirmed this way
 * (`no_skills_seen` is then expected), and it carries no load errors.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pluginNameFromId } from '../../shared/contracts/plugins.js';

/** The namespaced skill names of the first `skill_listing` record among `lines`, or null when there is none. */
export function findSkillListingNames(lines: Iterable<string>): string[] | null {
  for (const line of lines) {
    const names = skillListingNamesFromLine(line);
    if (names) return names;
  }
  return null;
}

function skillListingNamesFromLine(line: string): string[] | null {
  if (!line.includes('"skill_listing"')) return null;
  try {
    const parsed = JSON.parse(line) as { attachment?: { type?: string; names?: unknown } };
    const a = parsed.attachment;
    if (a?.type !== 'skill_listing' || !Array.isArray(a.names)) return null;
    return a.names.filter((n): n is string => typeof n === 'string');
  } catch {
    return null;
  }
}

/** Per plugin id: whether any listed skill carries its `<name>:` prefix. Pure. */
export function checkSkillsForPlugins(
  pluginIds: readonly string[],
  skillNames: readonly string[],
): Record<string, 'skills_seen' | 'no_skills_seen'> {
  const out: Record<string, 'skills_seen' | 'no_skills_seen'> = {};
  for (const id of pluginIds) {
    const prefix = `${pluginNameFromId(id)}:`;
    out[id] = skillNames.some((n) => n.startsWith(prefix)) ? 'skills_seen' : 'no_skills_seen';
  }
  return out;
}

/**
 * Stream a transcript until its first `skill_listing` record (written near the
 * start of a session) and return its names; null when the file has none or
 * cannot be read.
 */
export async function readTranscriptSkillListing(transcriptPath: string): Promise<string[] | null> {
  let stream: ReturnType<typeof createReadStream> | undefined;
  try {
    stream = createReadStream(transcriptPath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const names = skillListingNamesFromLine(line);
      if (names) {
        rl.close();
        return names;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    stream?.destroy();
  }
}
