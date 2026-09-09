/**
 * Keep all local agent processes on the same CPU allocation. Descendants
 * inherit Linux affinity, so concurrent test runners cannot each consume the
 * whole host. The server and terminal transport stay outside this allocation.
 */
export function validateAgentCpuList(value: string | undefined, platform: NodeJS.Platform): string | undefined {
  const list = value?.trim();
  if (!list) return undefined;
  if (platform !== 'linux') {
    throw new Error('KOOKR_AGENT_CPU_LIST requires Linux; unset it on other platforms');
  }
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(list)) {
    throw new Error('KOOKR_AGENT_CPU_LIST must be a CPU list such as 0-7 or 0-3,8-11');
  }
  for (const range of list.split(',')) {
    const [start, end = start] = range.split('-').map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      throw new Error('KOOKR_AGENT_CPU_LIST contains an invalid CPU range');
    }
  }
  return list;
}

export function buildAgentCpuCommand(command: string, args: string[], cpuList?: string): { command: string; args: string[] } {
  return cpuList
    ? { command: 'taskset', args: ['--cpu-list', cpuList, command, ...args] }
    : { command, args };
}
