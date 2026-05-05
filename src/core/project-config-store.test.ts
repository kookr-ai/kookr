import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectConfigStore } from './project-config-store.js';

describe('ProjectConfigStore', () => {
  let tempDir: string;
  let store: ProjectConfigStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-test-'));
    store = new ProjectConfigStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('starts empty', async () => {
    await store.load();
    expect(store.getAllConfigs()).toEqual([]);
    expect(store.getConfig('anything')).toBeUndefined();
  });

  test('set and get config', async () => {
    await store.load();
    const config = store.setConfig('github.com/org/repo', {
      dailyPrLimit: 3,
      notes: 'Be careful',
    });
    expect(config.project).toBe('github.com/org/repo');
    expect(config.dailyPrLimit).toBe(3);
    expect(config.notes).toBe('Be careful');
    expect(store.getConfig('github.com/org/repo')).toEqual(config);
  });

  test('update existing config', async () => {
    await store.load();
    store.setConfig('github.com/org/repo', { dailyPrLimit: 2 });
    store.setConfig('github.com/org/repo', { notes: 'Updated' });
    const config = store.getConfig('github.com/org/repo')!;
    expect(config.dailyPrLimit).toBe(2);
    expect(config.notes).toBe('Updated');
  });

  test('persist and reload', async () => {
    await store.load();
    store.setConfig('github.com/org/repo', { dailyPrLimit: 5, notes: 'Test' });
    await store.save();

    const store2 = new ProjectConfigStore(tempDir);
    await store2.load();
    const config = store2.getConfig('github.com/org/repo')!;
    expect(config.dailyPrLimit).toBe(5);
    expect(config.notes).toBe('Test');
  });

  test('getAllConfigs returns all entries', async () => {
    await store.load();
    store.setConfig('a', { dailyPrLimit: 1 });
    store.setConfig('b', { dailyPrLimit: 2 });
    expect(store.getAllConfigs()).toHaveLength(2);
  });
});

describe('ProjectConfigStore — rate limits', () => {
  let tempDir: string;
  let store: ProjectConfigStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ratelimit-test-'));
    store = new ProjectConfigStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('loads rate limits from rate-limits.json', async () => {
    writeFileSync(join(tempDir, 'rate-limits.json'), JSON.stringify({
      defaults: { maxPrsPerDay: 1 },
      overrides: { 'grafana/grafana': { maxPrsPerDay: 2 } },
      blocked: ['ggml-org/llama.cpp'],
    }));

    await store.load();
    await store.loadRateLimits();

    expect(store.getEffectiveDailyLimit('github.com/grafana/grafana')).toBe(2);
    expect(store.getEffectiveDailyLimit('github.com/rust-lang/rust')).toBe(1);
    expect(store.isBlocked('github.com/ggml-org/llama.cpp')).toBe(true);
    expect(store.isBlocked('github.com/grafana/grafana')).toBe(false);
  });

  test('manual config takes precedence over rate-limits.json', async () => {
    writeFileSync(join(tempDir, 'rate-limits.json'), JSON.stringify({
      defaults: { maxPrsPerDay: 1 },
      overrides: {},
      blocked: [],
    }));

    await store.load();
    await store.loadRateLimits();
    store.setConfig('github.com/org/repo', { dailyPrLimit: 5 });

    expect(store.getEffectiveDailyLimit('github.com/org/repo')).toBe(5);
  });

  test('returns undefined when no rate-limits.json exists', async () => {
    await store.load();
    await store.loadRateLimits();

    expect(store.getEffectiveDailyLimit('github.com/org/repo')).toBeUndefined();
  });

  test('getBlockedRepos returns all blocked repos', async () => {
    writeFileSync(join(tempDir, 'rate-limits.json'), JSON.stringify({
      defaults: { maxPrsPerDay: 1 },
      overrides: {},
      blocked: ['ggml-org/llama.cpp', 'some/other-repo'],
    }));

    await store.load();
    await store.loadRateLimits();

    expect(store.getBlockedRepos().sort()).toEqual(['ggml-org/llama.cpp', 'some/other-repo']);
  });

  test('local projects return null for daily limit', async () => {
    writeFileSync(join(tempDir, 'rate-limits.json'), JSON.stringify({
      defaults: { maxPrsPerDay: 1 },
      overrides: {},
      blocked: [],
    }));

    await store.load();
    await store.loadRateLimits();

    // Local projects don't have a repo name, so rate limits don't apply
    expect(store.isBlocked('local/my-project')).toBe(false);
  });
});
