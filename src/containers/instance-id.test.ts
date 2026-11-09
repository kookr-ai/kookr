import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getOrCreateInstanceId, readInstanceId } from './instance-id.js';

describe('instance id', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-iid-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('is created once and stable across calls, including concurrent first calls', async () => {
    expect(await readInstanceId(dir)).toBeUndefined();
    const ids = await Promise.all([getOrCreateInstanceId(dir), getOrCreateInstanceId(dir), getOrCreateInstanceId(dir)]);
    expect(new Set(ids).size).toBe(1);
    expect(await getOrCreateInstanceId(dir)).toBe(ids[0]);
    expect(await readInstanceId(dir)).toBe(ids[0]);
    expect(readFileSync(join(dir, 'instance-id'), 'utf8').trim()).toBe(ids[0]);
  });

  test('a corrupt file is an error, never silently replaced (that would orphan labelled containers)', async () => {
    writeFileSync(join(dir, 'instance-id'), 'garbage');
    await expect(getOrCreateInstanceId(dir)).rejects.toThrow('refusing to replace');
    expect(readFileSync(join(dir, 'instance-id'), 'utf8')).toBe('garbage');
    expect(await readInstanceId(dir)).toBeUndefined();
  });
});
