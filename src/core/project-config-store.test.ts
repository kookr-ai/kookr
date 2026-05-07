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

  test('setLocalPathIfUnset writes when unset and persists synchronously', async () => {
    await store.load();
    const wrote = await store.setLocalPathIfUnset('github.com/org/repo', '/work/repo');
    expect(wrote).toBe(true);
    expect(store.getConfig('github.com/org/repo')?.localPath).toBe('/work/repo');

    // Reload from disk to confirm the save was awaited.
    const store2 = new ProjectConfigStore(tempDir);
    await store2.load();
    expect(store2.getConfig('github.com/org/repo')?.localPath).toBe('/work/repo');
  });

  test('setLocalPathIfUnset is a no-op when the field is already set', async () => {
    await store.load();
    await store.setLocalPathIfUnset('p', '/first/path');
    const wrote = await store.setLocalPathIfUnset('p', '/second/path');
    expect(wrote).toBe(false);
    expect(store.getConfig('p')?.localPath).toBe('/first/path');
  });

  test('setLocalPathIfUnset preserves other fields', async () => {
    await store.load();
    store.setConfig('p', { tracked: true, notes: 'hi' });
    const wrote = await store.setLocalPathIfUnset('p', '/work/repo');
    expect(wrote).toBe(true);
    const config = store.getConfig('p')!;
    expect(config.localPath).toBe('/work/repo');
    expect(config.tracked).toBe(true);
    expect(config.notes).toBe('hi');
  });

  test('setLocalPathIfUnset rejects empty string', async () => {
    await store.load();
    const wrote = await store.setLocalPathIfUnset('p', '');
    expect(wrote).toBe(false);
    expect(store.getConfig('p')).toBeUndefined();
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
