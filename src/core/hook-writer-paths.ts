import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Resolves the on-disk path of the bundled Kookr hook writer
 * (`bin/kookr-hook-writer.js`). Both `src/core/*.ts` (vitest) and
 * `dist/core/*.js` (compiled) sit two levels deep, so `../../bin/...`
 * lands on the same path either way.
 *
 * Returns `undefined` when the writer is not present on disk. Adapters
 * fall back to the legacy `awk` pipeline so generated hook settings
 * remain usable in that state. See rfc-activity-log-reliability §6.
 */
const moduleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

export function resolveHookWriterPath(baseDir: string = moduleDir): string | undefined {
  const candidate = resolve(baseDir, '..', '..', 'bin', 'kookr-hook-writer.js');
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Resolve the on-disk path of the bundled Stop-hook nudge
 * (`bin/kookr-stop-nudge.js`, RFC: rfc-agent-signal-surface §7). Returns
 * `undefined` when absent so adapters simply omit the nudge hook entry rather
 * than wiring a broken command.
 */
export function resolveStopNudgePath(baseDir: string = moduleDir): string | undefined {
  const candidate = resolve(baseDir, '..', '..', 'bin', 'kookr-stop-nudge.js');
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Build the Stop-hook nudge command: `node <nudge>`. The script reads the raw
 * Stop payload from stdin and resolves task identity/API from the agent env
 * (KOOKR_TASK_ID / KOOKR_API_BASE_URL). It is hard fail-open (always exits 0).
 */
export function buildStopNudgeCommand(opts: { nudgePath: string; nodePath?: string }): string {
  const { nudgePath, nodePath = process.execPath } = opts;
  return `${shellQuote(nodePath)} ${shellQuote(nudgePath)}`;
}

/**
 * Build the shell hook command Kookr writes into Claude Code / Codex CLI
 * settings. When the bundled writer is available, the command pipes stdin
 * into `node <writer> --session ... --file ... [--url ...]` so concurrent
 * hook payloads cannot interleave on the JSONL file. When the writer is
 * missing (e.g. fresh checkout pre-install), falls back to the legacy
 * `awk` pipeline so the generated settings remain functional.
 */
export function buildHookCommand(opts: {
  tmuxName: string;
  hookFile: string;
  serverPort?: number;
  writerPath?: string;
  nodePath?: string;
}): string {
  const { tmuxName, hookFile, serverPort, writerPath, nodePath = process.execPath } = opts;
  const url = serverPort ? `http://localhost:${serverPort}/api/hook-event/${tmuxName}` : undefined;

  if (writerPath) {
    const urlArg = url ? ` --url ${shellQuote(url)}` : '';
    return `${shellQuote(nodePath)} ${shellQuote(writerPath)} --session ${shellQuote(tmuxName)} --file ${shellQuote(hookFile)}${urlArg}`;
  }

  if (url) {
    return `awk -v file='${hookFile}' '{ print >> file; print }' | curl -s -X POST ${url} --max-time 1 -H 'Content-Type: application/json' -d @- >/dev/null 2>&1`;
  }
  return `awk -v file='${hookFile}' '{ print >> file }'`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
