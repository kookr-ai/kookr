import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Playbook, PlaybookParameter } from '../../core/playbook.js';

const { mockDiscoverPlaybooks, mockKbProbe, mockEvolutionConfigProbe } = vi.hoisted(() => ({
  mockDiscoverPlaybooks: vi.fn(),
  mockKbProbe: vi.fn(),
  mockEvolutionConfigProbe: vi.fn(),
}));

vi.mock('../../core/playbook-discovery.js', () => ({
  discoverPlaybooks: mockDiscoverPlaybooks,
}));

// preparePlaybookList only consumes CAPABILITY_PROBES; we mock the whole
// module so the table dispatches to the controlled fake.
vi.mock('../launch-capability-probe.js', () => ({
  CAPABILITY_PROBES: { kb: mockKbProbe, 'evolution-config': mockEvolutionConfigProbe },
}));

import { preparePlaybookList } from './playbook-list.js';

function param(overrides: Partial<PlaybookParameter> = {}): PlaybookParameter {
  return {
    name: overrides.name ?? 'p',
    description: overrides.description ?? '',
    required: overrides.required ?? false,
    ...overrides,
  };
}

function playbook(parameters: PlaybookParameter[]): Playbook {
  return {
    id: 'pb.md',
    scope: 'project',
    name: 'pb',
    description: '',
    parameters,
    checklist: [],
    tags: [],
    body: '',
    sourceCwd: '/p',
  };
}

describe('preparePlaybookList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns playbooks with no capabilities when no parameter is gated (no probe)', async () => {
    mockDiscoverPlaybooks.mockResolvedValueOnce([
      playbook([param({ name: 'plain' })]),
    ]);
    const result = await preparePlaybookList('/cwd');
    expect(result.playbooks).toHaveLength(1);
    expect(result.capabilities).toBeUndefined();
    expect(mockKbProbe).not.toHaveBeenCalled();
  });

  test('probes only the gated dependencies and attaches available state', async () => {
    mockDiscoverPlaybooks.mockResolvedValueOnce([
      playbook([param({ name: 'p1' }), param({ name: 'gated', gatedBy: 'kb' })]),
    ]);
    mockKbProbe.mockResolvedValueOnce('available');

    const result = await preparePlaybookList('/cwd');
    expect(mockKbProbe).toHaveBeenCalledTimes(1);
    expect(result.capabilities).toEqual({ kb: 'available' });
  });

  test('attaches absent state when the probe reports absent', async () => {
    mockDiscoverPlaybooks.mockResolvedValueOnce([
      playbook([param({ name: 'gated', gatedBy: 'kb' })]),
    ]);
    mockKbProbe.mockResolvedValueOnce('absent');

    const result = await preparePlaybookList('/cwd');
    expect(result.capabilities).toEqual({ kb: 'absent' });
  });

  test('omits the dependency key when the probe returns undefined (fail open)', async () => {
    mockDiscoverPlaybooks.mockResolvedValueOnce([
      playbook([param({ name: 'gated', gatedBy: 'kb' })]),
    ]);
    mockKbProbe.mockResolvedValueOnce(undefined);

    const result = await preparePlaybookList('/cwd');
    // `capabilities` exists (a gated param was discovered) but the kb key is
    // omitted so the form treats it as unknown → fail-open.
    expect(result.capabilities).toEqual({});
    expect(result.capabilities?.kb).toBeUndefined();
  });

  test('probes a dependency only once even when multiple parameters gate on it', async () => {
    mockDiscoverPlaybooks.mockResolvedValueOnce([
      playbook([
        param({ name: 'g1', gatedBy: 'kb' }),
        param({ name: 'g2', gatedBy: 'kb' }),
      ]),
      playbook([param({ name: 'g3', gatedBy: 'kb' })]),
    ]);
    mockKbProbe.mockResolvedValueOnce('available');

    await preparePlaybookList('/cwd');
    expect(mockKbProbe).toHaveBeenCalledTimes(1);
  });

  test('probes evolution config against the catalog cwd for evolution-gated parameters', async () => {
    mockDiscoverPlaybooks.mockResolvedValueOnce([
      playbook([param({ name: 'targetScore', gatedBy: 'evolution-config' })]),
    ]);
    mockEvolutionConfigProbe.mockResolvedValueOnce('available');

    const result = await preparePlaybookList('/project-with-config');

    expect(mockEvolutionConfigProbe).toHaveBeenCalledWith('/project-with-config');
    expect(result.capabilities).toEqual({ 'evolution-config': 'available' });
  });

  test('propagates a discoverPlaybooks rejection (probe failure cannot mask it)', async () => {
    mockDiscoverPlaybooks.mockRejectedValueOnce(new Error('readdir failed'));
    await expect(preparePlaybookList('/cwd')).rejects.toThrow('readdir failed');
  });
});
