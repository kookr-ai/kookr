import type { ContainerInfo, ContainerRunSpec, DockerRunnerPort, NetworkInfo } from './ports.js';

/** In-memory DockerRunnerPort for tests. Records every mutating call in `calls`. */
export class FakeDocker implements DockerRunnerPort {
  containers: ContainerInfo[] = [];
  networks: NetworkInfo[] = [];
  calls: string[] = [];
  /** The listing id passed with each stop/rm/net-rm call, in call order (undefined when the caller passed none). */
  ids: Array<string | undefined> = [];
  failOn?: string;
  runs: ContainerRunSpec[] = [];
  health: string | undefined = 'healthy';
  port = 40123;

  async runContainer(spec: ContainerRunSpec): Promise<string> {
    this.calls.push(`run ${spec.name}`);
    if (this.failOn === `run ${spec.name}` || this.failOn === 'run') throw new Error('docker run failed');
    this.runs.push(spec);
    this.containers.push({ id: `id-${spec.name}`, name: spec.name, state: 'running', createdAt: new Date(), labels: spec.labels });
    return `id-${spec.name}`;
  }
  async publishedPort(): Promise<number> {
    return this.port;
  }
  async healthStatus(): Promise<string | undefined> {
    return this.health;
  }
  async forceRemoveContainer(name: string): Promise<void> {
    this.calls.push(`rm-f ${name}`);
    this.containers = this.containers.filter((c) => c.name !== name);
  }

  async listContainers(label: { key: string; value: string }): Promise<ContainerInfo[]> {
    return this.containers.filter((c) => c.labels[label.key] === label.value);
  }
  async stopContainer(name: string, _grace?: number, id?: string): Promise<void> {
    this.calls.push(`stop ${name}`);
    this.ids.push(id);
    if (this.failOn === `stop ${name}`) throw new Error('boom');
    const c = this.containers.find((x) => x.name === name);
    if (c) c.state = 'exited';
  }
  async removeContainer(name: string, id?: string): Promise<void> {
    this.calls.push(`rm ${name}`);
    this.ids.push(id);
    this.containers = this.containers.filter((c) => c.name !== name);
  }
  async listNetworks(label: { key: string; value: string }): Promise<NetworkInfo[]> {
    return this.networks.filter((n) => n.labels[label.key] === label.value);
  }
  async removeNetwork(name: string, id?: string): Promise<void> {
    this.calls.push(`net-rm ${name}`);
    this.ids.push(id);
    this.networks = this.networks.filter((n) => n.name !== name);
  }
}
