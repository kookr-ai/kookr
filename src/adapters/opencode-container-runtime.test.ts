import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { FakeDocker } from '../containers/fake-docker.js';
import { FakeTerminalBackend } from './fake-terminal-backend.js';
import { createOpenCodeContainerRuntime, isOpenCodeContainersEnabled } from './opencode-container-runtime.js';

describe('opencode container runtime wiring', () => {
  test('flag parsing: only 1/true/yes enable it', () => {
    for (const v of ['1', 'true', 'YES', ' yes ']) expect(isOpenCodeContainersEnabled({ KOOKR_OPENCODE_CONTAINERS: v })).toBe(true);
    for (const v of [undefined, '', '0', 'no', 'off']) expect(isOpenCodeContainersEnabled({ KOOKR_OPENCODE_CONTAINERS: v })).toBe(false);
  });

  test('flag off: nothing is constructed and docker is never touched', async () => {
    const docker = new FakeDocker();
    const rt = await createOpenCodeContainerRuntime({ taskStore: new TaskStore(), backend: new FakeTerminalBackend(), env: {}, hooksDir: '/tmp/x/hooks', docker });
    expect(rt).toBeUndefined();
    expect(docker.calls).toEqual([]);
  });

  test('flag on without an image: stays off and warns (never a silent half-configured mode)', async () => {
    const warn = vi.fn();
    const rt = await createOpenCodeContainerRuntime({ taskStore: new TaskStore(), backend: new FakeTerminalBackend(), env: { KOOKR_OPENCODE_CONTAINERS: '1' }, hooksDir: '/tmp/x/hooks', warn });
    expect(rt).toBeUndefined();
    expect(warn.mock.calls[0]![0]).toContain('KOOKR_OPENCODE_CONTAINER_IMAGE');
  });

  test('flag + image: builds the adapter under the data dir, persists an instance id, and defers watcher binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-rt-'));
    try {
      const rt = await createOpenCodeContainerRuntime({
        taskStore: new TaskStore(), backend: new FakeTerminalBackend(), hooksDir: join(dir, 'hooks'), docker: new FakeDocker(),
        env: { KOOKR_OPENCODE_CONTAINERS: 'true', KOOKR_OPENCODE_CONTAINER_IMAGE: 'img:1' },
      });
      expect(rt).toBeDefined();
      expect(await rt!.bindWatcher({ watch() {}, stop() {}, isWatching: () => false })).toEqual([]);
      rt!.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
