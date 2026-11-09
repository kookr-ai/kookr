import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveSessionPolicy, type SessionPolicyDeps } from './opencode-session-policy.js';

describe('resolveSessionPolicy', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-policy-'));
    writeFileSync(join(dir, 'p.md'), '---\nid: p\ndescription: d\npermission: ask\ndeliverable: file:X.md\nshelves: [alpha]\n---\nBe careful.\n');
    writeFileSync(join(dir, 'q.md'), '---\nid: q\ndescription: d\npermission: allow\ndeliverable: file:X.md\n---\nPlain.\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const deps = (over: Partial<SessionPolicyDeps> = {}): SessionPolicyDeps => ({
    profilesDir: dir, defaultPermission: 'allow', env: {}, warn: () => {}, ...over,
  });

  test('no profile: constructor defaults apply', async () => {
    const r = await resolveSessionPolicy(deps({ defaultProfile: { instructions: 'base' } }), {});
    expect(r).toEqual({ permission: 'allow', instructions: 'base' });
  });
  test('profile posture beats the default; per-call bypass beats both', async () => {
    expect((await resolveSessionPolicy(deps({ defaultPermission: 'ask' }), { profileId: 'q' })).permission).toBe('allow');
    const shelfShow = vi.fn().mockResolvedValue('');
    expect((await resolveSessionPolicy(deps({ shelfShow }), { profileId: 'p' })).permission).toBe('ask');
    expect((await resolveSessionPolicy(deps({ shelfShow }), { profileId: 'p', bypassPermissions: true })).permission).toBe('allow');
    expect((await resolveSessionPolicy(deps(), { profileId: 'q', bypassPermissions: false })).permission).toBe('ask');
  });
  test('shelf lessons are appended after the profile instructions using the session env', async () => {
    const shelfShow = vi.fn().mockResolvedValue('- a lesson\n');
    const r = await resolveSessionPolicy(deps({ shelfShow, env: { A: '1' } }), { profileId: 'p', extraEnv: { NB_DIR: '/x' } });
    expect(r.instructions).toContain('Be careful.');
    expect(r.instructions).toContain('a lesson');
    expect(r.instructions!.indexOf('Be careful.')).toBeLessThan(r.instructions!.indexOf('a lesson'));
    expect(shelfShow.mock.calls[0]).toBeDefined();
  });
  test('an unknown profile id throws a typed error', async () => {
    await expect(resolveSessionPolicy(deps(), { profileId: 'nope' })).rejects.toThrow();
  });
});
