import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONTAINER_NAME_PREFIX, type ContainerInfo, type ContainerRunSpec, type DockerRunnerPort, type NetworkInfo } from './ports.js';

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

  /** Container operations are limited to Kookr's own `kookr-oc-` names, whatever the caller passes (#3557). */
  private static safeContainer(name: string): string {
    DockerCliRunner.safeName(name);
    if (!name.startsWith(CONTAINER_NAME_PREFIX)) throw new Error(`refusing unsafe docker object name ${JSON.stringify(name)} (not a ${CONTAINER_NAME_PREFIX} container)`);
    return name;
  }

  /** The argv for `docker run` (exported for tests). Values are single argv entries; nothing goes through a shell. */
  static runArgs(spec: ContainerRunSpec): string[] {
    DockerCliRunner.safeContainer(spec.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(spec.image)) throw new Error(`refusing unsafe image reference ${JSON.stringify(spec.image)}`);
    const a = ['run', '-d', '--pull', 'never', '--name', spec.name, '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', spec.memory, '--cpus', spec.cpus, '--pids-limit', String(spec.pidsLimit), '--user', spec.user,
      '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '-p', `127.0.0.1::${spec.publishPort}`];
    for (const [k, v] of Object.entries(spec.labels)) a.push('--label', `${k}=${v}`);
    for (const t of spec.tmpfs) a.push('--tmpfs', t);
    for (const m of spec.mounts) a.push('-v', `${m.source}:${m.target}:${m.readOnly ? 'ro' : 'rw'}`);
    for (const [k, v] of Object.entries(spec.env)) a.push('-e', `${k}=${v}`);
    a.push(spec.image);
    return a;
  }

  async runContainer(spec: ContainerRunSpec): Promise<string> {
    return (await this.exec(DockerCliRunner.runArgs(spec), this.timeoutMs)).trim();
  }

  async publishedPort(name: string, containerPort: number): Promise<number> {
    const out = await this.exec(['port', DockerCliRunner.safeContainer(name), `${containerPort}/tcp`], this.timeoutMs);
    // One line per binding, e.g. `127.0.0.1:51228` (and possibly an IPv6 line); take the loopback IPv4 one.
    const m = /^127\.0\.0\.1:(\d+)$/m.exec(out);
    if (!m) throw new Error(`no loopback port published for ${name}:${containerPort}`);
    return Number(m[1]);
  }

  async healthStatus(name: string): Promise<string | undefined> {
    const out = (await this.exec(['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{end}}', DockerCliRunner.safeContainer(name)], this.timeoutMs)).trim();
    return out || undefined;
  }

  async forceRemoveContainer(name: string): Promise<void> {
    await this.exec(['rm', '-f', DockerCliRunner.safeContainer(name)], this.timeoutMs);
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
    await this.exec(['stop', '-t', String(Math.max(0, Math.floor(graceSeconds))), DockerCliRunner.safeContainer(name)], this.timeoutMs + graceSeconds * 1000);
  }

  async removeContainer(name: string): Promise<void> {
    await this.exec(['rm', DockerCliRunner.safeContainer(name)], this.timeoutMs);
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
