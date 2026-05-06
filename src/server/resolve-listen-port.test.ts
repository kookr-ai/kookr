import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  formatPortInUseMessage,
  probeListenPort,
  resolveListenPort,
} from './resolve-listen-port.js';

interface FakeDeps {
  out: { log: (m: string) => void; error: (m: string) => void };
  exit: (code: number) => never;
  logs: string[];
  errors: string[];
  exits: number[];
}

function makeDeps(): FakeDeps {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  return {
    out: {
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
    },
    exit: ((code: number) => {
      exits.push(code);
    }) as unknown as (code: number) => never,
    logs,
    errors,
    exits,
  };
}

describe('formatPortInUseMessage', () => {
  it('contains the port, host, lsof guidance, and KOOKR_PORT options', () => {
    const msg = formatPortInUseMessage(4800, '127.0.0.1');
    expect(msg).toContain('Port 4800 on 127.0.0.1 is already in use');
    expect(msg).toContain('lsof -ti:4800');
    expect(msg).toContain('KOOKR_PORT=4801');
    expect(msg).toContain('KOOKR_PORT=auto');
  });
});

describe('probeListenPort', () => {
  it('returns true for a free ephemeral port', async () => {
    expect(await probeListenPort(0, '127.0.0.1')).toBe(true);
  });

  it('returns false when the port is already bound', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const port = (blocker.address() as AddressInfo).port;
    try {
      expect(await probeListenPort(port, '127.0.0.1')).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('resolveListenPort', () => {
  it('returns the requested port when the probe says it is free', async () => {
    const deps = makeDeps();
    const probe = vi.fn(async () => true);
    const result = await resolveListenPort('4800', '127.0.0.1', { ...deps, probe });
    expect(result).toEqual({ port: 4800, source: 'requested' });
    expect(probe).toHaveBeenCalledWith(4800, '127.0.0.1');
    expect(deps.exits).toEqual([]);
    expect(deps.errors).toEqual([]);
  });

  it('exits with a structured EADDRINUSE message when the requested port is busy', async () => {
    const deps = makeDeps();
    const probe = vi.fn(async () => false);
    await resolveListenPort('4800', '127.0.0.1', { ...deps, probe });
    expect(deps.exits).toEqual([1]);
    const joined = deps.errors.join('\n');
    expect(joined).toContain('Port 4800 on 127.0.0.1 is already in use');
    expect(joined).toContain('KOOKR_PORT=auto');
    expect(joined).toContain('lsof -ti:4800');
  });

  it('rejects non-numeric, out-of-range, or non-integer ports', async () => {
    for (const bad of ['abc', '0', '-5', '70000', '4800.5']) {
      const deps = makeDeps();
      await resolveListenPort(bad, '127.0.0.1', {
        ...deps,
        probe: async () => true,
      });
      expect(deps.exits).toEqual([1]);
      expect(deps.errors.join('\n')).toContain(`KOOKR_PORT=${bad}`);
    }
  });

  it('defaults to 4800 when env is missing', async () => {
    const deps = makeDeps();
    const probe = vi.fn(async () => true);
    const result = await resolveListenPort(undefined, '127.0.0.1', { ...deps, probe });
    expect(result).toEqual({ port: 4800, source: 'requested' });
    expect(probe).toHaveBeenCalledWith(4800, '127.0.0.1');
  });

  it('auto-selects the first free port in [autoMin, autoMax]', async () => {
    const deps = makeDeps();
    const busy = new Set([4800, 4801, 4802]);
    const probe = vi.fn(async (p: number) => !busy.has(p));
    const result = await resolveListenPort('auto', '127.0.0.1', {
      ...deps,
      probe,
      autoMin: 4800,
      autoMax: 4810,
    });
    expect(result).toEqual({ port: 4803, source: 'auto' });
    expect(deps.exits).toEqual([]);
  });

  it('exits when KOOKR_PORT=auto finds no free port in range', async () => {
    const deps = makeDeps();
    const probe = vi.fn(async () => false);
    await resolveListenPort('AUTO', '127.0.0.1', {
      ...deps,
      probe,
      autoMin: 4800,
      autoMax: 4802,
    });
    expect(deps.exits).toEqual([1]);
    expect(deps.errors.join('\n')).toContain('no free port found in range 4800-4802');
  });

  it('matches "auto" case-insensitively and trims surrounding whitespace', async () => {
    const deps = makeDeps();
    const probe = vi.fn(async () => true);
    const result = await resolveListenPort('  Auto  ', '127.0.0.1', {
      ...deps,
      probe,
      autoMin: 4800,
      autoMax: 4810,
    });
    expect(result).toEqual({ port: 4800, source: 'auto' });
  });
});
