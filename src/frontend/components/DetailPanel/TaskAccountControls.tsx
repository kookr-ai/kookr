import React, { useCallback, useRef, useState } from 'react';
import type { AgentState } from '../../../shared/contracts/agent-state.js';
import { switchTaskClaudeAccount } from '../../api/claude-accounts.js';
import { usePopoverDismiss } from '../../hooks/usePopoverDismiss.js';
import {
  accountStatus,
  accountTitle,
  pickContinueAccount,
  testAccount,
  useClaudeAccounts,
} from '../../store/claude-accounts.js';

/*
 * Claude account controls for one task: a header badge with a "Move this task
 * to..." menu, and a banner when the task stopped on its account's usage limit.
 * Both render nothing for agents other than Claude Code.
 */

/** The account a task runs on; absent means the host login. */
export function taskClaudeAccount(agent: AgentState): string {
  return agent.claudeAccount ?? 'host';
}

type SwitchResult = { kind: 'ok' | 'error'; text: string };

/** Ask the server to restart the task on `account`; returns a line to show inline. */
async function switchAccount(taskId: string, account: string): Promise<SwitchResult> {
  try {
    const res = await switchTaskClaudeAccount(taskId, account);
    const body = res.body as { error?: string; to?: string } | null;
    if (res.ok) return { kind: 'ok', text: `Moved to ${body?.to ?? account}.` };
    return { kind: 'error', text: body?.error ?? `Could not switch account (HTTP ${res.status})` };
  } catch (err) {
    return { kind: 'error', text: err instanceof Error ? err.message : 'Could not switch account' };
  }
}

export function TaskAccountBadge({ agent }: { agent: AgentState }) {
  const { accounts, hasRegistered } = useClaudeAccounts();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SwitchResult | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePopoverDismiss(open, close, menuRef, triggerRef);

  if (agent.agentType !== 'claude-code' || !agent.taskId) return null;
  const taskId = agent.taskId;
  const current = taskClaudeAccount(agent);
  // Nothing to choose between until a second account exists.
  if (!hasRegistered && current === 'host') return null;

  async function moveTo(name: string) {
    setBusy(true);
    setResult(null);
    const outcome = await switchAccount(taskId, name);
    setResult(outcome);
    setBusy(false);
    if (outcome.kind === 'ok') setOpen(false);
  }

  return (
    <span className="task-account">
      <button
        ref={triggerRef}
        type="button"
        className="detail-badge task-account-badge"
        data-testid="task-account-badge"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Account {current} {'▾'}
      </button>
      {result && !open && (
        <span
          className={`task-account-result task-account-result--${result.kind}`}
          role={result.kind === 'error' ? 'alert' : 'status'}
          data-testid="task-account-result"
        >
          {result.text}
        </span>
      )}
      {open && (
        <div ref={menuRef} className="task-account-menu" role="menu" aria-label="Move this task to" data-testid="task-account-menu">
          <div className="task-account-menu-title">Move this task to{'…'}</div>
          {accounts.map((account) => (
            <button
              key={account.name}
              type="button"
              role="menuitemradio"
              aria-checked={account.name === current}
              className="task-account-item"
              disabled={busy || account.name === current}
              title={account.label}
              onClick={() => { void moveTo(account.name); }}
            >
              <span>{account.name}</span>
              {account.name === current && <span className="task-account-current">current</span>}
            </button>
          ))}
          <div className="settings-desc">Restarts the agent in place and continues its conversation</div>
          {result && result.kind === 'error' && (
            <div className="settings-error" role="alert" data-testid="task-account-result">{result.text}</div>
          )}
        </div>
      )}
    </span>
  );
}

export function TaskAccountBanner({
  agent,
  onOpenAccountSettings,
}: {
  agent: AgentState;
  onOpenAccountSettings?: () => void;
}) {
  const { accounts, tests, testing, registered } = useClaudeAccounts();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SwitchResult | null>(null);

  if (agent.agentType !== 'claude-code' || !agent.taskId || agent.stuckReason !== 'provider_paused') return null;
  const taskId = agent.taskId;
  const current = taskClaudeAccount(agent);
  const other = pickContinueAccount(accounts, current, tests);
  const currentTest = tests[current];

  async function continueOn(name: string) {
    setBusy(true);
    setResult(null);
    setResult(await switchAccount(taskId, name));
    setBusy(false);
  }

  async function testCurrent() {
    setResult(null);
    const tested = await testAccount(current);
    if (!tested.ok) setResult({ kind: 'error', text: tested.error });
  }

  return (
    <div className="launch-quota-banner task-account-banner" role="status" data-testid="task-account-banner">
      <span>This task stopped on {current}&apos;s usage limit.</span>
      <div className="task-account-banner-actions">
        {registered.length === 0 ? (
          onOpenAccountSettings && (
            <button type="button" className="settings-button primary" onClick={onOpenAccountSettings}>
              Add an account{'…'}
            </button>
          )
        ) : other ? (
          <button
            type="button"
            className="settings-button primary"
            disabled={busy}
            title={accountTitle(other)}
            onClick={() => { void continueOn(other.name); }}
          >
            Continue on {other.name}
          </button>
        ) : (
          <span className="settings-desc">No other account looks available right now.</span>
        )}
        <button
          type="button"
          className="settings-button"
          disabled={testing[current] === true}
          onClick={() => { void testCurrent(); }}
        >
          {testing[current] ? 'Testing…' : `Test ${current}`}
        </button>
      </div>
      {currentTest && (
        <div className="settings-desc" data-testid="task-account-banner-test">
          {current}: {accountStatus(currentTest).label}. {currentTest.message}
        </div>
      )}
      {result && (
        <div
          className={`task-account-result task-account-result--${result.kind}`}
          role={result.kind === 'error' ? 'alert' : 'status'}
          data-testid="task-account-result"
        >
          {result.text}
        </div>
      )}
    </div>
  );
}
