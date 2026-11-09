import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContainerInfo, DockerRunnerPort, NetworkInfo } from './ports.js';

const execFileAsync = promisify(execFile);

export type DockerExec = (args: string[], timeoutMs: number) => Promise<string>;

const defaultExec: DockerExec = async (args, timeoutMs) => {
  const { stdout } = await execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

interface InspectContainer {
  Id: string;
  Name: string;
  Created: string;
  State?: { Status?: string; ExitCode?: number; OOMKilled?: boolean };
  RestartCount?: number;
  Config?: { Labels?: Record<string, string> | null };
}
interface InspectNetwork { Id: string; Name: string; Created?: string; Labels?: Record<string, string> | null }

/** Docker CLI adapter. Arguments are always an argv array (never a shell string); names must be plain identifiers. */
export class DockerCliRunner implements DockerRunnerPort {
  constructor(private readonly exec: DockerExec = defaultExec, private readonly timeoutMs = 30_000) {}

  private static safeName(name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`refusing unsafe docker object name ${JSON.stringify(name)}`);
    return name;
  }

  async listContainers(label: { key: string; value: string }): Promise<ContainerInfo[]> {
    const ids = (await this.exec(['ps', '-a', '-q', '--no-trunc', '--filter', `label=${label.key}=${label.value}`], this.timeoutMs))
      .split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return [];
    const rows = JSON.parse(await this.exec(['inspect', '--type', 'container', ...ids], this.timeoutMs)) as InspectContainer[];
    return rows.map((r) => ({
      id: r.Id,
      name: r.Name.replace(/^\//, ''),
      state: r.State?.Status ?? 'unknown',
      createdAt: new Date(r.Created),
      labels: r.Config?.Labels ?? {},
      ...(r.State?.ExitCode !== undefined ? { exitCode: r.State.ExitCode } : {}),
      ...(r.State?.OOMKilled !== undefined ? { oomKilled: r.State.OOMKilled } : {}),
      ...(r.RestartCount !== undefined ? { restartCount: r.RestartCount } : {}),
    }));
  }

  async stopContainer(name: string, graceSeconds: number): Promise<void> {
    await this.exec(['stop', '-t', String(Math.max(0, Math.floor(graceSeconds))), DockerCliRunner.safeName(name)], this.timeoutMs + graceSeconds * 1000);
  }

  async removeContainer(name: string): Promise<void> {
    await this.exec(['rm', DockerCliRunner.safeName(name)], this.timeoutMs);
  }

  async listNetworks(label: { key: string; value: string }): Promise<NetworkInfo[]> {
    const ids = (await this.exec(['network', 'ls', '-q', '--no-trunc', '--filter', `label=${label.key}=${label.value}`], this.timeoutMs))
      .split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return [];
    const rows = JSON.parse(await this.exec(['network', 'inspect', ...ids], this.timeoutMs)) as InspectNetwork[];
    return rows.map((r) => ({ id: r.Id, name: r.Name, labels: r.Labels ?? {}, ...(r.Created ? { createdAt: new Date(r.Created) } : {}) }));
  }

  async removeNetwork(name: string): Promise<void> {
    await this.exec(['network', 'rm', DockerCliRunner.safeName(name)], this.timeoutMs);
  }
}
