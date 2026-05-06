import { createServer } from 'node:net';

export interface PortResolverDeps {
  out?: { log: (m: string) => void; error: (m: string) => void };
  exit?: (code: number) => never;
  probe?: (port: number, host: string) => Promise<boolean>;
  autoMin?: number;
  autoMax?: number;
}

export interface PortResolution {
  port: number;
  source: 'requested' | 'auto';
}

export async function probeListenPort(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer();
    let settled = false;
    const finish = (free: boolean): void => {
      if (settled) return;
      settled = true;
      probe.removeAllListeners();
      probe.close(() => resolve(free));
    };
    probe.once('error', () => finish(false));
    probe.once('listening', () => finish(true));
    probe.listen(port, host);
  });
}

export async function resolveListenPort(
  envPort: string | undefined,
  host: string,
  deps: PortResolverDeps = {},
): Promise<PortResolution> {
  const out = deps.out ?? { log: console.log.bind(console), error: console.error.bind(console) };
  const exit = deps.exit ?? ((code: number) => process.exit(code) as never);
  const probe = deps.probe ?? probeListenPort;
  const autoMin = deps.autoMin ?? 4800;
  const autoMax = deps.autoMax ?? 4810;

  const trimmed = (envPort ?? '4800').trim();

  if (trimmed.toLowerCase() === 'auto') {
    for (let p = autoMin; p <= autoMax; p++) {
      if (await probe(p, host)) {
        return { port: p, source: 'auto' };
      }
    }
    out.error(
      `[fatal] KOOKR_PORT=auto: no free port found in range ${autoMin}-${autoMax} on ${host}.\n` +
        `  Free a port in that range or set KOOKR_PORT explicitly to a port outside the range.`,
    );
    return exit(1);
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    out.error(
      `[fatal] KOOKR_PORT=${trimmed} is not a valid port number (1-65535) or "auto".`,
    );
    return exit(1);
  }

  if (await probe(parsed, host)) {
    return { port: parsed, source: 'requested' };
  }

  out.error(formatPortInUseMessage(parsed, host));
  return exit(1);
}

export function formatPortInUseMessage(port: number, host: string): string {
  return [
    `[fatal] Port ${port} on ${host} is already in use.`,
    `  What's running there:`,
    `    $ lsof -ti:${port}   # prints PID`,
    `    $ ps -p <PID> -o command=`,
    `  Options:`,
    `    - Kill that process and retry`,
    `    - Set KOOKR_PORT=${port + 1} and retry`,
    `    - Set KOOKR_PORT=auto to bind the next free port`,
  ].join('\n');
}
