import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OpenCodeProfileError,
  loadOpenCodeProfiles,
  parseOpenCodeProfile,
  resolveOpenCodeProfile,
  resolveOpenCodeProfilesDir,
} from './opencode-profiles.js';

const GOOD = `---
id: demo
description: A demo profile.
permission: allow
deliverable: file:OUT.md
shelves: [one, "two"]
model: deepinfra/some-model
---
Do the demo.

Second paragraph.
`;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-profiles-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseOpenCodeProfile', () => {
  it('parses every field and keeps the body as instructions', () => {
    expect(parseOpenCodeProfile(GOOD)).toEqual({
      id: 'demo',
      description: 'A demo profile.',
      permission: 'allow',
      deliverable: { kind: 'file', name: 'OUT.md' },
      shelves: ['one', 'two'],
      model: 'deepinfra/some-model',
      instructions: 'Do the demo.\n\nSecond paragraph.\n',
    });
  });

  it('defaults shelves to [] and omits model; accepts deliverable none / commit-and-pr-body', () => {
    const p = parseOpenCodeProfile('---\nid: x\ndescription: d\npermission: ask\ndeliverable: none\n---\nbody');
    expect(p.shelves).toEqual([]);
    expect(p).not.toHaveProperty('model');
    expect(p.deliverable).toEqual({ kind: 'none' });
    expect(parseOpenCodeProfile(GOOD.replace('file:OUT.md', 'commit-and-pr-body')).deliverable).toEqual({ kind: 'commit-and-pr-body' });
  });

  it.each([
    ['no frontmatter', 'just text', /missing YAML frontmatter/],
    ['unknown key', GOOD.replace('permission: allow', 'permision: allow\npermission: allow'), /unknown frontmatter key "permision"/],
    ['duplicate key', GOOD.replace('id: demo', 'id: demo\nid: demo2'), /duplicate frontmatter key "id"/],
    ['missing required', GOOD.replace('description: A demo profile.\n', ''), /missing required frontmatter key "description"/],
    ['bad id', GOOD.replace('id: demo', 'id: Bad_Id'), /id "Bad_Id"/],
    ['bad permission', GOOD.replace('permission: allow', 'permission: yolo'), /permission must be/],
    ['bad deliverable', GOOD.replace('file:OUT.md', 'zip'), /deliverable must be/],
    ['path-like deliverable file', GOOD.replace('file:OUT.md', 'file:../x'), /plain file name/],
    ['shelves not a list', GOOD.replace('[one, "two"]', 'one'), /shelves must be an inline list/],
    ['multi-line yaml', GOOD.replace('description: A demo profile.', 'description: |\n  multi'), /unparseable frontmatter line/],
    ['empty body', GOOD.split('Do the demo.')[0]!, /body .* is empty|missing YAML frontmatter/],
  ])('rejects %s with a clear message', (_n, text, re) => {
    expect(() => parseOpenCodeProfile(text, 'f.md')).toThrow(re);
    expect(() => parseOpenCodeProfile(text, 'f.md')).toThrow(/opencode profile f\.md/);
  });
});

describe('loadOpenCodeProfiles / resolveOpenCodeProfile (fixture dir)', () => {
  it('loads *.md only, sorted, and ignores other files', () => {
    writeFileSync(join(dir, 'a.md'), GOOD);
    writeFileSync(join(dir, 'b.md'), GOOD.replace('id: demo', 'id: other'));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    expect([...loadOpenCodeProfiles(dir).keys()]).toEqual(['demo', 'other']);
  });

  it('returns an empty map for a missing dir and throws on duplicate ids or an invalid file', () => {
    expect(loadOpenCodeProfiles(join(dir, 'nope')).size).toBe(0);
    writeFileSync(join(dir, 'a.md'), GOOD);
    writeFileSync(join(dir, 'b.md'), GOOD);
    expect(() => loadOpenCodeProfiles(dir)).toThrow(/duplicate profile id "demo"/);
    writeFileSync(join(dir, 'b.md'), 'garbage');
    expect(() => loadOpenCodeProfiles(dir)).toThrow(/b\.md/);
  });

  it('throws a typed unknown_profile error listing valid ids', () => {
    writeFileSync(join(dir, 'a.md'), GOOD);
    mkdirSync(join(dir, 'sub'));
    expect(resolveOpenCodeProfile('demo', dir).id).toBe('demo');
    try {
      resolveOpenCodeProfile('nope', dir);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OpenCodeProfileError);
      expect((err as OpenCodeProfileError).code).toBe('unknown_profile');
      expect((err as Error).message).toContain('valid profiles: demo');
    }
  });

  it('honours KOOKR_OPENCODE_PROFILES_DIR', () => {
    expect(resolveOpenCodeProfilesDir({ KOOKR_OPENCODE_PROFILES_DIR: dir })).toBe(dir);
  });
});

describe('real plugin/opencode-profiles', () => {
  const real = loadOpenCodeProfiles();

  it('ships scoped-fix, reviewer and test-auditor with the expected deliverables', () => {
    expect([...real.keys()].sort()).toEqual(['reviewer', 'scoped-fix', 'test-auditor']);
    expect(real.get('scoped-fix')!.deliverable).toEqual({ kind: 'commit-and-pr-body' });
    expect(real.get('reviewer')!.deliverable).toEqual({ kind: 'file', name: 'REVIEW.md' });
    expect(real.get('test-auditor')!.deliverable).toEqual({ kind: 'file', name: 'AUDIT.md' });
    for (const p of real.values()) {
      expect(p.permission).toBe('allow');
      expect(p.instructions!.length).toBeGreaterThan(200);
      expect(p.shelves!.length).toBeGreaterThan(0);
    }
  });
});
