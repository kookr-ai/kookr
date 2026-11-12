import { describe, expect, it, vi } from 'vitest';
import {
  LUCY_EARS_COMPOSE_PROJECT,
  NO_GPU_REASON,
  lucyEarsComposeIdentity,
  ownsBundledLucyEars,
  parseLucyEarsPort,
  parseLucyEarsTimeoutMs,
  startLucyEars,
  stopBundledLucyEars,
  type LucyEarsIo,
  type LucyEarsState,
} from './lucy-ears-manager.js';

function fakeIo(over: Partial<LucyEarsIo> = {}): LucyEarsIo & { clock: { t: number } } {
  const clock = { t: 0 };
  return {
    clock,
    hasNvidia: async () => true,
    isHealthy: async () => false,
    composeUp: async () => {},
    composeDown: async () => {},
    sleep: async (ms) => { clock.t += ms; },
    now: () => clock.t,
    ...over,
  };
}

describe('startLucyEars', () => {
  it('does not start anything and says why when there is no NVIDIA GPU', async () => {
    const composeUp = vi.fn();
    const h = startLucyEars({ earsDir: '/app/lucy-ears', io: fakeIo({ hasNvidia: async () => false, composeUp }) });
    await h.settled;
    expect(h.getState()).toEqual({ phase: 'unavailable', reason: NO_GPU_REASON });
    expect(composeUp).not.toHaveBeenCalled();
  });

  it('reports starting immediately, before bring-up has finished', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const h = startLucyEars({ earsDir: '/d', io: fakeIo({ hasNvidia: async () => { await gate; return false; } }) });
    expect(h.getState()).toEqual({ phase: 'starting' });
    release();
    await h.settled;
    expect(h.getState().phase).toBe('unavailable');
  });

  it('adopts a healthy recogniser even when the nvidia-runtime probe says no GPU (CDI hosts)', async () => {
    const h = startLucyEars({ earsDir: '/d', io: fakeIo({ hasNvidia: async () => false, isHealthy: async () => true }) });
    await h.settled;
    expect(h.getState().phase).toBe('ready');
  });

  it('adopts an already healthy recogniser with no compose call (hand-started or previous run)', async () => {
    const composeUp = vi.fn();
    const composeDown = vi.fn();
    const h = startLucyEars({ earsDir: '/d', port: 8095, io: fakeIo({ isHealthy: async () => true, composeUp, composeDown }) });
    await h.settled;
    expect(h.getState()).toEqual({ phase: 'ready', url: 'ws://127.0.0.1:8095' });
    expect(composeUp).not.toHaveBeenCalled();
    expect(composeDown).not.toHaveBeenCalled();
  });

  it('runs compose up under the lucy-ears project, then waits through a slow download until healthy', async () => {
    let polls = 0;
    const composeUp = vi.fn(async () => {});
    const io = fakeIo({ composeUp, isHealthy: async () => ++polls > 4 }); // 1 reuse probe + 3 loading polls
    const states: LucyEarsState[] = [];
    const h = startLucyEars({ earsDir: '/app/lucy-ears', port: 9001, io, startupTimeoutMs: 600_000 });
    h.onChange((s) => states.push(s));
    await h.settled;
    expect(composeUp).toHaveBeenCalledTimes(1);
    const [flags, env] = composeUp.mock.calls[0] as unknown as [string[], NodeJS.ProcessEnv, number];
    expect(flags).toEqual(['-p', LUCY_EARS_COMPOSE_PROJECT, '-f', '/app/lucy-ears/docker-compose.yml']);
    expect(env.KOOKR_LUCY_EARS_PORT).toBe('9001');
    expect(states).toEqual([{ phase: 'ready', url: 'ws://127.0.0.1:9001' }]);
    expect(io.clock.t).toBeGreaterThan(0);
  });

  it('leaves the container running (it may be the operator\'s) and explains when health never arrives', async () => {
    const composeDown = vi.fn(async () => {});
    const h = startLucyEars({ earsDir: '/d', io: fakeIo({ composeDown }), startupTimeoutMs: 10_000 });
    await h.settled;
    const s = h.getState();
    expect(s.phase).toBe('unavailable');
    expect((s as { reason: string }).reason).toContain('within 10s');
    expect((s as { reason: string }).reason).toContain('KOOKR_LUCY_EARS_HEALTH_TIMEOUT_S');
    expect(composeDown).not.toHaveBeenCalled();
  });

  it('spends one startup budget across compose up and the health wait', async () => {
    const io = fakeIo({ composeUp: async () => { io.clock.t += 8_000; } });
    const upTimeouts: number[] = [];
    io.composeUp = async (_f, _e, t) => { upTimeouts.push(t); io.clock.t += 8_000; };
    const h = startLucyEars({ earsDir: '/d', io, startupTimeoutMs: 10_000, pollIntervalMs: 1000 });
    await h.settled;
    expect(upTimeouts).toEqual([10_000]);
    expect(io.clock.t).toBeLessThanOrEqual(12_000); // not 8s + a fresh 10s
  });

  it('reports a failed compose up with its stderr and does not tear down', async () => {
    const composeDown = vi.fn();
    const composeUp = async () => { throw Object.assign(new Error('exit 1'), { stderr: 'no such image\n' }); };
    const h = startLucyEars({ earsDir: '/d', io: fakeIo({ composeUp, composeDown }) });
    await h.settled;
    const s = h.getState() as { phase: string; reason: string };
    expect(s.phase).toBe('unavailable');
    expect(s.reason).toContain('exit 1');
    expect(s.reason).toContain('no such image');
    expect(composeDown).not.toHaveBeenCalled();
  });

  it('turns an unexpected throw into an unavailable state instead of rejecting', async () => {
    const h = startLucyEars({ earsDir: '/d', io: fakeIo({ hasNvidia: async () => { throw new Error('boom'); } }) });
    await expect(h.settled).resolves.toBeUndefined();
    expect(h.getState()).toMatchObject({ phase: 'unavailable', reason: expect.stringContaining('boom') });
  });

  it('a throwing listener does not break bring-up, and unsubscribe stops notifications', async () => {
    const h = startLucyEars({ earsDir: '/d', io: fakeIo({ isHealthy: async () => true }) });
    const seen = vi.fn();
    h.onChange(() => { throw new Error('bad listener'); });
    const off = h.onChange(seen);
    off();
    await h.settled;
    expect(h.getState().phase).toBe('ready');
    expect(seen).not.toHaveBeenCalled();
  });

  it('stop runs compose down with the same project flags as start', async () => {
    const composeDown = vi.fn(async () => {});
    const h = startLucyEars({ earsDir: '/app/lucy-ears', io: fakeIo({ isHealthy: async () => true, composeDown }) });
    await h.settled;
    await h.stop();
    expect(composeDown.mock.calls[0][0]).toEqual(lucyEarsComposeIdentity('/app/lucy-ears', 8095).flags);
  });
});

describe('stopBundledLucyEars', () => {
  it('uses the same compose project and file as start', async () => {
    const composeDown = vi.fn(async () => {});
    await stopBundledLucyEars({ earsDir: '/prod/lucy-ears', port: 8095, io: { composeDown } });
    expect(composeDown.mock.calls[0][0]).toEqual(['-p', 'lucy-ears', '-f', '/prod/lucy-ears/docker-compose.yml']);
  });
});

describe('ownsBundledLucyEars', () => {
  it('owns the sidecar only when enabled and no URL is given', () => {
    expect(ownsBundledLucyEars({ KOOKR_LUCY_EARS: 'true' })).toBe(true);
    expect(ownsBundledLucyEars({ KOOKR_LUCY_EARS: '1' })).toBe(true);
    expect(ownsBundledLucyEars({})).toBe(false);
    expect(ownsBundledLucyEars({ KOOKR_LUCY_EARS: 'false' })).toBe(false);
  });
  it('an explicit URL means an external sidecar: not owned, even when enabled', () => {
    expect(ownsBundledLucyEars({ KOOKR_LUCY_EARS: 'true', KOOKR_LUCY_EARS_URL: 'ws://127.0.0.1:8095' })).toBe(false);
    expect(ownsBundledLucyEars({ KOOKR_LUCY_EARS: 'true', KOOKR_LUCY_EARS_URL: '   ' })).toBe(true);
  });
});

describe('env parsing', () => {
  it('port defaults to 8095 and rejects junk', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseLucyEarsPort(undefined)).toBe(8095);
    expect(parseLucyEarsPort('9100')).toBe(9100);
    expect(parseLucyEarsPort('0')).toBe(8095);
    expect(parseLucyEarsPort('70000')).toBe(8095);
    expect(parseLucyEarsPort('abc')).toBe(8095);
    warn.mockRestore();
  });
  it('health timeout is seconds, default 15 minutes, junk ignored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseLucyEarsTimeoutMs(undefined)).toBe(900_000);
    expect(parseLucyEarsTimeoutMs('60')).toBe(60_000);
    expect(parseLucyEarsTimeoutMs('-1')).toBe(900_000);
    warn.mockRestore();
  });
});
