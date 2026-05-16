import { describe, test, expect, vi } from 'vitest';
import type { ProjectSummary } from '../../shared/protocol.js';
import { resolveParameterSource, mergeSourceAndStaticOptions } from './playbook-source-resolver.js';

function makeSummary(project: string, displayName: string): ProjectSummary {
  return {
    project,
    displayName,
    color: 0,
    activeAgents: 0,
    findingCount: 0,
    todayPrCount: 0,
    weekPrCount: 0,
    openPrs: 0,
    recentTasks: [],
  };
}

describe('resolveParameterSource', () => {
  const summaries: ProjectSummary[] = [
    makeSummary('github.com/grafana/grafana', 'grafana/grafana'),
    makeSummary('github.com/microsoft/vscode', 'microsoft/vscode'),
    makeSummary('local/my-project', 'my-project'),
  ];

  test('tracked-projects returns hosted projects only', async () => {
    const result = await resolveParameterSource('tracked-projects', summaries);
    expect(result).toEqual([
      { label: 'grafana/grafana', value: 'grafana/grafana' },
      { label: 'microsoft/vscode', value: 'microsoft/vscode' },
    ]);
  });

  test('tracked-projects filters out local/ projects', async () => {
    const result = await resolveParameterSource('tracked-projects', summaries);
    const values = result.map((o) => o.value);
    expect(values).not.toContain('my-project');
  });

  test('tracked-projects with empty summaries returns empty array', async () => {
    const result = await resolveParameterSource('tracked-projects', []);
    expect(result).toEqual([]);
  });

  test('unknown source returns empty array with console warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveParameterSource('nonexistent-source', summaries);
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith('Unknown playbook parameter source: "nonexistent-source"');
    warnSpy.mockRestore();
  });
});

describe('mergeSourceAndStaticOptions', () => {
  test('source only — returns source options', () => {
    const source = [
      { label: 'grafana/grafana', value: 'grafana/grafana' },
    ];
    const result = mergeSourceAndStaticOptions(source, undefined);
    expect(result).toEqual(source);
  });

  test('static only — returns static options', () => {
    const staticOpts = [
      { label: 'Fallback', value: 'fallback/repo' },
    ];
    const result = mergeSourceAndStaticOptions([], staticOpts);
    expect(result).toEqual(staticOpts);
  });

  test('both empty — returns empty', () => {
    expect(mergeSourceAndStaticOptions([], [])).toEqual([]);
  });

  test('merge with dedup: static overrides label for matching value', () => {
    const source = [
      { label: 'grafana/grafana', value: 'grafana/grafana' },
      { label: 'microsoft/vscode', value: 'microsoft/vscode' },
    ];
    const staticOpts = [
      { label: 'grafana/grafana (TypeScript)', value: 'grafana/grafana' },
      { label: 'denoland/deno', value: 'denoland/deno' },
    ];
    const result = mergeSourceAndStaticOptions(source, staticOpts);
    expect(result).toEqual([
      { label: 'grafana/grafana (TypeScript)', value: 'grafana/grafana' },
      { label: 'microsoft/vscode', value: 'microsoft/vscode' },
      { label: 'denoland/deno', value: 'denoland/deno' },
    ]);
  });

  test('no duplicates when values match', () => {
    const source = [{ label: 'a', value: 'a' }];
    const staticOpts = [{ label: 'A label', value: 'a' }];
    const result = mergeSourceAndStaticOptions(source, staticOpts);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('A label');
  });
});
