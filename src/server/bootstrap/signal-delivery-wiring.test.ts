import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { listSignalFiles, readSignal } from '../../observability/signal-delivery/operator-signal.js';
import { wireSignalDelivery } from './signal-delivery-wiring.js';

// Wiring-level coverage for issue #3924: with the owner-chat fallback active,
// detector broadcasts must land in the operator-signal outbox AND the delivery
// service must be built — otherwise alerts stay on the machine as before.

const FIRED_ALERT = {
  type: 'alert',
  severity: 'warning',
  summary: 'Permission prompt waiting 3 minutes',
  details: 'task t1 is waiting for approval',
  operationalAlert: { key: 'permission-prompt:t1', metric: 'permission_prompt_wait', state: 'fired' },
} as unknown as ServerMessage;

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-signal-wiring-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function waitForSignalFiles(dir: string): Promise<string[]> {
  let files: string[] = [];
  await vi.waitFor(async () => {
    files = await listSignalFiles(dir);
    expect(files.length).toBeGreaterThan(0);
  });
  return files;
}

describe('wireSignalDelivery (issue #3924)', () => {
  test('owner-chat fallback: detectors write alert files and the delivery service is built', async () => {
    const dir = await tempDir();
    const broadcastToAll = vi.fn();
    const warn = vi.fn();
    const wiring = wireSignalDelivery({
      env: { KOOKR_TELEGRAM_BOT_TOKEN: 'TOK', KOOKR_TELEGRAM_ALLOWED_USERS: '4242' } as NodeJS.ProcessEnv,
      broadcastToAll,
      dir,
      warn,
    });

    expect(wiring.destination.channels).toEqual(['telegram_owner_chat']);
    wiring.detectorBroadcast(FIRED_ALERT);
    expect(broadcastToAll).toHaveBeenCalledWith(FIRED_ALERT);

    const files = await waitForSignalFiles(dir);
    const signal = await readSignal(dir, files[0]!);
    expect(signal?.kind).toBe('alert');
    expect(signal?.title).toBe('Permission prompt waiting 3 minutes');

    const service = wiring.createDeliveryService();
    expect(service).not.toBeNull();
    expect(service!.status().configured).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test('no channel: dashboard only, no outbox write, no service, one start-up warning', async () => {
    const dir = await tempDir();
    const broadcastToAll = vi.fn();
    const warn = vi.fn();
    const wiring = wireSignalDelivery({
      env: { KOOKR_TELEGRAM_BOT_TOKEN: 'TOK', KOOKR_TELEGRAM_ALLOWED_USERS: '1,2' } as NodeJS.ProcessEnv,
      broadcastToAll,
      dir,
      warn,
    });

    wiring.detectorBroadcast(FIRED_ALERT);
    expect(broadcastToAll).toHaveBeenCalledWith(FIRED_ALERT);
    // Give a would-be async spool write a chance to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await listSignalFiles(dir)).toEqual([]);
    expect(wiring.createDeliveryService()).toBeNull();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(
      /server alerts go nowhere outside the dashboard: .*several allowed users/,
    );
  });
});
