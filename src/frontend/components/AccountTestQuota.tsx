import React from 'react';
import type { ClaudeAccountTestResponse } from '../../shared/contracts/claude-accounts.js';
import { nearLimitWindows, testQuotaStatus } from '../store/claude-accounts.js';
import { QuotaRows } from './UsageSummary.js';

/**
 * A tested account's 5-hour/7-day usage (issue #4251): the host's quota bars,
 * fed from the last Test instead of the live host poll, with when it was
 * measured and Claude Code's "close to the limit" warning. Renders nothing when
 * the test reported no usage. Used by Settings → Accounts and the footer popover.
 */
export function AccountTestQuota({ test }: { test: ClaudeAccountTestResponse | undefined }): React.ReactElement | null {
  const quota = testQuotaStatus(test);
  if (!test || !quota) return null;
  const near = nearLimitWindows(test.quota);
  const measured = new Date(quota.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const stale = Date.now() - quota.updatedAt > 5 * 60_000;
  return (
    <div className="claude-account-quota" data-testid={`claude-account-quota-${test.name}`}>
      <QuotaRows quota={quota} />
      {near.length > 0 && (
        <div className="settings-desc claude-account-quota-warning" data-testid={`claude-account-quota-warning-${test.name}`}>
          {near.length === 1
            ? `${near[0]} quota is close to its limit.`
            : `${near.join(' and ')} quotas are close to their limits.`}
        </div>
      )}
      <div className="settings-desc claude-account-quota-measured">
        Measured by the test at {measured}.{stale ? ' Test again for current usage.' : ''}
      </div>
    </div>
  );
}
