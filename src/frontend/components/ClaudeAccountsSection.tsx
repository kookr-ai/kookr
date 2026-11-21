import React, { useEffect, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import {
  accountStatus,
  addAccount,
  refreshClaudeAccounts,
  removeAccount,
  setDefaultAccount,
  testAccount,
  useClaudeAccounts,
} from '../store/claude-accounts.js';
import type { ClaudeAccountView } from '../../shared/contracts/claude-accounts.js';
import { QuotaRows } from './UsageSummary.js';

/**
 * Settings → Accounts. Lists the host login and every registered Claude
 * account, lets the operator pick the account new tasks use, test any account
 * (including one that is out of quota) and add or remove accounts. Tokens are
 * write-only: the field is cleared the moment the form is submitted.
 */

type FieldErrors = { name?: string; token?: string; label?: string; form?: string };

function fieldErrorsFor(code: string | undefined, error: string): FieldErrors {
  if (code === 'invalid_name' || code === 'reserved_name') return { name: error };
  if (code === 'invalid_token') return { token: error };
  if (code === 'invalid_label') return { label: error };
  return { form: error };
}

function AccountRow({ account }: { account: ClaudeAccountView }) {
  const { tests, testing } = useClaudeAccounts();
  const quotaStatus = useKookrStore((s) => s.quotaStatus);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isHost = account.name === 'host';
  const test = tests[account.name];
  const status = accountStatus(test);
  const outOfQuota = status.outcome === 'usage_limited';
  const isTesting = testing[account.name] === true;
  const hasQuota = Boolean(quotaStatus && (quotaStatus.fiveHour || quotaStatus.sevenDay));

  async function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.error);
  }

  return (
    <div className="settings-row claude-account-row" data-testid={`claude-account-row-${account.name}`}>
      <input
        type="radio"
        name="claude-default-account"
        className="claude-account-radio"
        checked={account.isDefault}
        aria-label={`Use ${account.name} for new tasks`}
        onChange={() => { void run(() => setDefaultAccount(account.name)); }}
      />
      <div className="settings-row-info claude-account-info">
        <div className="claude-account-heading">
          <span className="claude-account-name">{account.name}</span>
          {account.isDefault && <span className="claude-account-default">New tasks</span>}
          <span
            className={`settings-permission-status claude-account-status claude-account-status--${status.tone}`}
            data-testid={`claude-account-status-${account.name}`}
            title={test?.message}
          >
            {status.label}
          </span>
        </div>
        <div className="settings-desc claude-account-meta">
          {isHost ? 'The host’s own claude login' : (account.label ?? 'No label')}
          {account.tokenHint && <> {'·'} token ending {account.tokenHint}</>}
        </div>
        {test?.message && <div className="settings-desc claude-account-message">{test.message}</div>}
        {outOfQuota && (
          <div className="settings-desc">Test now checks whether this account&apos;s quota is back.</div>
        )}
        {isHost && quotaStatus && hasQuota && (
          <div className="claude-account-quota">
            <QuotaRows quota={quotaStatus} />
          </div>
        )}
        {!isHost && (
          <div className="settings-desc claude-account-no-usage">Usage not available for this account.</div>
        )}
        {error && <div className="settings-error claude-account-error" role="alert">{error}</div>}
      </div>
      <div className="claude-account-actions">
        {confirmingRemove ? (
          <>
            <span className="settings-desc">Remove {account.name}?</span>
            <button
              type="button"
              className="settings-button"
              onClick={() => { setConfirmingRemove(false); void run(() => removeAccount(account.name)); }}
            >
              Remove
            </button>
            <button type="button" className="settings-button secondary" onClick={() => setConfirmingRemove(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="settings-button"
              disabled={isTesting}
              title={outOfQuota ? 'Check whether this account’s quota is back' : undefined}
              onClick={() => { void run(() => testAccount(account.name)); }}
            >
              {isTesting ? 'Testing…' : outOfQuota ? 'Test now' : 'Test'}
            </button>
            {!isHost && (
              <button type="button" className="settings-button secondary" onClick={() => setConfirmingRemove(true)}>
                Remove
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AddAccountForm({ onlyHost }: { onlyHost: boolean }) {
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const request = { name: name.trim(), token: token.trim(), ...(label.trim() ? { label: label.trim() } : {}) };
    // The token never outlives the submit: clear the field before awaiting.
    setToken('');
    setErrors({});
    setNotice(null);
    setBusy(true);
    const added = await addAccount(request);
    if (!added.ok) {
      setErrors(fieldErrorsFor(added.code, added.error));
      setBusy(false);
      return;
    }
    setName('');
    setLabel('');
    const tested = await testAccount(request.name);
    setNotice(tested.ok ? `Added ${request.name}.` : `Added ${request.name}, but the test failed: ${tested.error}`);
    setBusy(false);
  }

  return (
    <div className="settings-section" data-testid="claude-account-add">
      <div className="settings-section-title">{onlyHost ? 'Add your second account' : 'Add account'}</div>
      <div className="settings-desc claude-account-steps">
        1. In a browser signed in to that Claude account, run <code>claude setup-token</code>.
        {' '}2. Paste what it prints below.
      </div>
      <form onSubmit={(e) => { void submit(e); }} autoComplete="off">
        <div className="settings-field">
          <label htmlFor="claude-account-name">Account name</label>
          <input
            id="claude-account-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="work"
            aria-invalid={errors.name ? true : undefined}
          />
          {errors.name && <div className="settings-error" role="alert">{errors.name}</div>}
        </div>
        <div className="settings-field">
          <label htmlFor="claude-account-label">Email or label (optional)</label>
          <input
            id="claude-account-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="me@example.com"
            aria-invalid={errors.label ? true : undefined}
          />
          {errors.label && <div className="settings-error" role="alert">{errors.label}</div>}
        </div>
        <div className="settings-field">
          <label htmlFor="claude-account-token">Token</label>
          <input
            id="claude-account-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste the output of claude setup-token"
            aria-invalid={errors.token ? true : undefined}
          />
          {errors.token && <div className="settings-error" role="alert">{errors.token}</div>}
        </div>
        {errors.form && <div className="settings-error" role="alert">{errors.form}</div>}
        {notice && <div className="settings-desc" role="status">{notice}</div>}
        <button type="submit" className="settings-button" disabled={busy || !name.trim() || !token.trim()}>
          {busy ? 'Adding…' : 'Add and test'}
        </button>
      </form>
    </div>
  );
}

export function ClaudeAccountsSection(): React.ReactElement {
  const { accounts, loaded, loadError, hasRegistered } = useClaudeAccounts();

  useEffect(() => { void refreshClaudeAccounts(); }, []);

  return (
    <>
      <div className="settings-section" data-testid="claude-accounts-section">
        <div className="settings-section-title">Claude accounts</div>
        <div className="settings-desc claude-accounts-intro">
          Pick the Claude account new tasks run on. Quota bars in the sidebar always show the host login.
        </div>
        {!loaded && <div className="settings-loading">Loading...</div>}
        {loadError && <div className="settings-error" role="alert">{loadError}</div>}
        <div role="radiogroup" aria-label="Account for new tasks">
          {accounts.map((account) => <AccountRow key={account.name} account={account} />)}
        </div>
      </div>
      <AddAccountForm onlyHost={!hasRegistered} />
    </>
  );
}
