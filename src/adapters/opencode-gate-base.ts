/**
 * Deliverable-gate base resolution, shared by every opencode launch mode (RFC #3541, S2a).
 *
 * The base is the commit the deliverable gate counts "commits ahead" of. The first launch of a task records HEAD;
 * every later launch of the SAME task (resume, or a crash-recovery fresh launch after the worker already committed)
 * keeps that original base while it still resolves in the repo, and only records a new one when none is stored or the
 * stored one no longer exists. Best-effort: a non-git cwd yields no base.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitExecEnv } from '../core/git-helpers.js';
import { readGateBase, writeGateBase } from './opencode-task-data.js';

const execFileAsync = promisify(execFile);

export async function resolveGateBaseEnv(
  cwd: string,
  taskDir: string,
  resuming: boolean,
  priorBase?: string,
): Promise<Record<string, string>> {
  const saved = resuming ? await readGateBase(taskDir) : priorBase;
  try {
    if (saved) {
      const ok = await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `${saved}^{commit}`], { cwd, timeout: 5000, env: gitExecEnv() })
        .then(() => true, () => false);
      if (ok) {
        // A fresh launch wiped the dir: put the kept base back.
        if (!resuming) await writeGateBase(taskDir, saved).catch(() => { /* best-effort */ });
        return { KOOKR_OPENCODE_GATE_BASE: saved };
      }
    }
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 5000, env: gitExecEnv() });
    const sha = stdout.trim();
    if (!/^[0-9a-f]{7,64}$/.test(sha)) return {};
    await writeGateBase(taskDir, sha).catch(() => { /* best-effort */ });
    return { KOOKR_OPENCODE_GATE_BASE: sha };
  } catch {
    return {};
  }
}
