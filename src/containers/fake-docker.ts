import type { ContainerInfo, DockerRunnerPort, NetworkInfo } from './ports.js';

/** In-memory DockerRunnerPort for tests. Records every mutating call in `calls`. */
export class FakeDocker implements DockerRunnerPort {
  containers: ContainerInfo[] = [];
  networks: NetworkInfo[] = [];
  calls: string[] = [];
  failOn?: string;

  async listContainers(label: { key: string; value: string }): Promise<ContainerInfo[]> {
    return this.containers.filter((c) => c.labels[label.key] === label.value);
  }
  async stopContainer(name: string): Promise<void> {
    this.calls.push(`stop ${name}`);
    if (this.failOn === `stop ${name}`) throw new Error('boom');
    const c = this.containers.find((x) => x.name === name);
    if (c) c.state = 'exited';
  }
  async removeContainer(name: string): Promise<void> {
    this.calls.push(`rm ${name}`);
    this.containers = this.containers.filter((c) => c.name !== name);
  }
  async listNetworks(label: { key: string; value: string }): Promise<NetworkInfo[]> {
    return this.networks.filter((n) => n.labels[label.key] === label.value);
  }
  async removeNetwork(name: string): Promise<void> {
    this.calls.push(`net-rm ${name}`);
    this.networks = this.networks.filter((n) => n.name !== name);
  }
}
