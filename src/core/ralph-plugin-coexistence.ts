import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Detect whether the standalone Claude Code Ralph Wiggum plugin
 * (`ralph-wiggum@claude-code-plugins`) is enabled in any settings file
 * Claude Code reads. If it is, Kookr must refuse to start its own Ralph
 * loop on the same agent — both controllers would fire on the same Stop
 * event, double-injecting the prompt and corrupting the audit trail.
 *
 * This is a day-1 correctness gate per issue #440 ("Coexistence false-
 * negative" risk + the M1 plugin-coexistence detection requirement).
 *
 * Two signals indicate coexistence:
 *
 *   1. `enabledPlugins["ralph-wiggum@<marketplace>"] === true` in any
 *      settings file. Empirically verified against the installed plugin
 *      manifest.
 *   2. Any Stop hook whose command path contains "ralph-wiggum" — defensive
 *      for users who registered the hook outside the plugin mechanism.
 *
 * The detector reads the four settings files Claude Code is documented to
 * read, in precedence order:
 *
 *   - `<cwd>/.claude/settings.local.json`  (project-local, highest precedence)
 *   - `<cwd>/.claude/settings.json`        (project)
 *   - `~/.claude/settings.local.json`      (user-local)
 *   - `~/.claude/settings.json`            (user)
 *
 * Missing or malformed files are skipped silently — better to under-report
 * than to refuse Ralph startup because a stray settings file has a typo.
 * The caller (Ralph launch code) decides what to do with a positive result.
 */

export interface CoexistenceResult {
  /** True if any signal matched in any scanned file. */
  detected: boolean;
  /** Settings files where a signal matched (in scan order). Empty if not detected. */
  matchedFiles: string[];
  /**
   * Plain-language reasons one per matched file. Suitable for surfacing to
   * the user in an error message ("refusing to start Ralph: standalone plugin
   * is enabled in <file>").
   */
  reasons: string[];
}

interface SettingsFile {
  enabledPlugins?: Record<string, boolean>;
  hooks?: {
    Stop?: Array<{
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
  };
}

const STANDALONE_PLUGIN_NAME_PREFIX = 'ralph-wiggum@';
const HOOK_COMMAND_MARKER = 'ralph-wiggum';

/**
 * Build the list of settings file paths to scan, in Claude Code's documented
 * precedence order (project > user, .local > base). Exposed for tests.
 */
export function settingsFilePaths(cwd: string, home: string = homedir()): string[] {
  return [
    join(cwd, '.claude', 'settings.local.json'),
    join(cwd, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
    join(home, '.claude', 'settings.json'),
  ];
}

/**
 * Scan all four settings files for the standalone Ralph plugin. Returns a
 * structured result so the launch code can format an actionable error.
 *
 * Never throws. Filesystem and JSON parse errors per-file are swallowed.
 */
export async function detectStandalonePlugin(
  cwd: string,
  home: string = homedir(),
): Promise<CoexistenceResult> {
  const matchedFiles: string[] = [];
  const reasons: string[] = [];

  for (const path of settingsFilePaths(cwd, home)) {
    const reason = await scanOne(path);
    if (reason) {
      matchedFiles.push(path);
      reasons.push(reason);
    }
  }

  return {
    detected: matchedFiles.length > 0,
    matchedFiles,
    reasons,
  };
}

async function scanOne(path: string): Promise<string | null> {
  let raw: string;
  try {
    await access(path);
    raw = await readFile(path, 'utf-8');
  } catch {
    return null;
  }

  let parsed: SettingsFile;
  try {
    parsed = JSON.parse(raw) as SettingsFile;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  // Signal 1: enabledPlugins flag.
  const enabled = parsed.enabledPlugins;
  if (enabled && typeof enabled === 'object') {
    for (const [pluginId, isEnabled] of Object.entries(enabled)) {
      if (isEnabled === true && pluginId.startsWith(STANDALONE_PLUGIN_NAME_PREFIX)) {
        return `enabledPlugins["${pluginId}"] is true`;
      }
    }
  }

  // Signal 2: any Stop hook command referencing the standalone plugin.
  const stopHooks = parsed.hooks?.Stop ?? [];
  for (const group of stopHooks) {
    const inner = group?.hooks ?? [];
    for (const h of inner) {
      if (typeof h?.command === 'string' && h.command.includes(HOOK_COMMAND_MARKER)) {
        return `Stop hook command references "${HOOK_COMMAND_MARKER}": ${h.command}`;
      }
    }
  }

  return null;
}
