import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Best-effort Docker runtime probe. Missing Docker, permission errors, and
 * malformed output all resolve to false so callers can keep CPU fallback.
 */
export async function hasDockerRuntime(runtimeName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', ['info', '--format', '{{json .Runtimes}}'], {
      timeout: 5_000,
    });
    const runtimes = JSON.parse(stdout) as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(runtimes, runtimeName);
  } catch {
    return false;
  }
}
