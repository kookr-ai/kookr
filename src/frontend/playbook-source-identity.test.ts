import { describe, expect, test } from 'vitest';
import type { Playbook, PlaybookSourceIdentity } from '../shared/contracts/playbook.js';
import { isSamePlaybookResource, matchesPlaybookSource } from './playbook-source-identity.js';

function playbook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: 'triage.md',
    name: 'Triage',
    description: '',
    parameters: [],
    checklist: [],
    tags: [],
    body: '',
    scope: 'user',
    sourceCwd: '/home/dev/.kookr/playbooks',
    sourceDigest: 'sha-abc',
    ...overrides,
  };
}

const source: PlaybookSourceIdentity = {
  id: 'triage.md',
  scope: 'user',
  sourceCwd: '/home/dev/.kookr/playbooks',
  sourceDigest: 'sha-abc',
};

describe('isSamePlaybookResource (relaunch — path identity)', () => {
  test('matches the same resource path', () => {
    expect(isSamePlaybookResource(playbook(), source)).toBe(true);
  });

  test('rejects a same-id playbook from a different tier (the #2892 substitution)', () => {
    // A project-tier triage.md would win id precedence, but it is NOT the
    // resource the source task executed.
    expect(
      isSamePlaybookResource(playbook({ scope: 'project', sourceCwd: '/work/repo' }), source),
    ).toBe(false);
  });

  test('rejects a different sourceCwd within the same scope', () => {
    expect(isSamePlaybookResource(playbook({ sourceCwd: '/other/repo' }), source)).toBe(false);
  });

  test('still matches after an in-place edit (digest is ignored for relaunch)', () => {
    // Relaunch means "run this workflow again" against its current definition;
    // editing the file in place must not force a manual reselect.
    expect(isSamePlaybookResource(playbook({ sourceDigest: 'sha-edited' }), source)).toBe(true);
    expect(isSamePlaybookResource(playbook({ sourceDigest: undefined }), source)).toBe(true);
  });
});

describe('matchesPlaybookSource (schedule pin — exact version)', () => {
  test('matches the exact same resource and digest', () => {
    expect(matchesPlaybookSource(playbook(), source)).toBe(true);
  });

  test('rejects a same-path playbook edited to a new digest', () => {
    expect(matchesPlaybookSource(playbook({ sourceDigest: 'sha-def' }), source)).toBe(false);
  });

  test('rejects a same-id playbook from a different tier', () => {
    expect(
      matchesPlaybookSource(playbook({ scope: 'project', sourceCwd: '/work/repo' }), source),
    ).toBe(false);
  });

  test('rejects a catalog entry that never recorded a digest', () => {
    expect(matchesPlaybookSource(playbook({ sourceDigest: undefined }), source)).toBe(false);
  });
});
