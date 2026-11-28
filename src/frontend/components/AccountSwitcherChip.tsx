import React, { useCallback, useRef, useState } from 'react';
import { usePopoverDismiss } from '../hooks/usePopoverDismiss.js';
import {
  accountStatus,
  accountTitle,
  setDefaultAccount,
  testAccount,
  useClaudeAccounts,
} from '../store/claude-accounts.js';
import { AccountTestQuota } from './AccountTestQuota.js';

/**
 * Footer chip naming the account new tasks launch on, with a popover to change
 * it and to test any account. Renders nothing until a second account exists, so
 * single-account setups see no new chrome.
 */
export function AccountSwitcherChip({ onOpenAccountSettings }: { onOpenAccountSettings?: () => void }) {
  const { accounts, defaultName, tests, testing, hasRegistered } = useClaudeAccounts();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePopoverDismiss(open, close, popoverRef, triggerRef);

  if (!hasRegistered) return null;
  const current = accounts.find((a) => a.name === defaultName);
  const currentName = current?.name ?? defaultName;

  function toggle() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setAnchor({ left: Math.max(8, rect.left), bottom: Math.max(8, window.innerHeight - rect.top + 4) });
      setError(null);
    }
    setOpen((value) => !value);
  }

  async function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.error);
  }

  return (
    <div className="account-chip-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="account-chip"
        data-testid="account-chip"
        title={current ? accountTitle(current) : currentName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`New tasks use the ${currentName} Claude account. Change account`}
        onClick={toggle}
      >
        <span className="account-chip-full">New tasks: {currentName}</span>
        <span className="account-chip-short" aria-hidden="true">{currentName.slice(0, 2)}</span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="account-popover"
          role="dialog"
          aria-label="Claude accounts"
          data-testid="account-popover"
          style={anchor ? { left: anchor.left, bottom: anchor.bottom } : undefined}
        >
          <div className="account-popover-title">Account for new tasks</div>
          <div role="radiogroup" aria-label="Account for new tasks">
            {accounts.map((account) => {
              const status = accountStatus(tests[account.name]);
              const outOfQuota = status.outcome === 'usage_limited';
              return (
                <div className="account-popover-row" key={account.name} data-testid={`account-popover-row-${account.name}`}>
                  <input
                    type="radio"
                    name="footer-default-account"
                    checked={account.isDefault}
                    aria-label={`Use ${account.name} for new tasks`}
                    onChange={() => { void run(() => setDefaultAccount(account.name)); }}
                  />
                  <span className="account-popover-name" title={account.label}>{account.name}</span>
                  <span
                    className={`claude-account-status claude-account-status--${status.tone}`}
                    data-testid={`account-popover-status-${account.name}`}
                  >
                    {status.label}
                  </span>
                  <button
                    type="button"
                    className="settings-button"
                    disabled={testing[account.name] === true}
                    onClick={() => { void run(() => testAccount(account.name)); }}
                  >
                    {testing[account.name] ? 'Testing…' : outOfQuota ? 'Test now' : 'Test'}
                  </button>
                  {account.name !== 'host' && <AccountTestQuota test={tests[account.name]} />}
                </div>
              );
            })}
          </div>
          {error && <div className="settings-error" role="alert">{error}</div>}
          <div className="settings-desc">Sidebar bars show the host login. An account&apos;s own bars appear after you test it.</div>
          {onOpenAccountSettings && (
            <button
              type="button"
              className="settings-button secondary account-popover-manage"
              onClick={() => { setOpen(false); onOpenAccountSettings(); }}
            >
              Manage accounts in Settings{'…'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
