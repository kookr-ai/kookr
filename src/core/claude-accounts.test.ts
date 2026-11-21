import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeAccountError,
  HOST_CLAUDE_ACCOUNT,
  effectiveClaudeAccount,
  emptyClaudeAccountRegistry,
  extractClaudeOAuthToken,
  loadClaudeAccounts,
  resolveClaudeAccountsFile,
  saveClaudeAccounts,
  summarizeClaudeAccounts,
  withAccount,
  withDefaultAccount,
  withoutAccount,
} from './claude-accounts.js';

const TOKEN_A = 'sk-ant-oat01-' + 'a'.repeat(30) + 'AAAA';
const TOKEN_B = 'sk-ant-oat01-' + 'b'.repeat(30) + 'BBBB';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-accounts-'));
  file = join(dir, 'nested', 'claude-accounts.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('claude account registry', () => {
  test('a missing file is an empty registry where everything runs on host', () => {
    const registry = loadClaudeAccounts(file);
    expect(registry.accounts).toEqual({});
    expect(effectiveClaudeAccount(registry, undefined)).toBe(HOST_CLAUDE_ACCOUNT);
  });

  test('round-trips through disk with owner-only permissions', () => {
    const registry = withDefaultAccount(withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_A), 'work');
    saveClaudeAccounts(registry, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const loaded = loadClaudeAccounts(file);
    expect(loaded.default).toBe('work');
    expect(loaded.accounts.work?.token).toBe(TOKEN_A);
  });

  test('a pinned account wins over the default; the default wins over host', () => {
    let registry = withAccount(withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_A), 'personal', TOKEN_B);
    registry = withDefaultAccount(registry, 'work');
    expect(effectiveClaudeAccount(registry, undefined)).toBe('work');
    expect(effectiveClaudeAccount(registry, 'personal')).toBe('personal');
    expect(effectiveClaudeAccount(registry, HOST_CLAUDE_ACCOUNT)).toBe(HOST_CLAUDE_ACCOUNT);
  });

  test('removing the default account makes host the default again', () => {
    const registry = withDefaultAccount(withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_A), 'work');
    expect(withoutAccount(registry, 'work').default).toBeUndefined();
  });

  test('host is reserved and names are restricted', () => {
    const empty = emptyClaudeAccountRegistry();
    expect(() => withAccount(empty, HOST_CLAUDE_ACCOUNT, TOKEN_A)).toThrow(ClaudeAccountError);
    for (const bad of ['', 'Work', 'a b', '../x', '-x', 'x'.repeat(41)]) {
      expect(() => withAccount(empty, bad, TOKEN_A)).toThrow(ClaudeAccountError);
    }
    expect(() => withAccount(empty, 'work', 'not-a-token')).toThrow(/setup-token/);
    expect(() => withDefaultAccount(empty, 'nope')).toThrow(/known: host/);
  });

  test('finds the token inside the output of claude setup-token', () => {
    expect(extractClaudeOAuthToken(`Your OAuth token (valid for 1 year):\n\n${TOKEN_A}\n\nStore it securely.`)).toBe(TOKEN_A);
    expect(extractClaudeOAuthToken('no token here')).toBeUndefined();
  });

  test('summaries never contain the token', () => {
    const registry = withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_A);
    const rows = summarizeClaudeAccounts(registry);
    expect(rows.map((r) => r.name)).toEqual([HOST_CLAUDE_ACCOUNT, 'work']);
    expect(rows[0]?.isDefault).toBe(true);
    expect(rows[1]?.tokenHint).toBe('…AAAA');
    expect(JSON.stringify(rows)).not.toContain(TOKEN_A);
  });

  test('a corrupt or inconsistent file throws rather than guessing an account', () => {
    writeFileSync(file.replace('nested/', ''), '{not json');
    expect(() => loadClaudeAccounts(file.replace('nested/', ''))).toThrow(/not valid JSON/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ version: 1, default: 'ghost', accounts: {} }));
    expect(() => loadClaudeAccounts(bad)).toThrow(/not registered/);
    writeFileSync(bad, JSON.stringify({ version: 1, accounts: { host: { token: TOKEN_A } } }));
    expect(() => loadClaudeAccounts(bad)).toThrow(/invalid entry/);
  });

  test('the file location honours the override variable', () => {
    expect(resolveClaudeAccountsFile({ KOOKR_CLAUDE_ACCOUNTS_FILE: '/x/y.json' })).toBe('/x/y.json');
    expect(resolveClaudeAccountsFile({ HOME: '/srv/op-home' })).toBe('/srv/op-home/.kookr/claude-accounts.json');
  });

  test('a save replaces the file atomically and leaves no temp file', () => {
    saveClaudeAccounts(withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_A), file);
    saveClaudeAccounts(withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_B), file);
    expect(readFileSync(file, 'utf-8')).toContain(TOKEN_B);
    expect(readFileSync(file, 'utf-8')).not.toContain(TOKEN_A);
  });
});
