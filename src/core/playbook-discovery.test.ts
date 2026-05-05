import { describe, test, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPlaybooks } from './playbook-discovery.js';

async function createTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-test-'));
}

const VALID_PLAYBOOK = `---
name: Test Playbook
description: A test playbook
---

Do the thing.
`;

const INVALID_PLAYBOOK = `No frontmatter here`;

describe('discoverPlaybooks', () => {
  test('returns empty array when .kookr/playbooks/ does not exist', async () => {
    const dir = await createTempProject();
    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('discovers playbooks from .kookr/playbooks/', async () => {
    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(join(pbDir, 'alpha.md'), VALID_PLAYBOOK);
    await writeFile(
      join(pbDir, 'beta.md'),
      '---\nname: Beta\n---\nBeta body.',
    );

    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('alpha.md');
      expect(result[0].name).toBe('Test Playbook');
      expect(result[0].sourceCwd).toBe(dir);
      expect(result[1].id).toBe('beta.md');
      expect(result[1].name).toBe('Beta');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('skips invalid playbook files', async () => {
    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(join(pbDir, 'good.md'), VALID_PLAYBOOK);
    await writeFile(join(pbDir, 'bad.md'), INVALID_PLAYBOOK);

    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Test Playbook');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('ignores non-.md files', async () => {
    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(join(pbDir, 'playbook.md'), VALID_PLAYBOOK);
    await writeFile(join(pbDir, 'readme.txt'), 'not a playbook');

    try {
      const result = await discoverPlaybooks(dir);
      expect(result).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('returns sorted by filename', async () => {
    const dir = await createTempProject();
    const pbDir = join(dir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(join(pbDir, 'z-last.md'), '---\nname: Z\n---\nZ');
    await writeFile(join(pbDir, 'a-first.md'), '---\nname: A\n---\nA');

    try {
      const result = await discoverPlaybooks(dir);
      expect(result[0].id).toBe('a-first.md');
      expect(result[1].id).toBe('z-last.md');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
