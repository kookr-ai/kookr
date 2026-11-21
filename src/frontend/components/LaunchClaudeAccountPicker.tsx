import React from 'react';
import { useClaudeAccounts } from '../store/claude-accounts.js';

/**
 * "Claude account" select for the Launch dialog. Hidden until at least one
 * account besides `host` is registered. The empty value means "use the default
 * account", which the server resolves.
 */
export function LaunchClaudeAccountPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { accounts, defaultName, hasRegistered } = useClaudeAccounts();
  if (!hasRegistered) return null;
  return (
    <label className="agent-type-select launch-claude-account">
      <span className="agent-type-select-label">Claude account</span>
      <select aria-label="Claude account" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Default ({defaultName})</option>
        {accounts.map((account) => (
          <option key={account.name} value={account.name} title={account.label}>{account.name}</option>
        ))}
      </select>
    </label>
  );
}
